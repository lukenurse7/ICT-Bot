'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  DJ30 ICT — BACKTEST v3  (Judas Swing strategy)
//
//  Strategy:
//    1. Pre-NY range: highest 5m high + lowest 5m low from 07:00–13:55 UTC
//    2. Sweep window 14:00–16:00 UTC only
//    3. After sweep: MSS (BOS/CHoCH) + FVG on 5m (approximates 1m)
//    4. Entry: FVG midpoint (limit)
//    5. SL: beyond sweep candle extreme
//    6. TP: 3:1 RR (fixed)
//    7. One trade per day max
//    8. 2% compounding from £1,500
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const axios = require('axios');
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const KEY    = process.env.TWELVEDATA_API_KEY;
const BASE   = 'https://api.twelvedata.com';
const SYMBOL = 'DIA';

const ACCOUNT_START = 1500;
const RISK_PCT      = 0.02;
const TP_R          = 3.0;
const SIM_BARS      = 300; // ~25hrs of 5m bars

function fmt(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }
function fmtDT(iso) { const d = new Date(iso); return `${fmt(d)} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`; }
function fmtGBP(n) { return (n >= 0 ? '+' : '') + '£' + Math.abs(n).toFixed(2); }

function threeMonthRange() {
  const now = new Date();
  const day = now.getUTCDay();
  const daysToLastFri = day === 0 ? 1 : (day >= 6 ? day - 5 : day + 2);
  const end = new Date(now);
  end.setUTCDate(now.getUTCDate() - daysToLastFri);
  end.setUTCHours(23, 59, 59, 0);
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - 3);
  start.setUTCHours(0, 0, 0, 0);
  return { start, end, label: `${fmt(start)} → ${fmt(end)}` };
}

const CACHE_DIR = path.join(__dirname, '..', '.cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);
const wait = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(params, label) {
  const cacheFile = path.join(CACHE_DIR, `dj30_${label}.json`);
  if (fs.existsSync(cacheFile)) {
    process.stdout.write(chalk.gray(` (cached)\n`));
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      const delay = [30000,60000,90000,120000][attempt-1]||120000;
      process.stdout.write(chalk.yellow(` retry in ${delay/1000}s...\n`));
      await wait(delay);
    }
    try {
      const r = await axios.get(`${BASE}/time_series`, {
        params: { ...params, apikey: KEY, format: 'JSON', timezone: 'UTC' }, timeout: 25000
      });
      if (r.data.status === 'error') throw new Error(`TwelveData: ${r.data.message}`);
      if (!r.data.values?.length) throw new Error('No data');
      const candles = r.data.values.reverse().map(c => ({
        time: c.datetime, open: +c.open, high: +c.high, low: +c.low, close: +c.close
      }));
      fs.writeFileSync(cacheFile, JSON.stringify(candles));
      process.stdout.write(chalk.green(` ✓ ${candles.length} bars\n`));
      return candles;
    } catch(e) {
      if (e.response?.status===429||e.message.includes('429')) { lastErr=e; continue; }
      throw e;
    }
  }
  throw lastErr || new Error('Max retries');
}

async function fetchChunked(interval, outputsize, months) {
  const now = new Date(), all = [];
  for (let m = months-1; m >= 0; m--) {
    const ed = new Date(now); ed.setUTCMonth(now.getUTCMonth()-m); ed.setUTCDate(1); ed.setUTCHours(0,0,0,0);
    const sd = new Date(ed); sd.setUTCMonth(sd.getUTCMonth()-1);
    const label = `${interval}_${fmt(sd)}`;
    process.stdout.write(chalk.gray(`  ${interval} ${fmt(sd)}...`));
    try {
      all.push(...await fetchWithRetry({ symbol:SYMBOL,interval,outputsize,start_date:`${fmt(sd)} 00:00:00`,end_date:`${fmt(ed)} 23:59:59` }, label));
      await wait(8000);
    } catch(e) { process.stdout.write(chalk.yellow(` skip: ${e.message.slice(0,40)}\n`)); }
  }
  const seen = new Set();
  return all.filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;}).sort((a,b)=>new Date(a.time)-new Date(b.time));
}

// ─── Strategy logic ───────────────────────────────────────────────────────────

function getPreNYRange(candles5m, dateStr) {
  const session = candles5m.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const h = new Date(c.time).getUTCHours();
    const m = new Date(c.time).getUTCMinutes();
    const mins = h * 60 + m;
    return mins >= 7 * 60 && mins < 14 * 60;
  });
  if (session.length < 3) return null;
  return {
    high: Math.max(...session.map(c => c.high)),
    low:  Math.min(...session.map(c => c.low))
  };
}

function detectSweep(candles5m, dateStr, preNY) {
  if (!preNY) return { detected: false };
  const nyBars = candles5m.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const h = new Date(c.time).getUTCHours();
    return h >= 14 && h < 16;
  });
  for (const c of nyBars) {
    if (c.high > preNY.high && c.close < preNY.high)
      return { detected: true, dir: 'bear', level: preNY.high, sweepHigh: c.high, sweepLow: c.low, sweepClose: c.close, sweepTime: c.time, levelName: 'Pre-NY High (BSL)' };
    if (c.low < preNY.low && c.close > preNY.low)
      return { detected: true, dir: 'bull', level: preNY.low,  sweepHigh: c.high, sweepLow: c.low, sweepClose: c.close, sweepTime: c.time, levelName: 'Pre-NY Low (SSL)' };
  }
  return { detected: false };
}

function detectMSS(barsAfterSweep, sweepDir) {
  const w = barsAfterSweep.slice(0, 20);
  if (w.length < 4) return { confirmed: false };

  for (let i = 2; i < w.length; i++) {
    const last = w[i], prev = w[i-1];
    if (sweepDir === 'bear') {
      let swLow = Infinity;
      for (let j = 0; j < i - 1; j++) {
        const c = w[j];
        if (c.low < (w[j-1]?.low ?? Infinity) && c.low < (w[j+1]?.low ?? Infinity))
          swLow = Math.min(swLow, c.low);
      }
      if (swLow < Infinity && last.close < swLow)
        return { confirmed: true, type: 'BOS_DOWN', level: swLow, mssBar: i };
      if (last.close < prev.low)
        return { confirmed: true, type: 'CHoCH', level: prev.low, mssBar: i };
    }
    if (sweepDir === 'bull') {
      let swHigh = -Infinity;
      for (let j = 0; j < i - 1; j++) {
        const c = w[j];
        if (c.high > (w[j-1]?.high ?? -Infinity) && c.high > (w[j+1]?.high ?? -Infinity))
          swHigh = Math.max(swHigh, c.high);
      }
      if (swHigh > -Infinity && last.close > swHigh)
        return { confirmed: true, type: 'BOS_UP', level: swHigh, mssBar: i };
      if (last.close > prev.high)
        return { confirmed: true, type: 'CHoCH', level: prev.high, mssBar: i };
    }
  }
  return { confirmed: false };
}

function detectFVG(barsAfterSweep, sweepDir, mssBar) {
  // Look for FVG in candles up to and including the MSS bar
  const window = barsAfterSweep.slice(0, mssBar + 3);
  const gaps = [];
  for (let i = 1; i < window.length - 1; i++) {
    const prev = window[i-1], next = window[i+1];
    if (sweepDir === 'bear' && prev.low > next.high)
      gaps.push({ found: true, top: prev.low, bottom: next.high, mid: (prev.low + next.high) / 2 });
    if (sweepDir === 'bull' && prev.high < next.low)
      gaps.push({ found: true, top: next.low, bottom: prev.high, mid: (next.low + prev.high) / 2 });
  }
  if (!gaps.length) return { found: false };
  return gaps[gaps.length - 1]; // most recent FVG
}

function simulateOutcome(dir, entry, sl, tp, future) {
  for (const c of future) {
    const isLong = dir === 'bull';
    // Check if FVG was touched first (entry fill)
    const filled = isLong ? c.low <= entry : c.high >= entry;
    if (!filled) continue;
    // Once filled, check SL vs TP
    if (isLong) {
      if (c.low <= sl)  return { result: 'LOSS',   pnlR: -1 };
      if (c.high >= tp) return { result: 'WIN_TP', pnlR: TP_R };
    } else {
      if (c.high >= sl) return { result: 'LOSS',   pnlR: -1 };
      if (c.low <= tp)  return { result: 'WIN_TP', pnlR: TP_R };
    }
  }
  return { result: 'OPEN', pnlR: null };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  console.clear();
  console.log('\n' + chalk.bold.cyan('  ◆ DJ30 ICT v3 — JUDAS SWING BACKTEST  [3:1 RR · 2% compounding]'));
  console.log(chalk.gray('  Strategy: Pre-NY range → 14:00–16:00 sweep → 5m MSS + FVG → FVG limit entry\n'));

  const range = threeMonthRange();
  console.log(chalk.gray(`  Period: ${range.label}\n`));

  const all5m = await fetchChunked('5min', 4500, 4);

  console.log(chalk.green('\n  ✓ Data ready'));

  const period5m = all5m.filter(c => { const t = new Date(c.time); return t >= range.start && t <= range.end; });
  console.log(chalk.gray(`  5m bars in range: ${period5m.length}\n`));
  if (!period5m.length) { console.log(chalk.red('  No data.')); return; }

  // Get unique trading days
  const tradingDays = [...new Set(period5m.map(c => c.time.slice(0, 10)))].sort();

  const signals = [];
  let balance = ACCOUNT_START, peakBalance = ACCOUNT_START, maxDrawdown = 0;

  for (const dateStr of tradingDays) {
    const preNY = getPreNYRange(all5m, dateStr);
    if (!preNY) continue;

    const sweep = detectSweep(all5m, dateStr, preNY);
    if (!sweep.detected) continue;

    // Find bars after sweep (still within 14:00–16:00 window)
    const sweepIdx = all5m.findIndex(c => c.time === sweep.sweepTime);
    if (sweepIdx < 0) continue;

    // Only use bars that are still within 16:00 on the same day
    const barsAfterSweep = all5m.slice(sweepIdx + 1).filter(c => {
      if (!c.time.startsWith(dateStr)) return false;
      return new Date(c.time).getUTCHours() < 16;
    });

    if (barsAfterSweep.length < 4) continue;

    const mss = detectMSS(barsAfterSweep, sweep.dir);
    if (!mss.confirmed) continue;

    const fvg = detectFVG(barsAfterSweep, sweep.dir, mss.mssBar);
    if (!fvg.found) continue;

    const isLong = sweep.dir === 'bull';
    const entry  = parseFloat(fvg.mid.toFixed(2));

    // SL just beyond sweep candle extreme
    const slBuf = entry * 0.0008;
    const sl     = isLong
      ? parseFloat((sweep.sweepLow  - slBuf).toFixed(2))
      : parseFloat((sweep.sweepHigh + slBuf).toFixed(2));

    const risk = Math.abs(entry - sl);
    if (risk <= 0 || risk > entry * 0.02) continue;

    // Validate SL is on correct side
    if (isLong && sl >= entry) continue;
    if (!isLong && sl <= entry) continue;

    const tp = isLong
      ? parseFloat((entry + risk * TP_R).toFixed(2))
      : parseFloat((entry - risk * TP_R).toFixed(2));

    // Simulate from ALL bars after the MSS bar (FVG needs to be touched)
    const simStart = sweepIdx + mss.mssBar + 1;
    const future   = all5m.slice(simStart, simStart + SIM_BARS);
    const outcome  = simulateOutcome(sweep.dir, entry, sl, tp, future);

    const riskGBP = balance * RISK_PCT;
    const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;

    if (pnlGBP !== null) {
      balance += pnlGBP;
      if (balance > peakBalance) peakBalance = balance;
      const dd = ((peakBalance - balance) / peakBalance) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    signals.push({
      date: dateStr, sweepTime: sweep.sweepTime,
      dir: isLong ? 'BUY' : 'SELL',
      preNYHigh: parseFloat(preNY.high.toFixed(2)),
      preNYLow:  parseFloat(preNY.low.toFixed(2)),
      sweep: sweep.levelName, sweepLevel: sweep.level,
      mssType: mss.type, fvgMid: fvg.mid,
      entry, sl, tp,
      risk: parseFloat(risk.toFixed(2)),
      riskGBP: parseFloat(riskGBP.toFixed(2)),
      pnlGBP:  pnlGBP != null ? parseFloat(pnlGBP.toFixed(2)) : null,
      balanceAfter: pnlGBP != null ? parseFloat(balance.toFixed(2)) : null,
      ...outcome
    });
  }

  // ─── Print ────────────────────────────────────────────────────────────────
  const sep = '═'.repeat(72);
  console.log('\n' + sep);
  console.log(chalk.bold.cyan('  SIGNAL REPORT — DJ30 v3 (Judas Swing) — 3 MONTHS'));
  console.log(chalk.gray(`  ${range.label}  |  FVG limit entry  |  3:1 RR  |  2% compounding`));
  console.log(sep);

  signals.forEach((s, idx) => {
    const isLong = s.dir === 'BUY';
    const clr  = isLong ? chalk.green : chalk.red;
    const oc   = s.result === 'WIN_TP' ? chalk.green : s.result === 'LOSS' ? chalk.red : chalk.yellow;
    const pnlStr = s.pnlR != null
      ? (s.pnlR > 0 ? chalk.green(`+${s.pnlR.toFixed(1)}R  ${fmtGBP(s.pnlGBP)}`) : chalk.red(`${s.pnlR.toFixed(1)}R  -£${Math.abs(s.pnlGBP)}`))
      : chalk.yellow('open');
    console.log(`\n  #${idx+1} ${chalk.gray(s.date)}  ${clr(`${isLong?'▲':'▼'} ${s.dir}`)}  ${chalk.gray(`${s.sweep} → ${s.mssType}`)}`);
    console.log(`  Range: ${chalk.gray(`H:$${s.preNYHigh}  L:$${s.preNYLow}`)}  Swept: ${chalk.gray(`$${s.sweepLevel}`)}`);
    console.log(`  Entry ${chalk.white(`$${s.entry}`)}  SL ${chalk.red(`$${s.sl}`)}  TP ${chalk.green(`$${s.tp}`)}  Risk ${Math.round(s.risk)}pts  ${chalk.gray('£'+s.riskGBP)}`);
    console.log(`  → ${oc(s.result||'OPEN')}  ${pnlStr}${s.balanceAfter ? chalk.gray('  bal: ') + chalk.white('£'+s.balanceAfter) : ''}`);
  });

  // ─── Summary ─────────────────────────────────────────────────────────────
  const closed  = signals.filter(s => s.pnlR != null);
  const wins    = closed.filter(s => s.pnlR > 0);
  const losses  = closed.filter(s => s.pnlR < 0);
  const totalR  = closed.reduce((s, x) => s + x.pnlR, 0);
  const totalGBP= closed.reduce((s, x) => s + (x.pnlGBP||0), 0);
  const wr      = closed.length ? ((wins.length / closed.length) * 100).toFixed(0) : 0;
  const pf      = losses.length ? (wins.reduce((s,x)=>s+x.pnlR,0) / Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2) : '∞';

  const byMonth = {};
  signals.forEach(s => {
    const mk = s.date.slice(0, 7);
    byMonth[mk] = (byMonth[mk] || []).concat(s);
  });

  console.log('\n\n' + sep);
  console.log(chalk.bold.cyan('  3-MONTH SUMMARY — DJ30 v3 (Judas Swing)'));
  console.log(sep);
  console.log(chalk.gray('  Total signals:   ') + chalk.white(signals.length));
  console.log(chalk.gray('  Wins (3R):       ') + chalk.green(wins.length));
  console.log(chalk.gray('  Losses:          ') + chalk.red(losses.length));
  console.log(chalk.gray('  Win rate:        ') + (parseFloat(wr) >= 30 ? chalk.green : chalk.red)(`${wr}%`));
  console.log(chalk.gray('  Net R:           ') + (totalR >= 0 ? chalk.green(`+${totalR.toFixed(2)}R`) : chalk.red(`${totalR.toFixed(2)}R`)));
  console.log(chalk.gray('  Profit factor:   ') + chalk.cyan(pf));
  console.log('\n' + chalk.bold.cyan('  ── ACCOUNT (£1,500 · 2% compounding) ──'));
  console.log(chalk.gray('  Start:           ') + chalk.white('£1,500.00'));
  console.log(chalk.gray('  End:             ') + (balance >= ACCOUNT_START ? chalk.green : chalk.red)('£'+balance.toFixed(2)));
  console.log(chalk.gray('  Net P&L:         ') + (totalGBP >= 0 ? chalk.green : chalk.red)(fmtGBP(totalGBP)));
  console.log(chalk.gray('  Return:          ') + (balance >= ACCOUNT_START ? chalk.green : chalk.red)(`${((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)}%`));
  console.log(chalk.gray('  Peak balance:    ') + chalk.white('£'+peakBalance.toFixed(2)));
  console.log(chalk.gray('  Max drawdown:    ') + chalk.yellow(`${maxDrawdown.toFixed(1)}%`));

  console.log(chalk.gray('\n  Month by month:'));
  Object.entries(byMonth).sort().forEach(([mo, sigs]) => {
    const mW = sigs.filter(s => s.pnlR > 0).length;
    const mL = sigs.filter(s => s.pnlR < 0).length;
    const mR = sigs.reduce((s, x) => s + (x.pnlR||0), 0);
    const mGBP = sigs.reduce((s, x) => s + (x.pnlGBP||0), 0);
    const mWR = (mW+mL) > 0 ? Math.round(mW/(mW+mL)*100) : 0;
    console.log(
      chalk.gray(`    ${mo}  `) + chalk.white(`${sigs.length} signals`) +
      chalk.gray('  ') + chalk.green(`${mW}W`) + chalk.gray('/') + chalk.red(`${mL}L`) +
      chalk.gray(`  ${mWR}% WR  `) +
      (mR >= 0 ? chalk.green(`+${mR.toFixed(1)}R`) : chalk.red(`${mR.toFixed(1)}R`)) +
      chalk.gray('  ') + (mGBP >= 0 ? chalk.green(fmtGBP(mGBP)) : chalk.red(fmtGBP(mGBP)))
    );
  });

  console.log(chalk.gray('\n  Note: DIA (~$490) used as DJ30 proxy. Levels are DIA prices, not DJ30 points.'));

  const reportPath = path.join(__dirname, '..', 'backtest_report_dj30_v3.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    period: range.label, generatedAt: new Date().toISOString(),
    settings: { symbol: 'DJ30/DIA', strategy: 'Judas Swing', entryMethod: 'fvg_midpoint_limit', rrTarget: TP_R, startBalance: ACCOUNT_START, riskPct: RISK_PCT * 100, compounding: true },
    account: { start: ACCOUNT_START, end: parseFloat(balance.toFixed(2)), netGBP: parseFloat(totalGBP.toFixed(2)), returnPct: parseFloat(((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)), peakBalance: parseFloat(peakBalance.toFixed(2)), maxDrawdown: parseFloat(maxDrawdown.toFixed(1)) },
    stats: { total: signals.length, wins: wins.length, losses: losses.length, winRate: wr+'%', netR: totalR.toFixed(2), profitFactor: pf },
    signals
  }, null, 2));

  console.log(chalk.gray('\n  Report → backtest_report_dj30_v3.json'));
  console.log('\n' + sep + '\n');
}

run().catch(e => { console.log(chalk.red(`\n  ✗ ${e.message}\n`)); process.exit(1); });
