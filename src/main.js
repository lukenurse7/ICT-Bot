'use strict';

// ═══════════════════════════════════════════════════════════════════════
//  COMBINED SIGNAL BOT
//  XAUUSD  — scans every 60s, 24/5, signals anytime
//  DJ30    — scans every 60s, signals ONLY during 14:00–16:00 GMT KZ
// ═══════════════════════════════════════════════════════════════════════

require('dotenv').config();
const chalk = require('chalk');
const cron  = require('node-cron');
const { publishSignal, updateStatus, startServer } = require('./signal_server');
const tg = require('./telegram');

// ─── XAUUSD engine ──────────────────────────────────────────────────────
const { fetchAll: xauFetch }            = require('./data_xau');
const { runAnalysis, runLondonJudas }   = require('./ict_xau');
const { sessionStatus, getAsiaSessionBounds, isWeekday } = require('./sessions');
const {
  printHeader: xauHeader, printStatusBar, printKeyLevels,
  printSweep, printMSS, printFVG, printConfluence,
  printSignal: printXauSignal, printWaiting
} = require('./format_xau');

// ─── DJ30 engine ────────────────────────────────────────────────────────
const { fetchAllData: dj30Fetch }       = require('./data');
const { runICTAnalysis }                = require('./ict');
const { isKillZone, killZoneStatus, getGMTTime } = require('./killzone');

const SIGNAL_COOLDOWN = 600 * 1000; // 10 min ms

// Per-instrument state
const state = {
  xau:  { lastTime: 0, lastDir: null, lastKZWindow: null },
  dj30: { lastTime: 0, lastDir: null }
};

function ts() {
  const { full } = getGMTTime();
  return `${String(full.getHours()).padStart(2,'0')}:${String(full.getMinutes()).padStart(2,'0')} GMT`;
}

function divider(c = '─', n = 62) { return chalk.gray(c.repeat(n)); }
function fmtP(p) { return p.toLocaleString('en-GB', { minimumFractionDigits: 2 }); }

// ─── Banner ──────────────────────────────────────────────────────────────

function banner() {
  console.clear();
  console.log('\n' + chalk.bold.yellow('  ◆ ICT SIGNAL BOT  —  COMBINED'));
  console.log(chalk.gray('  XAUUSD (24/5 scan)  +  DJ30 (14:00–16:00 GMT KZ only)'));
  console.log(divider());
}

// ─── XAUUSD kill zone check ───────────────────────────────────────────────
// Only fire signals during London KZ (07:00-09:00 UTC)
// NY KZ removed for XAU — backtesting shows NY has poor win rate for this strategy
function isXauKillZone() {
  const h = new Date().getUTCHours();
  return (h >= 7 && h < 9);
}

function currentKZWindow() {
  const h = new Date().getUTCHours();
  const d = new Date().toISOString().slice(0, 10);
  if (h >= 7 && h < 9) return `${d}_LON`;
  return null;
}

// ─── XAUUSD scan ─────────────────────────────────────────────────────────

async function scanXAU() {
  if (!isWeekday()) return;

  const inKZ = isXauKillZone();

  try {
    const data = await xauFetch();

    // Print XAU header
    console.log('\n' + chalk.bold.yellow('  ◆ XAUUSD') + chalk.gray(`  [${ts()}]`));
    const chg = data.quote.changePct > 0
      ? chalk.green(`+${data.quote.changePct.toFixed(2)}%`)
      : chalk.red(`${data.quote.changePct.toFixed(2)}%`);
    console.log(chalk.gray('  Price: ') + chalk.bold.yellow(fmtP(data.quote.price)) + '  ' + chg);

    if (!inKZ) {
      console.log(chalk.gray('  Status: ') + chalk.yellow('Outside London KZ (07:00–09:00 UTC)'));
      console.log(chalk.gray('  Strategy: London Judas Swing — signals only 07:00–09:00 UTC'));
      return;
    }

    console.log(chalk.gray('  Status: ') + chalk.bgYellow.black(' LONDON KZ ACTIVE '));
    console.log(chalk.gray('  Strategy: Asia High sweep → MSS → FVG SELL (20-day SMA filter)'));

    // Run London Judas Swing analysis
    const judas = runLondonJudas(data);

    if (!judas.active) {
      console.log(chalk.gray(`  [XAU] ${judas.reason}`));
      return;
    }

    if (!judas.signal) {
      console.log(chalk.gray(`  [XAU] Waiting: ${judas.reason}`));
      updateStatus({ waitReason: judas.reason });
      return;
    }

    // Signal found — apply cooldown
    const now = Date.now();
    const s   = state.xau;
    const kzWin = currentKZWindow();
    const sameWindow = kzWin && kzWin === s.lastKZWindow && judas.signal.direction === s.lastDir;

    if (sameWindow) {
      const elapsed = Math.round((now - s.lastTime) / 60000);
      console.log(chalk.gray(`  [XAU] Signal already fired this London session (${elapsed}m ago)`));
    } else {
      const sig = judas.signal;
      console.log('\n' + chalk.bold.yellow('═'.repeat(62)));
      console.log(chalk.red(`  ▼ SELL SIGNAL — XAU/USD  |  ${sig.sweep} → ${sig.mssType}`));
      console.log(chalk.gray(`\n  Entry  `) + chalk.bold.white(fmtP(sig.entry)));
      console.log(chalk.gray('  SL     ') + chalk.red(fmtP(sig.sl)));
      console.log(chalk.gray(`  TP1    `) + chalk.green(fmtP(sig.tp1)) + chalk.gray(` (${sig.tp1R}R · ${sig.tp1Desc})`));
      console.log(chalk.gray(`  TP2    `) + chalk.green(fmtP(sig.tp2)) + chalk.gray(` (${sig.tp2R}R · ${sig.tp2Desc})`));
      if (sig.sma20) console.log(chalk.gray(`  SMA20  `) + chalk.gray(fmtP(sig.sma20)));
      console.log(chalk.bold.yellow('═'.repeat(62)) + '\n');

      publishSignal(sig);
      tg.send(tg.signalMessage(sig));
      s.lastTime     = now;
      s.lastDir      = sig.direction;
      s.lastKZWindow = kzWin;
    }

    updateStatus({ waitReason: null });

  } catch (err) {
    console.log(chalk.red(`  [XAU] ✗ ${err.message}`));
  }
}

// ─── DJ30 scan ───────────────────────────────────────────────────────────

async function scanDJ30() {
  const kz = killZoneStatus();

  try {
    const { candles5m, h1, quote } = await dj30Fetch();
    const analysis = runICTAnalysis({ candles5m, h1 });

    console.log('\n' + chalk.bold.white('  ■ DJ30') + chalk.gray(`  [${ts()}]`));
    const chg = quote.changePct > 0 ? chalk.green(`+${quote.changePct.toFixed(2)}%`) : chalk.red(`${quote.changePct.toFixed(2)}%`);
    console.log(chalk.gray('  Price: ') + chalk.bold.white(fmtP(quote.price)) + '  ' + chg);

    if (!isKillZone()) {
      console.log(chalk.gray('  Status: ') + chalk.yellow(kz.message));
      console.log(chalk.gray('  No DJ30 signals outside 14:00–16:00 GMT KZ.'));
      return;
    }

    console.log(chalk.gray('  Status: ') + chalk.bgGreen.black(` ${kz.message} `));

    if (analysis.signals.length === 0) {
      console.log(chalk.gray('  No high-confluence DJ30 setup this scan.'));
      return;
    }

    const now = Date.now();
    const s   = state.dj30;
    for (const sig of analysis.signals) {
      const dup = sig.direction === s.lastDir && (now - s.lastTime) < SIGNAL_COOLDOWN;
      if (dup) { console.log(chalk.gray('  [DJ30] Signal cooldown active')); continue; }

      const isLong = sig.direction === 'BUY';
      const color  = isLong ? chalk.green : chalk.red;
      const arrow  = isLong ? '▲' : '▼';

      console.log('\n' + chalk.bold.white('═'.repeat(62)));
      console.log(color(`  ${arrow} ${sig.direction} SIGNAL — DJ30  |  ${sig.sweep} → ${sig.mssType}`));
      console.log(chalk.gray('  Tags: ') + chalk.white(sig.tags.join(' · ')));
      console.log(chalk.gray(`\n  Entry  `) + chalk.bold.white(fmtP(sig.entry)));
      console.log(chalk.gray('  SL     ') + chalk.red(fmtP(sig.sl)) + chalk.gray(` (${sig.stopPoints} pts)`));
      console.log(chalk.gray(`  TP1    `) + chalk.green(fmtP(sig.tp1)) + chalk.gray(` (${sig.tp1R}R · ${sig.tp1Desc})`));
      console.log(chalk.gray(`  TP2    `) + chalk.green(fmtP(sig.tp2)) + chalk.gray(` (${sig.tp2R}R · ${sig.tp2Desc})`));
      console.log(chalk.bold.white('═'.repeat(62)) + '\n');

      tg.send(tg.signalMessage({ ...sig, instrument: 'DJ30' }));  // → Telegram
      s.lastTime = now;
      s.lastDir  = sig.direction;
    }

  } catch (err) {
    console.log(chalk.red(`  [DJ30] ✗ ${err.message}`));
  }
}

// ─── Orchestrator ────────────────────────────────────────────────────────

async function runCycle() {
  banner();
  // Run both scans in parallel, then schedule next cycle
  await Promise.allSettled([scanXAU(), scanDJ30()]);
  console.log('\n' + divider());
  console.log(chalk.gray(`  Next scan in 60s — Ctrl+C to stop\n`));
}

// Start signal HTTP server, then begin scanning
startServer();
runCycle();
setInterval(runCycle, 60 * 1000);
