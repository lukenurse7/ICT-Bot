'use strict';

// ─── 5m Engine ────────────────────────────────────────────────────────────────
// Job: track swing highs/lows all day, then at KZ open mark the most recent
// confirmed 5m High and Low. Pass those two levels to the 1m engine.
//
// The 1m engine does all the entry work. The 5m engine only answers:
//   "What are the key levels to watch for a sweep?"

const { latestPivots } = require('./swings');

const STATES = {
  IDLE:               'IDLE',
  WATCHING:           'WATCHING',
  PERMISSION_GRANTED: 'PERMISSION_GRANTED',
};

class Engine5m {
  constructor(instrumentName) {
    this.instrument = instrumentName;
    this.pivots     = { lastHigh: null, lastLow: null };
    this.state      = STATES.IDLE;
    this.sessionKey = null;
    this.permission = null;
  }

  tick(sessionKey, candles5m, inKZ) {
    // Always update pivots all day — so we always have fresh levels at KZ open
    const p = latestPivots(candles5m, 3);
    if (p.lastHigh) this.pivots.lastHigh = p.lastHigh;
    if (p.lastLow)  this.pivots.lastLow  = p.lastLow;

    // Reset setup state on new session (but NOT pivots)
    if (sessionKey !== this.sessionKey) {
      this._resetSetup(sessionKey);
    }

    // Outside KZ: stay idle, keep building pivot context
    if (!inKZ) {
      if (this.state !== STATES.IDLE) this._resetSetup(sessionKey);
      return this._result(candles5m,
        `Outside KZ — 5m H: ${this.pivots.lastHigh?.price.toFixed(2) ?? '—'}  L: ${this.pivots.lastLow?.price.toFixed(2) ?? '—'}`
      );
    }

    // Inside KZ — grant permission immediately if we have both levels
    if (this.state === STATES.IDLE || this.state === STATES.WATCHING) {
      this.state = STATES.WATCHING;

      if (!this.pivots.lastHigh || !this.pivots.lastLow) {
        return this._result(candles5m, 'KZ active — no confirmed pivots yet, building structure');
      }

      // Permission granted: pass the 5m High/Low to the 1m engine
      this.state = STATES.PERMISSION_GRANTED;
      this.permission = {
        instrument:  this.instrument,
        targetHigh:  this.pivots.lastHigh.price,
        targetLow:   this.pivots.lastLow.price,
        pivots:      { ...this.pivots },
        timestamp:   new Date().toISOString(),
      };
    }

    if (this.state === STATES.PERMISSION_GRANTED) {
      return this._result(candles5m, `PERMISSION GRANTED — 5m H:${this.permission.targetHigh.toFixed(2)} L:${this.permission.targetLow.toFixed(2)}`, true);
    }

    return this._result(candles5m, 'Scanning...');
  }

  _resetSetup(sessionKey) {
    this.state      = STATES.IDLE;
    this.sessionKey = sessionKey;
    this.permission = null;
    // pivots intentionally NOT reset
  }

  _result(candles, waitReason, permissionGranted = false) {
    const latest = candles[candles.length - 1];
    return {
      state: this.state,
      permissionGranted,
      permission: this.permission,
      sweep: null,
      waitReason,
      debug: {
        pivotHigh: this.pivots.lastHigh?.price ?? null,
        pivotLow:  this.pivots.lastLow?.price  ?? null,
        latestBar: latest?.time ?? null,
      },
    };
  }
}

module.exports = { Engine5m, STATES };
