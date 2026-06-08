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

// ─── XAUUSD engine ──────────────────────────────────────────────────────
const { fetchAll: xauFetch }            = require('./data_xau');
const { runAnalysis }                   = require('./ict_xau');
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
  xau:  { lastTime: 0, lastDir: null },
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

// ─── XAUUSD scan ─────────────────────────────────────────────────────────

async function scanXAU() {
  if (!isWeekday()) return;

  try {
    const session = sessionStatus();
    const alwaysActive = { ...session, active: true };

    const data     = await xauFetch();
    const asia     = getAsiaSessionBounds(data.h1);
    const result   = runAnalysis(data, asia, alwaysActive);

    // Print compact XAU block
    console.log('\n' + chalk.bold.yellow('  ◆ XAUUSD') + chalk.gray(`  [${ts()}]`));
    printStatusBar(result.quote, session, result.htf);
    printKeyLevels(result.lvls);
    console.log(divider());
    console.log(chalk.gray('  MARKET STRUCTURE'));
    printSweep(result.sweepResult);
    printMSS(result.mss);
    printFVG(result.fvg);
    printConfluence(result.confluence);

    if (result.signal) {
      const now = Date.now();
      const s   = state.xau;
      const dup = result.signal.direction === s.lastDir && (now - s.lastTime) < SIGNAL_COOLDOWN;

      if (!dup) {
        printXauSignal(result.signal);
        publishSignal(result.signal);   // → signal server → MT5 bridge
        s.lastTime = now;
        s.lastDir  = result.signal.direction;
      } else {
        console.log(chalk.gray('  [XAU] Signal cooldown active'));
      }
    } else {
      printWaiting(result.waitReason, result);
    }

    updateStatus({ waitReason: result.waitReason, confluence: result.confluence?.score });

  } catch (err) {
    console.log(chalk.red(`  [XAU] ✗ ${err.message}`));
  }
}

// ─── DJ30 scan ───────────────────────────────────────────────────────────

async function scanDJ30() {
  const kz = killZoneStatus();

  try {
    const { candles15m, candles5m, quote } = await dj30Fetch();
    const analysis = runICTAnalysis(candles15m, candles5m);

    console.log('\n' + chalk.bold.white('  ■ DJ30') + chalk.gray(`  [${ts()}]`));
    const chg = quote.changePct > 0 ? chalk.green(`+${quote.changePct.toFixed(2)}%`) : chalk.red(`${quote.changePct.toFixed(2)}%`);
    console.log(chalk.gray('  Price: ') + chalk.bold.white(fmtP(quote.price)) + '  ' + chg);

    const biasColor = analysis.bias === 'bullish' ? chalk.green : analysis.bias === 'bearish' ? chalk.red : chalk.yellow;
    console.log(chalk.gray('  HTF Bias: ') + biasColor(analysis.bias.toUpperCase()));

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

      const isLong = sig.direction === 'long';
      const color  = isLong ? chalk.green : chalk.red;
      const arrow  = isLong ? '▲' : '▼';

      console.log('\n' + chalk.bold.white('═'.repeat(62)));
      console.log(color(`  ${arrow} ${sig.direction.toUpperCase()} SIGNAL — DJ30  |  Confluence: ${sig.confluence}%`));
      console.log(chalk.gray('  Tags: ') + chalk.white(sig.tags.join(' · ')));
      console.log(chalk.gray(`\n  Entry  `) + chalk.bold.white(fmtP(sig.entry)));
      console.log(chalk.gray('  SL     ') + chalk.red(fmtP(sig.sl)) + chalk.gray(` (${sig.stopPoints} pts)`));
      console.log(chalk.gray(`  TP1    `) + chalk.green(fmtP(sig.tp1)) + chalk.gray(` (1:${sig.rr} R:R)`));
      console.log(chalk.gray(`  TP2    `) + chalk.green(fmtP(sig.tp2)));
      console.log(chalk.bold.white('═'.repeat(62)) + '\n');

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
