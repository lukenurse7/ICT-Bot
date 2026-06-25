'use strict';

// ─── 1m Execution Engine ──────────────────────────────────────────────────────
// Activated by 5m permission with targetHigh and targetLow.
//
// Correct flow:
//   1. SWEEP  — 1m candle wicks through the specific 5m targetHigh (SHORT) or
//               targetLow (LONG) and closes back on the other side
//   2. MSS    — displacement candle shifts 1m structure in signal direction
//   3. FVG    — imbalance left behind by the displacement candle
//   4. ENTRY  — price reaches the START of the FVG (limit order level)
//               SHORT: c2.high (bottom of bear FVG)
//               LONG:  c2.low  (top of bull FVG)
//   SL  = sweep extreme + buffer
//   TP1 = 3R, TP2 = opposite 5m level

const MIN_RISK_PTS = parseFloat(process.env.MIN_RISK_PTS || '0.5');
const MAX_1M_BARS  = parseInt(process.env.MAX_1M_BARS   || '60');

const DISPLACEMENT_RATIO = 0.35;
const FVG_MIN_SIZE_1M    = 0.02;

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
    this.active      = true;
    this.targetHigh  = permission.targetHigh;
    this.targetLow   = permission.targetLow;
    this.sweep5m     = { targetHigh: permission.targetHigh, targetLow: permission.targetLow };
    this.startBar    = null;
    this.state       = STATES.WATCHING;
  }

  tick(candles1m) {
    if (!this.active) return this._result('1m engine idle');

    if (this.startBar === null) this.startBar = candles1m.length - 1;

    const barsElapsed = (candles1m.length - 1) - this.startBar;
    if (barsElapsed > MAX_1M_BARS) {
      this._reset();
      return this._result(`Expired — no entry in ${MAX_1M_BARS} bars`);
    }

    // ── STEP 1: Sweep of the specific 5m level ───────────────────────────────
    if (this.state === STATES.WATCHING) {
      const sweep = this._detectSweep(candles1m);
      if (!sweep) {
        return this._result(
          `Watching for sweep of 5m H:${this.targetHigh?.toFixed(2)} L:${this.targetLow?.toFixed(2)} [${barsElapsed}/${MAX_1M_BARS}m]`
        );
      }
      this.sweep1m     = sweep;
      this.direction   = sweep.dir === 'bear' ? 'SHORT' : 'LONG';
      this.sweepBarIdx = candles1m.length - 1;
      this.state       = STATES.SWEPT;
    }

    // ── STEP 2: 1m MSS after sweep ───────────────────────────────────────────
    if (this.state === STATES.SWEPT) {
      const isShort = this.direction === 'SHORT';
      const mss = this._detectMSS(candles1m, isShort);
      if (!mss) {
        const b = (candles1m.length - 1) - this.sweepBarIdx;
        return this._result(`Sweep ✓ (${this.direction}) — waiting for 1m MSS [${b}m]`);
      }
      this.mss1m     = mss;
      this.mssBarIdx = candles1m.length - 1;
      this.state     = STATES.MSS;
    }

    // ── STEP 3: FVG from the displacement candle ─────────────────────────────
    if (this.state === STATES.MSS) {
      const isShort = this.direction === 'SHORT';
      const fvg = this._detectFVG(candles1m, isShort);
      if (!fvg) {
        const b = (candles1m.length - 1) - this.mssBarIdx;
        return this._result(`MSS ✓ (${this.mss1m.type}) — waiting for 1m FVG [${b}m]`);
      }
      this.fvg1m = fvg;
      this.state = STATES.ENTRY_WATCH;
      return this._result(`FVG ✓ ${fvg.bottom.toFixed(2)}–${fvg.top.toFixed(2)} — entry at ${fvg.entryLevel.toFixed(2)}`);
    }

    // ── STEP 4: Wait for price to reach the FVG start (limit level) ─────────
    if (this.state === STATES.ENTRY_WATCH) {
      const isShort = this.direction === 'SHORT';
      const latest  = candles1m[candles1m.length - 1];
      const fvg     = this.fvg1m;

      // SHORT: price rallies back up to c2.high (FVG bottom), wick enters zone
      // LONG:  price pulls back down to c2.low (FVG top), wick enters zone
      const reached = isShort
        ? latest.high >= fvg.entryLevel
        : latest.low  <= fvg.entryLevel;

      if (!reached) {
        return this._result(`Waiting for price to reach FVG start @ ${fvg.entryLevel.toFixed(2)}`);
      }

      const signal = this._buildSignal(isShort, latest);
      if (!signal) {
        this._reset();
        return this._result(`FVG reached but risk < ${MIN_RISK_PTS}pts — skipping`);
      }

      this.signal = signal;
      this.state  = STATES.ENTRY;
    }

    if (this.state === STATES.ENTRY) {
      return this._result('ENTRY SIGNAL READY', true);
    }

    return this._result('Scanning 1m...');
  }

  // ─── Sweep of specific 5m targetHigh or targetLow ─────────────────────────
  // Price only needs to TRADE THROUGH the level — close does not need to
  // reverse back on the same candle. The MSS+FVG that follows confirms
  // direction. We track which level was taken so later steps know direction.
  _detectSweep(candles) {
    if (candles.length < 3) return null;
    const window = candles.slice(-10);
    for (let i = window.length - 1; i >= 0; i--) {
      const bar = window[i];
      // Bear sweep: wick above targetHigh (close anywhere)
      if (this.targetHigh != null && bar.high > this.targetHigh) {
        return { dir: 'bear', sweepCandle: bar, sweepHigh: bar.high, level: this.targetHigh };
      }
      // Bull sweep: wick below targetLow (close anywhere)
      if (this.targetLow != null && bar.low < this.targetLow) {
        return { dir: 'bull', sweepCandle: bar, sweepLow: bar.low, level: this.targetLow };
      }
    }
    return null;
  }

  // ─── 1m MSS: displacement break of recent internal swing ──────────────────
  _detectMSS(candles, isShort) {
    const window = candles.slice(-20);
    if (window.length < 5) return null;
    const last = window[window.length - 1];
    const prev = window[window.length - 2];

    // Displacement: body must be meaningful
    const range = last.high - last.low;
    if (range === 0) return null;
    const body = Math.abs(last.close - last.open);
    if (body / range < DISPLACEMENT_RATIO) return null;

    if (isShort && last.close < last.open) {
      // BOS down: close below a recent swing low
      let swingLow = Infinity;
      for (let i = 1; i < window.length - 1; i++) {
        const c = window[i];
        if (c.low < window[i - 1].low && c.low < window[i + 1].low)
          swingLow = Math.min(swingLow, c.low);
      }
      if (swingLow < Infinity && last.close < swingLow)
        return { type: 'BOS_DOWN', level: swingLow, mssCandle: last };
      // CHoCH: close below previous candle's low
      if (last.close < prev.low)
        return { type: 'CHoCH', level: prev.low, mssCandle: last };
    }

    if (!isShort && last.close > last.open) {
      let swingHigh = -Infinity;
      for (let i = 1; i < window.length - 1; i++) {
        const c = window[i];
        if (c.high > window[i - 1].high && c.high > window[i + 1].high)
          swingHigh = Math.max(swingHigh, c.high);
      }
      if (swingHigh > -Infinity && last.close > swingHigh)
        return { type: 'BOS_UP', level: swingHigh, mssCandle: last };
      if (last.close > prev.high)
        return { type: 'CHoCH', level: prev.high, mssCandle: last };
    }

    return null;
  }

  // ─── 1m FVG: 3-candle imbalance from displacement candle ──────────────────
  // entryLevel = START of FVG (first price touched on retest)
  //   SHORT: c2.high (bottom of bear FVG — price rallies up to here)
  //   LONG:  c2.low  (top of bull FVG — price pulls back down to here)
  _detectFVG(candles, isShort) {
    const window = candles.slice(-15);
    const fvgs   = [];

    for (let i = 1; i < window.length - 1; i++) {
      const c0 = window[i - 1];
      const c1 = window[i];       // displacement candle
      const c2 = window[i + 1];

      const range = c1.high - c1.low;
      if (range === 0) continue;
      const body      = Math.abs(c1.close - c1.open);
      const displaced = body / range >= DISPLACEMENT_RATIO;
      if (!displaced) continue;

      if (isShort && c1.close < c1.open && c2.high < c0.low) {
        const size = c0.low - c2.high;
        if (size >= FVG_MIN_SIZE_1M)
          fvgs.push({
            dir:        'bear',
            top:        c0.low,
            bottom:     c2.high,
            mid:        (c0.low + c2.high) / 2,
            entryLevel: c2.high,   // START: bottom of bear FVG
            size,
            time: c1.time,
          });
      }

      if (!isShort && c1.close > c1.open && c2.low > c0.high) {
        const size = c2.low - c0.high;
        if (size >= FVG_MIN_SIZE_1M)
          fvgs.push({
            dir:        'bull',
            top:        c2.low,
            bottom:     c0.high,
            mid:        (c2.low + c0.high) / 2,
            entryLevel: c2.low,    // START: top of bull FVG
            size,
            time: c1.time,
          });
      }
    }

    return fvgs.length ? fvgs[fvgs.length - 1] : null;
  }

  // ─── Build entry signal ────────────────────────────────────────────────────
  _buildSignal(isShort, triggerCandle) {
    const entry    = this.fvg1m.entryLevel;
    const sweep    = this.sweep1m;
    const slBuffer = 0.10;

    const sl = isShort
      ? parseFloat((sweep.sweepHigh + slBuffer).toFixed(2))
      : parseFloat((sweep.sweepLow  - slBuffer).toFixed(2));

    const risk = Math.abs(entry - sl);
    if (risk < MIN_RISK_PTS) return null;

    const tp1 = isShort
      ? parseFloat((entry - risk * 3).toFixed(2))
      : parseFloat((entry + risk * 3).toFixed(2));

    // TP2 = opposite 5m level
    const tp2 = isShort ? this.targetLow : this.targetHigh;

    return {
      instrument:  this.instrument,
      direction:   this.direction,
      entry:       parseFloat(entry.toFixed(2)),
      sl,
      tp1,
      tp2:         tp2 != null ? parseFloat(tp2.toFixed(2)) : null,
      riskPts:     parseFloat(risk.toFixed(2)),
      sweep5mH:    this.targetHigh,
      sweep5mL:    this.targetLow,
      sweep1m:     `wick to ${isShort ? sweep.sweepHigh.toFixed(2) : sweep.sweepLow.toFixed(2)}`,
      mss1m:       `${this.mss1m.type} @ ${this.mss1m.level.toFixed(2)}`,
      fvg1m:       `${this.fvg1m.bottom.toFixed(2)}–${this.fvg1m.top.toFixed(2)}`,
      entryLevel:  `FVG start @ ${entry.toFixed(2)}`,
      triggerTime: triggerCandle.time,
      timestamp:   new Date().toISOString(),
    };
  }

  _reset() {
    this.active      = false;
    this.direction   = null;
    this.targetHigh  = null;
    this.targetLow   = null;
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
