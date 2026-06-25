'use strict';

// ─── 1m Execution Engine ──────────────────────────────────────────────────────
// Activated by 5m permission. Watches 1m candles for a refined ICT entry.
//
// Correct ICT execution flow (SHORT example):
//   1. SWEEP    — 1m wick above a confirmed 1m swing high, close back below
//   2. MSS      — 1m close below a recent swing low (structure shift to bearish)
//   3. FVG      — displacement candle creates a 1m imbalance ABOVE current price
//   4. RETEST   — price RALLIES back up into the FVG zone (this is the entry)
//   5. ENTRY    — alert fires: enter SHORT at FVG midpoint, SL above sweep wick
//
// Why the retest step matters:
//   After displacement the FVG is above price. We do NOT enter at the bottom of
//   the move. We place a LIMIT at the FVG midpoint and wait for the pullback.
//   This gives a tighter SL (sweep high → FVG entry) and better R:R.
//
// Expires after MAX_1M_BARS bars from activation with no signal.

const MIN_RISK_PTS = parseFloat(process.env.MIN_RISK_PTS || '0.75');  // skip signals with < 0.75pt risk
const MAX_1M_BARS  = parseInt(process.env.MAX_1M_BARS   || '60');     // expire after 60 mins

const DISPLACEMENT_RATIO = 0.35;   // body/range — ETF 1m candles have small bodies
const FVG_MIN_SIZE_1M    = 0.02;   // minimum FVG width in points

const STATES = {
  IDLE:     'IDLE',
  WATCHING: 'WATCHING',
  SWEPT:    'SWEPT',
  MSS:      'MSS',
  RETEST:   'RETEST',   // FVG found, waiting for price to return into it
  ENTRY:    'ENTRY',
};

class Engine1m {
  constructor(instrumentName) {
    this.instrument = instrumentName;
    this._reset();
  }

  activate(permission) {
    this._reset();
    this.active    = true;
    this.direction = permission.direction;   // 'SHORT' or 'LONG'
    this.fvg5m     = permission.fvg;
    this.sweep5m   = permission.sweep;
    this.startBar  = null;
    this.state     = STATES.WATCHING;
  }

  tick(candles1m) {
    if (!this.active) return this._result('1m engine idle');

    if (this.startBar === null) this.startBar = candles1m.length - 1;

    const barsElapsed = (candles1m.length - 1) - this.startBar;
    if (barsElapsed > MAX_1M_BARS) {
      this._reset();
      return this._result(`Expired — no entry in ${MAX_1M_BARS} bars`);
    }

    const isShort = this.direction === 'SHORT';

    // ── STEP 1: Look for 1m sweep of a confirmed swing high/low ─────────────
    if (this.state === STATES.WATCHING) {
      const sweep = this._detectSweep(candles1m, isShort);
      if (!sweep) {
        return this._result(`Watching for 1m ${isShort ? 'bear' : 'bull'} sweep [${barsElapsed}/${MAX_1M_BARS}m]`);
      }
      this.sweep1m     = sweep;
      this.sweepBarIdx = candles1m.length - 1;
      this.state       = STATES.SWEPT;
    }

    // ── STEP 2: Look for 1m MSS (structure shift in signal direction) ────────
    if (this.state === STATES.SWEPT) {
      const mss = this._detectMSS(candles1m, isShort);
      if (!mss) {
        const b = (candles1m.length - 1) - this.sweepBarIdx;
        return this._result(`1m sweep ✓ — waiting for 1m MSS [${b}m]`);
      }
      this.mss1m     = mss;
      this.mssBarIdx = candles1m.length - 1;
      this.state     = STATES.MSS;
    }

    // ── STEP 3: Look for 1m displacement + FVG ──────────────────────────────
    if (this.state === STATES.MSS) {
      const fvg = this._detectFVG(candles1m, isShort);
      if (!fvg) {
        const b = (candles1m.length - 1) - this.mssBarIdx;
        return this._result(`1m MSS ✓ (${this.mss1m.type}) — waiting for 1m FVG [${b}m]`);
      }
      this.fvg1m = fvg;
      this.state = STATES.RETEST;
      return this._result(`1m FVG ✓ ${fvg.bottom.toFixed(2)}–${fvg.top.toFixed(2)} — waiting for retest`);
    }

    // ── STEP 4: Wait for price to RETURN into the FVG zone ──────────────────
    // This is the actual entry point — a limit order at the FVG midpoint
    if (this.state === STATES.RETEST) {
      const latest = candles1m[candles1m.length - 1];
      const fvg    = this.fvg1m;

      // For SHORT: price needs to rally back UP into the FVG (which is above current price)
      // For LONG:  price needs to pull back DOWN into the FVG (which is below current price)
      const intoFVG = isShort
        ? latest.high >= fvg.bottom   // candle wick enters the FVG from below
        : latest.low  <= fvg.top;     // candle wick enters the FVG from above

      if (!intoFVG) {
        return this._result(`Waiting for retest of FVG ${fvg.bottom.toFixed(2)}–${fvg.top.toFixed(2)}`);
      }

      // Price has entered the FVG — build the entry signal
      const signal = this._buildSignal(isShort, latest);
      if (!signal) {
        // Risk too small — skip this setup
        this._reset();
        return this._result(`FVG retest reached but risk < ${MIN_RISK_PTS}pts — skipping`);
      }

      this.signal = signal;
      this.state  = STATES.ENTRY;
    }

    if (this.state === STATES.ENTRY) {
      return this._result('ENTRY SIGNAL READY', true);
    }

    return this._result('Scanning 1m...');
  }

  // ─── 1m sweep detection ────────────────────────────────────────────────────
  // Requires a CONFIRMED 1m swing pivot (N candles each side), not just highest high.
  // For SHORT: wick above a confirmed swing HIGH → close back below
  // For LONG:  wick below a confirmed swing LOW  → close back above
  _detectSweep(candles, isShort) {
    if (candles.length < 8) return null;
    const window = candles.slice(-40);
    const last   = window[window.length - 1];
    const LOOK   = 2;  // bars each side to confirm swing

    if (isShort) {
      // Find confirmed swing highs (higher than LOOK bars each side)
      let bestLevel = -Infinity;
      for (let i = LOOK; i < window.length - LOOK - 1; i++) {
        const c = window[i];
        let isHigh = true;
        for (let j = 1; j <= LOOK; j++) {
          if (c.high <= window[i - j].high || c.high <= window[i + j].high) { isHigh = false; break; }
        }
        if (isHigh) bestLevel = Math.max(bestLevel, c.high);
      }
      if (bestLevel === -Infinity) return null;
      // Sweep: wick above the swing high, close back below
      if (last.high > bestLevel && last.close < bestLevel) {
        return { dir: 'bear', sweepCandle: last, sweepHigh: last.high, level: bestLevel };
      }
    } else {
      // Find confirmed swing lows
      let bestLevel = Infinity;
      for (let i = LOOK; i < window.length - LOOK - 1; i++) {
        const c = window[i];
        let isLow = true;
        for (let j = 1; j <= LOOK; j++) {
          if (c.low >= window[i - j].low || c.low >= window[i + j].low) { isLow = false; break; }
        }
        if (isLow) bestLevel = Math.min(bestLevel, c.low);
      }
      if (bestLevel === Infinity) return null;
      if (last.low < bestLevel && last.close > bestLevel) {
        return { dir: 'bull', sweepCandle: last, sweepLow: last.low, level: bestLevel };
      }
    }
    return null;
  }

  // ─── 1m MSS ────────────────────────────────────────────────────────────────
  _detectMSS(candles, isShort) {
    const window = candles.slice(-20);
    if (window.length < 5) return null;
    const last = window[window.length - 1];
    const prev = window[window.length - 2];

    if (isShort) {
      // BOS down: close below a confirmed swing low
      let swingLow = Infinity;
      for (let i = 1; i < window.length - 2; i++) {
        const c = window[i];
        if (c.low < window[i - 1].low && c.low < window[i + 1].low)
          swingLow = Math.min(swingLow, c.low);
      }
      if (swingLow < Infinity && last.close < swingLow && last.close < last.open)
        return { type: 'BOS_DOWN', level: swingLow, mssCandle: last };
      // CHoCH: close below previous candle's low
      if (last.close < prev.low && last.close < last.open)
        return { type: 'CHoCH', level: prev.low, mssCandle: last };
    } else {
      let swingHigh = -Infinity;
      for (let i = 1; i < window.length - 2; i++) {
        const c = window[i];
        if (c.high > window[i - 1].high && c.high > window[i + 1].high)
          swingHigh = Math.max(swingHigh, c.high);
      }
      if (swingHigh > -Infinity && last.close > swingHigh && last.close > last.open)
        return { type: 'BOS_UP', level: swingHigh, mssCandle: last };
      if (last.close > prev.high && last.close > last.open)
        return { type: 'CHoCH', level: prev.high, mssCandle: last };
    }
    return null;
  }

  // ─── 1m FVG + displacement ─────────────────────────────────────────────────
  _detectFVG(candles, isShort) {
    const window = candles.slice(-30);
    const fvgs   = [];

    for (let i = 1; i < window.length - 1; i++) {
      const c0 = window[i - 1];
      const c1 = window[i];
      const c2 = window[i + 1];

      const range = c1.high - c1.low;
      if (range === 0) continue;
      const body      = Math.abs(c1.close - c1.open);
      const displaced = body / range >= DISPLACEMENT_RATIO;
      if (!displaced) continue;

      if (isShort && c1.close < c1.open && c2.high < c0.low) {
        const size = c0.low - c2.high;
        if (size >= FVG_MIN_SIZE_1M)
          fvgs.push({ dir: 'bear', top: c0.low, bottom: c2.high, mid: (c0.low + c2.high) / 2, size, time: c1.time });
      }
      if (!isShort && c1.close > c1.open && c2.low > c0.high) {
        const size = c2.low - c0.high;
        if (size >= FVG_MIN_SIZE_1M)
          fvgs.push({ dir: 'bull', top: c2.low, bottom: c0.high, mid: (c2.low + c0.high) / 2, size, time: c1.time });
      }
    }

    return fvgs.length ? fvgs[fvgs.length - 1] : null;
  }

  // ─── Build entry signal once price retests FVG ───────────────────────────
  // Entry = FVG midpoint (limit order level)
  // SL    = beyond the 1m sweep wick + small buffer
  // TP1   = 2R, TP2 = 3.5R
  _buildSignal(isShort, retestCandle) {
    const entry  = this.fvg1m.mid;
    const sweep  = this.sweep1m;

    // SL is beyond the sweep wick extreme
    const slBuffer = 0.10;  // 10 cent fixed buffer beyond sweep wick
    const sl = isShort
      ? parseFloat((sweep.sweepHigh + slBuffer).toFixed(2))
      : parseFloat((sweep.sweepLow  - slBuffer).toFixed(2));

    const risk = Math.abs(entry - sl);

    // Reject signals where risk is too small (setup is degenerate)
    if (risk < MIN_RISK_PTS) return null;

    const tp1 = isShort
      ? parseFloat((entry - risk * 2).toFixed(2))
      : parseFloat((entry + risk * 2).toFixed(2));
    const tp2 = isShort
      ? parseFloat((entry - risk * 3.5).toFixed(2))
      : parseFloat((entry + risk * 3.5).toFixed(2));

    return {
      instrument: this.instrument,
      direction:  this.direction,
      entry:      parseFloat(entry.toFixed(2)),
      sl,
      tp1,
      tp2,
      riskPts:    parseFloat(risk.toFixed(2)),
      sweep5m:    this.sweep5m.levelName,
      fvg5m:      `${this.fvg5m.bottom.toFixed(2)}–${this.fvg5m.top.toFixed(2)}`,
      sweep1m:    `wick to ${isShort ? sweep.sweepHigh.toFixed(2) : sweep.sweepLow.toFixed(2)}`,
      mss1m:      `${this.mss1m.type} @ ${this.mss1m.level.toFixed(2)}`,
      fvg1m:      `${this.fvg1m.bottom.toFixed(2)}–${this.fvg1m.top.toFixed(2)}`,
      retestTime: retestCandle.time,
      timestamp:  new Date().toISOString(),
    };
  }

  _reset() {
    this.active      = false;
    this.direction   = null;
    this.fvg5m       = null;
    this.sweep5m     = null;
    this.sweep1m     = null;
    this.mss1m       = null;
    this.fvg1m       = null;
    this.signal      = null;
    this.startBar    = null;
    this.sweepBarIdx = null;
    this.mssBarIdx   = null;
    this.state       = STATES.IDLE;
  }

  _result(waitReason, entryReady = false) {
    return { state: this.state, entryReady, signal: this.signal, waitReason };
  }
}

module.exports = { Engine1m, STATES };
