'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  XAUUSD ICT — 3 MONTH BACKTEST
//  Fetches data in monthly chunks, stitches together, runs full analysis
//  All strategy improvements applied:
//    • HTF bias hard gate
//    • Kill zone only (London 07-09, NY 12-15)
//    • 80% min confluence
//    • FVG confirmation candle + wick depth check
//    • Multi-TF liquidity targets (TP2/TP3)
//    • 50% close TP1, BE stop, 25% TP2, 25% TP3
//    • 1% risk per trade, £1,000 start
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const axios = require('axios');
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const {
  htfBias, keyLevels, detectLiquiditySweep,
  detectMSS, entryFVG, findOrderBlock, scoreConfluence,
  liquidityTargets
} = require('./ict_xau');

const KEY    = process.env.TWELVEDATA_API_KEY;
const BASE   = 'https://api.twelvedata.com';
const SYMBOL = 'XAU/USD';

// ─── Account settings ────────────────────────────────────────────────────────
const ACCOUNT_START  = 5000;
const RISK_PCT       = 0.04;
const TP1_R          = 1.5;
const TP2_R          = 2.5;
const TP3_R          = 5.0;
const SIM_BARS       = 288;   // 24h
const MIN_SCORE      = 80;
const COOLDOWN       = 36;    // 3h in 5m bars
const DAILY_LOSS_CAP = 0.03;

// ─── Date helpers ────────────────────────────────────────────────────────────
function fmt(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function fmtDT(iso) {
  const d = new Date(iso);
  return `${fmt(d)} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`;
}
function fmtGBP(n) { return '£' + n.toFixed(2); }

function threeMonthRange() {
  const now = new Date();
  const day = now.getUTCDay();
  // End = last Friday
  const daysToLastFri = day === 0 ? 1 : (day >= 6 ? day - 5 : day + 2);
  const end = new Date(now);
  end.setUTCDate(now.getUTCDate() - daysToLastFri);
  end.setUTCHours(23, 59, 59, 0);
  // Start = ~3 months before end
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - 3);
  start.setUTCHours(0, 0, 0, 0);
  return { start, end, label: `${fmt(start)} → ${fmt(end)}` };
}

// ─── Disk cache ──────────────────────────────────────────────────────────────
const CACHE_DIR = path.join(__dirname, '..', '.cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

const wait = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(params, label) {
  const cacheFile = path.join(CACHE_DIR, `3m_${label}.json`);
  if (fs.existsSync(cacheFile)) {
    process.stdout.write(chalk.gray(` (cached)\n`));
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      const delay = [30000, 60000, 90000, 120000][attempt-1] || 120000;
      process.stdout.write(chalk.yellow(` rate-limited, retry in ${delay/1000}s...\n`));
      await wait(delay);
    }
    try {
      const r = await axios.get(`${BASE}/time_series`, {
        params: { ...params, apikey: KEY, format: 'JSON', timezone: 'UTC' },
        timeout: 25000
      });
      if (r.data.status === 'error') throw new Error(`TwelveData: ${r.data.message}`);
      if (!r.data.values?.length) throw new Error('No data returned');
      const candles = r.data.values.reverse().map(c => ({
        time: c.datetime, open: parseFloat(c.open), high: parseFloat(c.high),
        low: parseFloat(c.low), close: parseFloat(c.close), volume: parseFloat(c.volume || 0)
      }));
      fs.writeFileSync(cacheFile, JSON.stringify(candles));
      process.stdout.write(chalk.green(` ✓ ${candles.length} bars\n`));
      return candles;
    } catch (e) {
      if (e.response?.status === 429 || e.message.includes('429')) { lastErr = e; continue; }
      throw e;
    }
  }
  throw lastErr || new Error('Max retries exceeded');
}

// Fetch candles in monthly chunks and stitch together
async function fetchChunked(interval, outputsize, months) {
  const now = new Date();
  const allCandles = [];

  for (let m = months - 1; m >= 0; m--) {
    const endDate = new Date(now);
    endDate.setUTCMonth(now.getUTCMonth() - m);
    endDate.setUTCDate(1);
    endDate.setUTCHours(0,0,0,0);
    const startDate = new Date(endDate);
    startDate.setUTCMonth(startDate.getUTCMonth() - 1);

    const label = `${interval}_${fmt(startDate)}_${fmt(endDate)}`;
    process.stdout.write(chalk.gray(`  ${interval} chunk ${fmt(startDate)}...`));

    try {
      const chunk = await fetchWithRetry({
        symbol: SYMBOL, interval, outputsize,
        start_date: `${fmt(startDate)} 00:00:00`,
        end_date:   `${fmt(endDate)} 23:59:59`
      }, label);
      allCandles.push(...chunk);
      await wait(8000);
    } catch (e) {
      process.stdout.write(chalk.yellow(` skipped: ${e.message.slice(0,50)}\n`));
    }
  }

  // Deduplicate and sort
  const seen = new Set();
  return allCandles
    .filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
    .sort((a, b) => new Date(a.time) - new Date(b.time));
}

function inRange(candles, start, end) {
  return candles.filter(c => { const t = new Date(c.time); return t >= start && t <= end; });
}

function rollup(src, factor) {
  const out = [];
  for (let i = 0; i < src.length; i += factor) {
    const s = src.slice(i, i + factor);
    if (!s.length) continue;
    out.push({ time: s[0].time, open: s[0].open, high: Math.max(...s.map(c => c.high)),
      low: Math.min(...s.map(c => c.low)), close: s[s.length-1].close,
      volume: s.reduce((a, c) => a + c.volume, 0) });
  }
  return out;
}

function sessionLabel(iso) {
  const h = new Date(iso).getUTCHours();
  if (h >= 7  && h < 9)  return '🟡 London KZ';
  if (h >= 12 && h < 15) return '🟢 NY KZ';
  if (h >= 0  && h < 6)  return 'Asia';
  return 'Off-hours';
}
function isKillZone(iso) {
  const h = new Date(iso).getUTCHours();
  return (h >= 7 && h < 9) || (h >= 12 && h < 15); // KZ only
}
function asiaRange(h1Candles, date) {
  const start = new Date(date); start.setUTCHours(0,0,0,0);
  const end   = new Date(date); end.setUTCHours(6,0,0,0);
  const asia  = h1Candles.filter(c => { const t = new Date(c.time); return t >= start && t < end; });
  if (!asia.length) return null;
  return { high: Math.max(...asia.map(c => c.high)), low: Math.min(...asia.map(c => c.low)) };
}

function htfAligned(htf, dir) {
  return (dir === 'bull' && (htf.bias === 'bullish' || htf.bias === 'pullback_in_bear'))
      || (dir === 'bear' && (htf.bias === 'bearish' || htf.bias === 'pullback_in_bull'));
}

function simulateOutcome(dir, entry, sl, tp1, tp2, tp3, futureCandles) {
  let tp1Hit = false;
  let currentSL = sl;
  for (const c of futureCandles) {
    const slHit   = dir === 'bull' ? c.low  <= currentSL : c.high >= currentSL;
    const tp1Hit_ = dir === 'bull' ? c.high >= tp1 : c.low  <= tp1;
    const tp2Hit  = dir === 'bull' ? c.high >= tp2 : c.low  <= tp2;
    const tp3Hit  = dir === 'bull' ? c.high >= tp3 : c.low  <= tp3;
    if (!tp1Hit) {
      if (slHit)   return { result: 'LOSS',        pnlR: -1,                            exits: ['Full loss at SL'] };
      if (tp3Hit)  return { result: 'WIN_TP3',     pnlR: 0.5*TP1_R+0.25*TP2_R+0.25*TP3_R, exits: ['50%@TP1','25%@TP2','25%@TP3'] };
      if (tp2Hit)  return { result: 'WIN_TP2',     pnlR: 0.5*TP1_R+0.5*TP2_R,          exits: ['50%@TP1','50%@TP2'] };
      if (tp1Hit_) { tp1Hit = true; currentSL = entry; }
    } else {
      if (slHit)   return { result: 'WIN_TP1_BE',  pnlR: 0.5*TP1_R,                    exits: ['50%@TP1','50% BE'] };
      if (tp3Hit)  return { result: 'WIN_TP3',     pnlR: 0.5*TP1_R+0.25*TP2_R+0.25*TP3_R, exits: ['50%@TP1','25%@TP2','25%@TP3'] };
      if (tp2Hit)  return { result: 'WIN_TP2',     pnlR: 0.5*TP1_R+0.5*TP2_R,          exits: ['50%@TP1','50%@TP2'] };
    }
  }
  if (tp1Hit) return { result: 'WIN_TP1_OPEN', pnlR: 0.5*TP1_R, exits: ['50%@TP1','50% open'] };
  return { result: 'OPEN', pnlR: null, exits: [] };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  console.clear();
  console.log('\n' + chalk.bold.yellow('  ◆ XAUUSD ICT — 3 MONTH BACKTEST'));
  console.log(chalk.gray('  All strategy fixes applied  |  1% risk/trade  |  £1,000 start\n'));

  const range = threeMonthRange();
  console.log(chalk.gray(`  Period: ${range.label}\n`));
  console.log(chalk.gray('  Fetching data in monthly chunks...\n'));

  // Fetch 3 months of data in chunks
  const all5m  = await fetchChunked('5min',  4500, 4); await wait(15000);
  const all15m = await fetchChunked('15min', 1500, 4); await wait(15000);
  const allH1  = await fetchChunked('1h',    750,  4); await wait(15000);

  // HTF — single large fetch (daily/4H don't need chunking)
  process.stdout.write(chalk.gray('  Fetching 4H candles...'));
  const allH4 = await fetchWithRetry({ symbol: SYMBOL, interval: '4h', outputsize: 200 }, '4h_3m').catch(() => rollup(allH1, 4));
  await wait(10000);
  process.stdout.write(chalk.gray('  Fetching Daily candles...'));
  const allDaily = await fetchWithRetry({ symbol: SYMBOL, interval: '1day', outputsize: 90 }, '1day_3m').catch(() => rollup(allH1, 24));

  console.log(chalk.green('\n  ✓ Data assembled'));

  const period5m = inRange(all5m, range.start, range.end);
  console.log(chalk.gray(`  5m bars in period: ${period5m.length}  (${Math.round(period5m.length/12)} hours)\n`));

  if (period5m.length === 0) { console.log(chalk.red('  No data found.')); return; }

  const signals     = [];
  let lastSignalBar = -999;
  let balance       = ACCOUNT_START;
  let peakBalance   = ACCOUNT_START;
  let maxDrawdown   = 0;
  const dailyPnL    = {};
  const dailyBlocked = {};

  for (let i = 50; i < period5m.length - 1; i++) {
    const bar         = period5m[i];
    const currentTime = new Date(bar.time);
    const dateStr     = fmt(currentTime);

    if (i - lastSignalBar < COOLDOWN) continue;
    if (dailyBlocked[dateStr]) continue;
    if (!isKillZone(bar.time)) continue;

    const slice5m  = all5m.filter(c  => new Date(c.time) <= currentTime);
    const slice15m = all15m.filter(c => new Date(c.time) <= currentTime);
    const sliceH1  = allH1.filter(c  => new Date(c.time) <= currentTime);

    if (slice5m.length < 40 || allH4.length < 6 || allDaily.length < 5) continue;

    const asia    = asiaRange(sliceH1, bar.time);
    const session = { active: true, label: sessionLabel(bar.time) };

    let htf, lvls, sweepResult, mss, fvg, ob, conf;
    try {
      htf  = htfBias(allDaily, allH4);
      lvls = keyLevels(allDaily, asia);
      const s5  = detectLiquiditySweep(slice5m,  lvls, htf);
      const s15 = detectLiquiditySweep(slice15m, lvls, htf);
      sweepResult = s5.mostRecent ? s5 : s15;
      mss  = detectMSS(slice5m, sweepResult);
      fvg  = entryFVG(slice5m, mss, sweepResult);
      ob   = findOrderBlock(slice5m, sweepResult);
      conf = scoreConfluence(htf, sweepResult, mss, fvg, ob, session);
    } catch (e) { continue; }

    const dir = sweepResult.mostRecent?.dir;
    if (!dir || !mss.confirmed || conf.score < MIN_SCORE || !fvg?.inFVG) continue;
    if (!htfAligned(htf, dir)) continue;

    // Market execution: enter at the open of the next bar (not FVG optimalEntry)
    const nextBar5m = period5m[i + 1];
    if (!nextBar5m) continue;
    const entryPrice = nextBar5m.open;
    const buf  = entryPrice * 0.0008;
    const sl   = dir === 'bull'
      ? Math.min((sweepResult.mostRecent.sweepLow || entryPrice) - buf, entryPrice - buf * 2)
      : Math.max((sweepResult.mostRecent.sweepHigh || entryPrice) + buf, entryPrice + buf * 2);
    const risk = Math.abs(entryPrice - sl);
    if (risk > 15 || risk <= 0) continue;

    const tp1 = dir === 'bull' ? entryPrice + risk * TP1_R : entryPrice - risk * TP1_R;
    const liq  = liquidityTargets(dir, entryPrice, risk, lvls, slice5m, sliceH1);
    const tp2  = liq.tp2;
    const tp3  = liq.tp3;

    // Simulate from bar AFTER entry bar
    const future  = period5m.slice(i + 2, i + SIM_BARS);
    const outcome = simulateOutcome(dir, entryPrice, sl, tp1, tp2, tp3, future);

    const riskGBP = balance * RISK_PCT;
    const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;

    if (pnlGBP !== null) {
      balance += pnlGBP;
      dailyPnL[dateStr] = (dailyPnL[dateStr] || 0) + pnlGBP;
      if (dailyPnL[dateStr] < -(ACCOUNT_START * DAILY_LOSS_CAP)) dailyBlocked[dateStr] = true;
      if (balance > peakBalance) peakBalance = balance;
      const dd = ((peakBalance - balance) / peakBalance) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    signals.push({
      time: bar.time, dir: dir === 'bull' ? 'BUY' : 'SELL',
      entry: parseFloat(entryPrice.toFixed(2)),
      sl: parseFloat(sl.toFixed(2)), tp1: parseFloat(tp1.toFixed(2)),
      tp2, tp3, risk: parseFloat(risk.toFixed(2)),
      score: conf.score, grade: conf.grade,
      session: session.label, htfBias: htf.bias,
      sweep: sweepResult.mostRecent.levelName, mssType: mss.type,
      tp2Desc: liq.tp2Desc, tp3Desc: liq.tp3Desc,
      riskGBP: parseFloat(riskGBP.toFixed(2)),
      pnlGBP: pnlGBP !== null ? parseFloat(pnlGBP.toFixed(2)) : null,
      balanceAfter: pnlGBP !== null ? parseFloat(balance.toFixed(2)) : null,
      ...outcome
    });

    lastSignalBar = i;
  }

  // ─── Print signals ────────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(72));
  console.log(chalk.bold.yellow('  SIGNAL REPORT — XAUUSD — 3 MONTHS'));
  console.log(chalk.gray(`  ${range.label}  |  ${MIN_SCORE}% min  |  1% risk/trade`));
  console.log('═'.repeat(72));

  signals.forEach((s, idx) => {
    const isLong = s.dir === 'BUY';
    const color  = isLong ? chalk.green : chalk.red;
    const outcomeColor = s.result === 'WIN_TP3' ? chalk.bold.green
      : s.result?.startsWith('WIN') ? chalk.green
      : s.result === 'LOSS' ? chalk.red : chalk.yellow;
    const pnlStr = s.pnlR != null
      ? (s.pnlR > 0 ? chalk.green(`+${s.pnlR.toFixed(2)}R  +£${s.pnlGBP}`) : chalk.red(`${s.pnlR.toFixed(2)}R  £${s.pnlGBP}`))
      : chalk.yellow('open');

    console.log(
      '\n' + chalk.bold(`  #${idx+1}`) + chalk.gray(` ${fmtDT(s.time)}  ${s.session}`) +
      '  ' + color(`${isLong?'▲':'▼'} ${s.dir}`) +
      chalk.gray(`  ${s.score}%`) + chalk.gray(`  ${s.sweep} → ${s.mssType}`)
    );
    console.log(
      chalk.gray('  Entry ') + chalk.white(`$${s.entry}`) +
      chalk.gray('  SL ') + chalk.red(`$${s.sl}`) +
      chalk.gray(`  TP1 `) + chalk.green(`$${s.tp1}`) +
      chalk.gray(`  TP2 `) + chalk.green(`$${s.tp2}`) + chalk.gray(` (${s.tp2Desc})`)
    );
    console.log(
      chalk.gray('  → ') + outcomeColor(s.result || 'OPEN') + '  ' + pnlStr +
      (s.balanceAfter ? chalk.gray(`  bal: `) + chalk.white(fmtGBP(s.balanceAfter)) : '')
    );
  });

  // ─── Summary ─────────────────────────────────────────────────────────────

  const closed  = signals.filter(s => s.result !== 'OPEN' && s.pnlR !== null);
  const wins    = closed.filter(s => s.pnlR > 0);
  const losses  = closed.filter(s => s.pnlR < 0);
  const totalR  = closed.reduce((sum, s) => sum + s.pnlR, 0);
  const totalGBP = closed.reduce((sum, s) => sum + (s.pnlGBP || 0), 0);
  const wr      = closed.length ? ((wins.length / closed.length) * 100).toFixed(0) : 0;
  const pf      = losses.length
    ? (wins.reduce((s,x)=>s+x.pnlR,0) / Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2)
    : '∞';

  // Monthly breakdown
  const byMonth = {};
  signals.forEach(s => {
    const d = new Date(s.time);
    const mk = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
    byMonth[mk] = byMonth[mk] || [];
    byMonth[mk].push(s);
  });

  console.log('\n\n' + '═'.repeat(72));
  console.log(chalk.bold.yellow('  3-MONTH SUMMARY'));
  console.log('═'.repeat(72));
  console.log(chalk.gray('  Total signals:  ') + chalk.white(signals.length));
  console.log(chalk.gray('  Closed:         ') + chalk.white(closed.length));
  console.log(chalk.gray('  Wins:           ') + chalk.green(wins.length));
  console.log(chalk.gray('  Losses:         ') + chalk.red(losses.length));
  console.log(chalk.gray('  Win rate:       ') + (parseFloat(wr)>=50?chalk.green:chalk.red)(`${wr}%`));
  console.log(chalk.gray('  Net R:          ') + (totalR>=0?chalk.green(`+${totalR.toFixed(2)}R`):chalk.red(`${totalR.toFixed(2)}R`)));
  console.log(chalk.gray('  Profit factor:  ') + chalk.cyan(pf));

  console.log('\n' + chalk.bold.yellow('  ── ACCOUNT (£1,000 start, 1% risk) ──'));
  console.log(chalk.gray('  Start:          ') + chalk.white('£1,000.00'));
  console.log(chalk.gray('  End:            ') + (balance>=ACCOUNT_START?chalk.green:chalk.red)(fmtGBP(balance)));
  console.log(chalk.gray('  Net P&L:        ') + (totalGBP>=0?chalk.green(`+${fmtGBP(totalGBP)}`):chalk.red(fmtGBP(totalGBP))));
  console.log(chalk.gray('  Return:         ') + (totalGBP>=0?chalk.green:chalk.red)(`${((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)}%`));
  console.log(chalk.gray('  Peak balance:   ') + chalk.white(fmtGBP(peakBalance)));
  console.log(chalk.gray('  Max drawdown:   ') + chalk.yellow(`${maxDrawdown.toFixed(1)}%`));

  console.log(chalk.gray('\n  Month by month:'));
  Object.entries(byMonth).sort().forEach(([mo, sigs]) => {
    const mW   = sigs.filter(s=>s.pnlR>0).length;
    const mL   = sigs.filter(s=>s.pnlR<0).length;
    const mR   = sigs.reduce((sum,s)=>sum+(s.pnlR||0),0);
    const mGBP = sigs.reduce((sum,s)=>sum+(s.pnlGBP||0),0);
    const mWR  = (mW+mL)>0 ? Math.round(mW/(mW+mL)*100) : 0;
    console.log(
      chalk.gray(`    ${mo}  `) +
      chalk.white(`${sigs.length} signals`) + chalk.gray('  ') +
      chalk.green(`${mW}W`) + chalk.gray('/') + chalk.red(`${mL}L`) +
      chalk.gray(`  ${mWR}% WR  `) +
      (mR>=0?chalk.green(`+${mR.toFixed(1)}R`):chalk.red(`${mR.toFixed(1)}R`)) +
      chalk.gray('  ') +
      (mGBP>=0?chalk.green(`+${fmtGBP(mGBP)}`):chalk.red(fmtGBP(mGBP)))
    );
  });

  console.log(chalk.gray('\n  Session breakdown:'));
  const bySess = {};
  signals.forEach(s => { bySess[s.session] = (bySess[s.session]||[]).concat(s); });
  Object.entries(bySess).sort((a,b)=>b[1].length-a[1].length).forEach(([sess,sigs])=>{
    const sW = sigs.filter(s=>s.pnlR>0).length;
    const sL = sigs.filter(s=>s.pnlR<0).length;
    const sWR = (sW+sL)>0?Math.round(sW/(sW+sL)*100):0;
    console.log(chalk.gray(`    ${sess.padEnd(16)} ${sigs.length} signals  ${sW}W/${sL}L  ${sWR}% WR`));
  });

  console.log(chalk.gray('\n  Result breakdown:'));
  const byResult = {};
  signals.forEach(s => { byResult[s.result] = (byResult[s.result]||0)+1; });
  Object.entries(byResult).sort((a,b)=>b[1]-a[1]).forEach(([r,n])=>{
    const color = r==='WIN_TP3'?chalk.bold.green:r?.startsWith('WIN')?chalk.green:r==='LOSS'?chalk.red:chalk.yellow;
    console.log(chalk.gray(`    ${color(r?.padEnd(16))}  ${n} trades`));
  });

  // Save report
  const reportPath = path.join(__dirname, '..', 'backtest_report_5k_4pct_xau.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    period: range.label, generatedAt: new Date().toISOString(),
    settings: { startBalance: ACCOUNT_START, riskPct: RISK_PCT*100, minConfluence: MIN_SCORE },
    account: {
      start: ACCOUNT_START, end: parseFloat(balance.toFixed(2)),
      netGBP: parseFloat(totalGBP.toFixed(2)),
      returnPct: parseFloat(((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)),
      maxDrawdown: parseFloat(maxDrawdown.toFixed(1)), peakBalance: parseFloat(peakBalance.toFixed(2))
    },
    stats: { total: signals.length, wins: wins.length, losses: losses.length, winRate: wr+'%', netR: totalR.toFixed(2), profitFactor: pf },
    byMonth: Object.fromEntries(Object.entries(byMonth).map(([mo,sigs])=>[mo,{
      signals: sigs.length,
      wins: sigs.filter(s=>s.pnlR>0).length,
      losses: sigs.filter(s=>s.pnlR<0).length,
      netR: sigs.reduce((s,x)=>s+(x.pnlR||0),0).toFixed(2),
      netGBP: sigs.reduce((s,x)=>s+(x.pnlGBP||0),0).toFixed(2)
    }])),
    signals
  }, null, 2));
  console.log(chalk.gray(`\n  Report saved → backtest_report_3month.json`));
  console.log('\n' + '═'.repeat(72) + '\n');
}

run().catch(err => {
  console.log(chalk.red(`\n  ✗ Fatal: ${err.message}\n`));
  process.exit(1);
});
