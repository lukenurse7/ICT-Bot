'use strict';

// ─── 1m Execution Engine ──────────────────────────────────────────────────────
// Based on the reference ICT implementation (ict_killzone_tool.py).
//
// Flow:
//   1. SWEEP      — 1m wick trades through the specific 5m targetHigh (SHORT)
//                   or targetLow (LONG). Close anywhere.
//   2. MSS        — confirmed 1m swing low (SHORT) or high (LONG) that existed
//                   BEFORE the sweep is broken by a close AFTER the sweep
//   3. FVG        — bearish/bullish gap found inside the impulse leg
//                   (candles between sweep and MSS)
//   4. ENTRY_WATCH — wait for price to retrace into the FVG zone
//   5. ENTRY      — alert fires
//
//   SL  = swept 5m level + SL_BUFFER (above the liquidity for SHORT)
//   TP1 = 3R, TP2 = opposite 5m level

const MIN_RISK_PTS = parseFloat(process.env.MIN_RISK_PTS || '0.5');
const MAX_1M_BARS  = parseInt(process.env.MAX_1M_BARS   || '90');
const SL_BUFFER    = parseFloat(process.env.SL_BUFFER   || '1.0');  // tight scalp buffer
const TP_R         = parseFloat(process.env.TP_R        || '2.0');  // TP at 2R
const SWING_K      = 1;   // bars each side to confirm a 1m swing (1 = responsive, 2 = strict)

const STATES = {
  IDLE:        'IDLE',
  WATCHING:    'WATCHING',
  SWEPT:       'SWEPT',
  MSS:         'MSS',
  ENTRY_WATCH: 'ENTRY_WATCH',
  ENTRY:       'ENTRY',
};

class Engine1m {
  constructor(instrumentName) {
    this.instrument = instrumentName;
    this._reset();
  }

  activate(permission) {
    this._reset();
    this.active     = true;
    this.targetHigh = permission.targetHigh;
    this.targetLow  = permission.targetLow;
    this.startBar   = null;
    this.state      = STATES.WATCHING;
  }

  tick(candles1m) {
    if (!this.active) return this._result('1m engine idle');

    if (this.startBar === null) this.startBar = candles1m.length - 1;

    const barsElapsed = (candles1m.length - 1) - this.startBar;
    if (barsElapsed > MAX_1M_BARS) {
      // Don't fully reset — keep watching for another sweep within the same session
      const savedHigh = this.targetHigh;
      const savedLow  = this.targetLow;
      this._reset();
      this.active      = true;
      this.targetHigh  = savedHigh;
      this.targetLow   = savedLow;
      this.startBar    = candles1m.length - 1;
      this.state       = STATES.WATCHING;
      return this._result(`Setup expired — re-watching for new sweep [reset]`);
    }

    // ── STEP 1: sweep of specific 5m level ──────────────────────────────────
    if (this.state === STATES.WATCHING) {
      const sweep = this._detectSweep(candles1m);
      if (!sweep) {
        return this._result(
          `Watching for sweep of H:${this.targetHigh?.toFixed(2)} L:${this.targetLow?.toFixed(2)} [${barsElapsed}/${MAX_1M_BARS}m]`
        );
      }
      this.sweep1m     = sweep;
      this.direction   = sweep.dir === 'bear' ? 'SHORT' : 'LONG';
      this.sweepBarIdx = sweep.barIdx;
      this.state       = STATES.SWEPT;
    }

    // ── STEP 2: 1m MSS after the sweep ──────────────────────────────────────
    if (this.state === STATES.SWEPT) {
      const isShort = this.direction === 'SHORT';
      const mss = this._detectMSS(candles1m, isShort);
      if (!mss) {
        const b = (candles1m.length - 1) - this.sweepBarIdx;
        return this._result(`Sweep ✓ (${this.direction}) — waiting for 1m MSS [${b}m]`);
      }
      this.mss1m     = mss;
      this.mssBarIdx = mss.barIdx;
      this.state     = STATES.MSS;
    }

    // ── STEP 3: FVG inside the impulse leg (sweep → MSS) ────────────────────
    if (this.state === STATES.MSS) {
      const isShort = this.direction === 'SHORT';
      const fvg = this._detectFVG(candles1m, isShort);
      if (!fvg) {
        return this._result(`MSS ✓ (${this.mss1m.type}) — no FVG in impulse leg`);
      }
      this.fvg1m = fvg;
      this.state = STATES.ENTRY_WATCH;
      return this._result(`FVG ✓ ${fvg.bottom.toFixed(2)}–${fvg.top.toFixed(2)} — waiting for retracement`);
    }

    // ── STEP 4: wait for price to retrace into FVG ──────────────────────────
    if (this.state === STATES.ENTRY_WATCH) {
      const latest  = candles1m[candles1m.length - 1];
      const fvg     = this.fvg1m;
      const isShort = this.direction === 'SHORT';

      // Price must reach the proximal edge of the FVG (the entry level)
      const reached = isShort
        ? latest.high >= fvg.bottom   // rally up to FVG bottom
        : latest.low  <= fvg.top;     // pullback down to FVG top

      if (!reached) {
        return this._result(`Waiting for retracement to FVG ${isShort ? 'bottom' : 'top'} @ ${isShort ? fvg.bottom.toFixed(2) : fvg.top.toFixed(2)}`);
      }

      const signal  = this._buildSignal(isShort, latest);
      if (!signal) {
        this._reset();
        return this._result(`FVG tapped but risk < ${MIN_RISK_PTS}pts or inverted — skipping`);
      }
      this.signal = signal;
      this.state  = STATES.ENTRY;
    }

    if (this.state === STATES.ENTRY) {
      return this._result('ENTRY SIGNAL READY', true);
    }

    return this._result('Scanning 1m...');
  }

  // ─── Confirmed 1m swings (repaint-safe, k bars each side) ─────────────────
  _confirmedSwings(candles) {
    const highs = [], lows = [];
    const n = candles.length;
    for (let i = SWING_K; i < n - SWING_K; i++) {
      const hi = candles[i].high, lo = candles[i].low;
      let isHigh = true, isLow = true;
      for (let j = 1; j <= SWING_K; j++) {
        if (hi <= candles[i - j].high || hi <= candles[i + j].high) isHigh = false;
        if (lo >= candles[i - j].low  || lo >= candles[i + j].low)  isLow  = false;
      }
      if (isHigh) highs.push({ idx: i, price: hi });
      if (isLow)  lows.push({ idx: i, price: lo });
    }
    return { highs, lows };
  }

  // ─── Sweep: wick through specific 5m level (close anywhere) ───────────────
  _detectSweep(candles) {
    for (let i = candles.length - 1; i >= Math.max(0, candles.length - 10); i--) {
      const bar = candles[i];
      if (this.targetHigh != null && bar.high > this.targetHigh)
        return { dir: 'bear', barIdx: i, sweepHigh: bar.high, level: this.targetHigh };
      if (this.targetLow != null && bar.low < this.targetLow)
        return { dir: 'bull', barIdx: i, sweepLow: bar.low, level: this.targetLow };
    }
    return null;
  }

  // ─── MSS: confirmed swing before sweep broken by close after sweep ─────────
  _detectMSS(candles, isShort) {
    // Find confirmed swings in candles up to and including the sweep bar
    const preSweep = candles.slice(0, this.sweepBarIdx + 1);
    const { highs, lows } = this._confirmedSwings(preSweep);

    if (isShort) {
      // Need a confirmed swing LOW before the sweep to break downward
      if (!lows.length) return null;
      const refLevel = lows[lows.length - 1].price;
      for (let i = this.sweepBarIdx + 1; i < candles.length; i++) {
        if (candles[i].close < refLevel)
          return { type: 'BOS_DOWN', level: refLevel, barIdx: i, mssCandle: candles[i] };
      }
    } else {
      // Need a confirmed swing HIGH before the sweep to break upward
      if (!highs.length) return null;
      const refLevel = highs[highs.length - 1].price;
      for (let i = this.sweepBarIdx + 1; i < candles.length; i++) {
        if (candles[i].close > refLevel)
          return { type: 'BOS_UP', level: refLevel, barIdx: i, mssCandle: candles[i] };
      }
    }
    return null;
  }

  // ─── FVG: gap in the impulse leg between sweep and MSS ────────────────────
  // SHORT: candle[i-1].low > candle[i+1].high  → bearish FVG
  // LONG:  candle[i-1].high < candle[i+1].low  → bullish FVG
  // Entry at proximal edge: bottom (SHORT) or top (LONG)
  _detectFVG(candles, isShort) {
    const legStart = Math.max(1, this.sweepBarIdx);
    // Search all candles after sweep — FVG can form any time after MSS during the session
    const legEnd   = candles.length - 2;

    // Search most-recent first within the impulse leg
    for (let i = legEnd; i >= legStart; i--) {
      const a = candles[i - 1];   // candle before
      const b = candles[i];       // displacement candle
      const c = candles[i + 1];   // candle after

      if (isShort && a.low > c.high) {
        const top = a.low, bottom = c.high;
        return { dir: 'bear', top, bottom, mid: (top + bottom) / 2, entryLevel: bottom };
      }
      if (!isShort && a.high < c.low) {
        const top = c.low, bottom = a.high;
        return { dir: 'bull', top, bottom, mid: (top + bottom) / 2, entryLevel: top };
      }
    }
    return null;
  }

  // ─── Build signal ──────────────────────────────────────────────────────────
  _buildSignal(isShort, triggerCandle) {
    // SL: just beyond the sweep wick extreme — tight scalp placement
    const sweepExtreme = isShort ? this.sweep1m.sweepHigh : this.sweep1m.sweepLow;
    const sl = isShort
      ? parseFloat((sweepExtreme + SL_BUFFER).toFixed(2))
      : parseFloat((sweepExtreme - SL_BUFFER).toFixed(2));

    // Entry: proximal edge of FVG (the end closest to current price)
    // SHORT: price rallies UP into FVG → entry at FVG bottom (c2.high)
    // LONG:  price drops DOWN into FVG → entry at FVG top (c2.low)
    const entry = isShort
      ? this.fvg1m.bottom   // lowest point of bear FVG — first touched on rally
      : this.fvg1m.top;     // highest point of bull FVG — first touched on pullback

    const risk = Math.abs(entry - sl);

    if (isShort && sl <= entry) return null;
    if (!isShort && sl >= entry) return null;
    if (risk < MIN_RISK_PTS) return null;

    // TP at fixed R multiple — scalp target, not swing
    const tp = isShort
      ? parseFloat((entry - risk * TP_R).toFixed(2))
      : parseFloat((entry + risk * TP_R).toFixed(2));

    const rr = TP_R;

    return {
      instrument:  this.instrument,
      direction:   this.direction,
      entry:       parseFloat(entry.toFixed(2)),
      sl,
      tp1:         tp,
      tp2:         isShort ? this.targetLow : this.targetHigh,  // stretch target
      riskPts:     parseFloat(risk.toFixed(2)),
      rewardPts:   parseFloat((risk * TP_R).toFixed(2)),
      rr,
      sweep5mH:    this.targetHigh,
      sweep5mL:    this.targetLow,
      sweep1m:     `wick to ${isShort ? this.sweep1m.sweepHigh?.toFixed(2) : this.sweep1m.sweepLow?.toFixed(2)}`,
      mss1m:       `${this.mss1m.type} @ ${this.mss1m.level.toFixed(2)}`,
      fvg1m:       `${this.fvg1m.bottom.toFixed(2)}–${this.fvg1m.top.toFixed(2)}`,
      triggerTime: triggerCandle.time,
      timestamp:   new Date().toISOString(),
    };
  }

  _reset() {
    this.active      = false;
    this.direction   = null;
    this.targetHigh  = null;
    this.targetLow   = null;
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
