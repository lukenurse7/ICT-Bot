'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  DJ30 ICT — BACKTEST v4  (Yahoo Finance real DJ30 data)
//
//  Strategy: Judas Swing
//    1. Pre-NY range: highest 5m high + lowest 5m low from 07:00–13:55 UTC
//    2. Sweep window 14:00–16:00 UTC only
//    3. After sweep: MSS (BOS/CHoCH) + FVG on 5m
//    4. Entry: FVG midpoint (limit)
//    5. SL: beyond sweep candle extreme + buffer
//    6. TP: 3:1 RR (fixed)
//    7. One trade per day max
//    8. 2% compounding from £1,500
//
//  Data: Yahoo Finance ^DJI 5m (~60 days free, real DJ30 prices ~50,000pts)
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const axios = require('axios');
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const ACCOUNT_START = 1500;
const RISK_PCT      = 0.02;
const TP_R          = 3.0;
const SIM_BARS      = 300;

function fmt(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }
function fmtDT(iso) { const d = new Date(iso); return `${fmt(d)} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`; }
function fmtGBP(n) { return (n >= 0 ? '+' : '-') + '£' + Math.abs(n).toFixed(2); }

const CACHE_DIR = path.join(__dirname, '..', '.cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);
const wait = ms => new Promise(r => setTimeout(r, ms));

async function fetchYahooDJ30() {
  const cacheFile = path.join(CACHE_DIR, 'yahoo_dji_5m.json');
  // Cache for 1 hour only (fresh data matters)
  const cacheAge = fs.existsSync(cacheFile)
    ? (Date.now() - fs.statSync(cacheFile).mtimeMs) / 1000 / 60
    : Infinity;

  if (cacheAge < 60) {
    process.stdout.write(chalk.gray(' (cached)\n'));
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }

  process.stdout.write(chalk.gray(' fetching...'));
  const r = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5EDJI', {
    params: { interval: '5m', range: '60d' },
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 20000
  });

  const result = r.data.chart.result[0];
  const timestamps = result.timestamp;
  const quotes = result.indicators.quote[0];

  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (quotes.open[i] == null) continue;
    candles.push({
      time:  new Date(timestamps[i] * 1000).toISOString().slice(0, 16).replace('T', ' '),
      open:  quotes.open[i],
      high:  quotes.high[i],
      low:   quotes.low[i],
      close: quotes.close[i]
    });
  }

  fs.writeFileSync(cacheFile, JSON.stringify(candles));
  process.stdout.write(chalk.green(` ✓ ${candles.length} bars (${candles[0].time.slice(0,10)} → ${candles[candles.length-1].time.slice(0,10)})\n`));
  return candles;
}

// ─── Strategy logic ───────────────────────────────────────────────────────────

function getPreNYRange(candles, dateStr) {
  const session = candles.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const h = parseInt(c.time.slice(11, 13));
    const m = parseInt(c.time.slice(14, 16));
    const mins = h * 60 + m;
    return mins >= 7 * 60 && mins < 14 * 60;
  });
  if (session.length < 3) return null;
  return {
    high:    Math.max(...session.map(c => c.high)),
    low:     Math.min(...session.map(c => c.low)),
    candles: session.length
  };
}

function detectSweep(candles, dateStr, preNY) {
  if (!preNY) return { detected: false };
  const nyBars = candles.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const h = parseInt(c.time.slice(11, 13));
    return h >= 14 && h < 16;
  });
  for (const c of nyBars) {
    if (c.high > preNY.high && c.close < preNY.high)
      return { detected: true, dir: 'bear', level: preNY.high, sweepHigh: c.high, sweepLow: c.low, sweepTime: c.time, levelName: 'Pre-NY High (BSL)' };
    if (c.low < preNY.low && c.close > preNY.low)
      return { detected: true, dir: 'bull', level: preNY.low, sweepHigh: c.high, sweepLow: c.low, sweepTime: c.time, levelName: 'Pre-NY Low (SSL)' };
  }
  return { detected: false };
}

function detectMSS(bars, sweepDir) {
  const w = bars.slice(0, 25);
  if (w.length < 4) return { confirmed: false };

  for (let i = 2; i < w.length; i++) {
    const last = w[i], prev = w[i-1];

    if (sweepDir === 'bear') {
      let swLow = Infinity;
      for (let j = 1; j < i - 1; j++) {
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
      for (let j = 1; j < i - 1; j++) {
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

function detectFVG(bars, sweepDir, mssBar) {
  const window = bars.slice(0, Math.min(mssBar + 4, bars.length));
  const gaps = [];
  for (let i = 1; i < window.length - 1; i++) {
    const prev = window[i-1], next = window[i+1];
    if (sweepDir === 'bear' && prev.low > next.high)
      gaps.push({ found: true, top: prev.low, bottom: next.high, mid: (prev.low + next.high) / 2 });
    if (sweepDir === 'bull' && prev.high < next.low)
      gaps.push({ found: true, top: next.low, bottom: prev.high, mid: (next.low + prev.high) / 2 });
  }
  if (!gaps.length) return { found: false };
  return gaps[gaps.length - 1];
}

function simulateOutcome(dir, entry, sl, tp, future) {
  let filled = false;
  for (const c of future) {
    const isLong = dir === 'bull';
    if (!filled) {
      // Wait for FVG to be touched (limit entry)
      if (isLong  && c.low  <= entry) filled = true;
      if (!isLong && c.high >= entry) filled = true;
      if (!filled) continue;
    }
    // Once filled, check SL vs TP on same and subsequent bars
    if (isLong) {
      if (c.low  <= sl) return { result: 'LOSS',   pnlR: -1 };
      if (c.high >= tp) return { result: 'WIN_TP', pnlR: TP_R };
    } else {
      if (c.high >= sl) return { result: 'LOSS',   pnlR: -1 };
      if (c.low  <= tp) return { result: 'WIN_TP', pnlR: TP_R };
    }
  }
  if (filled) return { result: 'OPEN_FILLED', pnlR: null };
  return { result: 'NO_FILL', pnlR: null };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  console.clear();
  console.log('\n' + chalk.bold.cyan('  ◆ DJ30 ICT v4 — JUDAS SWING  [Yahoo Finance real data · 3:1 RR]'));
  console.log(chalk.gray('  Pre-NY range → 14:00–16:00 sweep → MSS + FVG → limit entry → 3:1 RR\n'));

  process.stdout.write(chalk.gray('  Fetching ^DJI 5m data...'));
  const allCandles = await fetchYahooDJ30();

  const tradingDays = [...new Set(allCandles.map(c => c.time.slice(0, 10)))].sort();
  console.log(chalk.gray(`  Trading days: ${tradingDays.length}  (${tradingDays[0]} → ${tradingDays[tradingDays.length-1]})\n`));

  const signals = [];
  let balance = ACCOUNT_START, peakBalance = ACCOUNT_START, maxDrawdown = 0;
  let noRange = 0, noSweep = 0, noMSS = 0, noFVG = 0;

  for (const dateStr of tradingDays) {
    const preNY = getPreNYRange(allCandles, dateStr);
    if (!preNY) { noRange++; continue; }

    const sweep = detectSweep(allCandles, dateStr, preNY);
    if (!sweep.detected) { noSweep++; continue; }

    const sweepIdx = allCandles.findIndex(c => c.time === sweep.sweepTime);
    if (sweepIdx < 0) continue;

    // Bars after sweep, still within 16:00 on same day
    const barsAfterSweep = allCandles.slice(sweepIdx + 1).filter(c => {
      if (!c.time.startsWith(dateStr)) return false;
      return parseInt(c.time.slice(11, 13)) < 16;
    });
    if (barsAfterSweep.length < 4) { noMSS++; continue; }

    const mss = detectMSS(barsAfterSweep, sweep.dir);
    if (!mss.confirmed) { noMSS++; continue; }

    const fvg = detectFVG(barsAfterSweep, sweep.dir, mss.mssBar);
    if (!fvg.found) { noFVG++; continue; }

    const isLong = sweep.dir === 'bull';
    const entry  = parseFloat(fvg.mid.toFixed(1));
    const slBuf  = entry * 0.0005;
    const sl     = isLong
      ? parseFloat((sweep.sweepLow  - slBuf).toFixed(1))
      : parseFloat((sweep.sweepHigh + slBuf).toFixed(1));

    const risk = Math.abs(entry - sl);
    if (risk <= 0 || risk > entry * 0.02) continue;
    if (isLong  && sl >= entry) continue;
    if (!isLong && sl <= entry) continue;
    // Minimum 50pts stop (DJ30 noise filter)
    if (risk < 50) continue;

    const tp = isLong
      ? parseFloat((entry + risk * TP_R).toFixed(1))
      : parseFloat((entry - risk * TP_R).toFixed(1));

    const simStart = sweepIdx + mss.mssBar + 1;
    const future   = allCandles.slice(simStart, simStart + SIM_BARS);
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
      preNYHigh: Math.round(preNY.high), preNYLow: Math.round(preNY.low),
      sweep: sweep.levelName, sweepLevel: Math.round(sweep.level),
      mssType: mss.type, fvgMid: Math.round(fvg.mid),
      entry, sl, tp,
      risk: Math.round(risk),
      riskGBP: parseFloat(riskGBP.toFixed(2)),
      pnlGBP:  pnlGBP != null ? parseFloat(pnlGBP.toFixed(2)) : null,
      balanceAfter: pnlGBP != null ? parseFloat(balance.toFixed(2)) : null,
      ...outcome
    });
  }

  // ─── Print ────────────────────────────────────────────────────────────────
  const sep = '═'.repeat(72);
  console.log(sep);
  console.log(chalk.bold.cyan('  SIGNAL REPORT — DJ30 Judas Swing — Real Data'));
  console.log(sep);

  signals.forEach((s, idx) => {
    const isLong = s.dir === 'BUY';
    const clr = isLong ? chalk.green : chalk.red;
    const oc  = s.result === 'WIN_TP' ? chalk.green : s.result === 'LOSS' ? chalk.red : chalk.yellow;
    const pnlStr = s.pnlR != null
      ? (s.pnlR > 0 ? chalk.green(`+${s.pnlR.toFixed(1)}R  ${fmtGBP(s.pnlGBP)}`) : chalk.red(`-1.0R  ${fmtGBP(s.pnlGBP)}`))
      : chalk.yellow(s.result);
    console.log(`\n  #${idx+1} ${chalk.gray(s.date)}  ${clr(`${isLong?'▲':'▼'} ${s.dir}`)}  ${chalk.gray(`${s.sweep} → ${s.mssType}`)}`);
    console.log(`  Range H:${s.preNYHigh}  L:${s.preNYLow}  Swept: ${s.sweepLevel}pts`);
    console.log(`  Entry ${chalk.white(s.entry)}  SL ${chalk.red(s.sl)}  TP ${chalk.green(s.tp)}  Risk ${s.risk}pts  ${chalk.gray('£'+s.riskGBP)}`);
    console.log(`  → ${oc(s.result||'?')}  ${pnlStr}${s.balanceAfter ? chalk.gray('  bal: ') + chalk.white('£'+s.balanceAfter) : ''}`);
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
  signals.forEach(s => { const mk = s.date.slice(0,7); byMonth[mk] = (byMonth[mk]||[]).concat(s); });

  console.log('\n\n' + sep);
  console.log(chalk.bold.cyan('  SUMMARY — DJ30 Judas Swing (Real ^DJI Data)'));
  console.log(sep);
  console.log(chalk.gray('  Filter stats:'));
  console.log(chalk.gray(`    No pre-NY range:  ${noRange} days`));
  console.log(chalk.gray(`    No sweep 14-16:   ${noSweep} days`));
  console.log(chalk.gray(`    No MSS after:     ${noMSS} days`));
  console.log(chalk.gray(`    No FVG found:     ${noFVG} days`));
  console.log(chalk.gray(`    Signals fired:    ${signals.length} days`));
  console.log('');
  console.log(chalk.gray('  Total signals:   ') + chalk.white(signals.length));
  console.log(chalk.gray('  Wins (3R):       ') + chalk.green(wins.length));
  console.log(chalk.gray('  Losses:          ') + chalk.red(losses.length));
  console.log(chalk.gray('  Open/no fill:    ') + chalk.yellow(signals.length - closed.length));
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
    const mR = sigs.reduce((s,x) => s+(x.pnlR||0), 0);
    const mGBP = sigs.reduce((s,x) => s+(x.pnlGBP||0), 0);
    const mWR = (mW+mL)>0 ? Math.round(mW/(mW+mL)*100) : 0;
    console.log(
      chalk.gray(`    ${mo}  `) + chalk.white(`${sigs.length} signals`) +
      chalk.gray('  ') + chalk.green(`${mW}W`) + chalk.gray('/') + chalk.red(`${mL}L`) +
      chalk.gray(`  ${mWR}% WR  `) +
      (mR>=0 ? chalk.green(`+${mR.toFixed(1)}R`) : chalk.red(`${mR.toFixed(1)}R`)) +
      chalk.gray('  ') + (mGBP>=0 ? chalk.green(fmtGBP(mGBP)) : chalk.red(fmtGBP(mGBP)))
    );
  });

  const reportPath = path.join(__dirname, '..', 'backtest_report_dj30_yahoo.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    period: `${tradingDays[0]} → ${tradingDays[tradingDays.length-1]}`,
    generatedAt: new Date().toISOString(),
    dataSource: 'Yahoo Finance ^DJI 5m',
    settings: { strategy: 'Judas Swing', rrTarget: TP_R, minStopPts: 50, startBalance: ACCOUNT_START, riskPct: RISK_PCT*100 },
    account: { start: ACCOUNT_START, end: parseFloat(balance.toFixed(2)), netGBP: parseFloat(totalGBP.toFixed(2)), returnPct: parseFloat(((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)), peakBalance: parseFloat(peakBalance.toFixed(2)), maxDrawdown: parseFloat(maxDrawdown.toFixed(1)) },
    stats: { total: signals.length, wins: wins.length, losses: losses.length, winRate: wr+'%', netR: totalR.toFixed(2), profitFactor: pf },
    signals
  }, null, 2));

  console.log(chalk.gray('\n  Report → backtest_report_dj30_yahoo.json'));
  console.log('\n' + sep + '\n');
}

run().catch(e => { console.log(chalk.red(`\n  ✗ ${e.message}\n`)); process.exit(1); });
