'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  XAUUSD ICT STRATEGY BACKTESTER
//  Generates synthetic XAUUSD price data with realistic ICT setups baked in,
//  then runs the live analysis engine over rolling windows to show:
//    • How many signals fire
//    • Win/loss outcomes
//    • Average R:R achieved
//    • What each signal looked like (entry/SL/TP)
// ═══════════════════════════════════════════════════════════════════════════

const chalk = require('chalk');
const {
  htfBias, keyLevels, detectLiquiditySweep,
  detectMSS, entryFVG, findOrderBlock, scoreConfluence
} = require('./ict_xau');
const { sessionStatus } = require('./sessions');

// ─── Synthetic candle generator ─────────────────────────────────────────────

function makeCandle(time, open, high, low, close) {
  return { time, open, high, low, close, volume: Math.random() * 1000 + 500 };
}

/**
 * Generate a series of candles using a simple random-walk with drift.
 * We also inject 6 ICT-style setups (3 long, 3 short) so the engine fires.
 */
function generatePriceData() {
  const START_PRICE = 3100;
  const MS = 5 * 60 * 1000; // 5-min in ms
  const BASE_TIME = new Date('2025-01-06T08:00:00Z').getTime();

  // Build 200 5-min candles (~16h of data)
  const candles5m = [];
  let price = START_PRICE;

  for (let i = 0; i < 200; i++) {
    const time = new Date(BASE_TIME + i * MS).toISOString();
    const move = (Math.random() - 0.49) * 4; // slight bullish drift
    const range = 3 + Math.random() * 5;
    const open = price;
    const close = price + move;
    const high = Math.max(open, close) + Math.random() * range;
    const low  = Math.min(open, close) - Math.random() * range;
    candles5m.push(makeCandle(time, open, high, low, close));
    price = close;
  }

  // ── Inject Setup A: SSL sweep + bullish BOS at index 40 ──────────────────
  const sweepBase = 3080;
  // Pre-sweep: two equal lows establish SSL at sweepBase
  candles5m[35] = makeCandle(candles5m[35].time, sweepBase + 5, sweepBase + 12, sweepBase + 0.5, sweepBase + 8);
  candles5m[38] = makeCandle(candles5m[38].time, sweepBase + 6, sweepBase + 10, sweepBase + 0.5, sweepBase + 7);
  // Sweep candle: wick below, close back above
  candles5m[40] = makeCandle(candles5m[40].time, sweepBase + 5, sweepBase + 6, sweepBase - 4, sweepBase + 5);
  // BOS candle: strong close above the last swing high
  candles5m[42] = makeCandle(candles5m[42].time, sweepBase + 5, sweepBase + 25, sweepBase + 4, sweepBase + 22);
  // FVG: gap between [41].high and [43].low
  candles5m[41] = makeCandle(candles5m[41].time, sweepBase + 5, sweepBase + 10, sweepBase + 4, sweepBase + 9);
  candles5m[43] = makeCandle(candles5m[43].time, sweepBase + 15, sweepBase + 26, sweepBase + 12, sweepBase + 24);
  // Continuation
  for (let i = 44; i < 60; i++) {
    candles5m[i] = makeCandle(candles5m[i].time,
      sweepBase + 20 + (i - 44) * 1.5,
      sweepBase + 24 + (i - 44) * 1.5,
      sweepBase + 18 + (i - 44) * 1.5,
      sweepBase + 23 + (i - 44) * 1.5
    );
  }

  // ── Inject Setup B: BSL sweep + bearish BOS at index 100 ─────────────────
  const bearBase = 3130;
  candles5m[95]  = makeCandle(candles5m[95].time,  bearBase - 5, bearBase - 0.5, bearBase - 12, bearBase - 8);
  candles5m[98]  = makeCandle(candles5m[98].time,  bearBase - 6, bearBase - 0.5, bearBase - 10, bearBase - 7);
  candles5m[100] = makeCandle(candles5m[100].time, bearBase - 5, bearBase + 4,   bearBase - 6,  bearBase - 5);
  candles5m[102] = makeCandle(candles5m[102].time, bearBase - 5, bearBase - 4,   bearBase - 25, bearBase - 22);
  candles5m[101] = makeCandle(candles5m[101].time, bearBase - 5, bearBase - 9,   bearBase - 4,  bearBase - 8);
  candles5m[103] = makeCandle(candles5m[103].time, bearBase - 14, bearBase - 12, bearBase - 26, bearBase - 24);
  for (let i = 104; i < 120; i++) {
    candles5m[i] = makeCandle(candles5m[i].time,
      bearBase - 20 - (i - 104) * 1.5,
      bearBase - 18 - (i - 104) * 1.5,
      bearBase - 24 - (i - 104) * 1.5,
      bearBase - 23 - (i - 104) * 1.5
    );
  }

  // Build scale-up from 5m candles for higher timeframes
  function rollup(src, factor) {
    const out = [];
    for (let i = 0; i < src.length; i += factor) {
      const slice = src.slice(i, i + factor);
      if (!slice.length) continue;
      out.push({
        time:   slice[0].time,
        open:   slice[0].open,
        high:   Math.max(...slice.map(c => c.high)),
        low:    Math.min(...slice.map(c => c.low)),
        close:  slice[slice.length - 1].close,
        volume: slice.reduce((s, c) => s + c.volume, 0)
      });
    }
    return out;
  }

  const m15  = rollup(candles5m, 3);   // 15m
  const h1   = rollup(candles5m, 12);  // 1h
  const h4   = rollup(candles5m, 48);  // 4h
  const daily = rollup(candles5m, 288); // 1d — will only be ~1 day but enough for structure

  // Pad daily to at least 6 candles so swing detection works
  while (daily.length < 6) {
    const last = daily[daily.length - 1];
    daily.unshift({
      time:   new Date(new Date(last.time).getTime() - 86400000 * (6 - daily.length)).toISOString(),
      open:   last.open - 20,
      high:   last.high - 15,
      low:    last.low  - 25,
      close:  last.close - 20,
      volume: last.volume
    });
  }

  // Inject clear HTF bullish structure (HH + HL on daily)
  daily[0] = { ...daily[0], high: 3040, low: 2980, open: 2990, close: 3020 };
  daily[1] = { ...daily[1], high: 3060, low: 2995, open: 3000, close: 3055 };
  daily[2] = { ...daily[2], high: 3050, low: 3005, open: 3040, close: 3010 }; // HL pullback
  daily[3] = { ...daily[3], high: 3090, low: 3010, open: 3015, close: 3085 }; // HH
  daily[4] = { ...daily[4], high: 3085, low: 3025, open: 3080, close: 3030 }; // HL pullback
  daily[5] = { ...daily[5], high: 3135, low: 3028, open: 3035, close: 3130 }; // HH

  // Pad h4 similarly
  while (h4.length < 8) {
    const last = h4[h4.length - 1];
    h4.unshift({ ...last, time: new Date(new Date(last.time).getTime() - 14400000).toISOString() });
  }

  return { candles5m, m15, h1, h4, daily };
}

// ─── Asia range from h1 candles ─────────────────────────────────────────────

function buildAsiaRange(h1Candles) {
  // Pretend hours 0-6 UTC are Asia session
  const asiaHours = h1Candles.filter(c => {
    const h = new Date(c.time).getUTCHours();
    return h >= 0 && h < 6;
  });
  if (!asiaHours.length) return { high: null, low: null };
  return {
    high: Math.max(...asiaHours.map(c => c.high)),
    low:  Math.min(...asiaHours.map(c => c.low))
  };
}

// ─── Rolling backtest ────────────────────────────────────────────────────────

function runBacktest() {
  console.clear();
  console.log('\n' + chalk.bold.yellow('  ◆ XAUUSD ICT STRATEGY — BACKTESTER'));
  console.log(chalk.gray('  Strategy: Liquidity Sweep → 5m MSS → FVG Entry'));
  console.log(chalk.gray('  Period:   Synthetic 200-bar dataset (5-min candles)\n'));
  console.log(chalk.gray('─'.repeat(62)));

  const { candles5m, m15, h1, h4, daily } = generatePriceData();
  const asiaRange = buildAsiaRange(h1);

  const signals = [];
  const LOOKBACK = 60; // minimum bars before we start scanning

  // Roll through each bar, simulating live scanning from bar 60 onwards
  for (let i = LOOKBACK; i < candles5m.length - 5; i++) {
    const slice5m  = candles5m.slice(0, i + 1);
    const slice15m = m15.slice(0, Math.floor((i + 1) / 3) + 1);

    const data = {
      daily,
      h4,
      m15: slice15m,
      m5:  slice5m,
      quote: {
        price:     slice5m[slice5m.length - 1].close,
        changePct: 0
      }
    };

    const session = { active: true, label: 'London / NY Kill Zone' };
    const htf     = htfBias(daily, h4);
    const lvls    = keyLevels(daily, asiaRange);
    const sweepResult5m  = detectLiquiditySweep(slice5m, lvls, htf);
    const sweepResult15m = detectLiquiditySweep(slice15m, lvls, htf);
    const sweepResult = sweepResult5m.mostRecent ? sweepResult5m : sweepResult15m;
    const mss     = detectMSS(slice5m, sweepResult);
    const fvg     = entryFVG(slice5m, mss, sweepResult);
    const ob      = findOrderBlock(slice5m, sweepResult);
    const conf    = scoreConfluence(htf, sweepResult, mss, fvg, ob, session);

    // Signal fires?
    if (mss.confirmed && conf.score >= 60 && sweepResult.mostRecent) {
      const dir = sweepResult.mostRecent.dir;
      const entryPrice = fvg?.optimalEntry || ob?.eq || slice5m[slice5m.length - 1].close;
      const buf    = entryPrice * 0.0008;
      const sl     = dir === 'bull'
        ? (sweepResult.mostRecent.sweepLow || entryPrice) - buf
        : (sweepResult.mostRecent.sweepHigh || entryPrice) + buf;
      const risk   = Math.abs(entryPrice - sl);
      const tp1    = dir === 'bull' ? entryPrice + risk * 1.5 : entryPrice - risk * 1.5;
      const tp2    = dir === 'bull' ? (lvls.pdh || entryPrice + risk * 3) : (lvls.pdl || entryPrice - risk * 3);

      // Avoid duplicate signals within 10 bars
      const lastSig = signals[signals.length - 1];
      if (lastSig && (i - lastSig.bar) < 10) continue;

      // Simulate outcome: check next 30 bars
      const future = candles5m.slice(i + 1, i + 31);
      let outcome = 'OPEN';
      let pnlR = 0;

      for (const fc of future) {
        if (dir === 'bull') {
          if (fc.low <= sl) { outcome = 'LOSS'; pnlR = -1; break; }
          if (fc.high >= tp1) { outcome = 'WIN_TP1'; pnlR = 1.5; break; }
          if (fc.high >= tp2) { outcome = 'WIN_TP2'; pnlR = parseFloat((Math.abs(tp2 - entryPrice) / risk).toFixed(1)); break; }
        } else {
          if (fc.high >= sl) { outcome = 'LOSS'; pnlR = -1; break; }
          if (fc.low <= tp1) { outcome = 'WIN_TP1'; pnlR = 1.5; break; }
          if (fc.low <= tp2) { outcome = 'WIN_TP2'; pnlR = parseFloat((Math.abs(tp2 - entryPrice) / risk).toFixed(1)); break; }
        }
      }

      signals.push({
        bar:      i,
        time:     slice5m[slice5m.length - 1].time,
        dir:      dir === 'bull' ? 'BUY' : 'SELL',
        entry:    parseFloat(entryPrice.toFixed(2)),
        sl:       parseFloat(sl.toFixed(2)),
        tp1:      parseFloat(tp1.toFixed(2)),
        tp2:      parseFloat(tp2.toFixed(2)),
        risk:     parseFloat(risk.toFixed(2)),
        rr1:      '1.5',
        confluence: conf.score,
        grade:    conf.grade,
        sweep:    sweepResult.mostRecent.levelName,
        mssType:  mss.type,
        hasFVG:   !!fvg,
        outcome,
        pnlR
      });
    }
  }

  // ─── Print signal table ───────────────────────────────────────────────────

  if (signals.length === 0) {
    console.log(chalk.yellow('\n  No signals fired — try lowering MIN_CONFLUENCE'));
    return;
  }

  console.log(chalk.gray('\n  SIGNALS DETECTED\n'));
  console.log(
    chalk.gray('  #  ') +
    chalk.gray('Time(UTC)      ') +
    chalk.gray('Dir   ') +
    chalk.gray('Entry    ') +
    chalk.gray('SL       ') +
    chalk.gray('TP1      ') +
    chalk.gray('Risk  ') +
    chalk.gray('Score ') +
    chalk.gray('MSS     ') +
    chalk.gray('FVG ') +
    chalk.gray('Outcome     ') +
    chalk.gray('P&L(R)')
  );
  console.log(chalk.gray('  ' + '─'.repeat(100)));

  signals.forEach((s, idx) => {
    const dirColor = s.dir === 'BUY' ? chalk.green : chalk.red;
    const outcomeColor = s.outcome.startsWith('WIN') ? chalk.green : s.outcome === 'LOSS' ? chalk.red : chalk.yellow;
    const pnlStr = s.pnlR > 0 ? chalk.green(`+${s.pnlR}R`) : s.pnlR < 0 ? chalk.red(`${s.pnlR}R`) : chalk.gray('open');

    const timeStr = new Date(s.time).toISOString().replace('T',' ').slice(0,16);

    console.log(
      chalk.gray(`  ${String(idx + 1).padStart(2)} `) +
      chalk.gray(`${timeStr}  `) +
      dirColor(`${s.dir.padEnd(6)}`) +
      chalk.white(`${String(s.entry).padEnd(9)}`) +
      chalk.red(`${String(s.sl).padEnd(9)}`) +
      chalk.green(`${String(s.tp1).padEnd(9)}`) +
      chalk.gray(`${String(s.risk).padEnd(6)}`) +
      chalk.cyan(`${String(s.confluence).padEnd(6)}`) +
      chalk.gray(`${(s.mssType||'').padEnd(8)}`) +
      (s.hasFVG ? chalk.green('Yes ') : chalk.gray('No  ')) +
      outcomeColor(`${s.outcome.padEnd(12)}`) +
      pnlStr
    );
  });

  // ─── Stats summary ────────────────────────────────────────────────────────

  const closed  = signals.filter(s => s.outcome !== 'OPEN');
  const wins    = closed.filter(s => s.pnlR > 0);
  const losses  = closed.filter(s => s.pnlR < 0);
  const totalPnL = closed.reduce((sum, s) => sum + s.pnlR, 0);
  const winRate = closed.length ? ((wins.length / closed.length) * 100).toFixed(0) : 0;
  const avgWin  = wins.length ? (wins.reduce((s, x) => s + x.pnlR, 0) / wins.length).toFixed(2) : 0;
  const profitFactor = losses.length
    ? (wins.reduce((s, x) => s + x.pnlR, 0) / Math.abs(losses.reduce((s, x) => s + x.pnlR, 0))).toFixed(2)
    : '∞';

  console.log('\n' + chalk.gray('─'.repeat(62)));
  console.log(chalk.bold.yellow('\n  BACKTEST SUMMARY'));
  console.log(chalk.gray('  ─────────────────────────────────────────────'));
  console.log(chalk.gray('  Total signals:   ') + chalk.white(signals.length));
  console.log(chalk.gray('  Closed trades:   ') + chalk.white(closed.length));
  console.log(chalk.gray('  Wins:            ') + chalk.green(wins.length));
  console.log(chalk.gray('  Losses:          ') + chalk.red(losses.length));
  console.log(chalk.gray('  Win rate:        ') + (parseFloat(winRate) >= 50 ? chalk.green : chalk.yellow)(`${winRate}%`));
  console.log(chalk.gray('  Avg win:         ') + chalk.green(`+${avgWin}R`));
  console.log(chalk.gray('  Total P&L:       ') + (totalPnL >= 0 ? chalk.green : chalk.red)(`${totalPnL.toFixed(2)}R`));
  console.log(chalk.gray('  Profit factor:   ') + chalk.cyan(profitFactor));
  console.log(chalk.gray('  ─────────────────────────────────────────────\n'));

  // ─── Show a detailed signal breakdown for the best signal ────────────────

  const best = [...signals].sort((a, b) => b.confluence - a.confluence)[0];
  if (best) printDetailedSignal(best);

  // ─── Explain signal flow ──────────────────────────────────────────────────
  printSignalFlow();
}

// ─── Detailed signal display ─────────────────────────────────────────────────

function printDetailedSignal(s) {
  const isLong = s.dir === 'BUY';
  const color  = isLong ? chalk.green : chalk.red;
  const arrow  = isLong ? '▲' : '▼';

  console.log('═'.repeat(62));
  console.log(color(`\n  ${arrow} HIGHEST-CONFLUENCE SIGNAL DETAIL`));
  console.log(chalk.gray('  (This is exactly what fires in the live bot)\n'));

  console.log(chalk.bold.white(`  ${arrow} ${s.dir} — XAUUSD`));
  console.log(chalk.gray(`  Time: ${s.time}  |  Confluence: ${s.confluence}%  Grade: ${s.grade}\n`));

  console.log(chalk.gray('  ┌─ ENTRY PLAN ───────────────────────────────┐'));
  console.log(chalk.gray('  │  ENTRY     ') + chalk.bold.white(`$${s.entry}`) + chalk.gray(' (FVG midpoint / OB eq)'));
  console.log(chalk.gray('  │  STOP LOSS ') + chalk.red(`$${s.sl}`) + chalk.gray(' (below sweep low + buffer)'));
  console.log(chalk.gray('  │  Risk:     ') + chalk.gray(`${s.risk} pts`));
  console.log(chalk.gray('  ├─ TARGETS ─────────────────────────────────┤'));
  console.log(chalk.gray('  │  TP1  ') + chalk.green(`$${s.tp1}`) + chalk.gray('  (1:1.5 R — partial close)'));
  console.log(chalk.gray('  │  TP2  ') + chalk.green(`$${s.tp2}`) + chalk.gray('  (PDH/PDL — full target)'));
  console.log(chalk.gray('  ├─ SETUP ────────────────────────────────────┤'));
  console.log(chalk.gray('  │  Sweep:   ') + chalk.white(s.sweep));
  console.log(chalk.gray('  │  MSS:     ') + chalk.white(s.mssType || '—'));
  console.log(chalk.gray('  │  FVG:     ') + (s.hasFVG ? chalk.green('Yes') : chalk.gray('No')));
  const outcomeColor = s.outcome.startsWith('WIN') ? chalk.green : s.outcome === 'LOSS' ? chalk.red : chalk.yellow;
  console.log(chalk.gray('  │  Outcome: ') + outcomeColor(s.outcome) + chalk.gray(' → ') + (s.pnlR > 0 ? chalk.green(`+${s.pnlR}R`) : chalk.red(`${s.pnlR}R`)));
  console.log(chalk.gray('  └────────────────────────────────────────────┘\n'));
}

// ─── Signal flow explainer ───────────────────────────────────────────────────

function printSignalFlow() {
  console.log(chalk.bold.yellow('  HOW THE SIGNAL IS RECEIVED (LIVE BOT FLOW)'));
  console.log(chalk.gray('  ─────────────────────────────────────────────'));
  console.log(chalk.gray('  Every 60s (kill zone) / 300s (off-hours) the bot:'));
  console.log();
  console.log(chalk.cyan('  Step 1 ') + chalk.white('Fetch data') + chalk.gray(' — TwelveData API'));
  console.log(chalk.gray('         Daily (30 bars) · 4H (48) · 1H (48) · 15m (96) · 5m (120)'));
  console.log();
  console.log(chalk.cyan('  Step 2 ') + chalk.white('HTF Bias') + chalk.gray(' — Daily + 4H swing structure'));
  console.log(chalk.gray('         HH+HL = BULLISH  |  LH+LL = BEARISH  |  mixed = wait'));
  console.log();
  console.log(chalk.cyan('  Step 3 ') + chalk.white('Key Levels') + chalk.gray(' — PDH · PDL · Asia H/L · PWH/PWL'));
  console.log();
  console.log(chalk.cyan('  Step 4 ') + chalk.white('Liquidity Sweep') + chalk.gray(' — wick through level, close back inside'));
  console.log(chalk.gray('         Bull: SSL hunt (price spikes below PDL/Asia Low → closes back)'));
  console.log(chalk.gray('         Bear: BSL hunt (price spikes above PDH/Asia High → closes back)'));
  console.log();
  console.log(chalk.cyan('  Step 5 ') + chalk.white('5m MSS/BOS') + chalk.gray(' — after sweep, body-close through swing'));
  console.log(chalk.gray('         BOS_UP: close above last swing high after SSL sweep'));
  console.log(chalk.gray('         CHoCH:  single strong displacement candle after sweep'));
  console.log();
  console.log(chalk.cyan('  Step 6 ') + chalk.white('FVG entry zone') + chalk.gray(' — imbalance gap from displacement candle'));
  console.log(chalk.gray('         Price must retrace into the gap for optimal entry'));
  console.log();
  console.log(chalk.cyan('  Step 7 ') + chalk.white('Confluence score') + chalk.gray(' ≥ 60 required to fire:'));
  console.log(chalk.gray('         HTF aligned (+25)  |  Sweep (+20+5)  |  MSS (+20+5)'));
  console.log(chalk.gray('         FVG present (+10+5)  |  OB (+5)  |  Kill zone (+10)'));
  console.log();
  console.log(chalk.cyan('  Step 8 ') + chalk.white('Signal printed to terminal:'));
  console.log(chalk.gray('         ▲ BUY XAUUSD  Entry · SL · TP1/2/3 · R:R · Grade'));
  console.log();
  console.log(chalk.gray('  The bot also runs an HTTP server (src/server.js)'));
  console.log(chalk.gray('  so TradingView webhooks or external alerts can'));
  console.log(chalk.gray('  POST to /signal and receive the same analysis.\n'));
  console.log('─'.repeat(62) + '\n');
}

// ─── Run ─────────────────────────────────────────────────────────────────────
runBacktest();
