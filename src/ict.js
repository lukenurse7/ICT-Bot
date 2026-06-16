'use strict';

// ─── DJ30 ICT Analysis Engine ─────────────────────────────────────────────────
// Same methodology as ict_xau.js: HTF Bias → Sweep → MSS → FVG entry
// Kill zone (London 07-09 UTC / NY 12-15 UTC) is enforced by the caller

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

// ─── Liquidity Sweep Detection ────────────────────────────────────────────────
// Everything — levels, wick, sweep — runs on the 5m timeframe only.
// Mixing in 15m levels caused the 15m's different candle boundaries to disagree
// with what the 5m chart was actually showing at the moment of the sweep.
function detectSweep(candles15m, candles5m) {
  const LOOKBACK = 100;
  const recent5  = candles5m.slice(-LOOKBACK);
  const last5    = candles5m[candles5m.length - 1];

  // Collect significant swing levels from 5m
  const levels = [];

  // Equal highs (BSL)
  for (let i = 2; i < recent5.length - 1; i++) {
    const c = recent5[i];
    const prev = recent5.slice(Math.max(0, i-10), i);
    const eqHigh = prev.find(p => Math.abs(p.high - c.high) / c.high < 0.0005);
    if (eqHigh) levels.push({ price: Math.max(c.high, eqHigh.high), type: 'BSL', name: 'Equal Highs (BSL)' });
  }

  // Equal lows (SSL)
  for (let i = 2; i < recent5.length - 1; i++) {
    const c = recent5[i];
    const prev = recent5.slice(Math.max(0, i-10), i);
    const eqLow = prev.find(p => Math.abs(p.low - c.low) / c.low < 0.0005);
    if (eqLow) levels.push({ price: Math.min(c.low, eqLow.low), type: 'SSL', name: 'Equal Lows (SSL)' });
  }

  // Prev day high/low
  const yesterday = candles5m.slice(-300).filter(c => {
    const d = new Date(c.time); return d.getUTCHours() >= 21 || d.getUTCHours() < 2;
  });
  if (yesterday.length) {
    const pdh = Math.max(...yesterday.map(c => c.high));
    const pdl = Math.min(...yesterday.map(c => c.low));
    levels.push({ price: pdh, type: 'BSL', name: 'Prev Day High' });
    levels.push({ price: pdl, type: 'SSL', name: 'Prev Day Low' });
  }

  // Check for sweep: last 5m candle wicked above BSL or below SSL then closed back
  const results = [];
  for (const lvl of levels) {
    if (lvl.type === 'BSL' && last5.high > lvl.price && last5.close < lvl.price) {
      results.push({ dir: 'bear', level: lvl.price, levelName: lvl.name, barsAgo: 0, wick: last5.high });
    }
    if (lvl.type === 'SSL' && last5.low < lvl.price && last5.close > lvl.price) {
      results.push({ dir: 'bull', level: lvl.price, levelName: lvl.name, barsAgo: 0, wick: last5.low });
    }
  }

  // Also check recent 5m history for sweeps in last 12 bars
  for (let back = 1; back <= 12; back++) {
    const idx = candles5m.length - 1 - back;
    if (idx < 0) break;
    const c = candles5m[idx];
    for (const lvl of levels) {
      if (lvl.type === 'BSL' && c.high > lvl.price && c.close < lvl.price) {
        results.push({ dir: 'bear', level: lvl.price, levelName: lvl.name, barsAgo: back, wick: c.high });
      }
      if (lvl.type === 'SSL' && c.low < lvl.price && c.close > lvl.price) {
        results.push({ dir: 'bull', level: lvl.price, levelName: lvl.name, barsAgo: back, wick: c.low });
      }
    }
  }

  // Most recent sweep
  if (!results.length) return { detected: false };
  results.sort((a, b) => a.barsAgo - b.barsAgo);
  return { detected: true, ...results[0] };
}

// ─── Market Structure Shift ───────────────────────────────────────────────────
function detectMSS(candles5m, sweepDir) {
  const window = candles5m.slice(-20);
  if (window.length < 5) return { confirmed: false };

  if (sweepDir === 'bear') {
    // After BSL sweep, look for BOS down (close below recent swing low) or CHoCH
    let swingLow = Infinity;
    for (let i = 0; i < window.length - 3; i++) {
      const c = window[i];
      if (c.low < window[Math.max(0,i-1)]?.low && c.low < window[i+1]?.low) {
        swingLow = Math.min(swingLow, c.low);
      }
    }
    const last = window[window.length - 1];
    if (swingLow < Infinity && last.close < swingLow) {
      return { confirmed: true, type: 'BOS_DOWN', level: swingLow, description: 'Broke below swing low' };
    }
    // CHoCH: last candle closes below prev candle low after sweep
    const prev = window[window.length - 2];
    if (last.close < prev.low) {
      return { confirmed: true, type: 'CHoCH', level: prev.low, description: 'Change of character down' };
    }
  }

  if (sweepDir === 'bull') {
    let swingHigh = -Infinity;
    for (let i = 0; i < window.length - 3; i++) {
      const c = window[i];
      if (c.high > window[Math.max(0,i-1)]?.high && c.high > window[i+1]?.high) {
        swingHigh = Math.max(swingHigh, c.high);
      }
    }
    const last = window[window.length - 1];
    if (swingHigh > -Infinity && last.close > swingHigh) {
      return { confirmed: true, type: 'BOS_UP', level: swingHigh, description: 'Broke above swing high' };
    }
    const prev = window[window.length - 2];
    if (last.close > prev.high) {
      return { confirmed: true, type: 'CHoCH', level: prev.high, description: 'Change of character up' };
    }
  }

  return { confirmed: false };
}

// ─── FVG with Confirmation Candle ─────────────────────────────────────────────
function detectFVG(candles5m, sweepDir) {
  const window = candles5m.slice(-30);

  const candidates = [];
  for (let i = 0; i < window.length - 2; i++) {
    const c0 = window[i], c2 = window[i + 2];
    if (sweepDir === 'bear' && c2.high < c0.low) {
      const size = c0.low - c2.high;
      if (size > 0) candidates.push({ top: c0.low, bottom: c2.high, size, idx: i + 1 });
    }
    if (sweepDir === 'bull' && c2.low > c0.high) {
      const size = c2.low - c0.high;
      if (size > 0) candidates.push({ top: c2.low, bottom: c0.high, size, idx: i + 1 });
    }
  }

  if (!candidates.length) return { found: false };

  // Best = largest unfilled FVG
  const best = candidates.slice(-3).sort((a, b) => b.size - a.size)[0];

  // Confirmation candle: prev candle wicked into FVG and closed back out
  const prevCandle = window[window.length - 2];
  const zoneFormedAt = window[best.idx + 1].time; // the 3rd candle of the FVG pattern — zone exists from here on
  let confirmedEntry = false;

  if (sweepDir === 'bear') {
    const wickedIn  = prevCandle.high >= best.bottom;
    const closedBack = prevCandle.close <= best.top;
    const wickDepth = prevCandle.high - best.bottom;
    confirmedEntry = wickedIn && closedBack && wickDepth >= best.size * 0.5;
  } else {
    const wickedIn  = prevCandle.low <= best.top;
    const closedBack = prevCandle.close >= best.bottom;
    const wickDepth = best.top - prevCandle.low;
    confirmedEntry = wickedIn && closedBack && wickDepth >= best.size * 0.5;
  }

  return {
    found: true,
    top: best.top,
    bottom: best.bottom,
    size: best.size,
    entryZone: `${best.bottom.toFixed(2)}–${best.top.toFixed(2)}`,
    inFVG: confirmedEntry,
    zoneFormedAt,
    confirmPrice: prevCandle.close // 5m fallback only — superseded by the 1m trigger when available
  };
}

// ─── 1-minute entry trigger ───────────────────────────────────────────────────
// The 5m FVG candle only confirms the retracement once the whole 5m bar closes —
// by then price has often already moved well past that close (stale fill).
// Once the zone exists, scan forward on 1m candles for the first bar that actually
// wicks into the zone and closes back out — that is the true, immediately-actionable entry.
function findEntryTrigger1m(candles1m, fvg, sweepDir) {
  if (!fvg.found || !fvg.zoneFormedAt || !candles1m || !candles1m.length) return null;

  const zoneStart = new Date(fvg.zoneFormedAt).getTime();
  const after = candles1m.filter(c => new Date(c.time).getTime() > zoneStart);

  for (const c of after) {
    if (sweepDir === 'bear') {
      const wickedIn   = c.high >= fvg.bottom;
      const closedBack = c.close <= fvg.top;
      if (wickedIn && closedBack) return { price: c.close, time: c.time };
    } else {
      const wickedIn   = c.low <= fvg.top;
      const closedBack = c.close >= fvg.bottom;
      if (wickedIn && closedBack) return { price: c.close, time: c.time };
    }
  }
  return null;
}

// ─── Liquidity-based TPs ──────────────────────────────────────────────────────
// Minimums match the validated same-day backtest: TP2 ≥ 2.0R, TP3 ≥ 2.5R
// Liquidity targets (5m equal H/L, 1H swings) used only if they clear the minimum
function liquidityTPs(dir, entry, risk, candles5m, h1Candles) {
  const isLong  = dir === 'bull';
  const minTP2  = isLong ? entry + risk * 2.0 : entry - risk * 2.0;
  const minTP3  = isLong ? entry + risk * 2.5 : entry - risk * 2.5;
  const maxR    = 5.0;

  const candidates = [];

  // 5m equal lows/highs
  const c5 = candles5m.slice(-60);
  for (let i = 2; i < c5.length - 1; i++) {
    const c    = c5[i];
    const prev = c5.slice(Math.max(0, i-8), i);
    if (isLong) {
      const eq = prev.find(p => Math.abs(p.high - c.high) / c.high < 0.001);
      if (eq) candidates.push({ price: Math.max(c.high, eq.high), desc: '5m equal highs' });
    } else {
      const eq = prev.find(p => Math.abs(p.low - c.low) / c.low < 0.001);
      if (eq) candidates.push({ price: Math.min(c.low, eq.low), desc: '5m equal lows' });
    }
  }

  // 1H swing highs/lows
  const c1h = h1Candles.slice(-24);
  for (let i = 2; i < c1h.length - 2; i++) {
    const c = c1h[i];
    if (isLong) {
      if (c.high > c1h[i-1].high && c.high > c1h[i-2].high && c.high > c1h[i+1].high)
        candidates.push({ price: c.high, desc: '1H swing high' });
    } else {
      if (c.low < c1h[i-1].low && c.low < c1h[i-2].low && c.low < c1h[i+1].low)
        candidates.push({ price: c.low, desc: '1H swing low' });
    }
  }

  // TP2: nearest liquidity at or beyond 2.5R, else fixed 2.5R
  const tp2candidates = candidates
    .filter(t => isLong
      ? t.price >= minTP2 && t.price < entry + risk * maxR
      : t.price <= minTP2 && t.price > entry - risk * maxR)
    .sort((a, b) => isLong ? a.price - b.price : b.price - a.price);

  // TP3: nearest liquidity at or beyond 3.5R, else fixed 3.5R
  const tp3candidates = candidates
    .filter(t => isLong
      ? t.price >= minTP3 && t.price < entry + risk * maxR
      : t.price <= minTP3 && t.price > entry - risk * maxR)
    .sort((a, b) => isLong ? a.price - b.price : b.price - a.price);

  const tp2obj = tp2candidates[0] || { price: isLong ? entry + risk*2.0 : entry - risk*2.0, desc: 'Fixed 2.0R' };
  const tp3obj = tp3candidates[0] || { price: isLong ? entry + risk*2.5 : entry - risk*2.5, desc: 'Fixed 2.5R' };

  return { tp2: tp2obj.price, tp2Desc: tp2obj.desc, tp3: tp3obj.price, tp3Desc: tp3obj.desc };
}

// ─── Confluence Score ─────────────────────────────────────────────────────────
function scoreConfluence(sweep, mss, fvg) {
  let score = 25;  // KZ = 25pts — enforced by caller, replaces HTF bias gate
  const tags = ['KZ'];

  if (sweep.detected)    { score += 25; tags.push('SWEEP'); }
  if (mss.confirmed)     { score += 25; tags.push('MSS'); }
  if (fvg.found)         { score += 15; tags.push('FVG'); }
  if (fvg.inFVG)         { score += 10; tags.push('CONF_CANDLE'); }

  const grade = score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B' : score >= 60 ? 'C' : 'D';
  return { score: Math.min(score, 100), grade, tags };
}

// ─── Main Analysis ────────────────────────────────────────────────────────────
function runICTAnalysis(data) {
  const { daily, h4, h1, candles15m, candles5m, candles1m, livePrice } = data;

  const bias    = htfBias(daily, h4);
  const sweep   = detectSweep(candles15m, candles5m);
  const mss     = sweep.detected ? detectMSS(candles5m, sweep.dir) : { confirmed: false };
  const fvg     = (sweep.detected && mss.confirmed) ? detectFVG(candles5m, sweep.dir) : { found: false };
  const dir     = sweep.dir || null;
  const conf    = dir ? scoreConfluence(sweep, mss, fvg) : { score: 0, grade: 'D', tags: [] };

  let signal = null;

  if (dir && mss.confirmed && fvg.inFVG && conf.score >= 80) {
    const lastCandle = candles5m[candles5m.length - 1];
    const isLong = dir === 'bull';
    const noSignal = { bias, sweep, mss, fvg, confluence: conf, htfAligned: false, signal: null, signals: [], liquidity: { nearestBSL: null, nearestSSL: null }, structure: { bias, mss: null } };

    // Entry: find the actual moment price trades back into the FVG zone on the 1m
    // chart — far more realistic than waiting for the whole 5m candle to close,
    // by which point price has often already run well past that close (stale fill).
    const trigger1m = findEntryTrigger1m(candles1m, fvg, dir);
    if (!trigger1m) return noSignal; // zone not yet actually retraced into — no real fill available
    const entry = trigger1m.price;

    // SL: beyond the actual liquidity-sweep wick (the real invalidation point),
    // not a generic recent-candle swing
    if (sweep.wick == null) return noSignal;
    const sl = isLong
      ? sweep.wick - (sweep.wick * 0.0005)
      : sweep.wick + (sweep.wick * 0.0005);

    // Sanity check: SL must be on the correct side of entry
    if (isLong  && sl >= entry) return noSignal;
    if (!isLong && sl <= entry) return noSignal;

    const risk = Math.abs(entry - sl);

    // Minimum stop floor — rejects unrealistically tight stops (spread/slippage risk)
    const MIN_RISK_PTS = 25;
    if (risk < MIN_RISK_PTS) return noSignal;

    const tp1  = isLong ? entry + risk * 1.5 : entry - risk * 1.5;

    const { tp2, tp2Desc, tp3, tp3Desc } = liquidityTPs(dir, entry, risk, candles5m, h1);

    signal = {
      direction: isLong ? 'BUY' : 'SELL',
      entry:    parseFloat(entry.toFixed(2)),
      sl:       parseFloat(sl.toFixed(2)),
      tp1:      parseFloat(tp1.toFixed(2)),
      tp2:      parseFloat(tp2.toFixed(2)),
      tp3:      parseFloat(tp3.toFixed(2)),
      tp2Desc, tp3Desc,
      rr:       '1.5',
      rr1:      '1.5',
      stopPoints: Math.round(Math.abs(entry - sl)),
      confluence: conf.score,
      grade:    conf.grade,
      tags:     conf.tags,
      sweep:    sweep.levelName,
      mssType:  mss.type,
      htfBias:  bias,
      hasFVG:   true,
      timestamp: new Date().toISOString(),
      entryTriggerTime: trigger1m.time,
      price:    lastCandle.close
    };
  }

  return {
    bias,
    sweep,
    mss,
    fvg,
    confluence: conf,
    htfAligned: bias === 'bullish' || bias === 'bearish',
    signal,
    // legacy compat
    signals: signal ? [signal] : [],
    liquidity: { nearestBSL: null, nearestSSL: null },
    structure: { bias, mss: mss.confirmed ? mss : null }
  };
}

module.exports = {
  runICTAnalysis,
  detectMarketStructure: (c) => { const s = { highs: [], lows: [] }; return s; },
  findOrderBlocks: () => ({ bullish: null, bearish: null }),
  findFairValueGaps: () => ({ bullish: null, bearish: null, all: [] }),
  findLiquidityPools: () => ({ bsl: [], ssl: [], nearestBSL: null, nearestSSL: null })
};
