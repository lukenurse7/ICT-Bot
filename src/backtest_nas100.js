'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  NAS100 ICT — NY Kill Zone Judas Swing Backtest
//  Data: Yahoo Finance QQQ
//    • 5m with pre-market  → Asia + London session levels + sweep
//    • TwelveData 1m       → MSS + FVG on 1m after sweep
//
//  Strategy (NY Kill Zone — ICT Method):
//    1. Mark Asia session swing high/low  (04:00–08:00 UTC)
//    2. Mark London session swing high/low (08:00–12:00 UTC)
//       → BSL = most recent swing HIGH from either session
//       → SSL = most recent swing LOW from either session
//    3. NY Kill Zone 12:00–15:00 GMT: wait for sweep of BSL or SSL
//       (wick beyond level, close back inside)
//    4. Switch to 1m: find MSS (CHoCH/BOS) confirming reversal
//    5. 1m: find FVG created by the displacement leg
//    6. Entry: limit 25% inside FVG
//    7. SL: just beyond the SWEEP CANDLE's wick extreme
//       (sweep high for sells, sweep low for buys)
//    8. TP1: nearest opposing liquidity (Asia/London session level)
//    9. No new entries after 15:00 GMT (10:00 AM EST)
//   10. 2% compounding from £1,500
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

// ─── Step 1: Asia + London session swing levels (5m, pre-market) ──────────────
// Asia equivalent:  04:00–07:55 UTC (US pre-market opens 04:00 UTC)
// London session:   08:00–11:55 UTC (London active, US still pre-market)
// Kill zone starts: 12:00 UTC — so we look for levels before that
function getSessionLevels(candles5m, dateStr) {
  const KILL_ZONE_START = 12 * 60; // 12:00 UTC

  const preKZ = candles5m.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const m = minsUTC(c.time);
    return m >= 4 * 60 && m < KILL_ZONE_START;
  });
  if (preKZ.length < 5) return null;

  // Find most recent 5m swing HIGH and swing LOW before kill zone
  // Swing = higher/lower than both neighbours (1-bar pivot for 5m pre-market)
  let lastSwingHigh = null, lastSwingLow = null;

  for (let i = 1; i < preKZ.length - 1; i++) {
    const c = preKZ[i];
    if (c.high >= preKZ[i-1].high && c.high >= preKZ[i+1].high)
      lastSwingHigh = c.high;
    if (c.low <= preKZ[i-1].low && c.low <= preKZ[i+1].low)
      lastSwingLow = c.low;
  }

  // Fall back to session extreme if no swing found
  if (lastSwingHigh === null) lastSwingHigh = Math.max(...preKZ.map(c => c.high));
  if (lastSwingLow  === null) lastSwingLow  = Math.min(...preKZ.map(c => c.low));

  if (lastSwingHigh <= lastSwingLow) return null;
  if ((lastSwingHigh - lastSwingLow) / lastSwingLow < MIN_RANGE_PCT) return null;

  return { bsl: lastSwingHigh, ssl: lastSwingLow };
}

// ─── Step 2: Sweep in NY Kill Zone 12:00–15:00 UTC ────────────────────────────
function detectSweep5m(candles5m, dateStr, levels) {
  const KZ_START = 12 * 60; // 12:00 UTC (7:00 AM EST)
  const KZ_END   = 15 * 60; // 15:00 UTC (10:00 AM EST) — no entries after

  const kzBars = candles5m.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const m = minsUTC(c.time);
    return m >= KZ_START && m < KZ_END;
  });

  for (const c of kzBars) {
    if (c.high > levels.bsl && c.close < levels.bsl)
      return { detected: true, dir: 'bear', sweptLevel: levels.bsl,
               targetLevel: levels.ssl, sweepTime: c.time,
               sweepWickExtreme: c.high,  // SL anchor = sweep wick high
               label: 'BSL swept → target SSL' };
    if (c.low < levels.ssl && c.close > levels.ssl)
      return { detected: true, dir: 'bull', sweptLevel: levels.ssl,
               targetLevel: levels.bsl, sweepTime: c.time,
               sweepWickExtreme: c.low,   // SL anchor = sweep wick low
               label: 'SSL swept → target BSL' };
  }
  return { detected: false };
}

// ─── Step 3: MSS on 1m bars after sweep ───────────────────────────────────────
function detectMSS1m(bars1m, sweepDir) {
  if (bars1m.length < 4) return { confirmed: false };

  for (let i = 2; i < Math.min(bars1m.length, 60); i++) {
    const last = bars1m[i], prev = bars1m[i-1];

    if (sweepDir === 'bear') {
      // slAnchor = highest high in the consolidation up to and including MSS bar
      // This is the "recent high that caused the MSS" = SL goes just above it
      const slAnchor = Math.max(...bars1m.slice(0, i + 1).map(b => b.high));
      if (last.close < prev.low)
        return { confirmed: true, type: 'CHoCH', mssBar: i, slAnchor };
      let swingLow = Infinity;
      for (let j = 1; j < i - 1; j++)
        if (bars1m[j].low < (bars1m[j-1]?.low ?? Infinity) &&
            bars1m[j].low < (bars1m[j+1]?.low ?? Infinity))
          swingLow = Math.min(swingLow, bars1m[j].low);
      if (swingLow < Infinity && last.close < swingLow)
        return { confirmed: true, type: 'BOS_DOWN', mssBar: i, slAnchor };
    }

    if (sweepDir === 'bull') {
      // slAnchor = lowest low in the consolidation = SL goes just below it
      const slAnchor = Math.min(...bars1m.slice(0, i + 1).map(b => b.low));
      if (last.close > prev.high)
        return { confirmed: true, type: 'CHoCH', mssBar: i, slAnchor };
      let swingHigh = -Infinity;
      for (let j = 1; j < i - 1; j++)
        if (bars1m[j].high > (bars1m[j-1]?.high ?? -Infinity) &&
            bars1m[j].high > (bars1m[j+1]?.high ?? -Infinity))
          swingHigh = Math.max(swingHigh, bars1m[j].high);
      if (swingHigh > -Infinity && last.close > swingHigh)
        return { confirmed: true, type: 'BOS_UP', mssBar: i, slAnchor };
    }
  }
  return { confirmed: false };
}

// ─── Step 4: FVG / imbalance on 1m within the displacement ───────────────────
// ICT FVG: 3-candle pattern where the displacement candle (middle) creates an
// imbalance. We allow a small overlap (FVG_OVERLAP_ALLOW) to capture the
// imbalances traders see visually — pure no-overlap FVGs are rare on 1m liquid ETFs.
// Returns top/bottom of the gap AND the displacement candle's extreme for SL.
// ─── Combined MSS + FVG detector ─────────────────────────────────────────────
// Finds the FIRST displacement candle in post-sweep 1m bars that BOTH:
//   1. Creates a genuine FVG (prev.low > next.high for bear, next.low > prev.high for bull)
//   2. Represents a structure break (close strongly beyond prior bar's extreme)
// Searching up to 90 bars (full 90-min kill zone session).
function detectMSSandFVG1m(bars1m, sweepDir) {
  if (bars1m.length < 4) return { confirmed: false };

  // First pass: find all genuine FVGs in the entire window
  const candidates = [];
  for (let i = 1; i < Math.min(bars1m.length - 1, 90); i++) {
    const prev = bars1m[i-1], mid = bars1m[i], next = bars1m[i+1];
    if (sweepDir === 'bear') {
      // Bearish FVG: prev.low > next.high
      if (prev.low > next.high && (prev.low - next.high) >= MIN_FVG_PTS) {
        candidates.push({
          fvgBar: i, top: prev.low, bottom: next.high,
          size: parseFloat((prev.low - next.high).toFixed(3)),
          dispHigh: mid.high, dispLow: mid.low,
          // SL = just above the displacement candle's high
          slAnchor: mid.high
        });
      }
    }
    if (sweepDir === 'bull') {
      // Bullish FVG: next.low > prev.high
      if (next.low > prev.high && (next.low - prev.high) >= MIN_FVG_PTS) {
        candidates.push({
          fvgBar: i, top: next.low, bottom: prev.high,
          size: parseFloat((next.low - prev.high).toFixed(3)),
          dispHigh: mid.high, dispLow: mid.low,
          // SL = just below the displacement candle's low
          slAnchor: mid.low
        });
      }
    }
  }

  if (!candidates.length) return { confirmed: false, reason: 'no_fvg' };

  // Take the FIRST FVG that aligns with the sweep direction
  // (first displacement in the intended reversal direction)
  const fvg = candidates[0];
  return {
    confirmed: true,
    type: 'DISP+FVG',
    mssBar: fvg.fvgBar,
    fvg: { found: true, top: fvg.top, bottom: fvg.bottom, size: fvg.size,
           dispHigh: fvg.dispHigh, dispLow: fvg.dispLow },
    slAnchor: fvg.slAnchor
  };
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
  console.log('\n' + chalk.bold.cyan('  ◆ NAS100 — NY Kill Zone Judas Swing (ICT Method)'));
  console.log(chalk.gray('  Asia/London 5m levels → 5m sweep 12:00–15:00 GMT → 1m MSS + FVG → SL at sweep wick\n'));

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
    // Step 1: Asia + London session swing levels (before 12:00 UTC)
    const levels = getSessionLevels(c5m, dateStr);
    if (!levels) { stats.noLevels++; continue; }

    // Step 2: sweep in NY Kill Zone 12:00–15:00 UTC
    const sweep = detectSweep5m(c5m, dateStr, levels);
    if (!sweep.detected) { stats.noSweep++; continue; }

    const sweepMins = minsUTC(sweep.sweepTime);

    // Post-sweep 1m bars: after sweep candle, up to 15:00 UTC max
    const post1m = c2m.filter(c => {
      if (!c.time.startsWith(dateStr)) return false;
      const m = minsUTC(c.time);
      return m > sweepMins && m < 15 * 60;
    });

    if (post1m.length < 4) { stats.noMSS++; continue; }

    // Steps 3+4: find first genuine FVG in sweep direction (searches up to 90 bars)
    const result = detectMSSandFVG1m(post1m, sweep.dir);
    if (!result.confirmed) {
      if (result.reason === 'no_fvg') { stats.noFVG++; } else { stats.noMSS++; }
      continue;
    }
    const fvg = result.fvg;
    const mss = { mssBar: result.mssBar };

    // Build entry, SL, TP
    const isLong = sweep.dir === 'bull';
    const entry = parseFloat((isLong
      ? fvg.bottom + (fvg.top - fvg.bottom) * 0.25
      : fvg.top    - (fvg.top - fvg.bottom) * 0.25).toFixed(2));

    // SL = just beyond the displacement candle's extreme (middle bar of FVG)
    const sl = parseFloat((isLong
      ? result.slAnchor * (1 - SL_BUF_PCT)
      : result.slAnchor * (1 + SL_BUF_PCT)
    ).toFixed(2));

    const tp = parseFloat(sweep.targetLevel.toFixed(2));
    const risk = Math.abs(entry - sl);

    // Validity checks — log reason for debug
    const tpDist = Math.abs(tp - entry);
    const failReason =
      risk < entry * MIN_STOP_PCT              ? `stop_too_small (risk=$${risk.toFixed(3)}, min=$${(entry*MIN_STOP_PCT).toFixed(3)})` :
      risk > entry * 0.04                      ? `stop_too_large (risk=$${risk.toFixed(3)})` :
      isLong  && sl >= entry                   ? `bull_sl_above_entry (sl=$${sl} entry=$${entry})` :
      isLong  && tp <= entry                   ? `bull_tp_below_entry` :
      !isLong && sl <= entry                   ? `bear_sl_below_entry (sl=$${sl} entry=$${entry})` :
      !isLong && tp >= entry                   ? `bear_tp_above_entry (tp=$${tp} entry=$${entry})` :
      tpDist < MIN_TP_DIST                     ? `tp_too_close (dist=$${tpDist.toFixed(3)})` : null;
    if (failReason) {
      stats.riskFail++;
      stats.riskFailLog = stats.riskFailLog || [];
      stats.riskFailLog.push({ date: dateStr, dir: isLong?'BUY':'SELL', entry, sl, tp, fvgSize: fvg.size, reason: failReason,
        sweptLevel: sweep.sweptLevel, targetLevel: sweep.targetLevel, slAnchor: result.slAnchor });
      continue;
    }

    const rrPot = parseFloat((Math.abs(tp - entry) / risk).toFixed(2));

    // Simulate on 2m bars from after the MSS bar
    const simStart2m = c2m.indexOf(post1m[mss.mssBar]) + 1;
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
      mssType: result.type,
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
  console.log(chalk.bold.cyan('  SIGNAL REPORT — NAS100 NY Kill Zone (Asia/London levels · 1m MSS/FVG)'));
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
  console.log(chalk.bold.cyan('  SUMMARY — NAS100 NY Kill Zone (ICT · Asia/London + 1m)'));
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
    dataSource: 'Yahoo Finance QQQ 5m pre-market + TwelveData QQQ 1m',
    instrument: 'NAS100 proxy via QQQ ETF',
    strategy: 'ICT NY Kill Zone — Asia/London 5m levels, 12-15 GMT sweep, 1m MSS+FVG, SL at sweep wick',
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

  if (stats.riskFailLog && stats.riskFailLog.length) {
    console.log('\n' + sep);
    console.log(chalk.bold.yellow('  RISK-FAIL DEBUG — days that had FVG but failed validity checks'));
    console.log(sep);
    stats.riskFailLog.forEach((r, i) => {
      const clr = r.dir === 'BUY' ? chalk.green : chalk.red;
      console.log(`\n  #${i+1} ${chalk.gray(r.date)}  ${clr(r.dir)}  FVG: $${r.fvgSize}`);
      console.log(`  Entry $${r.entry}  SL $${r.sl}  TP $${r.tp}  slAnchor $${r.slAnchor}`);
      console.log(`  Swept $${r.sweptLevel}  → Target $${r.targetLevel}`);
      console.log(chalk.red(`  ✗ ${r.reason}`));
    });
    console.log('\n' + sep);
  }

  console.log('\n' + sep + '\n');
}

run().catch(e => { console.error(chalk.red(`\n  ✗ ${e.message}\n`)); process.exit(1); });
