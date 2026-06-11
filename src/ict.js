'use strict';

// ─── DJ30 ICT Analysis Engine ─────────────────────────────────────────────────
// Strategy: KZ + Fresh Sweep (≤6 bars) + MSS → enter on MSS bar close
//
// Key difference from XAUUSD:
//   • DJ30 impulses sharply at NY open — does NOT retrace into FVGs
//   • FVG confirmation gate removed entirely
//   • Entry is the MSS confirmation bar itself (not a limit/pullback)
//   • Sweep must be fresh (within 6 bars) to avoid stale setups
//   • HTF bias used as a bonus score point, NOT a hard gate

// ─── HTF Bias ─────────────────────────────────────────────────────────────────
function htfBias(dailyCandles, h4Candles) {
  function swings(arr) {
    const highs = [], lows = [];
    for (let i = 2; i < arr.length - 2; i++) {
      const c = arr[i];
      if (c.high > arr[i-1].high && c.high > arr[i-2].high && c.high > arr[i+1].high && c.high > arr[i+2].high)
        highs.push(c.high);
      if (c.low < arr[i-1].low && c.low < arr[i-2].low && c.low < arr[i+1].low && c.low < arr[i+2].low)
        lows.push(c.low);
    }
    return { highs, lows };
  }
  function bias({ highs, lows }) {
    if (highs.length < 2 || lows.length < 2) return 'ranging';
    const hh = highs[highs.length-1] > highs[highs.length-2];
    const hl = lows[lows.length-1]   > lows[lows.length-2];
    const lh = highs[highs.length-1] < highs[highs.length-2];
    const ll = lows[lows.length-1]   < lows[lows.length-2];
    if (hh && hl) return 'bullish';
    if (lh && ll) return 'bearish';
    return 'ranging';
  }
  const d = bias(swings(dailyCandles));
  const h = bias(swings(h4Candles));
  if (d === 'bullish' && h === 'bullish') return 'bullish';
  if (d === 'bearish' && h === 'bearish') return 'bearish';
  if (d === 'bullish' && h === 'bearish') return 'pullback_in_bull';
  if (d === 'bearish' && h === 'bullish') return 'pullback_in_bear';
  return 'ranging';
}

// ─── Liquidity Sweep Detection ────────────────────────────────────────────────
// Fresh sweep only: wicked beyond level and CLOSED back within last FRESH_BARS bars
const FRESH_BARS = 6;

function detectSweep(candles15m, candles5m) {
  const recent15 = candles15m.slice(-50);
  const levels   = [];

  // Equal highs (BSL)
  for (let i = 2; i < recent15.length - 1; i++) {
    const c    = recent15[i];
    const prev = recent15.slice(Math.max(0, i-10), i);
    const eqH  = prev.find(p => Math.abs(p.high - c.high) / c.high < 0.0005);
    if (eqH) levels.push({ price: Math.max(c.high, eqH.high), type: 'BSL', name: 'Equal Highs (BSL)' });
  }

  // Equal lows (SSL)
  for (let i = 2; i < recent15.length - 1; i++) {
    const c    = recent15[i];
    const prev = recent15.slice(Math.max(0, i-10), i);
    const eqL  = prev.find(p => Math.abs(p.low - c.low) / c.low < 0.0005);
    if (eqL) levels.push({ price: Math.min(c.low, eqL.low), type: 'SSL', name: 'Equal Lows (SSL)' });
  }

  // Prev day high/low
  const yesterday = candles15m.slice(-100).filter(c => {
    const h = new Date(c.time).getUTCHours(); return h >= 21 || h < 2;
  });
  if (yesterday.length) {
    levels.push({ price: Math.max(...yesterday.map(c => c.high)), type: 'BSL', name: 'Prev Day High' });
    levels.push({ price: Math.min(...yesterday.map(c => c.low)),  type: 'SSL', name: 'Prev Day Low' });
  }

  // Scan only last FRESH_BARS 5m candles for sweep
  const results = [];
  for (let back = 0; back <= FRESH_BARS; back++) {
    const idx = candles5m.length - 1 - back;
    if (idx < 0) break;
    const c = candles5m[idx];
    for (const lvl of levels) {
      if (lvl.type === 'BSL' && c.high > lvl.price && c.close < lvl.price)
        results.push({ dir: 'bear', level: lvl.price, levelName: lvl.name, barsAgo: back });
      if (lvl.type === 'SSL' && c.low < lvl.price && c.close > lvl.price)
        results.push({ dir: 'bull', level: lvl.price, levelName: lvl.name, barsAgo: back });
    }
  }

  if (!results.length) return { detected: false };
  results.sort((a, b) => a.barsAgo - b.barsAgo);
  return { detected: true, ...results[0] };
}

// ─── Market Structure Shift ───────────────────────────────────────────────────
function detectMSS(candles5m, sweepDir) {
  const window = candles5m.slice(-20);
  if (window.length < 5) return { confirmed: false };
  const last = window[window.length - 1];
  const prev = window[window.length - 2];

  if (sweepDir === 'bear') {
    // BOS down: close below a recent swing low
    let swingLow = Infinity;
    for (let i = 0; i < window.length - 3; i++) {
      const c = window[i];
      if (c.low < (window[i-1]?.low ?? Infinity) && c.low < (window[i+1]?.low ?? Infinity))
        swingLow = Math.min(swingLow, c.low);
    }
    if (swingLow < Infinity && last.close < swingLow)
      return { confirmed: true, type: 'BOS_DOWN', level: swingLow, entryClose: last.close, description: 'Broke below swing low' };
    // CHoCH: close below prev candle low
    if (last.close < prev.low)
      return { confirmed: true, type: 'CHoCH', level: prev.low, entryClose: last.close, description: 'Change of character down' };
  }

  if (sweepDir === 'bull') {
    let swingHigh = -Infinity;
    for (let i = 0; i < window.length - 3; i++) {
      const c = window[i];
      if (c.high > (window[i-1]?.high ?? -Infinity) && c.high > (window[i+1]?.high ?? -Infinity))
        swingHigh = Math.max(swingHigh, c.high);
    }
    if (swingHigh > -Infinity && last.close > swingHigh)
      return { confirmed: true, type: 'BOS_UP', level: swingHigh, entryClose: last.close, description: 'Broke above swing high' };
    if (last.close > prev.high)
      return { confirmed: true, type: 'CHoCH', level: prev.high, entryClose: last.close, description: 'Change of character up' };
  }

  return { confirmed: false };
}

// ─── TP Levels — meaningful structure, min R floors ──────────────────────────
function calcTPs(dir, entry, risk, candles5m, h1Candles, candles15m) {
  const isLong  = dir === 'bull';
  const tp2MinR = 2.5;
  const tp3MinR = 4.0;
  const tp2MaxR = 8.0;
  const tp3MaxR = 12.0;

  function rOf(price) { return Math.abs(price - entry) / risk; }

  // 1H swing levels (session structure)
  const c1h = h1Candles.slice(-48);
  const h1Levels = [];
  for (let i = 2; i < c1h.length - 2; i++) {
    const c = c1h[i];
    if (isLong && c.high > c1h[i-1].high && c.high > c1h[i-2].high && c.high > c1h[i+1].high)
      h1Levels.push({ price: c.high, source: '1H swing high' });
    if (!isLong && c.low < c1h[i-1].low && c.low < c1h[i-2].low && c.low < c1h[i+1].low)
      h1Levels.push({ price: c.low, source: '1H swing low' });
  }

  // Prev day high/low from 15m
  const yesterday = candles15m.slice(-100).filter(c => {
    const h = new Date(c.time).getUTCHours(); return h >= 21 || h < 2;
  });
  const pdh = yesterday.length ? Math.max(...yesterday.map(c => c.high)) : null;
  const pdl = yesterday.length ? Math.min(...yesterday.map(c => c.low))  : null;

  // TP2 — 1H swing levels within 2.5–8R
  const tp2Cands = h1Levels.filter(l => {
    const r = rOf(l.price);
    return r >= tp2MinR && r <= tp2MaxR && (isLong ? l.price > entry : l.price < entry);
  }).sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));

  const tp2Obj  = tp2Cands[0];
  const tp2     = tp2Obj ? tp2Obj.price : (isLong ? entry + risk * tp2MinR : entry - risk * tp2MinR);
  const tp2Desc = tp2Obj ? tp2Obj.source : `Fixed ${tp2MinR}R`;
  const tp2R    = rOf(tp2);

  // TP3 — PDH/PDL first, then further 1H swings, min 4R and beyond TP2
  const tp3Cands = [];
  if (isLong  && pdh && rOf(pdh) > tp2R && rOf(pdh) <= tp3MaxR) tp3Cands.push({ price: pdh, source: 'Prev Day High' });
  if (!isLong && pdl && rOf(pdl) > tp2R && rOf(pdl) <= tp3MaxR) tp3Cands.push({ price: pdl, source: 'Prev Day Low' });
  for (const l of h1Levels) {
    const r = rOf(l.price);
    if (r >= tp3MinR && r > tp2R + 0.5 && r <= tp3MaxR && (isLong ? l.price > tp2 : l.price < tp2))
      tp3Cands.push(l);
  }
  tp3Cands.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));

  const tp3Obj  = tp3Cands[0];
  const tp3     = tp3Obj ? tp3Obj.price : (isLong ? entry + risk * 5 : entry - risk * 5);
  const tp3Desc = tp3Obj ? tp3Obj.source : 'Fixed 5R extension';

  return {
    tp2: parseFloat(tp2.toFixed(2)), tp2Desc,
    tp3: parseFloat(tp3.toFixed(2)), tp3Desc
  };
}

// ─── Confluence Score ─────────────────────────────────────────────────────────
function scoreConfluence(sweep, mss, htfBiasVal, dir) {
  // All three core conditions required: KZ (enforced by caller) + Sweep + MSS
  // HTF alignment is a bonus — not a gate
  let score = 30;        // KZ base
  const tags = ['KZ'];

  if (sweep.detected) { score += 35; tags.push('SWEEP'); }
  if (mss.confirmed)  { score += 35; tags.push('MSS'); }

  // Bonus: HTF bias aligned with trade direction
  const aligned = dir && (
    (dir === 'bull' && (htfBiasVal === 'bullish' || htfBiasVal === 'pullback_in_bear')) ||
    (dir === 'bear' && (htfBiasVal === 'bearish' || htfBiasVal === 'pullback_in_bull'))
  );
  if (aligned) { score = Math.min(score + 10, 100); tags.push('HTF_ALIGNED'); }

  const grade = score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B' : score >= 60 ? 'C' : 'D';
  return { score, grade, tags };
}

// ─── Main Analysis ────────────────────────────────────────────────────────────
function runICTAnalysis(data) {
  const { daily, h4, h1, candles15m, candles5m } = data;

  const bias  = htfBias(daily, h4);
  const sweep = detectSweep(candles15m, candles5m);
  const mss   = sweep.detected ? detectMSS(candles5m, sweep.dir) : { confirmed: false };
  const dir   = sweep.dir || null;
  const conf  = scoreConfluence(sweep, mss, bias, dir);

  const htfAligned = dir && (
    (dir === 'bull' && (bias === 'bullish' || bias === 'pullback_in_bear')) ||
    (dir === 'bear' && (bias === 'bearish' || bias === 'pullback_in_bull'))
  );

  let signal = null;

  // Gate: sweep detected + MSS confirmed + min 80% score (KZ+Sweep+MSS = 100, or 90 without HTF)
  if (dir && sweep.detected && mss.confirmed && conf.score >= 80) {
    const lastCandle = candles5m[candles5m.length - 1];
    const isLong     = dir === 'bull';

    // Entry = close of MSS confirmation bar (market execution)
    const entry = mss.entryClose || lastCandle.close;

    // SL: just beyond the sweep level
    const slBuf = entry * 0.0012;
    const sl    = isLong
      ? sweep.level - slBuf
      : sweep.level + slBuf;

    const risk = Math.abs(entry - sl);

    // Sanity check: SL shouldn't be more than 1% away (DJ30 is ~500pts wide)
    if (risk <= 0 || risk > entry * 0.012) {
      return { bias, sweep, mss, fvg: { found: false }, confluence: conf, htfAligned: !!htfAligned, signal: null, signals: [], liquidity: {}, structure: { bias, mss: null } };
    }

    const tp1 = isLong ? entry + risk * 1.5 : entry - risk * 1.5;
    const { tp2, tp2Desc, tp3, tp3Desc } = calcTPs(dir, entry, risk, candles5m, h1, candles15m);

    signal = {
      direction:   isLong ? 'BUY' : 'SELL',
      entry:       parseFloat(entry.toFixed(2)),
      sl:          parseFloat(sl.toFixed(2)),
      tp1:         parseFloat(tp1.toFixed(2)),
      tp2:         parseFloat(tp2.toFixed(2)),
      tp3:         parseFloat(tp3.toFixed(2)),
      tp2Desc,
      tp3Desc,
      rr:          '1.5',
      rr1:         '1.5',
      stopPoints:  Math.round(risk),
      confluence:  conf.score,
      grade:       conf.grade,
      tags:        conf.tags,
      sweep:       sweep.levelName,
      mssType:     mss.type,
      htfBias:     bias,
      htfAligned:  !!htfAligned,
      hasFVG:      false,
      timestamp:   new Date().toISOString(),
      price:       lastCandle.close
    };
  }

  return {
    bias,
    sweep,
    mss,
    fvg: { found: false },
    confluence: conf,
    htfAligned: !!htfAligned,
    signal,
    signals: signal ? [signal] : [],
    liquidity: { nearestBSL: null, nearestSSL: null },
    structure: { bias, mss: mss.confirmed ? mss : null }
  };
}

module.exports = {
  runICTAnalysis,
  detectMarketStructure: () => ({ highs: [], lows: [] }),
  findOrderBlocks:       () => ({ bullish: null, bearish: null }),
  findFairValueGaps:     () => ({ bullish: null, bearish: null, all: [] }),
  findLiquidityPools:    () => ({ bsl: [], ssl: [], nearestBSL: null, nearestSSL: null })
};
