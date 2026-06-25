'use strict';

// ─── 5m Permission Engine ─────────────────────────────────────────────────────
// Implements the state machine:
//
//   IDLE → WATCHING → SWEPT → MSS_CONFIRMED → PERMISSION_GRANTED
//
// One engine instance per instrument. State resets when a new NY KZ session
// starts (i.e. the date changes in NY time).
//
// This engine only grants PERMISSION — it does not calculate entry.
// The 1m execution engine will handle the actual entry refinement.

const { latestPivots }             = require('./swings');
const { DISPLACEMENT_BODY_RATIO, FVG_MIN_SIZE } = require('./config');

const STATES = {
  IDLE:               'IDLE',               // outside KZ or market closed
  WATCHING:           'WATCHING',           // inside KZ, no sweep yet
  SWEPT:              'SWEPT',              // liquidity sweep detected, waiting for MSS
  MSS_CONFIRMED:      'MSS_CONFIRMED',      // MSS confirmed, waiting for FVG
  PERMISSION_GRANTED: 'PERMISSION_GRANTED', // full setup confirmed — alert
};

class Engine5m {
  constructor(instrumentName) {
    this.instrument  = instrumentName;
    this.state       = STATES.IDLE;
    this.sessionKey  = null;   // resets on new NY day

    // Captured setup details (populated as states progress)
    this.sweep       = null;   // { dir, level, levelName, sweepCandle }
    this.mss         = null;   // { type, level, mssCandle }
    this.fvg         = null;   // { dir, top, bottom, mid, size }
    this.permission  = null;   // final permission object sent to alert
  }

  // Called each scan cycle — returns the current engine result
  // sessionKey: today's NY date string (used to reset between sessions)
  // candles5m:  array of 5m OHLC candles, oldest first, fully confirmed
  // inKZ:       boolean — is the NY KZ currently active?
  tick(sessionKey, candles5m, inKZ) {
    // Reset if new session started
    if (sessionKey !== this.sessionKey) {
      this._reset(sessionKey);
    }

    // Outside KZ — idle
    if (!inKZ) {
      if (this.state !== STATES.IDLE) this._reset(sessionKey);
      return this._result('Outside NY Kill Zone — monitoring');
    }

    // ── WATCHING: look for pre-NY range and a sweep ──────────────────────────
    if (this.state === STATES.WATCHING || this.state === STATES.IDLE) {
      this.state = STATES.WATCHING;

      const pivots = latestPivots(candles5m, 3);
      if (!pivots.lastHigh || !pivots.lastLow) {
        return this._result('Building swing structure — not enough confirmed pivots yet');
      }

      const sweep = this._detectSweep(candles5m, pivots);
      if (!sweep) {
        return this._result(`Watching for liquidity sweep — last pivot high ${pivots.lastHigh.price.toFixed(2)}, low ${pivots.lastLow.price.toFixed(2)}`);
      }

      this.sweep = sweep;
      this.state = STATES.SWEPT;
    }

    // ── SWEPT: look for 5m MSS ───────────────────────────────────────────────
    if (this.state === STATES.SWEPT) {
      const mss = this._detectMSS(candles5m);
      if (!mss) {
        return this._result(`Sweep on ${this.sweep.levelName} (${this.sweep.dir.toUpperCase()}) — waiting for 5m MSS`);
      }

      this.mss   = mss;
      this.state = STATES.MSS_CONFIRMED;
    }

    // ── MSS CONFIRMED: look for displacement + FVG ───────────────────────────
    if (this.state === STATES.MSS_CONFIRMED) {
      const fvg = this._detectFVG(candles5m);
      if (!fvg) {
        return this._result(`MSS confirmed (${this.mss.type}) — waiting for displacement + FVG`);
      }

      this.fvg   = fvg;
      this.state = STATES.PERMISSION_GRANTED;

      this.permission = {
        instrument:  this.instrument,
        direction:   this.sweep.dir === 'bear' ? 'SHORT' : 'LONG',
        sweep:       this.sweep,
        mss:         this.mss,
        fvg:         this.fvg,
        timestamp:   new Date().toISOString(),
      };
    }

    // ── PERMISSION GRANTED ───────────────────────────────────────────────────
    if (this.state === STATES.PERMISSION_GRANTED) {
      return this._result('PERMISSION GRANTED', true);
    }

    return this._result('Scanning...');
  }

  // ─── Sweep detection ─────────────────────────────────────────────────────────
  // A sweep = candle wicks THROUGH a recent pivot level, then CLOSES BACK inside it
  _detectSweep(candles, pivots) {
    const last10 = candles.slice(-10);

    for (let i = last10.length - 1; i >= 0; i--) {
      const c = last10[i];

      // Bearish sweep: wick above last pivot high, close back below
      if (pivots.lastHigh) {
        const lvl = pivots.lastHigh.price;
        if (c.high > lvl && c.close < lvl) {
          return {
            dir:        'bear',
            level:      lvl,
            levelName:  `Pivot High (${lvl.toFixed(2)})`,
            sweepCandle: c,
            sweepHigh:  c.high,
          };
        }
      }

      // Bullish sweep: wick below last pivot low, close back above
      if (pivots.lastLow) {
        const lvl = pivots.lastLow.price;
        if (c.low < lvl && c.close > lvl) {
          return {
            dir:        'bull',
            level:      lvl,
            levelName:  `Pivot Low (${lvl.toFixed(2)})`,
            sweepCandle: c,
            sweepLow:   c.low,
          };
        }
      }
    }

    return null;
  }

  // ─── MSS detection ───────────────────────────────────────────────────────────
  // After a bearish sweep: price must close below a recent 5m swing low (BOS down)
  //   or close below the previous candle's low (CHoCH)
  // After a bullish sweep: price must close above a recent 5m swing high (BOS up)
  //   or close above the previous candle's high (CHoCH)
  _detectMSS(candles) {
    const window = candles.slice(-20);
    if (window.length < 5) return null;

    const last = window[window.length - 1];
    const prev = window[window.length - 2];
    const dir  = this.sweep.dir;

    if (dir === 'bear') {
      // Find swing lows in the post-sweep window
      let swingLow = Infinity;
      for (let i = 1; i < window.length - 2; i++) {
        const c = window[i];
        if (c.low < window[i - 1].low && c.low < window[i + 1].low) {
          swingLow = Math.min(swingLow, c.low);
        }
      }
      if (swingLow < Infinity && last.close < swingLow && last.close < last.open) {
        return { type: 'BOS_DOWN', level: swingLow, mssCandle: last };
      }
      if (last.close < prev.low && last.close < last.open) {
        return { type: 'CHoCH', level: prev.low, mssCandle: last };
      }
    }

    if (dir === 'bull') {
      let swingHigh = -Infinity;
      for (let i = 1; i < window.length - 2; i++) {
        const c = window[i];
        if (c.high > window[i - 1].high && c.high > window[i + 1].high) {
          swingHigh = Math.max(swingHigh, c.high);
        }
      }
      if (swingHigh > -Infinity && last.close > swingHigh && last.close > last.open) {
        return { type: 'BOS_UP', level: swingHigh, mssCandle: last };
      }
      if (last.close > prev.high && last.close > last.open) {
        return { type: 'CHoCH', level: prev.high, mssCandle: last };
      }
    }

    return null;
  }

  // ─── Displacement + FVG detection ────────────────────────────────────────────
  // Displacement: the candle body is at least DISPLACEMENT_BODY_RATIO of the total range
  // FVG: 3-candle imbalance — candle[i-1].low > candle[i+1].high (bear)
  //                         or candle[i-1].high < candle[i+1].low (bull)
  _detectFVG(candles) {
    const window = candles.slice(-30);
    const dir    = this.sweep.dir;
    const fvgs   = [];

    for (let i = 1; i < window.length - 1; i++) {
      const c0 = window[i - 1];
      const c1 = window[i];
      const c2 = window[i + 1];

      // Check displacement on the middle candle
      const range = c1.high - c1.low;
      if (range === 0) continue;
      const body = Math.abs(c1.close - c1.open);
      const displaced = body / range >= DISPLACEMENT_BODY_RATIO;
      if (!displaced) continue;

      if (dir === 'bear') {
        // Bearish displacement: strong down candle
        if (c1.close < c1.open && c2.high < c0.low) {
          const size = c0.low - c2.high;
          if (size >= FVG_MIN_SIZE) {
            fvgs.push({ dir: 'bear', top: c0.low, bottom: c2.high, mid: (c0.low + c2.high) / 2, size, time: c1.time });
          }
        }
      } else {
        // Bullish displacement: strong up candle
        if (c1.close > c1.open && c2.low > c0.high) {
          const size = c2.low - c0.high;
          if (size >= FVG_MIN_SIZE) {
            fvgs.push({ dir: 'bull', top: c2.low, bottom: c0.high, mid: (c2.low + c0.high) / 2, size, time: c1.time });
          }
        }
      }
    }

    // Return the most recent valid FVG
    return fvgs.length ? fvgs[fvgs.length - 1] : null;
  }

  _reset(sessionKey) {
    this.state      = STATES.IDLE;
    this.sessionKey = sessionKey;
    this.sweep      = null;
    this.mss        = null;
    this.fvg        = null;
    this.permission = null;
  }

  _result(waitReason, permissionGranted = false) {
    return {
      state:             this.state,
      permissionGranted,
      permission:        this.permission,
      sweep:             this.sweep,
      mss:               this.mss,
      fvg:               this.fvg,
      waitReason,
    };
  }
}

module.exports = { Engine5m, STATES };
