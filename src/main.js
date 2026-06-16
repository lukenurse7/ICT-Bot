'use strict';

// ═══════════════════════════════════════════════════════════════════════
//  DJ30 SIGNAL BOT
//  DJ30 only — scans every 60s, signals during 14:00–16:00 GMT KZ
//  XAUUSD disabled — low frequency, keeping DJ30 as sole instrument
// ═══════════════════════════════════════════════════════════════════════

require('dotenv').config();
const chalk = require('chalk');
const cron  = require('node-cron');
const { publishSignal, updateStatus, startServer } = require('./signal_server');
const tg = require('./telegram');

// ─── DJ30 engine ────────────────────────────────────────────────────────
const { fetchAllData: dj30Fetch }       = require('./data');
const { runICTAnalysis }                = require('./ict');
const { isKillZone, killZoneStatus, getGMTTime } = require('./killzone');

const SIGNAL_COOLDOWN = 600 * 1000; // 10 min ms

const state = {
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
  console.log('\n' + chalk.bold.white('  ■ ICT SIGNAL BOT  —  DJ30'));
  console.log(chalk.gray('  Signals during 14:00–16:00 GMT kill zone only'));
  console.log(chalk.gray('  Backtest: 79% WR · +67.9% on £2,000 = ~£3,358 over 3 months'));
  console.log(divider());
}

// ─── DJ30 scan ───────────────────────────────────────────────────────────

async function scanDJ30() {
  const kz = killZoneStatus();

  try {
    const { candles15m, candles5m, candles1m, quote, daily, h4, h1 } = await dj30Fetch();
    const analysis = runICTAnalysis({ daily, h4, h1, candles15m, candles5m, candles1m, livePrice: quote.price });

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
  await scanDJ30();
  console.log('\n' + divider());
  console.log(chalk.gray(`  Next scan in 60s — Ctrl+C to stop\n`));
}

// Start signal HTTP server, then begin scanning
startServer();
runCycle();
setInterval(runCycle, 60 * 1000);
