'use strict';

// ─── Instrument definitions ───────────────────────────────────────────────────
// TwelveData symbols for each instrument
const INSTRUMENTS = {
  DJ30: {
    symbol:    'DJI',          // Dow Jones Industrial Average — actual index on TwelveData
    name:      'DJ30',
    pipSize:   1,
    maxRiskPts: 300,           // DJ30 is ~51,000 pts so SL can be 50-200pts wide
  },
  NAS100: {
    symbol:    'NDX',          // Nasdaq 100 index on TwelveData
    name:      'NAS100',
    pipSize:   1,
    maxRiskPts: 500,
  },
};

// ─── NY Kill Zone ─────────────────────────────────────────────────────────────
// 08:30–11:00 New York time = 13:30–16:00 UTC (EST) / 12:30–15:00 UTC (EDT)
// We use UTC offsets: EST = UTC-5, EDT = UTC-4 (Mar–Nov)
// Safest approach: define in NY local hours and convert at runtime
const NY_KZ = {
  startHour: 8,   // 08:30 NY
  startMin:  30,
  endHour:   11,  // 11:00 NY
  endMin:    0,
};

// ─── Swing pivot lookback ─────────────────────────────────────────────────────
// A pivot high/low requires this many candles on each side to be lower/higher
const PIVOT_BARS = 3;

// ─── Displacement filter ──────────────────────────────────────────────────────
// A displacement candle body must be this fraction of the candle's total range
const DISPLACEMENT_BODY_RATIO = 0.4;

// ─── FVG minimum size ─────────────────────────────────────────────────────────
// FVG must be at least this many points wide to count
const FVG_MIN_SIZE = 0.3;

// ─── Scan interval ───────────────────────────────────────────────────────────
const SCAN_INTERVAL_MS = 60 * 1000; // 60 seconds

// ─── Signal cooldown ─────────────────────────────────────────────────────────
// Don't fire the same direction more than once per KZ session
const SIGNAL_COOLDOWN_MS = 90 * 60 * 1000; // 90 minutes

module.exports = { INSTRUMENTS, NY_KZ, PIVOT_BARS, DISPLACEMENT_BODY_RATIO, FVG_MIN_SIZE, SCAN_INTERVAL_MS, SIGNAL_COOLDOWN_MS };
