'use strict';

// ─── 5m Permission Engine ─────────────────────────────────────────────────────
// State machine with two separate concerns:
//
//   CONTEXT (runs all day, always):
//     - Pivot highs/lows updated on every candle, all session long
//     - This ensures we always know the most recent swing H/L before KZ opens
//
//   SETUP (only triggers inside NY Kill Zone):
//     - Sweep → MSS → FVG
//     - Resets at the start of each new KZ session
//     - Does NOT reset the pivot context
//
// Relaxed mode: sweep, MSS and FVG must each occur within MAX_CANDLES_AFTER
// candles of the previous step. Default 10. Prevents stale setups firing.

const { latestPivots }                              = require('./swings');
const { DISPLACEMENT_BODY_RATIO, FVG_MIN_SIZE }     = require('./config');

const MAX_CANDLES_AFTER = parseInt(process.env.MAX_CANDLES_AFTER || '10');

const STATES = {
  IDLE:               'IDLE',
  WATCHING:           'WATCHING',
  SWEPT:              'SWEPT',
  MSS_CONFIRMED:      'MSS_CONFIRMED',
  PERMISSION_GRANTED: 'PERMISSION_GRANTED',
};

class Engine5m {
  constructor(instrumentName) {
    this.instrument = instrumentName;

    // ── Context (persists all day, never reset mid-session) ──────────────────
    this.pivots     = { lastHigh: null, lastLow: null };

    // ── Setup state (reset at start of each KZ session) ─────────────────────
    this.state        = STATES.IDLE;
    this.sessionKey   = null;
    this.sweep        = null;
    this.sweepBarIdx  = null;   // candle index when sweep was detected
    this.mss          = null;
    this.mssBarIdx    = null;
    this.fvg          = null;
    this.permission   = null;
  }

  tick(sessionKey, candles5m, inKZ) {
    // ── 1. Always update pivot context (all day, every tick) ─────────────────
    const p = latestPivots(candles5m, 3);
    if (p.lastHigh) this.pivots.lastHigh = p.lastHigh;
    if (p.lastLow)  this.pivots.lastLow  = p.lastLow;

    const currentBar = candles5m.length - 1;  // index of latest candle

    // ── 2. Reset SETUP state only when a new KZ session starts ───────────────
    if (sessionKey !== this.sessionKey) {
      this._resetSetup(sessionKey);
    }

    // ── 3. Outside KZ — idle, but context still updating ─────────────────────
    if (!inKZ) {
      if (this.state !== STATES.IDLE) this._resetSetup(sessionKey);
      return this._result(candles5m, `Outside KZ — pivot H: ${this.pivots.lastHigh?.price.toFixed(2) ?? '—'}  L: ${this.pivots.lastLow?.price.toFixed(2) ?? '—'}`);
    }

    // ── 4. Inside KZ — run the setup state machine ───────────────────────────

    // WATCHING: look for sweep of the known pivot levels
    if (this.state === STATES.IDLE || this.state === STATES.WATCHING) {
      this.state = STATES.WATCHING;

      if (!this.pivots.lastHigh || !this.pivots.lastLow) {
        return this._result(candles5m, 'KZ active — no confirmed pivots yet, building structure');
      }

      const sweep = this._detectSweep(candles5m);
      if (!sweep) {
        return this._result(candles5m,
          `Watching for sweep — pivot H: ${this.pivots.lastHigh.price.toFixed(2)}  L: ${this.pivots.lastLow.price.toFixed(2)}`
        );
      }

      this.sweep       = sweep;
      this.sweepBarIdx = currentBar;
      this.state       = STATES.SWEPT;
    }

    // SWEPT: look for MSS within MAX_CANDLES_AFTER bars
    if (this.state === STATES.SWEPT) {
      const barsSinceSweep = currentBar - this.sweepBarIdx;
      if (barsSinceSweep > MAX_CANDLES_AFTER) {
        this._resetSetup(sessionKey);
        return this._result(candles5m, `Sweep expired (>${MAX_CANDLES_AFTER} bars, no MSS) — resetting`);
      }

      const mss = this._detectMSS(candles5m);
      if (!mss) {
        return this._result(candles5m,
          `Sweep: ${this.sweep.levelName} (${this.sweep.dir}) — waiting for MSS [${barsSinceSweep}/${MAX_CANDLES_AFTER} bars]`
        );
      }

      this.mss       = mss;
      this.mssBarIdx = currentBar;
      this.state     = STATES.MSS_CONFIRMED;
    }

    // MSS CONFIRMED: look for displacement + FVG within MAX_CANDLES_AFTER bars
    if (this.state === STATES.MSS_CONFIRMED) {
      const barsSinceMSS = currentBar - this.mssBarIdx;
      if (barsSinceMSS > MAX_CANDLES_AFTER) {
        this._resetSetup(sessionKey);
        return this._result(candles5m, `MSS expired (>${MAX_CANDLES_AFTER} bars, no FVG) — resetting`);
      }

      const fvg = this._detectFVG(candles5m);
      if (!fvg) {
        return this._result(candles5m,
          `MSS: ${this.mss.type} @ ${this.mss.level.toFixed(2)} — waiting for displacement + FVG [${barsSinceMSS}/${MAX_CANDLES_AFTER} bars]`
        );
      }

      this.fvg   = fvg;
      this.state = STATES.PERMISSION_GRANTED;

      this.permission = {
        instrument: this.instrument,
        direction:  this.sweep.dir === 'bear' ? 'SHORT' : 'LONG',
        sweep:      this.sweep,
        mss:        this.mss,
        fvg:        this.fvg,
        pivots:     { ...this.pivots },
        timestamp:  new Date().toISOString(),
      };
    }

    if (this.state === STATES.PERMISSION_GRANTED) {
      return this._result(candles5m, 'PERMISSION GRANTED', true);
    }

    return this._result(candles5m, 'Scanning...');
  }

  // ─── Sweep: wick through pivot level, close back inside ──────────────────────
  _detectSweep(candles) {
    // Check last 5 candles for a sweep of the stored pivot levels
    const last5 = candles.slice(-5);

    for (let i = last5.length - 1; i >= 0; i--) {
      const c = last5[i];

      if (this.pivots.lastHigh) {
        const lvl = this.pivots.lastHigh.price;
        if (c.high > lvl && c.close < lvl) {
          return { dir: 'bear', level: lvl, levelName: `Pivot High ${lvl.toFixed(2)}`, sweepCandle: c, sweepHigh: c.high };
        }
      }

      if (this.pivots.lastLow) {
        const lvl = this.pivots.lastLow.price;
        if (c.low < lvl && c.close > lvl) {
          return { dir: 'bull', level: lvl, levelName: `Pivot Low ${lvl.toFixed(2)}`, sweepCandle: c, sweepLow: c.low };
        }
      }
    }

    return null;
  }

  // ─── MSS: break of structure after sweep ────────────────────────────────────
  _detectMSS(candles) {
    const window = candles.slice(-20);
    if (window.length < 5) return null;

    const last = window[window.length - 1];
    const prev = window[window.length - 2];
    const dir  = this.sweep.dir;

    if (dir === 'bear') {
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
    }

    if (dir === 'bull') {
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

  // ─── FVG + displacement: 3-candle imbalance with strong body ────────────────
  _detectFVG(candles) {
    const window = candles.slice(-30);
    const dir    = this.sweep.dir;
    const fvgs   = [];

    for (let i = 1; i < window.length - 1; i++) {
      const c0 = window[i - 1];
      const c1 = window[i];
      const c2 = window[i + 1];

      const range = c1.high - c1.low;
      if (range === 0) continue;
      const body       = Math.abs(c1.close - c1.open);
      const displaced  = body / range >= DISPLACEMENT_BODY_RATIO;
      if (!displaced) continue;

      if (dir === 'bear' && c1.close < c1.open && c2.high < c0.low) {
        const size = c0.low - c2.high;
        if (size >= FVG_MIN_SIZE)
          fvgs.push({ dir: 'bear', top: c0.low, bottom: c2.high, mid: (c0.low + c2.high) / 2, size, time: c1.time });
      }

      if (dir === 'bull' && c1.close > c1.open && c2.low > c0.high) {
        const size = c2.low - c0.high;
        if (size >= FVG_MIN_SIZE)
          fvgs.push({ dir: 'bull', top: c2.low, bottom: c0.high, mid: (c2.low + c0.high) / 2, size, time: c1.time });
      }
    }

    return fvgs.length ? fvgs[fvgs.length - 1] : null;
  }

  _resetSetup(sessionKey) {
    this.state       = STATES.IDLE;
    this.sessionKey  = sessionKey;
    this.sweep       = null;
    this.sweepBarIdx = null;
    this.mss         = null;
    this.mssBarIdx   = null;
    this.fvg         = null;
    this.permission  = null;
    // NOTE: this.pivots is intentionally NOT reset here
  }

  _result(candles, waitReason, permissionGranted = false) {
    const latest = candles[candles.length - 1];
    return {
      state:             this.state,
      permissionGranted,
      permission:        this.permission,
      sweep:             this.sweep,
      mss:               this.mss,
      fvg:               this.fvg,
      waitReason,
      debug: {
        pivotHigh:  this.pivots.lastHigh?.price ?? null,
        pivotLow:   this.pivots.lastLow?.price  ?? null,
        latestBar:  latest?.time ?? null,
        maxCandles: MAX_CANDLES_AFTER,
      },
    };
  }
}

module.exports = { Engine5m, STATES };
