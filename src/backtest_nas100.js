'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  NAS100 ICT — Judas Swing Backtest  (CORRECTED)
//  Data: Yahoo Finance QQQ
//    • 5m with pre-market  → pre-NY swing levels + sweep detection
//    • 2m regular hours    → MSS + FVG on lower timeframe (2m ≈ 1m proxy)
//
//  Strategy:
//    1. 5m chart: mark the CLOSEST (most recent) swing high (BSL) and
//       swing low (SSL) formed before 14:00 GMT
//    2. 5m chart, 14:00–16:00 GMT window: wait for a candle to wick
//       BEYOND BSL or SSL and CLOSE back inside → sweep confirmed
//    3. Switch to 2m chart: find MSS (CHoCH / BOS) in the direction
//       opposite to the sweep
//    4. 2m chart: the displacement creating the MSS must leave a FVG
//       (3-candle gap, minimum size)
//    5. Entry: limit order 25% inside the FVG from the entry side
//    6. SL: just beyond the highest high (for sells) or lowest low
//       (for buys) formed in the post-sweep consolidation
//    7. TP: opposing liquidity (SSL if BSL swept, BSL if SSL swept)
//    8. One trade per day; 2% compounding from £1,500
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const axios = require('axios');
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const ACCOUNT_START = 1500;
const RISK_PCT      = 0.02;
const SIM_BARS      = 600;        // bars to simulate (2m bars, up to EOD)
const SL_BUF_PCT    = 0.0003;     // 0.03% buffer beyond swing extreme
const MIN_STOP_PCT  = 0.0005;     // minimum stop = 0.05% of price
const MIN_FVG_PTS   = 0.10;       // minimum FVG size on 2m ($0.10 on QQQ)
const MIN_RANGE_PCT = 0.001;      // pre-NY swing range must be ≥ 0.1% wide
const MIN_TP_DIST   = 1.50;       // TP must be at least $1.50 from entry

function fmtGBP(n) { return (n >= 0 ? '+' : '-') + '£' + Math.abs(n).toFixed(2); }

const CACHE_DIR = path.join(__dirname, '..', '.cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

// ─── Yahoo Finance fetcher ────────────────────────────────────────────────────
async function fetchYahoo(symbol, interval, range, includePrePost, cacheKey) {
  const cacheFile = path.join(CACHE_DIR, `yahoo_${cacheKey}.json`);
  const cacheAge  = fs.existsSync(cacheFile)
    ? (Date.now() - fs.statSync(cacheFile).mtimeMs) / 60000
    : Infinity;

  if (cacheAge < 60) {
    process.stdout.write(chalk.gray(' (cached)'));
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }

  process.stdout.write(chalk.gray(` fetching ${symbol} ${interval}...`));
  const r = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, {
    params: { interval, range, includePrePost: includePrePost ? 'true' : 'false' },
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 25000
  });

  const result = r.data.chart.result[0];
  const candles = result.timestamp.map((ts, i) => ({
    time:  new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' '),
    open:  result.indicators.quote[0].open[i],
    high:  result.indicators.quote[0].high[i],
    low:   result.indicators.quote[0].low[i],
    close: result.indicators.quote[0].close[i]
  })).filter(c => c.open != null && c.high != null);

  fs.writeFileSync(cacheFile, JSON.stringify(candles));
  process.stdout.write(chalk.green(` ✓ ${candles.length} bars (${candles[0].time.slice(0,10)} → ${candles[candles.length-1].time.slice(0,10)})\n`));
  return candles;
}

// ─── DST-aware NY open in UTC minutes ─────────────────────────────────────────
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

// ─── Step 1: CLOSEST swing high and swing low on 5m before 14:00 UTC ──────────
// "Closest" = the most recently formed swing pivot before the sweep window
function getClosestSwingLevels(candles5m, dateStr, nyOpenMins) {
  // Pre-session: 08:00 UTC up to (but not including) sweep window
  const session = candles5m.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const m = minsUTC(c.time);
    return m >= 8 * 60 && m < nyOpenMins;
  });
  if (session.length < 5) return null;

  // Find ALL swing highs and swing lows (pivot: higher/lower than 2 bars each side)
  let lastSwingHigh = null, lastSwingHighIdx = -1;
  let lastSwingLow  = null, lastSwingLowIdx  = -1;

  for (let i = 2; i < session.length - 2; i++) {
    const c = session[i];
    if (c.high > session[i-1].high && c.high > session[i-2].high &&
        c.high > session[i+1].high && c.high > session[i+2].high) {
      lastSwingHigh    = c.high;
      lastSwingHighIdx = i;
    }
    if (c.low < session[i-1].low && c.low < session[i-2].low &&
        c.low < session[i+1].low && c.low < session[i+2].low) {
      lastSwingLow    = c.low;
      lastSwingLowIdx = i;
    }
  }

  // Fall back to session high/low if no swing pivot found
  if (lastSwingHigh === null) lastSwingHigh = Math.max(...session.map(c => c.high));
  if (lastSwingLow  === null) lastSwingLow  = Math.min(...session.map(c => c.low));

  if (lastSwingHigh <= lastSwingLow) return null;
  if ((lastSwingHigh - lastSwingLow) / lastSwingLow < MIN_RANGE_PCT) return null;

  return { bsl: lastSwingHigh, ssl: lastSwingLow };
}

// ─── Step 2: Sweep on 5m in 14:00–16:00 UTC window ────────────────────────────
function detectSweep5m(candles5m, dateStr, nyOpenMins, levels) {
  const windowEnd = nyOpenMins + 120; // 2hr window
  const nyBars = candles5m.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const m = minsUTC(c.time);
    return m >= nyOpenMins && m < windowEnd;
  });

  for (const c of nyBars) {
    if (c.high > levels.bsl && c.close < levels.bsl)
      return { detected: true, dir: 'bear', sweptLevel: levels.bsl,
               targetLevel: levels.ssl, sweepTime: c.time,
               label: 'BSL swept → target SSL' };
    if (c.low < levels.ssl && c.close > levels.ssl)
      return { detected: true, dir: 'bull', sweptLevel: levels.ssl,
               targetLevel: levels.bsl, sweepTime: c.time,
               label: 'SSL swept → target BSL' };
  }
  return { detected: false };
}

// ─── Step 3: MSS on 2m bars after sweep ───────────────────────────────────────
function detectMSS2m(bars2m, sweepDir) {
  if (bars2m.length < 4) return { confirmed: false };

  for (let i = 2; i < Math.min(bars2m.length, 60); i++) {
    const last = bars2m[i], prev = bars2m[i-1];

    if (sweepDir === 'bear') {
      const slAnchor = Math.max(...bars2m.slice(0, i + 1).map(b => b.high));
      // CHoCH: close below prior bar's low
      if (last.close < prev.low)
        return { confirmed: true, type: 'CHoCH', mssBar: i, slAnchor };
      // BOS: close below a swing low formed after sweep
      let swingLow = Infinity;
      for (let j = 1; j < i - 1; j++)
        if (bars2m[j].low < (bars2m[j-1]?.low ?? Infinity) &&
            bars2m[j].low < (bars2m[j+1]?.low ?? Infinity))
          swingLow = Math.min(swingLow, bars2m[j].low);
      if (swingLow < Infinity && last.close < swingLow)
        return { confirmed: true, type: 'BOS_DOWN', mssBar: i, slAnchor };
    }

    if (sweepDir === 'bull') {
      const slAnchor = Math.min(...bars2m.slice(0, i + 1).map(b => b.low));
      // CHoCH: close above prior bar's high
      if (last.close > prev.high)
        return { confirmed: true, type: 'CHoCH', mssBar: i, slAnchor };
      // BOS: close above a swing high formed after sweep
      let swingHigh = -Infinity;
      for (let j = 1; j < i - 1; j++)
        if (bars2m[j].high > (bars2m[j-1]?.high ?? -Infinity) &&
            bars2m[j].high > (bars2m[j+1]?.high ?? -Infinity))
          swingHigh = Math.max(swingHigh, bars2m[j].high);
      if (swingHigh > -Infinity && last.close > swingHigh)
        return { confirmed: true, type: 'BOS_UP', mssBar: i, slAnchor };
    }
  }
  return { confirmed: false };
}

// ─── Step 4: FVG on 2m within the displacement ────────────────────────────────
function detectFVG2m(bars2m, sweepDir, mssBar) {
  // Search from bar 0 up through mssBar + a few bars
  const window = bars2m.slice(0, Math.min(mssBar + 6, bars2m.length));
  const gaps = [];

  for (let i = 1; i < window.length - 1; i++) {
    const prev = window[i-1], next = window[i+1];
    if (sweepDir === 'bear') {
      // Bearish FVG: gap between prev candle's LOW and next candle's HIGH
      const gapSize = prev.low - next.high;
      if (gapSize >= MIN_FVG_PTS)
        gaps.push({ found: true, top: prev.low, bottom: next.high,
                    size: parseFloat(gapSize.toFixed(3)) });
    }
    if (sweepDir === 'bull') {
      // Bullish FVG: gap between prev candle's HIGH and next candle's LOW
      const gapSize = next.low - prev.high;
      if (gapSize >= MIN_FVG_PTS)
        gaps.push({ found: true, top: next.low, bottom: prev.high,
                    size: parseFloat(gapSize.toFixed(3)) });
    }
  }

  if (!gaps.length) return { found: false };
  return gaps[gaps.length - 1]; // most recent FVG
}

// ─── Simulate limit order fill and outcome ────────────────────────────────────
function simulate(dir, entry, sl, tp, futureBars) {
  let filled = false;
  for (const c of futureBars) {
    if (!filled) {
      if (dir === 'bull' && c.low  <= entry) filled = true;
      if (dir === 'bear' && c.high >= entry) filled = true;
      if (!filled) continue;
    }
    if (dir === 'bull') {
      if (c.low  <= sl) return { result: 'LOSS', pnlR: -1 };
      if (c.high >= tp) return { result: 'WIN',
        pnlR: parseFloat(((tp - entry) / (entry - sl)).toFixed(2)) };
    } else {
      if (c.high >= sl) return { result: 'LOSS', pnlR: -1 };
      if (c.low  <= tp) return { result: 'WIN',
        pnlR: parseFloat(((entry - tp) / (sl - entry)).toFixed(2)) };
    }
  }
  return { result: filled ? 'OPEN' : 'NO_FILL', pnlR: null };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  console.clear();
  console.log('\n' + chalk.bold.cyan('  ◆ NAS100 Judas Swing — ICT Checklist'));
  console.log(chalk.gray('  Closest 5m swing H/L → 5m sweep 14:00–16:00 GMT → 1m MSS + FVG → limit entry\n'));

  // Fetch 5m with pre-market (for pre-NY levels + sweep)
  process.stdout.write(chalk.gray('  QQQ 5m (pre-market)...'));
  const c5m = await fetchYahoo('QQQ', '5m', '60d', true, 'qqq_5m_pre');

  // Load TwelveData 1m (regular hours, paginated, cached by fetch script)
  const c1mFile = path.join(CACHE_DIR, 'twelvedata_qqq_1m.json');
  if (!fs.existsSync(c1mFile)) {
    console.error(chalk.red('\n  ✗ TwelveData 1m cache missing. Run fetch script first.\n'));
    process.exit(1);
  }
  const c2m = JSON.parse(fs.readFileSync(c1mFile, 'utf8'));
  console.log(chalk.gray(`  TwelveData QQQ 1m... ✓ ${c2m.length} bars (${c2m[0].time.slice(0,10)} → ${c2m[c2m.length-1].time.slice(0,10)})`));

  const tradingDays = [...new Set(
    c5m.filter(c => minsUTC(c.time) >= 13 * 60).map(c => c.time.slice(0, 10))
  )].sort();

  console.log(chalk.gray(`\n  ${tradingDays.length} trading days: ${tradingDays[0]} → ${tradingDays[tradingDays.length-1]}\n`));

  const signals = [];
  let balance = ACCOUNT_START, peakBalance = ACCOUNT_START, maxDrawdown = 0;
  const stats = { noLevels: 0, noSweep: 0, noMSS: 0, noFVG: 0, riskFail: 0 };

  for (const dateStr of tradingDays) {
    const nyMins = nyOpenUTC(dateStr);

    // Step 1: closest 5m swing levels
    const levels = getClosestSwingLevels(c5m, dateStr, nyMins);
    if (!levels) { stats.noLevels++; continue; }

    // Step 2: sweep on 5m
    const sweep = detectSweep5m(c5m, dateStr, nyMins, levels);
    if (!sweep.detected) { stats.noSweep++; continue; }

    // Find where the sweep candle sits in time, then get 2m bars after it
    const sweepMins = minsUTC(sweep.sweepTime);

    // Post-sweep 1m bars: same date, after sweep candle, within 45 minutes of sweep
    const post2m = c2m.filter(c => {
      if (!c.time.startsWith(dateStr)) return false;
      const m = minsUTC(c.time);
      return m > sweepMins && m <= sweepMins + 45;
    });

    if (post2m.length < 4) { stats.noMSS++; continue; }

    // Step 3: MSS on 2m
    const mss = detectMSS2m(post2m, sweep.dir);
    if (!mss.confirmed) { stats.noMSS++; continue; }

    // Step 4: FVG on 2m
    const fvg = detectFVG2m(post2m, sweep.dir, mss.mssBar);
    if (!fvg.found) { stats.noFVG++; continue; }

    // Build entry, SL, TP
    const isLong = sweep.dir === 'bull';
    const entry = parseFloat((isLong
      ? fvg.bottom + (fvg.top - fvg.bottom) * 0.25
      : fvg.top    - (fvg.top - fvg.bottom) * 0.25).toFixed(2));

    const sl = parseFloat((isLong
      ? mss.slAnchor * (1 - SL_BUF_PCT)
      : mss.slAnchor * (1 + SL_BUF_PCT)).toFixed(2));

    const tp = parseFloat(sweep.targetLevel.toFixed(2));
    const risk = Math.abs(entry - sl);

    // Validity checks
    if (risk < entry * MIN_STOP_PCT)              { stats.riskFail++; continue; }
    if (risk > entry * 0.03)                      { stats.riskFail++; continue; }
    if (isLong  && (sl >= entry || tp <= entry))  { stats.riskFail++; continue; }
    if (!isLong && (sl <= entry || tp >= entry))  { stats.riskFail++; continue; }
    if (Math.abs(tp - entry) < MIN_TP_DIST)       { stats.riskFail++; continue; }
    // Entry must be within 2% of swept level (no chasing far-away FVGs)
    if (Math.abs(entry - sweep.sweptLevel) / sweep.sweptLevel > 0.02) { stats.riskFail++; continue; }

    const rrPot = parseFloat((Math.abs(tp - entry) / risk).toFixed(2));

    // Simulate on 2m bars from after the MSS bar
    const simStart2m = c2m.indexOf(post2m[mss.mssBar]) + 1;
    const future2m   = c2m.slice(simStart2m, simStart2m + SIM_BARS);
    const outcome    = simulate(sweep.dir, entry, sl, tp, future2m);

    const riskGBP = balance * RISK_PCT;
    const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;

    if (pnlGBP !== null) {
      balance += pnlGBP;
      if (balance > peakBalance) peakBalance = balance;
      const dd = (peakBalance - balance) / peakBalance * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    signals.push({
      date: dateStr,
      dir: isLong ? 'BUY' : 'SELL',
      bsl: parseFloat(levels.bsl.toFixed(2)),
      ssl: parseFloat(levels.ssl.toFixed(2)),
      sweep: sweep.label,
      sweptLevel: parseFloat(sweep.sweptLevel.toFixed(2)),
      targetLevel: parseFloat(sweep.targetLevel.toFixed(2)),
      mssType: mss.type,
      fvgSize: fvg.size,
      entry, sl, tp,
      risk: parseFloat(risk.toFixed(2)),
      rrPot,
      riskGBP: parseFloat(riskGBP.toFixed(2)),
      pnlGBP:  pnlGBP != null ? parseFloat(pnlGBP.toFixed(2)) : null,
      balanceAfter: pnlGBP != null ? parseFloat(balance.toFixed(2)) : null,
      ...outcome
    });
  }

  // ─── Print report ─────────────────────────────────────────────────────────
  const sep = '═'.repeat(72);
  console.log(sep);
  console.log(chalk.bold.cyan('  SIGNAL REPORT — NAS100 Judas Swing (5m levels + 1m MSS/FVG)'));
  console.log(sep);

  signals.forEach((s, idx) => {
    const isLong = s.dir === 'BUY';
    const clr = isLong ? chalk.green : chalk.red;
    const oc  = s.result === 'WIN' ? chalk.green : s.result === 'LOSS' ? chalk.red : chalk.yellow;
    const pnlStr = s.pnlR != null
      ? (s.pnlR > 0
          ? chalk.green(`+${s.pnlR.toFixed(2)}R  ${fmtGBP(s.pnlGBP)}`)
          : chalk.red(`-1.0R  ${fmtGBP(s.pnlGBP)}`))
      : chalk.yellow(s.result);

    console.log(`\n  #${idx+1} ${chalk.gray(s.date)}  ${clr(`${isLong?'▲':'▼'} ${s.dir}`)}  ${chalk.gray(s.sweep)}`);
    console.log(`  BSL:$${s.bsl}  SSL:$${s.ssl}  Swept:$${s.sweptLevel}  Target:$${s.targetLevel}`);
    console.log(`  Entry $${s.entry}  SL $${s.sl}  TP $${s.tp}  Risk $${s.risk}  Pot. ${chalk.cyan(s.rrPot+'R')}  ${chalk.gray('£'+s.riskGBP)}`);
    console.log(`  MSS: ${chalk.gray(s.mssType)}  FVG: $${s.fvgSize}  → ${oc(s.result)}  ${pnlStr}${s.balanceAfter ? chalk.gray('  bal: ') + '£'+s.balanceAfter : ''}`);
  });

  // ─── Summary ─────────────────────────────────────────────────────────────
  const closed  = signals.filter(s => s.pnlR != null);
  const wins    = closed.filter(s => s.pnlR > 0);
  const losses  = closed.filter(s => s.pnlR < 0);
  const totalR  = closed.reduce((s, x) => s + x.pnlR, 0);
  const totalGBP= closed.reduce((s, x) => s + (x.pnlGBP||0), 0);
  const wr      = closed.length ? (wins.length / closed.length * 100).toFixed(0) : 0;
  const avgWinR = wins.length ? (wins.reduce((s,x)=>s+x.pnlR,0)/wins.length).toFixed(2) : '0';
  const pf      = losses.length
    ? (wins.reduce((s,x)=>s+x.pnlR,0) / Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2)
    : wins.length ? '∞' : '0.00';

  const byMonth = {};
  signals.forEach(s => { const mk=s.date.slice(0,7); byMonth[mk]=(byMonth[mk]||[]).concat(s); });

  console.log('\n\n' + sep);
  console.log(chalk.bold.cyan('  SUMMARY — NAS100 Judas Swing (5m + 1m TwelveData)'));
  console.log(sep);
  console.log(chalk.gray('  Filter funnel:'));
  console.log(chalk.gray(`    Trading days:          ${tradingDays.length}`));
  console.log(chalk.gray(`    No pre-NY levels:      ${stats.noLevels}`));
  console.log(chalk.gray(`    No 5m sweep 14-16:     ${stats.noSweep}`));
  console.log(chalk.gray(`    No 1m MSS after sweep: ${stats.noMSS}`));
  console.log(chalk.gray(`    No 1m FVG found:       ${stats.noFVG}`));
  console.log(chalk.gray(`    Risk check fail:       ${stats.riskFail}`));
  console.log(chalk.gray(`    Signals fired:         ${signals.length}`));
  console.log('');
  console.log(chalk.gray('  Signals:         ') + chalk.white(signals.length));
  console.log(chalk.gray('  Wins:            ') + chalk.green(wins.length));
  console.log(chalk.gray('  Losses:          ') + chalk.red(losses.length));
  console.log(chalk.gray('  Open/no fill:    ') + chalk.yellow(signals.length - closed.length));
  console.log(chalk.gray('  Win rate:        ') + (parseFloat(wr)>=33?chalk.green:chalk.red)(`${wr}%`));
  console.log(chalk.gray('  Avg win R:       ') + chalk.cyan(avgWinR + 'R'));
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
    const mW=sigs.filter(s=>s.pnlR>0).length, mL=sigs.filter(s=>s.pnlR<0).length;
    const mR=sigs.reduce((s,x)=>s+(x.pnlR||0),0);
    const mGBP=sigs.reduce((s,x)=>s+(x.pnlGBP||0),0);
    const mWR=(mW+mL)>0?Math.round(mW/(mW+mL)*100):0;
    console.log(
      chalk.gray(`    ${mo}  `)+chalk.white(`${sigs.length} signals`)+chalk.gray('  ')+
      chalk.green(`${mW}W`)+chalk.gray('/')+chalk.red(`${mL}L`)+
      chalk.gray(`  ${mWR}% WR  `)+(mR>=0?chalk.green(`+${mR.toFixed(2)}R`):chalk.red(`${mR.toFixed(2)}R`))+
      chalk.gray('  ')+(mGBP>=0?chalk.green(fmtGBP(mGBP)):chalk.red(fmtGBP(mGBP)))
    );
  });

  const reportPath = path.join(__dirname, '..', 'backtest_report_nas100.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    period: `${tradingDays[0]} → ${tradingDays[tradingDays.length-1]}`,
    generatedAt: new Date().toISOString(),
    dataSource: 'Yahoo Finance QQQ 5m pre-market + 2m regular',
    instrument: 'NAS100 proxy via QQQ ETF',
    strategy: 'ICT Judas Swing — closest 5m swing H/L, 2m MSS+FVG',
    account: { start: ACCOUNT_START, end: parseFloat(balance.toFixed(2)),
      netGBP: parseFloat(totalGBP.toFixed(2)),
      returnPct: parseFloat(((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)),
      peakBalance: parseFloat(peakBalance.toFixed(2)),
      maxDrawdown: parseFloat(maxDrawdown.toFixed(1)) },
    stats: { total: signals.length, wins: wins.length, losses: losses.length,
      winRate: wr+'%', avgWinR, netR: totalR.toFixed(2), profitFactor: pf },
    signals
  }, null, 2));

  console.log(chalk.gray('\n  Report → backtest_report_nas100.json'));
  console.log('\n' + sep + '\n');
}

run().catch(e => { console.error(chalk.red(`\n  ✗ ${e.message}\n`)); process.exit(1); });
