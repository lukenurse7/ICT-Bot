'use strict';

// ─── 1m Execution Engine ──────────────────────────────────────────────────────
// Activated when the 5m engine grants PERMISSION.
// Watches 1m candles for a refined entry within the 5m FVG zone.
//
// Flow:
//   5m permission granted (direction + FVG zone known)
//   → 1m sweep: small liquidity sweep within/near the 5m FVG area
//   → 1m MSS:   break of structure on 1m confirming direction
//   → 1m FVG:   1m imbalance after the 1m MSS displacement
//   → ENTRY:    alert fires with entry price, SL, TP1, TP2
//
// SL: just beyond the 1m sweep candle extreme
// TP1: 2R, TP2: 3.5R (structure-based targets added in v3)
// Expires after MAX_1M_BARS bars with no signal

const MAX_1M_BARS          = parseInt(process.env.MAX_1M_BARS || '30');  // 30 mins
const DISPLACEMENT_RATIO   = 0.55;   // 1m displacement body/range threshold (slightly relaxed vs 5m)
const FVG_MIN_SIZE_1M      = 0.05;   // minimum 1m FVG size in points

const STATES = {
  IDLE:       'IDLE',
  WATCHING:   'WATCHING',
  SWEPT:      'SWEPT',
  MSS:        'MSS',
  ENTRY:      'ENTRY',
};

class Engine1m {
  constructor(instrumentName) {
    this.instrument = instrumentName;
    this._reset();
  }

  // Called when 5m grants permission
  activate(permission) {
    this._reset();
    this.active      = true;
    this.direction   = permission.direction;   // 'SHORT' or 'LONG'
    this.fvg5m       = permission.fvg;         // 5m FVG zone for context
    this.sweep5m     = permission.sweep;
    this.startBar    = null;                   // set on first tick
    this.state       = STATES.WATCHING;
  }

  // Called every scan cycle with latest 1m candles
  tick(candles1m) {
    if (!this.active) return this._result('1m engine idle');

    if (this.startBar === null) this.startBar = candles1m.length - 1;

    const barsElapsed = (candles1m.length - 1) - this.startBar;
    if (barsElapsed > MAX_1M_BARS) {
      this._reset();
      return this._result(`1m engine expired — no entry in ${MAX_1M_BARS} bars`);
    }

    const isShort = this.direction === 'SHORT';

    // ── WATCHING: look for 1m sweep near/within 5m FVG zone ─────────────────
    if (this.state === STATES.WATCHING) {
      const sweep = this._detectSweep(candles1m, isShort);
      if (!sweep) {
        return this._result(`1m: watching for sweep near FVG ${this.fvg5m.bottom.toFixed(2)}–${this.fvg5m.top.toFixed(2)} [${barsElapsed}/${MAX_1M_BARS}m]`);
      }
      this.sweep1m     = sweep;
      this.sweepBarIdx = candles1m.length - 1;
      this.state       = STATES.SWEPT;
    }

    // ── SWEPT: look for 1m MSS ───────────────────────────────────────────────
    if (this.state === STATES.SWEPT) {
      const mss = this._detectMSS(candles1m, isShort);
      if (!mss) {
        const b = (candles1m.length - 1) - this.sweepBarIdx;
        return this._result(`1m sweep confirmed — waiting for 1m MSS [${b} bars]`);
      }
      this.mss1m     = mss;
      this.mssBarIdx = candles1m.length - 1;
      this.state     = STATES.MSS;
    }

    // ── MSS: look for 1m FVG ─────────────────────────────────────────────────
    if (this.state === STATES.MSS) {
      const fvg = this._detectFVG(candles1m, isShort);
      if (!fvg) {
        const b = (candles1m.length - 1) - this.mssBarIdx;
        return this._result(`1m MSS confirmed (${this.mss1m.type}) — waiting for 1m FVG [${b} bars]`);
      }

      this.fvg1m = fvg;
      this.state = STATES.ENTRY;
      this.signal = this._buildSignal(isShort);
    }

    // ── ENTRY READY ──────────────────────────────────────────────────────────
    if (this.state === STATES.ENTRY) {
      return this._result('ENTRY SIGNAL READY', true);
    }

    return this._result('Scanning 1m...');
  }

  // ─── 1m sweep: wick through a recent 1m swing, close back ───────────────────
  // For SHORT: price wicks UP into/above 5m FVG zone then closes back down
  // For LONG:  price wicks DOWN into/below 5m FVG zone then closes back up
  _detectSweep(candles, isShort) {
    const last10 = candles.slice(-10);
    const fvg    = this.fvg5m;

    for (let i = last10.length - 1; i >= 1; i--) {
      const c    = last10[i];
      const prev = last10[i - 1];

      if (isShort) {
        // Wick up into FVG zone, close back below FVG bottom
        if (c.high >= fvg.bottom && c.close < fvg.bottom && c.close < prev.close) {
          return { dir: 'bear', sweepCandle: c, sweepHigh: c.high, level: fvg.bottom };
        }
      } else {
        // Wick down into FVG zone, close back above FVG top
        if (c.low <= fvg.top && c.close > fvg.top && c.close > prev.close) {
          return { dir: 'bull', sweepCandle: c, sweepLow: c.low, level: fvg.top };
        }
      }
    }
    return null;
  }

  // ─── 1m MSS: break of structure in signal direction ──────────────────────────
  _detectMSS(candles, isShort) {
    const window = candles.slice(-15);
    if (window.length < 4) return null;

    const last = window[window.length - 1];
    const prev = window[window.length - 2];

    if (isShort) {
      let swingLow = Infinity;
      for (let i = 1; i < window.length - 2; i++) {
        const c = window[i];
        if (c.low < window[i - 1].low && c.low < window[i + 1].low)
          swingLow = Math.min(swingLow, c.low);
      }
      if (swingLow < Infinity && last.close < swingLow && last.close < last.open)
        return { type: 'BOS_DOWN', level: swingLow, mssCandle: last };
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

  // ─── 1m FVG: 3-candle imbalance with displacement ────────────────────────────
  _detectFVG(candles, isShort) {
    const window = candles.slice(-20);
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

  // ─── Build the entry signal ───────────────────────────────────────────────────
  _buildSignal(isShort) {
    const entry  = this.fvg1m.mid;
    const sweep  = this.sweep1m;

    // SL just beyond the 1m sweep candle extreme + 0.1% buffer
    const slBuf = entry * 0.001;
    const sl    = isShort
      ? parseFloat((sweep.sweepHigh + slBuf).toFixed(2))
      : parseFloat((sweep.sweepLow  - slBuf).toFixed(2));

    const risk = Math.abs(entry - sl);
    const tp1  = isShort
      ? parseFloat((entry - risk * 2).toFixed(2))
      : parseFloat((entry + risk * 2).toFixed(2));
    const tp2  = isShort
      ? parseFloat((entry - risk * 3.5).toFixed(2))
      : parseFloat((entry + risk * 3.5).toFixed(2));

    return {
      instrument: this.instrument,
      direction:  this.direction,
      entry:      parseFloat(entry.toFixed(2)),
      sl,
      tp1,
      tp2,
      rr1:        '2.0R',
      rr2:        '3.5R',
      riskPts:    parseFloat(risk.toFixed(2)),
      sweep5m:    this.sweep5m.levelName,
      mss5m:      this.sweep5m.dir === 'bear' ? 'BOS_DOWN' : 'BOS_UP',
      fvg5m:      `${this.fvg5m.bottom.toFixed(2)}–${this.fvg5m.top.toFixed(2)}`,
      sweep1m:    `wick to ${isShort ? sweep.sweepHigh.toFixed(2) : sweep.sweepLow.toFixed(2)}`,
      mss1m:      `${this.mss1m.type} @ ${this.mss1m.level.toFixed(2)}`,
      fvg1m:      `${this.fvg1m.bottom.toFixed(2)}–${this.fvg1m.top.toFixed(2)}`,
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
    return {
      state:      this.state,
      entryReady,
      signal:     this.signal,
      waitReason,
    };
  }
}

module.exports = { Engine1m, STATES };
