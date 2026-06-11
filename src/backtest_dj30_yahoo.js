'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  DJ30 ICT — Judas Swing (ICT 90-day checklist)
//  Data: Yahoo Finance YM=F (Dow futures, 24hr, free)
//
//  Checklist:
//    1. Mark 5m swing highs (BSL) + swing lows (SSL) before 9:30 AM NY
//       = before 13:30 UTC (EDT) using London session data 07:00-13:25 UTC
//    2. Window: 9:30–11:00 AM NY = 13:30–15:00 UTC (EDT summer)
//    3. Sweep: wick beyond BSL/SSL, close back inside
//    4. After sweep: MSS (BOS/CHoCH) with displacement candle
//    5. Displacement must create a FVG (no FVG = no trade)
//    6. Entry: limit just inside the FVG
//    7. SL: just beyond the MSS swing point
//    8. TP: opposing liquidity (SSL if BSL swept, BSL if SSL swept)
//    9. One trade per day max
//   10. 2% compounding from £1,500
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const axios = require('axios');
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const ACCOUNT_START = 1500;
const RISK_PCT      = 0.02;
const SIM_BARS      = 400;
const SL_BUF_PCT    = 0.0003;
const MIN_STOP_PTS  = 30;   // minimum 30pt stop to filter noise
const MIN_FVG_PTS   = 5;    // minimum FVG size

function fmt(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }
function fmtGBP(n) { return (n >= 0 ? '+' : '-') + '£' + Math.abs(n).toFixed(2); }

const CACHE_DIR = path.join(__dirname, '..', '.cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

async function fetchYMFutures() {
  const cacheFile = path.join(CACHE_DIR, 'yahoo_ymf_5m.json');
  const cacheAge  = fs.existsSync(cacheFile)
    ? (Date.now() - fs.statSync(cacheFile).mtimeMs) / 60000
    : Infinity;

  if (cacheAge < 60) {
    process.stdout.write(chalk.gray(' (cached)\n'));
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }

  process.stdout.write(chalk.gray(' fetching YM=F...'));
  const r = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/YM%3DF', {
    params: { interval: '5m', range: '60d' },
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 20000
  });

  const result = r.data.chart.result[0];
  const candles = result.timestamp.map((ts, i) => ({
    time:  new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' '),
    open:  result.indicators.quote[0].open[i],
    high:  result.indicators.quote[0].high[i],
    low:   result.indicators.quote[0].low[i],
    close: result.indicators.quote[0].close[i]
  })).filter(c => c.open != null);

  fs.writeFileSync(cacheFile, JSON.stringify(candles));
  process.stdout.write(chalk.green(` ✓ ${candles.length} bars (${candles[0].time.slice(0,10)} → ${candles[candles.length-1].time.slice(0,10)})\n`));
  return candles;
}

// NYSE opens at 13:30 UTC (EDT/summer) or 14:30 UTC (EST/winter)
function nyOpenUTC(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const yr = d.getUTCFullYear();
  const dstStart = new Date(yr, 2, 1); dstStart.setDate(1 + (7 - dstStart.getDay()) % 7 + 7);
  const dstEnd   = new Date(yr, 10, 1); dstEnd.setDate(1 + (7 - dstEnd.getDay()) % 7);
  return (d >= dstStart && d < dstEnd) ? 13 * 60 + 30 : 14 * 60 + 30;
}

function minsUTC(timeStr) {
  return parseInt(timeStr.slice(11,13)) * 60 + parseInt(timeStr.slice(14,16));
}

const MIN_RANGE_PTS = 200; // BSL-SSL must be at least 200pts for meaningful TP distance

// ─── Step 1: 5m swing H/L from London session (07:00–NY open) ────────────────
function getPreNYLevels(candles, dateStr, nyOpenMins) {
  const session = candles.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const m = minsUTC(c.time);
    return m >= 7 * 60 && m < nyOpenMins;
  });
  if (session.length < 5) return null;

  // 5m swing highs (BSL) and swing lows (SSL)
  const swingHighs = [], swingLows = [];
  for (let i = 2; i < session.length - 2; i++) {
    const c = session[i];
    if (c.high > session[i-1].high && c.high > session[i-2].high &&
        c.high > session[i+1].high && c.high > session[i+2].high)
      swingHighs.push(c.high);
    if (c.low < session[i-1].low && c.low < session[i-2].low &&
        c.low < session[i+1].low && c.low < session[i+2].low)
      swingLows.push(c.low);
  }

  // Fall back to session H/L if no clear swing points
  const bsl = swingHighs.length ? Math.max(...swingHighs) : Math.max(...session.map(c => c.high));
  const ssl = swingLows.length  ? Math.min(...swingLows)  : Math.min(...session.map(c => c.low));

  if (bsl <= ssl) return null;
  if (bsl - ssl < MIN_RANGE_PTS) return null; // skip days with tiny range
  return { bsl, ssl, sessionBars: session.length, rangePts: Math.round(bsl - ssl) };
}

// ─── Step 2: detect sweep in NY window (13:30–15:00 UTC) ─────────────────────
function detectSweep(candles, dateStr, nyOpenMins, levels) {
  if (!levels) return { detected: false };
  const windowEnd = nyOpenMins + 90; // 9:30–11:00 AM NY
  const nyBars = candles.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const m = minsUTC(c.time);
    return m >= nyOpenMins && m < windowEnd;
  });

  for (const c of nyBars) {
    if (c.high > levels.bsl && c.close < levels.bsl)
      return { detected: true, dir: 'bear', sweptLevel: levels.bsl, targetLevel: levels.ssl,
               sweepHigh: c.high, sweepLow: c.low, sweepTime: c.time, levelName: 'BSL swept → target SSL' };
    if (c.low < levels.ssl && c.close > levels.ssl)
      return { detected: true, dir: 'bull', sweptLevel: levels.ssl, targetLevel: levels.bsl,
               sweepHigh: c.high, sweepLow: c.low, sweepTime: c.time, levelName: 'SSL swept → target BSL' };
  }
  return { detected: false };
}

// ─── Step 3: MSS with displacement ───────────────────────────────────────────
function detectMSS(bars, sweepDir) {
  if (bars.length < 4) return { confirmed: false };
  for (let i = 2; i < Math.min(bars.length, 30); i++) {
    const last = bars[i], prev = bars[i-1];
    if (sweepDir === 'bear') {
      let swingLow = Infinity;
      for (let j = 1; j < i - 1; j++)
        if (bars[j].low < (bars[j-1]?.low ?? Infinity) && bars[j].low < (bars[j+1]?.low ?? Infinity))
          swingLow = Math.min(swingLow, bars[j].low);
      if (swingLow < Infinity && last.close < swingLow)
        return { confirmed: true, type: 'BOS_DOWN', mssLevel: swingLow, mssBar: i };
      if (last.close < prev.low)
        return { confirmed: true, type: 'CHoCH', mssLevel: prev.low, mssBar: i };
    }
    if (sweepDir === 'bull') {
      let swingHigh = -Infinity;
      for (let j = 1; j < i - 1; j++)
        if (bars[j].high > (bars[j-1]?.high ?? -Infinity) && bars[j].high > (bars[j+1]?.high ?? -Infinity))
          swingHigh = Math.max(swingHigh, bars[j].high);
      if (swingHigh > -Infinity && last.close > swingHigh)
        return { confirmed: true, type: 'BOS_UP', mssLevel: swingHigh, mssBar: i };
      if (last.close > prev.high)
        return { confirmed: true, type: 'CHoCH', mssLevel: prev.high, mssBar: i };
    }
  }
  return { confirmed: false };
}

// ─── Step 4: FVG within displacement ─────────────────────────────────────────
function detectFVG(bars, sweepDir, mssBar) {
  const window = bars.slice(0, Math.min(mssBar + 4, bars.length));
  const gaps = [];
  for (let i = 1; i < window.length - 1; i++) {
    const prev = window[i-1], next = window[i+1];
    if (sweepDir === 'bear' && prev.low > next.high && (prev.low - next.high) >= MIN_FVG_PTS)
      gaps.push({ found: true, top: prev.low, bottom: next.high, mid: (prev.low + next.high) / 2 });
    if (sweepDir === 'bull' && prev.high < next.low && (next.low - prev.high) >= MIN_FVG_PTS)
      gaps.push({ found: true, top: next.low, bottom: prev.high, mid: (next.low + prev.high) / 2 });
  }
  if (!gaps.length) return { found: false };
  return gaps[gaps.length - 1];
}

// ─── Simulate outcome ─────────────────────────────────────────────────────────
function simulate(dir, entry, sl, tp, future) {
  let filled = false;
  for (const c of future) {
    const isLong = dir === 'bull';
    if (!filled) {
      if (isLong  && c.low  <= entry) filled = true;
      if (!isLong && c.high >= entry) filled = true;
      if (!filled) continue;
    }
    if (isLong) {
      if (c.low  <= sl) return { result: 'LOSS', pnlR: -1 };
      if (c.high >= tp) return { result: 'WIN',  pnlR: parseFloat(((tp - entry) / (entry - sl)).toFixed(2)) };
    } else {
      if (c.high >= sl) return { result: 'LOSS', pnlR: -1 };
      if (c.low  <= tp) return { result: 'WIN',  pnlR: parseFloat(((entry - tp) / (sl - entry)).toFixed(2)) };
    }
  }
  return { result: filled ? 'OPEN' : 'NO_FILL', pnlR: null };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  console.clear();
  console.log('\n' + chalk.bold.cyan('  ◆ DJ30 Judas Swing — ICT Checklist (YM Futures, real 24hr data)'));
  console.log(chalk.gray('  London 5m swing H/L → NY open sweep → MSS + FVG → limit → opposing liquidity TP\n'));

  process.stdout.write(chalk.gray('  YM=F 5m data...'));
  const allCandles = await fetchYMFutures();

  const tradingDays = [...new Set(
    allCandles.filter(c => {
      const h = minsUTC(c.time) / 60;
      return h >= 13; // only count days that have NY session data
    }).map(c => c.time.slice(0, 10))
  )].sort();

  console.log(chalk.gray(`  ${tradingDays.length} trading days with NY session: ${tradingDays[0]} → ${tradingDays[tradingDays.length-1]}\n`));

  const signals = [];
  let balance = ACCOUNT_START, peakBalance = ACCOUNT_START, maxDrawdown = 0;
  let stats = { noLevels: 0, noSweep: 0, noMSS: 0, noFVG: 0, riskFail: 0 };

  for (const dateStr of tradingDays) {
    const nyMins = nyOpenUTC(dateStr);

    const levels = getPreNYLevels(allCandles, dateStr, nyMins);
    if (!levels) { stats.noLevels++; continue; }

    const sweep = detectSweep(allCandles, dateStr, nyMins, levels);
    if (!sweep.detected) { stats.noSweep++; continue; }

    const sweepIdx = allCandles.findIndex(c => c.time === sweep.sweepTime);
    if (sweepIdx < 0) continue;

    const windowEnd = nyMins + 90;
    const postSweep = allCandles.slice(sweepIdx + 1).filter(c => {
      if (!c.time.startsWith(dateStr)) return false;
      return minsUTC(c.time) < windowEnd;
    });
    if (postSweep.length < 4) { stats.noMSS++; continue; }

    const mss = detectMSS(postSweep, sweep.dir);
    if (!mss.confirmed) { stats.noMSS++; continue; }

    const fvg = detectFVG(postSweep, sweep.dir, mss.mssBar);
    if (!fvg.found) { stats.noFVG++; continue; }

    const isLong = sweep.dir === 'bull';
    const entry = isLong
      ? parseFloat((fvg.bottom + (fvg.top - fvg.bottom) * 0.25).toFixed(1))
      : parseFloat((fvg.top    - (fvg.top - fvg.bottom) * 0.25).toFixed(1));

    const sl = isLong
      ? parseFloat((mss.mssLevel * (1 - SL_BUF_PCT)).toFixed(1))
      : parseFloat((mss.mssLevel * (1 + SL_BUF_PCT)).toFixed(1));

    const tp = parseFloat(sweep.targetLevel.toFixed(1));
    const risk = Math.abs(entry - sl);

    if (risk < MIN_STOP_PTS || risk > entry * 0.025)       { stats.riskFail++; continue; }
    if (isLong  && (sl >= entry || tp <= entry))            { stats.riskFail++; continue; }
    if (!isLong && (sl <= entry || tp >= entry))            { stats.riskFail++; continue; }

    const rrPotential = parseFloat((Math.abs(tp - entry) / risk).toFixed(2));

    const simStart = sweepIdx + mss.mssBar + 1;
    const future   = allCandles.slice(simStart, simStart + SIM_BARS);
    const outcome  = simulate(sweep.dir, entry, sl, tp, future);

    const riskGBP = balance * RISK_PCT;
    const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;

    if (pnlGBP !== null) {
      balance += pnlGBP;
      if (balance > peakBalance) peakBalance = balance;
      const dd = ((peakBalance - balance) / peakBalance) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    signals.push({
      date: dateStr, dir: isLong ? 'BUY' : 'SELL',
      levels: { bsl: Math.round(levels.bsl), ssl: Math.round(levels.ssl) },
      sweep: sweep.levelName, sweptLevel: Math.round(sweep.sweptLevel), targetLevel: Math.round(sweep.targetLevel),
      mssType: mss.type, fvgSize: Math.round(fvg.top - fvg.bottom),
      entry, sl, tp, risk: Math.round(risk), rrPotential,
      riskGBP: parseFloat(riskGBP.toFixed(2)),
      pnlGBP:  pnlGBP != null ? parseFloat(pnlGBP.toFixed(2)) : null,
      balanceAfter: pnlGBP != null ? parseFloat(balance.toFixed(2)) : null,
      ...outcome
    });
  }

  // ─── Print report ─────────────────────────────────────────────────────────
  const sep = '═'.repeat(72);
  console.log(sep);
  console.log(chalk.bold.cyan('  SIGNAL REPORT — DJ30 Judas Swing (YM Futures · ICT Checklist)'));
  console.log(sep);

  signals.forEach((s, idx) => {
    const isLong = s.dir === 'BUY';
    const clr = isLong ? chalk.green : chalk.red;
    const oc  = s.result === 'WIN' ? chalk.green : s.result === 'LOSS' ? chalk.red : chalk.yellow;
    const pnlStr = s.pnlR != null
      ? (s.pnlR > 0 ? chalk.green(`+${s.pnlR.toFixed(2)}R  ${fmtGBP(s.pnlGBP)}`) : chalk.red(`-1.0R  ${fmtGBP(s.pnlGBP)}`))
      : chalk.yellow(s.result);

    console.log(`\n  #${idx+1} ${chalk.gray(s.date)}  ${clr(`${isLong?'▲':'▼'} ${s.dir}`)}  ${chalk.gray(s.sweep)}`);
    console.log(`  BSL:${s.levels.bsl}  SSL:${s.levels.ssl}  Swept:${s.sweptLevel}  Target:${s.targetLevel}`);
    console.log(`  Entry ${chalk.white(s.entry)}  SL ${chalk.red(s.sl)}  TP ${chalk.green(s.tp)}  Risk ${s.risk}pts  Pot. ${chalk.cyan(s.rrPotential+'R')}  ${chalk.gray('£'+s.riskGBP)}`);
    console.log(`  MSS: ${chalk.gray(s.mssType)}  FVG: ${s.fvgSize}pts  → ${oc(s.result)}  ${pnlStr}${s.balanceAfter ? chalk.gray('  bal: ') + '£'+s.balanceAfter : ''}`);
  });

  // ─── Summary ─────────────────────────────────────────────────────────────
  const closed   = signals.filter(s => s.pnlR != null);
  const wins     = closed.filter(s => s.pnlR > 0);
  const losses   = closed.filter(s => s.pnlR < 0);
  const totalR   = closed.reduce((s, x) => s + x.pnlR, 0);
  const totalGBP = closed.reduce((s, x) => s + (x.pnlGBP||0), 0);
  const wr       = closed.length ? ((wins.length / closed.length) * 100).toFixed(0) : 0;
  const avgWinR  = wins.length ? (wins.reduce((s,x)=>s+x.pnlR,0)/wins.length).toFixed(2) : '0';
  const pf       = losses.length
    ? (wins.reduce((s,x)=>s+x.pnlR,0) / Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2)
    : wins.length ? '∞' : '0';

  const byMonth = {};
  signals.forEach(s => { const mk = s.date.slice(0,7); byMonth[mk] = (byMonth[mk]||[]).concat(s); });

  console.log('\n\n' + sep);
  console.log(chalk.bold.cyan('  SUMMARY — DJ30 Judas Swing (YM Futures)'));
  console.log(sep);
  console.log(chalk.gray('  Filter funnel:'));
  console.log(chalk.gray(`    Trading days:        ${tradingDays.length}`));
  console.log(chalk.gray(`    No London levels:    ${stats.noLevels}`));
  console.log(chalk.gray(`    No sweep 13:30-15:00:${stats.noSweep}`));
  console.log(chalk.gray(`    No MSS after sweep:  ${stats.noMSS}`));
  console.log(chalk.gray(`    No FVG found:        ${stats.noFVG}`));
  console.log(chalk.gray(`    Risk check fail:     ${stats.riskFail}`));
  console.log(chalk.gray(`    Signals fired:       ${signals.length}`));
  console.log('');
  console.log(chalk.gray('  Signals:         ') + chalk.white(signals.length));
  console.log(chalk.gray('  Wins:            ') + chalk.green(wins.length));
  console.log(chalk.gray('  Losses:          ') + chalk.red(losses.length));
  console.log(chalk.gray('  Open/no fill:    ') + chalk.yellow(signals.length - closed.length));
  console.log(chalk.gray('  Win rate:        ') + (parseFloat(wr)>=30?chalk.green:chalk.red)(`${wr}%`));
  console.log(chalk.gray('  Avg win R:       ') + chalk.cyan(avgWinR + 'R  (dynamic — opposing liquidity TP)'));
  console.log(chalk.gray('  Net R:           ') + (totalR>=0?chalk.green(`+${totalR.toFixed(2)}R`):chalk.red(`${totalR.toFixed(2)}R`)));
  console.log(chalk.gray('  Profit factor:   ') + chalk.cyan(pf));
  console.log('\n' + chalk.bold.cyan('  ── ACCOUNT (£1,500 · 2% compounding) ──'));
  console.log(chalk.gray('  Start:           ') + '£1,500.00');
  console.log(chalk.gray('  End:             ') + (balance>=ACCOUNT_START?chalk.green:chalk.red)('£'+balance.toFixed(2)));
  console.log(chalk.gray('  Net P&L:         ') + (totalGBP>=0?chalk.green:chalk.red)(fmtGBP(totalGBP)));
  console.log(chalk.gray('  Return:          ') + (balance>=ACCOUNT_START?chalk.green:chalk.red)(`${((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)}%`));
  console.log(chalk.gray('  Peak balance:    ') + '£'+peakBalance.toFixed(2));
  console.log(chalk.gray('  Max drawdown:    ') + chalk.yellow(`${maxDrawdown.toFixed(1)}%`));

  console.log(chalk.gray('\n  Month by month:'));
  Object.entries(byMonth).sort().forEach(([mo, sigs]) => {
    const mW = sigs.filter(s=>s.pnlR>0).length, mL = sigs.filter(s=>s.pnlR<0).length;
    const mR = sigs.reduce((s,x)=>s+(x.pnlR||0),0);
    const mGBP = sigs.reduce((s,x)=>s+(x.pnlGBP||0),0);
    const mWR = (mW+mL)>0?Math.round(mW/(mW+mL)*100):0;
    console.log(
      chalk.gray(`    ${mo}  `)+chalk.white(`${sigs.length} signals`)+chalk.gray('  ')+
      chalk.green(`${mW}W`)+chalk.gray('/')+chalk.red(`${mL}L`)+
      chalk.gray(`  ${mWR}% WR  `)+(mR>=0?chalk.green(`+${mR.toFixed(2)}R`):chalk.red(`${mR.toFixed(2)}R`))+
      chalk.gray('  ')+(mGBP>=0?chalk.green(fmtGBP(mGBP)):chalk.red(fmtGBP(mGBP)))
    );
  });

  const reportPath = path.join(__dirname, '..', 'backtest_report_dj30_yahoo.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    period: `${tradingDays[0]} → ${tradingDays[tradingDays.length-1]}`,
    generatedAt: new Date().toISOString(),
    dataSource: 'Yahoo Finance YM=F (Dow futures, 24hr)',
    strategy: 'ICT Judas Swing — 90-day checklist',
    account: { start: ACCOUNT_START, end: parseFloat(balance.toFixed(2)), netGBP: parseFloat(totalGBP.toFixed(2)), returnPct: parseFloat(((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)), peakBalance: parseFloat(peakBalance.toFixed(2)), maxDrawdown: parseFloat(maxDrawdown.toFixed(1)) },
    stats: { total: signals.length, wins: wins.length, losses: losses.length, winRate: wr+'%', avgWinR, netR: totalR.toFixed(2), profitFactor: pf },
    signals
  }, null, 2));

  console.log(chalk.gray('\n  Report → backtest_report_dj30_yahoo.json'));
  console.log('\n' + sep + '\n');
}

run().catch(e => { console.log(chalk.red(`\n  ✗ ${e.message}\n`)); process.exit(1); });
