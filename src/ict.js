'use strict';

// ─── DJ30 ICT Analysis Engine — Video Checklist Aligned ─────────────────────
// Checklist:
//  1. Mark 5m swing highs/lows (BSL/SSL) formed BEFORE 13:30 UTC (NY open)
//  2. Wait for price to sweep one of those levels during the kill zone
//  3. Drop to 1m — find market structure shift (swing break + displacement candle)
//  4. Identify FVG within the 1m displacement — no FVG = no trade
//  5. Place LIMIT order at FVG boundary (no confirmation wick required)
//  6. SL beyond the 1m MSS swing point
//  7. TP at opposing pre-KZ liquidity

// ─── HTF Bias ─────────────────────────────────────────────────────────────────
function htfBias(dailyCandles, h4Candles) {
  function swings(arr) {
    const highs = [], lows = [];
    for (let i = 2; i < arr.length - 2; i++) {
      const c = arr[i];
      if (c.high > arr[i-1].high && c.high > arr[i-2].high && c.high > arr[i+1].high && c.high > arr[i+2].high)
        highs.push(c.high);
      if (c.low  < arr[i-1].low  && c.low  < arr[i-2].low  && c.low  < arr[i+1].low  && c.low  < arr[i+2].low)
        lows.push(c.low);
    }
    return { highs, lows };
  }
  function bias(swg) {
    const { highs, lows } = swg;
    if (highs.length < 2 || lows.length < 2) return 'ranging';
    const hh = highs[highs.length-1] > highs[highs.length-2];
    const hl = lows[lows.length-1]   > lows[lows.length-2];
    const lh = highs[highs.length-1] < highs[highs.length-2];
    const ll = lows[lows.length-1]   < lows[lows.length-2];
    if (hh && hl) return 'bullish';
    if (lh && ll) return 'bearish';
    return 'ranging';
  }
  const daily = bias(swings(dailyCandles));
  const h4    = bias(swings(h4Candles));
  if (daily === 'bullish' && h4 === 'bullish') return 'bullish';
  if (daily === 'bearish' && h4 === 'bearish') return 'bearish';
  if (daily === 'bullish' && h4 === 'bearish') return 'pullback_in_bull';
  if (daily === 'bearish' && h4 === 'bullish') return 'pullback_in_bear';
  return 'ranging';
}

// ─── Step 1: Liquidity Levels ─────────────────────────────────────────────────
// DIA only trades 13:30–20:00 UTC (no pre-market data in TwelveData).
// We adapt the ICT "pre-KZ" concept using the current SESSION's swing highs/lows,
// filtered by the session-gap rule (>30 min gap = overnight boundary) so we never
// use stale overnight levels. Levels formed at 13:30–14:00 become the BSL/SSL
// that get swept at 14:00–16:00, mirroring the video's London→NY sweep pattern.
function buildPreKZLevels(candles5m) {
  const GAP_MS = 30 * 60 * 1000; // 30 min = session boundary
  let sessionStart = 0;
  for (let i = candles5m.length - 1; i > 0; i--) {
    const gap = new Date(candles5m[i].time).getTime() - new Date(candles5m[i-1].time).getTime();
    if (gap > GAP_MS) { sessionStart = i; break; }
  }
  const sess = candles5m.slice(sessionStart);
  if (sess.length < 5) return { levels: [] };

  const raw = [];
  for (let i = 1; i < sess.length - 1; i++) {
    const c = sess[i];
    if (c.high > sess[i-1].high && c.high > sess[i+1].high)
      raw.push({ price: c.high, type: 'BSL', name: `Intraday H ${c.time.slice(11,16)}` });
    if (c.low < sess[i-1].low && c.low < sess[i+1].low)
      raw.push({ price: c.low,  type: 'SSL', name: `Intraday L ${c.time.slice(11,16)}` });
  }

  const levels = [];
  for (const lvl of raw) {
    if (!levels.find(d => d.type === lvl.type && Math.abs(d.price - lvl.price) / lvl.price < 0.0005))
      levels.push(lvl);
  }
  return { levels };
}

// ─── Step 2: Sweep Detection ──────────────────────────────────────────────────
// Scans the last 12 5m bars for a wick beyond a session-level that closed back.
// Both sweep candle and level must be from the current session (post-gap-filter).
function detectSweep(candles5m) {
  const { levels } = buildPreKZLevels(candles5m);
  if (!levels.length) return { detected: false };

  const results = [];
  for (let back = 0; back <= 12; back++) {
    const idx = candles5m.length - 1 - back;
    if (idx < 0) break;
    const c = candles5m[idx];
    for (const lvl of levels) {
      if (lvl.type === 'BSL' && c.high > lvl.price && c.close < lvl.price)
        results.push({ dir: 'bear', level: lvl.price, levelName: lvl.name,
                       barsAgo: back, wick: c.high, sweepCandleIdx: idx,
                       sweepCandleTime: c.time });
      if (lvl.type === 'SSL' && c.low < lvl.price && c.close > lvl.price)
        results.push({ dir: 'bull', level: lvl.price, levelName: lvl.name,
                       barsAgo: back, wick: c.low, sweepCandleIdx: idx,
                       sweepCandleTime: c.time });
    }
  }

  if (!results.length) return { detected: false };
  results.sort((a, b) => a.barsAgo - b.barsAgo);
  return { detected: true, ...results[0] };
}

// ─── Step 3: 1m Market Structure Shift ───────────────────────────────────────
// After the sweep, drops to 1m and looks for a swing point break with a
// displacement candle (strong-bodied candle ≥ 60% of its own range).
function detectMSS1m(candles1m, sweepDir, sweepCandleTime) {
  const DISP_BODY_RATIO = 0.6;
  const MIN_SWING_BARS  = 2;

  const sweepTs = new Date(sweepCandleTime).getTime();
  const post = candles1m.filter(c => new Date(c.time).getTime() > sweepTs).slice(0, 60);

  if (post.length < 5) return { confirmed: false };

  if (sweepDir === 'bear') {
    for (let i = MIN_SWING_BARS; i < post.length - MIN_SWING_BARS; i++) {
      if (post[i].low >= post[i-1].low || post[i].low >= post[i+1].low) continue;
      const swingLevel = post[i].low;
      for (let j = i + 1; j < post.length; j++) {
        const c = post[j];
        if (c.close >= swingLevel) continue;
        const body  = c.open - c.close;
        const range = c.high - c.low;
        if (range > 0 && body / range >= DISP_BODY_RATIO)
          return { confirmed: true, type: 'MSS_BEAR', swingLevel,
                   swingTime: post[i].time, dispCandleIdx: j,
                   dispCandle: c, mssTime: c.time };
      }
    }
  }

  if (sweepDir === 'bull') {
    for (let i = MIN_SWING_BARS; i < post.length - MIN_SWING_BARS; i++) {
      if (post[i].high <= post[i-1].high || post[i].high <= post[i+1].high) continue;
      const swingLevel = post[i].high;
      for (let j = i + 1; j < post.length; j++) {
        const c = post[j];
        if (c.close <= swingLevel) continue;
        const body  = c.close - c.open;
        const range = c.high - c.low;
        if (range > 0 && body / range >= DISP_BODY_RATIO)
          return { confirmed: true, type: 'MSS_BULL', swingLevel,
                   swingTime: post[i].time, dispCandleIdx: j,
                   dispCandle: c, mssTime: c.time };
      }
    }
  }

  return { confirmed: false };
}

// ─── Step 4: 1m FVG in the Displacement ──────────────────────────────────────
// Finds the fair value gap created by the displacement candle sequence on 1m.
// No confirmation wick required — the zone itself is the limit order trigger.
function detectFVG1m(candles1m, sweepDir, sweepCandleTime, mss) {
  if (!mss.confirmed) return { found: false };

  const sweepTs = new Date(sweepCandleTime).getTime();
  const post    = candles1m.filter(c => new Date(c.time).getTime() > sweepTs).slice(0, 60);

  const di    = mss.dispCandleIdx;
  const start = Math.max(0, di - 3);
  const end   = Math.min(post.length - 1, di + 3);

  const candidates = [];
  for (let i = start; i <= end - 2; i++) {
    const c0 = post[i], c2 = post[i + 2];
    if (!c0 || !c2) continue;
    if (sweepDir === 'bear' && c2.high < c0.low) {
      const size = c0.low - c2.high;
      if (size > 0) candidates.push({ top: c0.low, bottom: c2.high, size, zoneFormedAt: c2.time });
    }
    if (sweepDir === 'bull' && c2.low > c0.high) {
      const size = c2.low - c0.high;
      if (size > 0) candidates.push({ top: c2.low, bottom: c0.high, size, zoneFormedAt: c2.time });
    }
  }

  if (!candidates.length) return { found: false };

  const best = candidates.sort((a, b) => b.size - a.size)[0];

  // Limit order at FVG boundary:
  // Bull → price retraces DOWN into the gap → limit BUY at the top edge (first touch)
  // Bear → price retraces UP into the gap → limit SELL at the bottom edge (first touch)
  const entryPrice = sweepDir === 'bull' ? best.top : best.bottom;

  return {
    found:        true,
    top:          best.top,
    bottom:       best.bottom,
    size:         best.size,
    entryPrice,
    entryZone:    `${best.bottom.toFixed(2)}–${best.top.toFixed(2)}`,
    zoneFormedAt: best.zoneFormedAt,
    inFVG:        true  // always true — no confirmation wick needed, limit order placed at zone
  };
}

// ─── Step 5: Wait for Limit Fill ─────────────────────────────────────────────
// After the FVG zone is identified, scan forward on 1m for price to actually
// reach the limit order price. Returns the fill candle's close and time.
function waitForLimitFill1m(candles1m, fvg, sweepDir) {
  if (!fvg.found || !fvg.zoneFormedAt) return null;

  const zoneTs = new Date(fvg.zoneFormedAt).getTime();
  const after  = candles1m.filter(c => new Date(c.time).getTime() > zoneTs);

  for (const c of after) {
    if (sweepDir === 'bull' && c.low <= fvg.entryPrice)
      return { price: fvg.entryPrice, time: c.time }; // limit buy filled
    if (sweepDir === 'bear' && c.high >= fvg.entryPrice)
      return { price: fvg.entryPrice, time: c.time }; // limit sell filled
  }
  return null; // limit order not yet triggered
}

// ─── Step 7: Opposing Pre-KZ Liquidity TPs ───────────────────────────────────
// Targets the pre-KZ swing levels on the OPPOSITE side of the trade.
// Bull trade targets BSL (swing highs) above entry; bear targets SSL below.
// Falls back to fixed R-multiples if no level clears the minimum.
function opposingLiquidityTPs(dir, entry, risk, candles5m, nowIso, h1Candles) {
  const isLong = dir === 'bull';
  const { levels } = buildPreKZLevels(candles5m);

  const opposing = levels
    .filter(l => isLong
      ? l.type === 'BSL' && l.price > entry + risk * 1.0
      : l.type === 'SSL' && l.price < entry - risk * 1.0)
    .sort((a, b) => isLong ? a.price - b.price : b.price - a.price);

  // Supplement with 1H swing highs/lows beyond 2R if pre-KZ levels are thin
  const h1w = (h1Candles || []).slice(-24);
  const h1targets = [];
  for (let i = 2; i < h1w.length - 2; i++) {
    const c = h1w[i];
    if (isLong && c.high > h1w[i-1].high && c.high > h1w[i-2].high && c.high > h1w[i+1].high)
      h1targets.push({ price: c.high, name: '1H swing high' });
    if (!isLong && c.low < h1w[i-1].low && c.low < h1w[i-2].low && c.low < h1w[i+1].low)
      h1targets.push({ price: c.low, name: '1H swing low' });
  }

  const fallback = r => isLong ? entry + risk * r : entry - risk * r;
  const minTP1 = fallback(1.5), minTP2 = fallback(2.0), minTP3 = fallback(2.5);

  const tp1cands = [...opposing, ...h1targets.filter(t =>
    isLong ? t.price >= minTP1 : t.price <= minTP1)].sort((a,b) => isLong ? a.price-b.price : b.price-a.price);
  const tp2cands = [...opposing, ...h1targets].filter(t =>
    isLong ? t.price >= minTP2 : t.price <= minTP2).sort((a,b) => isLong ? a.price-b.price : b.price-a.price);
  const tp3cands = [...opposing, ...h1targets].filter(t =>
    isLong ? t.price >= minTP3 : t.price <= minTP3).sort((a,b) => isLong ? a.price-b.price : b.price-a.price);

  const tp1 = tp1cands[0] || { price: fallback(1.5), name: 'Fixed 1.5R' };
  const tp2 = tp2cands[0] || { price: fallback(2.0), name: 'Fixed 2.0R' };
  const tp3 = tp3cands[0] || { price: fallback(2.5), name: 'Fixed 2.5R' };

  return {
    tp1: tp1.price, tp1Desc: tp1.name || tp1.desc,
    tp2: tp2.price, tp2Desc: tp2.name || tp2.desc,
    tp3: tp3.price, tp3Desc: tp3.name || tp3.desc,
  };
}

// ─── Confluence Score ─────────────────────────────────────────────────────────
// KZ=25, SWEEP=25, MSS_1m=25, FVG_1m=25  →  max 100, min 75 required
function scoreConfluence(sweep, mss, fvg) {
  let score = 25; const tags = ['KZ'];
  if (sweep.detected)  { score += 25; tags.push('SWEEP'); }
  if (mss.confirmed)   { score += 25; tags.push('MSS_1M'); }
  if (fvg.found)       { score += 25; tags.push('FVG_1M'); }
  const grade = score >= 100 ? 'A+' : score >= 75 ? 'A' : score >= 50 ? 'B' : 'C';
  return { score: Math.min(score, 100), grade, tags };
}

// ─── Main Analysis ────────────────────────────────────────────────────────────
function runICTAnalysis(data) {
  const { daily, h4, h1, candles5m, candles1m } = data;

  const nowIso  = candles5m[candles5m.length - 1].time;
  const bias    = htfBias(daily, h4);

  const noSig = (extra = {}) => ({
    bias, sweep: extra.sweep || { detected: false },
    mss: extra.mss || { confirmed: false },
    fvg: extra.fvg || { found: false },
    confluence: extra.conf || { score: 0, grade: 'D', tags: [] },
    htfAligned: false, signal: null, signals: [],
    liquidity: { nearestBSL: null, nearestSSL: null },
    structure: { bias, mss: null }
  });

  // Step 2: sweep of a pre-KZ level
  const sweep = detectSweep(candles5m);
  if (!sweep.detected) return noSig();

  // Step 3: 1m MSS with displacement after the sweep
  const mss = detectMSS1m(candles1m, sweep.dir, sweep.sweepCandleTime);
  if (!mss.confirmed) return noSig({ sweep });

  // Step 4: 1m FVG within the displacement
  const fvg = detectFVG1m(candles1m, sweep.dir, sweep.sweepCandleTime, mss);
  const conf = scoreConfluence(sweep, mss, fvg);
  if (!fvg.found || conf.score < 75) return noSig({ sweep, mss, fvg, conf });

  // Step 5: wait for limit fill — price must retrace to FVG boundary
  const fill = waitForLimitFill1m(candles1m, fvg, sweep.dir);
  if (!fill) return noSig({ sweep, mss, fvg, conf }); // zone not yet touched

  const isLong = sweep.dir === 'bull';
  const entry  = fill.price;

  // SL: just beyond the 1m MSS swing point (the actual invalidation level)
  const slBuffer = mss.swingLevel * 0.0003;
  const sl = isLong
    ? mss.swingLevel - slBuffer
    : mss.swingLevel + slBuffer;

  if (isLong && sl >= entry) return noSig({ sweep, mss, fvg, conf });
  if (!isLong && sl <= entry) return noSig({ sweep, mss, fvg, conf });

  const risk = Math.abs(entry - sl);
  if (risk < 25) return noSig({ sweep, mss, fvg, conf });

  const { tp1, tp1Desc, tp2, tp2Desc, tp3, tp3Desc } =
    opposingLiquidityTPs(sweep.dir, entry, risk, candles5m, nowIso, h1);

  const signal = {
    direction:   isLong ? 'BUY' : 'SELL',
    orderType:   'LIMIT',
    entry:       parseFloat(entry.toFixed(2)),
    sl:          parseFloat(sl.toFixed(2)),
    tp1:         parseFloat(tp1.toFixed(2)),
    tp2:         parseFloat(tp2.toFixed(2)),
    tp3:         parseFloat(tp3.toFixed(2)),
    tp1Desc, tp2Desc, tp3Desc,
    rr:          ((Math.abs(tp1 - entry)) / risk).toFixed(2),
    stopPoints:  Math.round(risk),
    confluence:  conf.score,
    grade:       conf.grade,
    tags:        conf.tags,
    sweep:       sweep.levelName,
    mssType:     mss.type,
    mssSwing:    parseFloat(mss.swingLevel.toFixed(2)),
    fvgTop:      parseFloat(fvg.top.toFixed(2)),
    fvgBottom:   parseFloat(fvg.bottom.toFixed(2)),
    htfBias:     bias,
    hasFVG:      true,
    timestamp:   new Date().toISOString(),
    mssTime:     mss.mssTime,
    fillTime:    fill.time,
  };

  return {
    bias, sweep, mss, fvg,
    confluence: conf,
    htfAligned: true,
    signal,
    signals: [signal],
    liquidity: { nearestBSL: null, nearestSSL: null },
    structure: { bias, mss }
  };
}

module.exports = {
  runICTAnalysis,
  detectMarketStructure: () => ({ highs: [], lows: [] }),
  findOrderBlocks: () => ({ bullish: null, bearish: null }),
  findFairValueGaps: () => ({ bullish: null, bearish: null, all: [] }),
  findLiquidityPools: () => ({ bsl: [], ssl: [], nearestBSL: null, nearestSSL: null })
};
