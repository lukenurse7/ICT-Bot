'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  XAUUSD ICT SCALPING BACKTEST
//  Based on community scalping spec:
//  - 15m for structure/bias, 5m for FVG + entry (proxy for 5m/1m)
//  - Session: London open 07:00-10:00 UTC only
//  - Sweep reference: Asia session H/L (00:00-07:00 UTC) + PDH/PDL
//  - FVG: min $1.50 gap, displacement candle required (body > 60% range)
//  - SL: FVG boundary + $3 buffer (tight scalp SL, not sweep extreme)
//  - TP: 1.5R and 2.5R (scalp targets, not swing)
//  - News filter: skip entries within 30min of hardcoded high-impact USD events
//  - BOS only (no CHoCH), entry at FVG midpoint limit order
//  - Min wick $2 on sweep (slightly looser for scalping volume)
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const ACCOUNT_START  = 1500;
const RISK_PCT       = 0.02;
const SIM_BARS       = 72;   // 6h max hold — scalp, not swing
const COOLDOWN_BARS  = 12;   // 1h cooldown (shorter for scalping)
const MIN_WICK       = 2;
const MIN_FVG_SIZE   = 1.50; // $1.50 minimum FVG gap
const DISPLACE_RATIO = 0.60; // body must be >60% of candle range (displacement)
const FVG_SL_BUFFER  = 3;    // $3 beyond FVG boundary as SL

const CACHE = path.join(__dirname, '..', '.cache');
function fmtGBP(n) { return (n>=0?'+':'') + '£' + Math.abs(n).toFixed(2); }
function fmtPct(n) { return (n>=0?'+':'') + n.toFixed(1) + '%'; }

// ─── High-impact USD news dates (hardcoded) ────────────────────────────────
// NFP = first Friday each month, FOMC, CPI — these are the major movers
// Format: 'YYYY-MM-DD' — block 30 min before/after these dates
const HIGH_IMPACT_DATES = new Set([
  // NFP dates (approx first Friday of each month)
  '2025-07-04','2025-08-01','2025-09-05','2025-10-03',
  '2025-11-07','2025-12-05','2026-01-09','2026-02-06',
  '2026-03-06','2026-04-03','2026-05-01','2026-06-05',
  // FOMC dates
  '2025-07-30','2025-09-17','2025-11-05','2025-12-17',
  '2026-01-28','2026-03-18','2026-05-06','2026-06-17',
  // CPI dates (approx 2nd week of month)
  '2025-07-11','2025-08-13','2025-09-11','2025-10-15',
  '2025-11-13','2025-12-11','2026-01-15','2026-02-12',
  '2026-03-12','2026-04-10','2026-05-13','2026-06-11',
]);

function isNearNews(isoTime) {
  const t    = new Date(isoTime);
  const date = t.toISOString().slice(0, 10);
  if (!HIGH_IMPACT_DATES.has(date)) return false;
  // Check if within 30 minutes of 13:30 UTC (typical news release window)
  const h = t.getUTCHours(), m = t.getUTCMinutes();
  const mins = h * 60 + m;
  return mins >= (13*60) && mins <= (14*60);  // 13:00-14:00 UTC block
}

// ─── Data loading ─────────────────────────────────────────────────────────
function loadChunks(prefix) {
  const all = [];
  for (let y=2025, m=6; !(y===2026&&m===7);) {
    const s  = `${y}-${String(m).padStart(2,'0')}-01`;
    const nm = m+1>12?1:m+1, ny = m+1>12?y+1:y;
    const e  = `${ny}-${String(nm).padStart(2,'0')}-01`;
    const f  = path.join(CACHE, `${prefix}_${s}_${e}.json`);
    if (fs.existsSync(f)) all.push(...JSON.parse(fs.readFileSync(f)));
    m++; if (m>12){m=1;y++;}
  }
  const seen = new Set();
  return all.filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
    .sort((a,b) => a.time.localeCompare(b.time));
}

function rollupM15(m5) {
  const out = [];
  for (let i = 0; i < m5.length; i += 3) {
    const s = m5.slice(i, i+3);
    if (!s.length) continue;
    out.push({ time:s[0].time, open:s[0].open,
      high: Math.max(...s.map(c=>c.high)), low: Math.min(...s.map(c=>c.low)),
      close: s[s.length-1].close });
  }
  return out;
}

// ─── Session ranges ─────────────────────────────────────────────────────────
function getAsiaRange(candles5m, dateStr) {
  const sess = candles5m.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const h = new Date(c.time).getUTCHours();
    return h >= 0 && h < 7;
  });
  if (sess.length < 6) return null;
  return { high: Math.max(...sess.map(c=>c.high)), low: Math.min(...sess.map(c=>c.low)),
           bars: sess.length };
}

function getPDRange(candles5m, dateStr) {
  const today = new Date(dateStr + 'T00:00:00Z');
  const yest  = new Date(today - 86400000);
  const bars  = candles5m.filter(c => { const t=new Date(c.time); return t>=yest && t<today; });
  if (!bars.length) return null;
  return { high: Math.max(...bars.map(c=>c.high)), low: Math.min(...bars.map(c=>c.low)) };
}

// ─── 15m bias (HTF structure for scalp direction filter) ───────────────────
function get15mBias(candles15m) {
  const w = candles15m.slice(-20);
  if (w.length < 10) return 'neutral';
  // Simple: is price above/below midpoint of last 20 bars?
  const hi   = Math.max(...w.map(c=>c.high));
  const lo   = Math.min(...w.map(c=>c.low));
  const mid  = (hi + lo) / 2;
  const last = w[w.length-1].close;
  if (last > mid * 1.001) return 'bullish';
  if (last < mid * 0.999) return 'bearish';
  return 'neutral';
}

// ─── Sweep detection (London: sweeps Asia H/L + PDH/PDL) ──────────────────
function detectSweep(candles5m, dateStr) {
  const recent = candles5m.slice(-20);
  const sweeps = [];
  const levels = [];

  const asia = getAsiaRange(candles5m, dateStr);
  if (asia) {
    levels.push({ price: asia.high, label: 'Asia High', dir: 'bear' });
    levels.push({ price: asia.low,  label: 'Asia Low',  dir: 'bull' });
  }
  const pd = getPDRange(candles5m, dateStr);
  if (pd) {
    levels.push({ price: pd.high, label: 'PDH', dir: 'bear' });
    levels.push({ price: pd.low,  label: 'PDL', dir: 'bull' });
  }

  for (const lvl of levels) {
    for (let back = 0; back < Math.min(18, recent.length - 1); back++) {
      const c   = recent[recent.length - 1 - back];
      const kzH = new Date(c.time).getUTCHours();
      if (kzH < 7 || kzH >= 10) continue; // London open only

      if (lvl.dir === 'bear' && c.high > lvl.price && c.close < lvl.price
          && (c.high - lvl.price) >= MIN_WICK) {
        sweeps.push({ dir:'bear', level:lvl.price, levelName:lvl.label,
          sweepHigh:c.high, sweepCandle:c, barsAgo:back,
          sweepBarIdx: recent.length - 1 - back });
        break;
      }
      if (lvl.dir === 'bull' && c.low < lvl.price && c.close > lvl.price
          && (lvl.price - c.low) >= MIN_WICK) {
        sweeps.push({ dir:'bull', level:lvl.price, levelName:lvl.label,
          sweepLow:c.low, sweepCandle:c, barsAgo:back,
          sweepBarIdx: recent.length - 1 - back });
        break;
      }
    }
  }

  if (!sweeps.length) return null;
  sweeps.sort((a,b) => a.barsAgo - b.barsAgo);
  return sweeps[0];
}

// ─── BOS detection (5m, no CHoCH) ─────────────────────────────────────────
function detectBOS(candles5m, sweepDir) {
  const w = candles5m.slice(-16);
  if (w.length < 5) return { confirmed: false };

  if (sweepDir === 'bear') {
    let swingLow = Infinity;
    for (let i = 1; i < w.length - 1; i++) {
      if (w[i].low < w[i-1].low && w[i].low < w[i+1].low)
        swingLow = Math.min(swingLow, w[i].low);
    }
    if (swingLow < Infinity && w[w.length-1].close < swingLow)
      return { confirmed:true, type:'BOS_DOWN', level:swingLow, bosBar:w[w.length-1] };
  } else {
    let swingHigh = -Infinity;
    for (let i = 1; i < w.length - 1; i++) {
      if (w[i].high > w[i-1].high && w[i].high > w[i+1].high)
        swingHigh = Math.max(swingHigh, w[i].high);
    }
    if (swingHigh > -Infinity && w[w.length-1].close > swingHigh)
      return { confirmed:true, type:'BOS_UP', level:swingHigh, bosBar:w[w.length-1] };
  }
  return { confirmed: false };
}

// ─── FVG detection with displacement filter ────────────────────────────────
// Displacement: the middle candle (c1) must have body > DISPLACE_RATIO of range
// Minimum gap: MIN_FVG_SIZE dollars
// Only post-sweep FVGs (startIdx)
function detectFVG(candles5m, sweepDir, sweepBarIdx) {
  const results = [];
  const w = candles5m.slice(Math.max(0, sweepBarIdx), candles5m.length);

  for (let i = 1; i < w.length - 1; i++) {
    const c0 = w[i-1], c1 = w[i], c2 = w[i+1];

    // Displacement check on c1 (the impulse candle)
    const range = c1.high - c1.low;
    if (range <= 0) continue;
    const body  = Math.abs(c1.close - c1.open);
    if (body / range < DISPLACE_RATIO) continue;  // weak candle — skip

    if (sweepDir === 'bear' && c2.high < c0.low) {
      const size = c0.low - c2.high;
      if (size < MIN_FVG_SIZE) continue;
      // Displacement direction must match: c1 should be a bearish displacement
      if (c1.close >= c1.open) continue; // must be a bearish candle
      results.push({ type:'bearish', top:c0.low, bottom:c2.high, size,
        midpoint:(c0.low+c2.high)/2, recency:w.length-1-i,
        c1Body: body, c1Range: range });
    }
    if (sweepDir === 'bull' && c2.low > c0.high) {
      const size = c2.low - c0.high;
      if (size < MIN_FVG_SIZE) continue;
      if (c1.close <= c1.open) continue; // must be bullish candle
      results.push({ type:'bullish', top:c2.low, bottom:c0.high, size,
        midpoint:(c2.low+c0.high)/2, recency:w.length-1-i,
        c1Body: body, c1Range: range });
    }

    // Inversion FVGs (higher priority)
    if (sweepDir === 'bear' && c2.low > c0.high) {
      const last = candles5m[candles5m.length-1];
      if (last.close < c0.high && c1.close >= c1.open) continue; // need bearish displacement
      if (last.close < c0.high) {
        const size = c2.low - c0.high;
        if (size < MIN_FVG_SIZE) continue;
        results.push({ type:'inversion_bear', top:c2.low, bottom:c0.high, size,
          midpoint:(c2.low+c0.high)/2, recency:w.length-1-i, priority:0,
          c1Body: body, c1Range: range });
      }
    }
    if (sweepDir === 'bull' && c2.high < c0.low) {
      const last = candles5m[candles5m.length-1];
      if (last.close > c0.low) {
        const size = c0.low - c2.high;
        if (size < MIN_FVG_SIZE) continue;
        results.push({ type:'inversion_bull', top:c0.low, bottom:c2.high, size,
          midpoint:(c0.low+c2.high)/2, recency:w.length-1-i, priority:0,
          c1Body: body, c1Range: range });
      }
    }
  }

  if (!results.length) return null;
  results.sort((a,b) => (a.priority||1)-(b.priority||1) || a.recency-b.recency || b.size-a.size);
  return results[0];
}

// ─── Simulate outcome ───────────────────────────────────────────────────────
function simulateOutcome(dir, entry, sl, tp1, tp2, tp1R, tp2R, future) {
  let tp1Hit = false, sl_ = sl;
  for (const c of future) {
    const slHit  = dir==='bull' ? c.low<=sl_  : c.high>=sl_;
    const t1Hit_ = dir==='bull' ? c.high>=tp1 : c.low<=tp1;
    const t2Hit  = dir==='bull' ? c.high>=tp2 : c.low<=tp2;
    if (!tp1Hit) {
      if (slHit)  return { result:'LOSS',       pnlR:-1 };
      if (t2Hit)  return { result:'WIN_TP2',    pnlR:+(0.5*tp1R+0.5*tp2R).toFixed(2) };
      if (t1Hit_) { tp1Hit=true; sl_=entry; }
    } else {
      if (slHit)  return { result:'WIN_TP1_BE', pnlR:+(0.5*tp1R).toFixed(2) };
      if (t2Hit)  return { result:'WIN_TP2',    pnlR:+(0.5*tp1R+0.5*tp2R).toFixed(2) };
    }
  }
  if (tp1Hit) return { result:'WIN_TP1_OPEN', pnlR:+(0.5*tp1R).toFixed(2) };
  return { result:'OPEN', pnlR:null };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
function run() {
  console.log('\n' + chalk.bold.yellow('  ◆ XAUUSD ICT SCALPING BACKTEST'));
  console.log(chalk.gray('  Period: 2025-06-11 → 2026-06-10'));
  console.log(chalk.gray('  Session: London open 07:00-10:00 UTC'));
  console.log(chalk.gray('  Structure: 15m bias | Entry: 5m FVG limit'));
  console.log(chalk.gray('  Sweep ref: Asia H/L + PDH/PDL | Min wick: $'+MIN_WICK));
  console.log(chalk.gray('  FVG: min $'+MIN_FVG_SIZE+' gap, displacement candle (body >'+Math.round(DISPLACE_RATIO*100)+'% range)'));
  console.log(chalk.gray('  SL: FVG boundary + $'+FVG_SL_BUFFER+' | TP1: 1.5R | TP2: 2.5R'));
  console.log(chalk.gray('  News filter: skip 30min window around NFP/FOMC/CPI\n'));

  const all5m     = loadChunks('xau1yr_5min');
  const all15m_raw = rollupM15(all5m);
  const allH1     = loadChunks('xau1yr_1h');

  const START    = new Date('2025-06-11T00:00:00Z');
  const END      = new Date('2026-06-10T23:59:59Z');
  const period5m = all5m.filter(c => { const t=new Date(c.time); return t>=START && t<=END; });

  console.log(chalk.gray(`  5m bars: ${period5m.length}  |  15m bars: ${all15m_raw.length}`));

  const funnel = {
    londonBars:0, sweeps:0, bos:0, fvgFound:0, newsBlocked:0,
    biasFiltered:0, riskFiltered:0, limitsFilled:0, limitsMissed:0,
    tradesGenerated:0
  };

  const signals = [];
  let balance = ACCOUNT_START, peak = ACCOUNT_START, maxDD = 0;
  let lastBar  = -999;
  let m15Ptr   = 0;

  for (let i = 100; i < period5m.length - 1; i++) {
    const bar = period5m[i];
    const h   = new Date(bar.time).getUTCHours();
    if (h < 7 || h >= 10) continue;  // London open only

    funnel.londonBars++;
    if (i - lastBar < COOLDOWN_BARS) continue;

    // Advance 15m pointer
    while (m15Ptr < all15m_raw.length - 1 && all15m_raw[m15Ptr+1].time <= bar.time) m15Ptr++;

    const dateStr   = bar.time.slice(0, 10);
    const slice5m   = period5m.slice(Math.max(0, i - 300), i + 1);
    const slice15m  = all15m_raw.slice(Math.max(0, m15Ptr - 60), m15Ptr + 1);

    // Step 1: Sweep
    const sweep = detectSweep(slice5m, dateStr);
    if (!sweep) continue;
    funnel.sweeps++;

    // Step 2: 15m bias filter — only trade in direction aligned with 15m structure
    const bias = get15mBias(slice15m);
    const biasOk = (sweep.dir === 'bear' && (bias === 'bearish' || bias === 'neutral'))
                || (sweep.dir === 'bull' && (bias === 'bullish' || bias === 'neutral'));
    if (!biasOk) { funnel.biasFiltered++; continue; }

    // Step 3: BOS confirmation
    const bos = detectBOS(slice5m, sweep.dir);
    if (!bos.confirmed) continue;
    funnel.bos++;

    // Step 4: FVG (post-sweep, displacement required)
    const sweepIdx = slice5m.length - 1 - sweep.barsAgo;
    const fvg = detectFVG(slice5m, sweep.dir, sweepIdx);
    if (!fvg) continue;
    funnel.fvgFound++;

    // Step 5: News filter
    if (isNearNews(bar.time)) { funnel.newsBlocked++; continue; }

    funnel.tradesGenerated++;

    // ── Entry: FVG midpoint limit ─────────────────────────────────────────
    const isLong = sweep.dir === 'bull';
    const entry  = fvg.midpoint;

    // Scalp SL: FVG boundary + $3 buffer (tight, based on FVG not sweep extreme)
    let sl;
    if (isLong) {
      sl = fvg.bottom - FVG_SL_BUFFER;
    } else {
      sl = fvg.top + FVG_SL_BUFFER;
    }
    const risk = Math.abs(entry - sl);
    if (risk <= 0 || risk > entry * 0.015) { funnel.riskFiltered++; continue; }

    // Scalp TPs: fixed 1.5R and 2.5R
    const tp1R = 1.5, tp2R = 2.5;
    const tp1  = isLong ? entry + risk * tp1R : entry - risk * tp1R;
    const tp2  = isLong ? entry + risk * tp2R : entry - risk * tp2R;

    // Fill simulation: check if price returns to FVG midpoint within 12 bars
    const fillWindow = period5m.slice(i+1, i+13);
    let fillIdx = -1;
    for (let f = 0; f < fillWindow.length; f++) {
      const c = fillWindow[f];
      if (isLong  && c.low  <= entry) { fillIdx = f; break; }
      if (!isLong && c.high >= entry) { fillIdx = f; break; }
    }

    if (fillIdx === -1) {
      funnel.limitsMissed++;
      signals.push({ time:bar.time, dir:isLong?'BUY':'SELL',
        entry:+entry.toFixed(2), result:'MISSED', pnlR:0, pnlGBP:0,
        balanceAfter:+balance.toFixed(2), sweep:sweep.levelName,
        fvgType:fvg.type, fvgSize:+fvg.size.toFixed(2), risk:+risk.toFixed(2) });
      continue;
    }

    funnel.limitsFilled++;
    lastBar = i;

    const future  = period5m.slice(i+1+fillIdx+1, i+1+fillIdx+1+SIM_BARS);
    const outcome = simulateOutcome(sweep.dir, entry, sl, tp1, tp2, tp1R, tp2R, future);
    const riskGBP = balance * RISK_PCT;
    const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;

    if (pnlGBP !== null) {
      balance += pnlGBP;
      if (balance > peak) peak = balance;
      const dd = (peak - balance) / peak * 100;
      if (dd > maxDD) maxDD = dd;
    }

    signals.push({ time:bar.time, dir:isLong?'BUY':'SELL',
      entry:+entry.toFixed(2), sl:+sl.toFixed(2), tp1:+tp1.toFixed(2), tp2:+tp2.toFixed(2),
      tp1R, tp2R, risk:+risk.toFixed(2), fvgSize:+fvg.size.toFixed(2),
      fvgType:fvg.type, sweep:sweep.levelName, bos15mBias:bias,
      fillBarsAfter:fillIdx+1,
      riskGBP:+riskGBP.toFixed(2),
      pnlGBP: pnlGBP!=null ? +pnlGBP.toFixed(2) : null,
      balanceAfter:+balance.toFixed(2),
      ...outcome });
  }

  // ─── Results ─────────────────────────────────────────────────────────────
  const sep    = '═'.repeat(72);
  const filled = signals.filter(s => s.result !== 'MISSED');
  const missed = signals.filter(s => s.result === 'MISSED');
  const closed = filled.filter(s => s.pnlR != null);
  const wins   = closed.filter(s => s.pnlR > 0);
  const losses = closed.filter(s => s.pnlR < 0);
  const totalR = +closed.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
  const totalGBP = +closed.reduce((s,x)=>s+(x.pnlGBP||0),0).toFixed(2);
  const wr     = closed.length ? Math.round(wins.length/closed.length*100) : 0;
  const pf     = losses.length
    ? +(wins.reduce((s,x)=>s+x.pnlR,0)/Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2)
    : wins.length ? '∞' : 0;

  console.log('\n' + sep);
  console.log(chalk.bold.yellow('  ══ DETECTION FUNNEL ══'));
  console.log(sep);
  console.log(chalk.gray('  London bars scanned:     ') + funnel.londonBars.toLocaleString());
  console.log(chalk.cyan('  → Sweeps found:          ') + funnel.sweeps + chalk.gray(` (${(funnel.sweeps/funnel.londonBars*100).toFixed(1)}%)`));
  console.log(chalk.cyan('  → 15m bias mismatch skip:') + funnel.biasFiltered);
  console.log(chalk.cyan('  → BOS confirmed:         ') + funnel.bos + chalk.gray(` (${funnel.sweeps?(funnel.bos/funnel.sweeps*100).toFixed(0):0}% of sweeps)`));
  console.log(chalk.cyan('  → FVG w/displacement:    ') + funnel.fvgFound + chalk.gray(` (${funnel.bos?(funnel.fvgFound/funnel.bos*100).toFixed(0):0}% of BOS)`));
  console.log(chalk.cyan('  → News blocked:          ') + funnel.newsBlocked);
  console.log(chalk.green('  → Trades generated:      ') + funnel.tradesGenerated);
  console.log(chalk.green('  → Limit fills:           ') + funnel.limitsFilled + chalk.gray(` (${funnel.tradesGenerated?(funnel.limitsFilled/funnel.tradesGenerated*100).toFixed(0):0}% fill rate)`));
  console.log(chalk.yellow('  → Limits missed:         ') + funnel.limitsMissed);
  console.log(chalk.gray('  → Risk filtered:         ') + funnel.riskFiltered);

  console.log('\n' + sep);
  console.log(chalk.bold.yellow('  ══ 1-YEAR SCALP RESULTS ══'));
  console.log(sep);
  console.log(chalk.gray('  Total signals:   ') + signals.length);
  console.log(chalk.gray('  Filled:          ') + chalk.green(filled.length) +
    chalk.gray(` (${signals.length?Math.round(filled.length/signals.length*100):0}% fill rate)  Missed: ${missed.length}`));
  console.log(chalk.gray('  Wins:            ') + chalk.green(wins.length));
  console.log(chalk.gray('  Losses:          ') + chalk.red(losses.length));
  console.log(chalk.gray('  Win rate:        ') + (wr>=50?chalk.green:chalk.yellow)(wr+'%'));
  console.log(chalk.gray('  Net R:           ') + (totalR>=0?chalk.green(`+${totalR}R`):chalk.red(`${totalR}R`)));
  console.log(chalk.gray('  Profit factor:   ') + chalk.cyan(pf));
  console.log('\n' + chalk.bold.yellow('  ── ACCOUNT ──'));
  console.log(chalk.gray('  Start:  £1,500   End: ') + (balance>=ACCOUNT_START?chalk.green:chalk.red)('£'+balance.toFixed(2)) +
    chalk.gray('  Return: ') + (balance>=ACCOUNT_START?chalk.green:chalk.red)(fmtPct((balance-ACCOUNT_START)/ACCOUNT_START*100)) +
    chalk.gray('  MaxDD: ') + chalk.yellow(maxDD.toFixed(1)+'%'));

  // Direction breakdown
  for (const d of ['BUY','SELL']) {
    const ds = closed.filter(s=>s.dir===d);
    if (!ds.length) continue;
    const dw=ds.filter(s=>s.pnlR>0).length, dl=ds.filter(s=>s.pnlR<0).length;
    const dwr=(dw+dl)?Math.round(dw/(dw+dl)*100):0;
    const dr=+ds.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
    process.stdout.write(chalk.gray(`  ${d.padEnd(5)}`)+`${ds.length} trades  `+chalk.green(`${dw}W`)+'/'+chalk.red(`${dl}L`)+
      chalk.gray(`  ${dwr}% WR  `)+(dr>=0?chalk.green(`+${dr}R`):chalk.red(`${dr}R`)));
    console.log();
  }

  // FVG type
  const byFVG = {};
  closed.forEach(s => { const k=s.fvgType; byFVG[k]=(byFVG[k]||[]).concat(s); });
  if (Object.keys(byFVG).length) {
    console.log(chalk.gray('\n  FVG type:'));
    Object.entries(byFVG).sort().forEach(([t,ss]) => {
      const w=ss.filter(s=>s.pnlR>0).length, l=ss.filter(s=>s.pnlR<0).length;
      const wr=(w+l)?Math.round(w/(w+l)*100):0;
      const r=+ss.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
      console.log(chalk.gray(`    ${t.padEnd(20)} ${ss.length} trades  ${w}W/${l}L  ${wr}% WR  `)+
        (r>=0?chalk.green(`+${r}R`):chalk.red(`${r}R`)));
    });
  }

  // Sweep type
  const bySweep = {};
  closed.forEach(s => { bySweep[s.sweep]=(bySweep[s.sweep]||[]).concat(s); });
  if (Object.keys(bySweep).length) {
    console.log(chalk.gray('\n  Sweep level:'));
    Object.entries(bySweep).sort().forEach(([t,ss]) => {
      const w=ss.filter(s=>s.pnlR>0).length, l=ss.filter(s=>s.pnlR<0).length;
      const wr=(w+l)?Math.round(w/(w+l)*100):0;
      const r=+ss.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
      console.log(chalk.gray(`    ${t.padEnd(20)} ${ss.length} trades  ${w}W/${l}L  ${wr}% WR  `)+
        (r>=0?chalk.green(`+${r}R`):chalk.red(`${r}R`)));
    });
  }

  // Month by month
  const byMonth = {};
  closed.forEach(s => {
    const d=new Date(s.time), k=`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
    byMonth[k]=(byMonth[k]||[]).concat(s);
  });
  console.log(chalk.gray('\n  Month by month:'));
  Object.entries(byMonth).sort().forEach(([mo,ms]) => {
    const mW=ms.filter(s=>s.pnlR>0).length, mL=ms.filter(s=>s.pnlR<0).length;
    const mR=+ms.reduce((s,x)=>s+x.pnlR,0).toFixed(1);
    const mWR=(mW+mL)?Math.round(mW/(mW+mL)*100):0;
    const mGBP=+ms.reduce((s,x)=>s+(x.pnlGBP||0),0).toFixed(2);
    console.log(chalk.gray(`    ${mo}  ${ms.length} trades  `)+chalk.green(`${mW}W`)+'/'+chalk.red(`${mL}L`)+
      chalk.gray(`  ${mWR}% WR  `)+(mR>=0?chalk.green(`+${mR}R`):chalk.red(`${mR}R`))+
      chalk.gray('  ')+(mGBP>=0?chalk.green(fmtGBP(mGBP)):chalk.red(fmtGBP(mGBP))));
  });

  // Individual trades
  console.log(chalk.gray('\n  Trade log (filled only):'));
  filled.forEach(s => {
    const col = s.pnlR > 0 ? chalk.green : s.pnlR < 0 ? chalk.red : chalk.gray;
    console.log(col(`    ${s.time.slice(0,16)}  ${s.dir.padEnd(4)} entry:${s.entry}  sl:${s.sl}  risk:$${s.risk}  fvg:${s.fvgType}  sweep:${s.sweep}  ${s.result}  ${s.pnlR != null ? (s.pnlR>=0?'+':'')+s.pnlR+'R' : 'OPEN'}`));
  });

  console.log('\n' + sep + '\n');

  fs.writeFileSync(path.join(__dirname,'..','backtest_report_xau_scalp.json'),
    JSON.stringify({ period:'2025-06-11 → 2026-06-10', method:'ICT scalping — London open 07-10 UTC',
      generatedAt:new Date().toISOString(), funnel,
      stats:{ total:signals.length, filled:filled.length, missed:missed.length,
        wins:wins.length, losses:losses.length, winRate:wr+'%',
        netR:totalR, profitFactor:pf },
      account:{ start:ACCOUNT_START, end:+balance.toFixed(2),
        returnPct:+((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1),
        maxDrawdown:+maxDD.toFixed(1) },
      signals }, null, 2));
  console.log(chalk.gray('  Report → backtest_report_xau_scalp.json\n'));
}

run();
