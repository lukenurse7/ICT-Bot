'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  XAUUSD ICT — LAST MONTH BACKTEST  (with HTF bias filter + £1000 account)
//  Covers ~4 weeks of real OHLCV data from TwelveData
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const axios = require('axios');
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const {
  htfBias, keyLevels, detectLiquiditySweep,
  detectMSS, entryFVG, findOrderBlock, scoreConfluence
} = require('./ict_xau');

const KEY    = process.env.TWELVEDATA_API_KEY;
const BASE   = 'https://api.twelvedata.com';
const SYMBOL = 'XAU/USD';

// ─── Account simulation settings ────────────────────────────────────────────
const ACCOUNT_START  = 1000;   // £1,000 starting balance
const RISK_PCT       = 0.01;   // 1% risk per trade
const PARTIAL_CLOSE  = 0.5;    // close 50% at TP1 (1.5R)
const TP1_R          = 1.5;
const TP2_R          = 3.0;
const DAILY_LOSS_CAP = 0.03;   // stop trading if down 3% in a day

// ─── Date helpers ────────────────────────────────────────────────────────────

function lastMonthRange() {
  const now = new Date();
  // End = last Friday
  const day = now.getUTCDay();
  const daysToLastFri = day === 0 ? 1 : (day >= 6 ? day - 5 : day + 2);
  const end = new Date(now);
  end.setUTCDate(now.getUTCDate() - daysToLastFri);
  end.setUTCHours(23, 59, 59, 0);
  // Start = 4 weeks before end's Monday
  const endMon = new Date(end);
  endMon.setUTCDate(end.getUTCDate() - 4);
  const start = new Date(endMon);
  start.setUTCDate(endMon.getUTCDate() - 21); // 3 more weeks back
  start.setUTCHours(0, 0, 0, 0);
  return { start, end, label: `${fmt(start)} → ${fmt(end)}` };
}

function fmt(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function fmtDT(iso) {
  const d = new Date(iso);
  return `${fmt(d)} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`;
}
function fmtGBP(n) { return '£' + n.toFixed(2); }

// ─── Disk cache ──────────────────────────────────────────────────────────────

const CACHE_DIR = path.join(__dirname, '..', '.cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

function cacheKey(interval, outputsize) {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(CACHE_DIR, `xau_${interval}_${outputsize}_${today}.json`);
}

function findBestCache(interval, minSize) {
  const today = new Date().toISOString().slice(0, 10);
  const files = fs.readdirSync(CACHE_DIR)
    .filter(f => f.startsWith(`xau_${interval}_`) && f.endsWith(`_${today}.json`));
  if (!files.length) return null;
  files.sort((a, b) => parseInt(b.split('_')[2]) - parseInt(a.split('_')[2]));
  const best = files[0];
  const size = parseInt(best.split('_')[2]);
  if (minSize && size < minSize) return null;
  return path.join(CACHE_DIR, best);
}

const wait = ms => new Promise(r => setTimeout(r, ms));

async function fetchHistorical(interval, outputsize) {
  const file = cacheKey(interval, outputsize);
  if (fs.existsSync(file)) {
    process.stdout.write(chalk.gray(' (cached)\n'));
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const best = findBestCache(interval, outputsize);
  if (best) {
    process.stdout.write(chalk.yellow(` (cache: ${path.basename(best)})\n`));
    return JSON.parse(fs.readFileSync(best, 'utf8'));
  }
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      const delay = [30000, 60000, 90000][attempt - 1] || 90000;
      process.stdout.write(chalk.yellow(` rate-limited, retry in ${delay/1000}s...\n`));
      await wait(delay);
    }
    try {
      const r = await axios.get(`${BASE}/time_series`, {
        params: { symbol: SYMBOL, interval, outputsize, apikey: KEY, format: 'JSON', timezone: 'UTC' },
        timeout: 20000
      });
      if (r.data.status === 'error') throw new Error(`TwelveData: ${r.data.message}`);
      if (!r.data.values?.length) throw new Error('No data returned');
      const candles = r.data.values.reverse().map(c => ({
        time: c.datetime, open: parseFloat(c.open), high: parseFloat(c.high),
        low: parseFloat(c.low), close: parseFloat(c.close), volume: parseFloat(c.volume || 0)
      }));
      fs.writeFileSync(file, JSON.stringify(candles));
      process.stdout.write(chalk.green(` ✓ ${candles.length} bars\n`));
      return candles;
    } catch (e) {
      if (e.response?.status === 429 || e.message.includes('429')) { lastErr = e; continue; }
      throw e;
    }
  }
  throw lastErr || new Error('Max retries exceeded');
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
  return (h >= 7 && h < 9) || (h >= 12 && h < 15);
}
function asiaRange(h1Candles, date) {
  const start = new Date(date); start.setUTCHours(0,0,0,0);
  const end   = new Date(date); end.setUTCHours(6,0,0,0);
  const asia  = h1Candles.filter(c => { const t = new Date(c.time); return t >= start && t < end; });
  if (!asia.length) return null;
  return { high: Math.max(...asia.map(c => c.high)), low: Math.min(...asia.map(c => c.low)) };
}

function simulateOutcome(dir, entry, sl, tp1, tp2, futureCandles) {
  for (const c of futureCandles) {
    if (dir === 'bull') {
      if (c.low  <= sl)  return { result: 'LOSS',    pnlR: -1,       exitPrice: sl,  exitTime: c.time };
      if (c.high >= tp2) return { result: 'WIN_TP2', pnlR: PARTIAL_CLOSE * TP1_R + PARTIAL_CLOSE * TP2_R, exitPrice: tp2, exitTime: c.time };
      if (c.high >= tp1) return { result: 'WIN_TP1', pnlR: PARTIAL_CLOSE * TP1_R, exitPrice: tp1, exitTime: c.time };
    } else {
      if (c.high >= sl)  return { result: 'LOSS',    pnlR: -1,       exitPrice: sl,  exitTime: c.time };
      if (c.low  <= tp2) return { result: 'WIN_TP2', pnlR: PARTIAL_CLOSE * TP1_R + PARTIAL_CLOSE * TP2_R, exitPrice: tp2, exitTime: c.time };
      if (c.low  <= tp1) return { result: 'WIN_TP1', pnlR: PARTIAL_CLOSE * TP1_R, exitPrice: tp1, exitTime: c.time };
    }
  }
  return { result: 'OPEN', pnlR: null, exitPrice: null, exitTime: null };
}

// ─── HTF bias hard gate (mirrors ict_xau.js) ────────────────────────────────
function htfAligned(htf, dir) {
  return (dir === 'bull' && (htf.bias === 'bullish' || htf.bias === 'pullback_in_bear'))
      || (dir === 'bear' && (htf.bias === 'bearish' || htf.bias === 'pullback_in_bull'));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  console.clear();
  console.log('\n' + chalk.bold.yellow('  ◆ XAUUSD ICT — LAST MONTH BACKTEST'));
  console.log(chalk.gray('  HTF Bias filter ON  |  Kill Zone only  |  80% min score  |  1% risk  |  £1,000 start\n'));

  const range = lastMonthRange();

  // 1 month 5m bars: ~20 days × 24h × 12 = 5760 + 500 warmup = 6500
  async function tryFetch(label, interval, size) {
    process.stdout.write(chalk.gray(`  Fetching ${label}...`));
    try { return await fetchHistorical(interval, size); }
    catch (e) { process.stdout.write(chalk.yellow(` skipped: ${e.message.slice(0,50)}\n`)); return null; }
  }

  const all5m  = await tryFetch('5m (5000 bars)',   '5min',  5000);
  if (!all5m) { console.log(chalk.red('  Fatal: 5m data unavailable')); return; }
  await wait(25000);
  const all15m = await tryFetch('15m (1500 bars)',  '15min', 1500) || rollup(all5m, 3);
  await wait(25000);
  const allH1  = await tryFetch('1H (400 bars)',    '1h',    400)  || rollup(all5m, 12);
  await wait(25000);
  const allH4Raw = await tryFetch('4H (150 bars)',  '4h',    150);
  await wait(25000);
  const allH4  = allH4Raw || rollup(allH1, 4);
  const allDailyRaw = await tryFetch('Daily (60 bars)', '1day', 60);
  const allDaily = allDailyRaw || rollup(allH1, 24);

  console.log(chalk.green('\n  ✓ Data assembled'));
  console.log(chalk.gray(`  Period: ${range.label}\n`));

  const month5m = inRange(all5m, range.start, range.end);
  console.log(chalk.gray(`  5m bars in range: ${month5m.length}`));
  if (month5m.length === 0) { console.log(chalk.red('  No 5m data found for period.')); return; }

  const signals      = [];
  const MIN_SCORE    = 80;
  const COOLDOWN     = 36; // 3h
  let lastSignalBar  = -999;

  // Account tracking
  let balance        = ACCOUNT_START;
  let peakBalance    = ACCOUNT_START;
  let maxDrawdown    = 0;
  let dailyPnL       = {};  // date → £ P&L
  let dailyBlocked   = {};  // date → bool (daily loss cap hit)

  for (let i = 30; i < month5m.length - 1; i++) {
    const bar         = month5m[i];
    const currentTime = new Date(bar.time);
    const dateStr     = fmt(currentTime);

    if (i - lastSignalBar < COOLDOWN) continue;
    if (dailyBlocked[dateStr]) continue;

    const slice5m  = all5m.filter(c  => new Date(c.time)  <= currentTime);
    const slice15m = all15m.filter(c => new Date(c.time)  <= currentTime);
    const sliceH1  = allH1.filter(c  => new Date(c.time)  <= currentTime);

    if (slice5m.length < 40 || allH4.length < 6 || allDaily.length < 5) continue;

    const asia    = asiaRange(sliceH1, bar.time);
    const session = { active: isKillZone(bar.time), label: sessionLabel(bar.time) };

    let htf, lvls, sweepResult, mss, fvg, ob, conf;
    try {
      htf  = htfBias(allDaily, allH4);
      lvls = keyLevels(allDaily, asia);
      const sweep5m  = detectLiquiditySweep(slice5m,  lvls, htf);
      const sweep15m = detectLiquiditySweep(slice15m, lvls, htf);
      sweepResult = sweep5m.mostRecent ? sweep5m : sweep15m;
      mss  = detectMSS(slice5m, sweepResult);
      fvg  = entryFVG(slice5m, mss, sweepResult);
      ob   = findOrderBlock(slice5m, sweepResult);
      conf = scoreConfluence(htf, sweepResult, mss, fvg, ob, session);
    } catch (e) { continue; }

    const dir = sweepResult.mostRecent?.dir;
    const fvgReady = fvg && fvg.inFVG;

    if (!dir || !mss.confirmed || conf.score < MIN_SCORE || !fvgReady) continue;

    // HTF bias hard gate
    if (!htfAligned(htf, dir)) continue;

    // Kill zone hard gate — London 07:00-09:00 or NY 12:00-15:00 UTC only
    if (!session.active) continue;

    const entryPrice = fvg.optimalEntry;
    const buf        = entryPrice * 0.0008;
    const sl = dir === 'bull'
      ? (sweepResult.mostRecent.sweepLow  || entryPrice) - buf
      : (sweepResult.mostRecent.sweepHigh || entryPrice) + buf;
    const risk = Math.abs(entryPrice - sl);
    if (risk > 15 || risk <= 0) continue;

    const tp1 = dir === 'bull' ? entryPrice + risk * TP1_R : entryPrice - risk * TP1_R;
    const tp2 = dir === 'bull'
      ? (lvls.pdh && lvls.pdh > entryPrice + risk * 2 ? lvls.pdh : entryPrice + risk * TP2_R)
      : (lvls.pdl && lvls.pdl < entryPrice - risk * 2 ? lvls.pdl : entryPrice - risk * TP2_R);

    const future  = month5m.slice(i + 1, i + 61);
    const outcome = simulateOutcome(dir, entryPrice, sl, tp1, tp2, future);

    // ── Account simulation ──────────────────────────────────────────────────
    const riskGBP  = balance * RISK_PCT;           // £ risked this trade
    const pnlGBP   = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;

    if (pnlGBP !== null) {
      balance += pnlGBP;
      dailyPnL[dateStr] = (dailyPnL[dateStr] || 0) + pnlGBP;
      // Daily loss cap check
      if (dailyPnL[dateStr] < -(ACCOUNT_START * DAILY_LOSS_CAP)) {
        dailyBlocked[dateStr] = true;
      }
      // Drawdown tracking
      if (balance > peakBalance) peakBalance = balance;
      const dd = ((peakBalance - balance) / peakBalance) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    signals.push({
      bar, i,
      time:     bar.time,
      dir:      dir === 'bull' ? 'BUY' : 'SELL',
      entry:    parseFloat(entryPrice.toFixed(2)),
      sl:       parseFloat(sl.toFixed(2)),
      tp1:      parseFloat(tp1.toFixed(2)),
      tp2:      parseFloat(tp2.toFixed(2)),
      risk:     parseFloat(risk.toFixed(2)),
      score:    conf.score,
      grade:    conf.grade,
      session:  session.label,
      htfBias:  htf.bias,
      sweep:    sweepResult.mostRecent.levelName,
      mssType:  mss.type,
      hasFVG:   true,
      hasOB:    !!ob,
      riskGBP:  parseFloat(riskGBP.toFixed(2)),
      pnlGBP:   pnlGBP !== null ? parseFloat(pnlGBP.toFixed(2)) : null,
      balanceAfter: pnlGBP !== null ? parseFloat(balance.toFixed(2)) : null,
      ...outcome
    });

    lastSignalBar = i;
  }

  // ─── Print each signal ───────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(72));
  console.log(chalk.bold.yellow('  SIGNAL REPORT — XAUUSD — LAST MONTH  (HTF Bias Filter ON)'));
  console.log(chalk.gray(`  ${range.label}  |  Min confluence: ${MIN_SCORE}%  |  1% risk/trade`));
  console.log('═'.repeat(72));

  if (signals.length === 0) {
    console.log(chalk.yellow('\n  No signals fired this month matching all criteria.\n'));
    return;
  }

  signals.forEach((s, idx) => {
    const isLong = s.dir === 'BUY';
    const color  = isLong ? chalk.green : chalk.red;
    const outcomeColor = s.result?.startsWith('WIN') ? chalk.green : s.result === 'LOSS' ? chalk.red : chalk.yellow;

    console.log('\n' + chalk.bold(`  Signal #${idx + 1}`) + chalk.gray(` — ${fmtDT(s.time)}  ${s.session}`));
    console.log('  ' + '─'.repeat(68));
    console.log(color(`  ${isLong ? '▲' : '▼'} ${s.dir}`) +
      chalk.gray('  Score: ') + chalk.cyan(`${s.score}%`) +
      chalk.gray('  Grade: ') + chalk.cyan(s.grade) +
      chalk.gray('  HTF: ') + chalk.white(s.htfBias.replace(/_/g,' ')));
    console.log(chalk.gray(`  Sweep: ${s.sweep}  MSS: ${s.mssType}`) + chalk.green('  +FVG') + (s.hasOB ? chalk.cyan('  +OB') : ''));

    console.log(chalk.gray('  ┌─ LEVELS ──────────────────────────────────────────────┐'));
    console.log(chalk.gray('  │  Entry    ') + chalk.bold.white(`$${s.entry}`));
    console.log(chalk.gray('  │  SL       ') + chalk.red(`$${s.sl}`) + chalk.gray(`  (${s.risk}pts  risk: £${s.riskGBP})`));
    console.log(chalk.gray('  │  TP1      ') + chalk.green(`$${s.tp1}`) + chalk.gray(`  (1:${TP1_R}R)`));
    console.log(chalk.gray('  │  TP2      ') + chalk.green(`$${s.tp2}`) + chalk.gray(`  (1:${TP2_R}R)`));
    if (s.result) {
      const pnlStr = s.pnlR != null
        ? (s.pnlR > 0 ? chalk.green(`+${s.pnlR}R  +£${s.pnlGBP}`) : chalk.red(`${s.pnlR}R  -£${Math.abs(s.pnlGBP)}`))
        : chalk.yellow('(open)');
      console.log(chalk.gray('  │  Outcome  ') + outcomeColor(s.result) + '  ' + pnlStr);
      if (s.exitTime) console.log(chalk.gray(`  │  Exit     ${fmtDT(s.exitTime)}  @ $${s.exitPrice?.toFixed(2)}`));
      if (s.balanceAfter) console.log(chalk.gray('  │  Balance  ') + chalk.bold.white(fmtGBP(s.balanceAfter)));
    }
    console.log(chalk.gray('  └────────────────────────────────────────────────────────┘'));
  });

  // ─── Summary ─────────────────────────────────────────────────────────────────

  const closed   = signals.filter(s => s.result !== 'OPEN');
  const wins     = closed.filter(s => s.pnlR > 0);
  const losses   = closed.filter(s => s.pnlR < 0);
  const totalR   = closed.reduce((sum, s) => sum + (s.pnlR || 0), 0);
  const totalGBP = closed.reduce((sum, s) => sum + (s.pnlGBP || 0), 0);
  const wr       = closed.length ? ((wins.length / closed.length) * 100).toFixed(0) : 0;
  const pf       = losses.length
    ? (wins.reduce((s, x) => s + x.pnlR, 0) / Math.abs(losses.reduce((s, x) => s + x.pnlR, 0))).toFixed(2)
    : '∞';

  // Weekly breakdown
  const byWeek = {};
  signals.forEach(s => {
    const d = new Date(s.time);
    const weekStart = new Date(d);
    weekStart.setUTCDate(d.getUTCDate() - d.getUTCDay() + 1);
    const wk = fmt(weekStart);
    byWeek[wk] = byWeek[wk] || [];
    byWeek[wk].push(s);
  });

  console.log('\n\n' + '═'.repeat(72));
  console.log(chalk.bold.yellow('  MONTHLY SUMMARY'));
  console.log('═'.repeat(72));
  console.log(chalk.gray('  Total signals:    ') + chalk.white(signals.length));
  console.log(chalk.gray('  Closed trades:    ') + chalk.white(closed.length));
  console.log(chalk.gray('  Open (no exit):   ') + chalk.yellow(signals.length - closed.length));
  console.log(chalk.gray('  Wins:             ') + chalk.green(wins.length));
  console.log(chalk.gray('  Losses:           ') + chalk.red(losses.length));
  console.log(chalk.gray('  Win rate:         ') + (parseFloat(wr) >= 50 ? chalk.green : chalk.red)(`${wr}%`));
  console.log(chalk.gray('  Net R:            ') + (totalR >= 0 ? chalk.green(`+${totalR.toFixed(2)}R`) : chalk.red(`${totalR.toFixed(2)}R`)));
  console.log(chalk.gray('  Profit factor:    ') + chalk.cyan(pf));

  console.log('\n' + chalk.bold.yellow('  ── ACCOUNT PERFORMANCE (£1,000 start, 1% risk) ──'));
  console.log(chalk.gray('  Starting balance: ') + chalk.white('£1,000.00'));
  console.log(chalk.gray('  Ending balance:   ') + (balance >= ACCOUNT_START ? chalk.green : chalk.red)(fmtGBP(balance)));
  console.log(chalk.gray('  Net profit/loss:  ') + (totalGBP >= 0 ? chalk.green(`+${fmtGBP(totalGBP)}`) : chalk.red(fmtGBP(totalGBP))));
  console.log(chalk.gray('  Return:           ') + (totalGBP >= 0 ? chalk.green : chalk.red)(`${((balance - ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)}%`));
  console.log(chalk.gray('  Peak balance:     ') + chalk.white(fmtGBP(peakBalance)));
  console.log(chalk.gray('  Max drawdown:     ') + chalk.yellow(`${maxDrawdown.toFixed(1)}%`));

  console.log(chalk.gray('\n  Week by week:'));
  Object.entries(byWeek).sort().forEach(([wk, sigs]) => {
    const wWins = sigs.filter(s => s.pnlR > 0);
    const wLoss = sigs.filter(s => s.pnlR < 0);
    const wGBP  = sigs.reduce((sum, s) => sum + (s.pnlGBP || 0), 0);
    const wR    = sigs.reduce((sum, s) => sum + (s.pnlR || 0), 0);
    console.log(
      chalk.gray(`    w/c ${wk}  `) +
      chalk.white(`${sigs.length} signals`) +
      chalk.gray('  ') + chalk.green(`${wWins.length}W`) + chalk.gray('/') + chalk.red(`${wLoss.length}L`) +
      chalk.gray('  ') + (wR >= 0 ? chalk.green(`+${wR.toFixed(1)}R`) : chalk.red(`${wR.toFixed(1)}R`)) +
      chalk.gray('  ') + (wGBP >= 0 ? chalk.green(`+${fmtGBP(wGBP)}`) : chalk.red(fmtGBP(wGBP)))
    );
  });

  console.log(chalk.gray('\n  Session breakdown:'));
  const bySess = {};
  signals.forEach(s => { bySess[s.session] = (bySess[s.session] || []).concat(s); });
  Object.entries(bySess).sort((a,b) => b[1].length - a[1].length).forEach(([sess, sigs]) => {
    const sWins = sigs.filter(s => s.pnlR > 0).length;
    const sLoss = sigs.filter(s => s.pnlR < 0).length;
    const sWR   = sigs.filter(s => s.pnlR !== null).length
      ? Math.round(sWins / sigs.filter(s => s.pnlR !== null).length * 100) : 0;
    console.log(chalk.gray(`    ${sess.padEnd(20)} ${sigs.length} signals  ${sWins}W/${sLoss}L  ${sWR}% WR`));
  });

  console.log(chalk.gray('\n  HTF bias distribution (signals that PASSED the filter):'));
  const byBias = {};
  signals.forEach(s => { byBias[s.htfBias] = (byBias[s.htfBias] || 0) + 1; });
  Object.entries(byBias).forEach(([bias, count]) => {
    console.log(chalk.gray(`    ${bias.padEnd(25)} ${count} signal${count>1?'s':''}`));
  });

  // Save report
  const reportPath = path.join(__dirname, '..', 'backtest_report_month.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    period: range.label, generatedAt: new Date().toISOString(),
    settings: { startBalance: ACCOUNT_START, riskPct: RISK_PCT*100, htfBiasFilter: true, minConfluence: MIN_SCORE },
    account: { start: ACCOUNT_START, end: parseFloat(balance.toFixed(2)), netGBP: parseFloat(totalGBP.toFixed(2)), returnPct: parseFloat(((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)), maxDrawdown: parseFloat(maxDrawdown.toFixed(1)) },
    stats: { total: signals.length, wins: wins.length, losses: losses.length, winRate: wr+'%', netR: totalR.toFixed(2), profitFactor: pf },
    signals: signals.map(s => ({ ...s, bar: undefined }))
  }, null, 2));
  console.log(chalk.gray(`\n  JSON report → backtest_report_month.json`));
  console.log('\n' + '═'.repeat(72) + '\n');
}

run().catch(err => {
  console.log(chalk.red(`\n  ✗ Fatal: ${err.message}\n`));
  process.exit(1);
});
