'use strict';

// ─── DJ30 ICT Analysis Engine ─────────────────────────────────────────────────
// Strategy: Judas Swing (NY Open Sweep)
//
// 1. Pre-NY range: highest 5m high + lowest 5m low from 07:00–13:55 UTC
// 2. Sweep window 14:00–16:00 UTC: price wicks beyond range H/L and closes back
// 3. After sweep: detect MSS (BOS/CHoCH) on 1m, find FVG within MSS
// 4. Entry: FVG midpoint (limit)  SL: beyond sweep extreme  TP: 3:1 RR

// ─── Pre-NY Range ─────────────────────────────────────────────────────────────
// Returns the swing high and swing low formed 07:00–13:55 UTC on 5m candles
function getPreNYRange(candles5m) {
  const today = new Date();
  const dateStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth()+1).padStart(2,'0')}-${String(today.getUTCDate()).padStart(2,'0')}`;

  const sessionCandles = candles5m.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const h = new Date(c.time).getUTCHours();
    const m = new Date(c.time).getUTCMinutes();
    const mins = h * 60 + m;
    return mins >= 7 * 60 && mins < 14 * 60; // 07:00–13:55
  });

  if (sessionCandles.length < 3) return null;

  const high = Math.max(...sessionCandles.map(c => c.high));
  const low  = Math.min(...sessionCandles.map(c => c.low));

  return { high, low, candles: sessionCandles.length };
}

// ─── Judas Sweep Detection ────────────────────────────────────────────────────
// Returns sweep direction if price wicked beyond pre-NY range and closed back
// Only valid between 14:00–16:00 UTC
function detectJudasSweep(candles5m, preNYRange) {
  if (!preNYRange) return { detected: false };

  const today = new Date();
  const dateStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth()+1).padStart(2,'0')}-${String(today.getUTCDate()).padStart(2,'0')}`;

  const nyCandles = candles5m.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const h = new Date(c.time).getUTCHours();
    return h >= 14 && h < 16;
  });

  if (!nyCandles.length) return { detected: false };

  // Check most recent first (freshest sweep wins)
  for (let i = nyCandles.length - 1; i >= 0; i--) {
    const c = nyCandles[i];
    // BSL swept: wicked above pre-NY high, closed back below → bearish
    if (c.high > preNYRange.high && c.close < preNYRange.high) {
      return { detected: true, dir: 'bear', level: preNYRange.high, sweepCandle: c, levelName: 'Pre-NY High (BSL)' };
    }
    // SSL swept: wicked below pre-NY low, closed back above → bullish
    if (c.low < preNYRange.low && c.close > preNYRange.low) {
      return { detected: true, dir: 'bull', level: preNYRange.low, sweepCandle: c, levelName: 'Pre-NY Low (SSL)' };
    }
  }

  return { detected: false };
}

// ─── MSS Detection ────────────────────────────────────────────────────────────
// After the sweep, look for a Market Structure Shift on 1m candles
function detectMSS(candles1m, sweepDir) {
  const window = candles1m.slice(-30);
  if (window.length < 5) return { confirmed: false };
  const last = window[window.length - 1];
  const prev = window[window.length - 2];

  if (sweepDir === 'bear') {
    // BOS down: close below a recent swing low
    let swingLow = Infinity;
    for (let i = 1; i < window.length - 2; i++) {
      const c = window[i];
      if (c.low < (window[i-1]?.low ?? Infinity) && c.low < (window[i+1]?.low ?? Infinity))
        swingLow = Math.min(swingLow, c.low);
    }
    if (swingLow < Infinity && last.close < swingLow)
      return { confirmed: true, type: 'BOS_DOWN', level: swingLow, mssCandle: last };
    if (last.close < prev.low)
      return { confirmed: true, type: 'CHoCH', level: prev.low, mssCandle: last };
  }

  if (sweepDir === 'bull') {
    let swingHigh = -Infinity;
    for (let i = 1; i < window.length - 2; i++) {
      const c = window[i];
      if (c.high > (window[i-1]?.high ?? -Infinity) && c.high > (window[i+1]?.high ?? -Infinity))
        swingHigh = Math.max(swingHigh, c.high);
    }
    if (swingHigh > -Infinity && last.close > swingHigh)
      return { confirmed: true, type: 'BOS_UP', level: swingHigh, mssCandle: last };
    if (last.close > prev.high)
      return { confirmed: true, type: 'CHoCH', level: prev.high, mssCandle: last };
  }

  return { confirmed: false };
}

// ─── FVG Detection ────────────────────────────────────────────────────────────
// Find a Fair Value Gap in the last N candles in the direction of the move
// FVG: 3-candle pattern where candle[i-1].high < candle[i+1].low (bull)
//                          or candle[i-1].low  > candle[i+1].high (bear)
function detectFVG(candles1m, sweepDir) {
  const window = candles1m.slice(-20);
  const gaps = [];

  for (let i = 1; i < window.length - 1; i++) {
    const prev = window[i - 1];
    const curr = window[i];
    const next = window[i + 1];

    if (sweepDir === 'bear') {
      // Bearish FVG: prev.low > next.high (gap to the downside)
      if (prev.low > next.high) {
        gaps.push({
          found: true,
          top:    prev.low,
          bottom: next.high,
          mid:    parseFloat(((prev.low + next.high) / 2).toFixed(2)),
          time:   curr.time
        });
      }
    }

    if (sweepDir === 'bull') {
      // Bullish FVG: prev.high < next.low (gap to the upside)
      if (prev.high < next.low) {
        gaps.push({
          found: true,
          top:    next.low,
          bottom: prev.high,
          mid:    parseFloat(((next.low + prev.high) / 2).toFixed(2)),
          time:   curr.time
        });
      }
    }
  }

  if (!gaps.length) return { found: false };
  // Return the most recent FVG
  return gaps[gaps.length - 1];
}

// ─── Main Analysis ────────────────────────────────────────────────────────────
function runICTAnalysis(data) {
  const { candles5m, candles1m } = data;

  const now = new Date();
  const utcHour = now.getUTCHours();

  // Outside trading window — do nothing
  if (utcHour < 7 || utcHour >= 16) {
    return { signal: null, signals: [], waitReason: 'Outside trading window (07:00–16:00 UTC)' };
  }

  // Pre-NY: just monitoring, no trades yet
  if (utcHour < 14) {
    const preNY = getPreNYRange(candles5m);
    return {
      signal: null, signals: [],
      preNYRange: preNY,
      waitReason: `Building pre-NY range — next: NY open 14:00 UTC`
    };
  }

  // NY window 14:00–16:00: look for Judas sweep
  const preNY  = getPreNYRange(candles5m);
  const sweep  = detectJudasSweep(candles5m, preNY);

  if (!sweep.detected) {
    return {
      signal: null, signals: [],
      preNYRange: preNY, sweep,
      waitReason: 'Waiting for pre-NY high/low sweep'
    };
  }

  // Sweep confirmed — look for MSS + FVG on 1m
  const use1m  = candles1m && candles1m.length > 10 ? candles1m : candles5m;
  const mss    = detectMSS(use1m, sweep.dir);
  const fvg    = mss.confirmed ? detectFVG(use1m, sweep.dir) : { found: false };

  if (!mss.confirmed) {
    return {
      signal: null, signals: [],
      preNYRange: preNY, sweep, mss,
      waitReason: `Sweep confirmed (${sweep.levelName}) — waiting for MSS`
    };
  }

  if (!fvg.found) {
    return {
      signal: null, signals: [],
      preNYRange: preNY, sweep, mss, fvg,
      waitReason: `MSS confirmed (${mss.type}) — waiting for FVG`
    };
  }

  // All conditions met — build signal
  const isLong = sweep.dir === 'bull';
  const entry  = fvg.mid;

  // SL: just beyond the sweep candle extreme
  const slBuf = entry * 0.0008;
  const sl     = isLong
    ? sweep.sweepCandle.low  - slBuf
    : sweep.sweepCandle.high + slBuf;

  const risk = Math.abs(entry - sl);
  if (risk <= 0 || risk > entry * 0.015) {
    return { signal: null, signals: [], waitReason: 'Risk check failed' };
  }

  const tp = isLong ? entry + risk * 3 : entry - risk * 3;

  const signal = {
    direction:  isLong ? 'BUY' : 'SELL',
    entry:      parseFloat(entry.toFixed(2)),
    sl:         parseFloat(sl.toFixed(2)),
    tp1:        parseFloat(tp.toFixed(2)),
    tp2:        parseFloat(tp.toFixed(2)),
    tp3:        parseFloat(tp.toFixed(2)),
    rr:         '3.0',
    rr1:        '3.0',
    stopPoints: Math.round(risk),
    confluence: 100,
    grade:      'A+',
    tags:       ['PRE_NY_RANGE', 'JUDAS_SWEEP', 'MSS', 'FVG'],
    sweep:      sweep.levelName,
    mssType:    mss.type,
    hasFVG:     true,
    fvgMid:     fvg.mid,
    htfBias:    'n/a',
    htfAligned: true,
    timestamp:  new Date().toISOString(),
    price:      candles5m[candles5m.length - 1].close
  };

  return {
    preNYRange: preNY,
    sweep, mss, fvg,
    signal,
    signals: [signal],
    confluence: { score: 100, grade: 'A+', tags: signal.tags },
    htfAligned: true,
    structure: { bias: sweep.dir, mss }
  };
}

module.exports = {
  runICTAnalysis,
  detectMarketStructure: () => ({ highs: [], lows: [] }),
  findOrderBlocks:       () => ({ bullish: null, bearish: null }),
  findFairValueGaps:     () => ({ bullish: null, bearish: null, all: [] }),
  findLiquidityPools:    () => ({ bsl: [], ssl: [], nearestBSL: null, nearestSSL: null })
};
