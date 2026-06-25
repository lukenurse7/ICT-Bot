'use strict';

const { PIVOT_BARS } = require('./config');

// ─── Pivot high/low detection ─────────────────────────────────────────────────
// A confirmed pivot HIGH at index i requires PIVOT_BARS candles on each side
// with a strictly lower high. Same logic for pivot LOWs.
// We never look at the last PIVOT_BARS candles — those can't be confirmed yet.
// This prevents repainting.

function findPivots(candles, lookback = PIVOT_BARS) {
  const highs = [];
  const lows  = [];

  // Stop before the last `lookback` candles — they aren't confirmed yet
  const end = candles.length - lookback;

  for (let i = lookback; i < end; i++) {
    const c = candles[i];

    const leftHighs  = candles.slice(i - lookback, i).map(x => x.high);
    const rightHighs = candles.slice(i + 1, i + lookback + 1).map(x => x.high);
    const leftLows   = candles.slice(i - lookback, i).map(x => x.low);
    const rightLows  = candles.slice(i + 1, i + lookback + 1).map(x => x.low);

    const isPivotHigh = leftHighs.every(h => h < c.high) && rightHighs.every(h => h < c.high);
    const isPivotLow  = leftLows.every(l  => l > c.low)  && rightLows.every(l  => l > c.low);

    if (isPivotHigh) highs.push({ price: c.high, time: c.time, index: i });
    if (isPivotLow)  lows.push ({ price: c.low,  time: c.time, index: i });
  }

  return { highs, lows };
}

// Returns the most recent confirmed pivot high and low from a candle array
function latestPivots(candles, lookback = PIVOT_BARS) {
  const { highs, lows } = findPivots(candles, lookback);
  return {
    lastHigh: highs.length ? highs[highs.length - 1] : null,
    lastLow:  lows.length  ? lows[lows.length - 1]   : null,
    highs,
    lows,
  };
}

module.exports = { findPivots, latestPivots };
