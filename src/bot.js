'use strict';

require('dotenv').config();
const cron = require('node-cron');
const chalk = require('chalk');
const { fetchAllData } = require('./data');
const { runICTAnalysis } = require('./ict');
const { isKillZone, killZoneStatus, getGMTTime } = require('./killzone');

// ─── Terminal colour helpers ─────────────────────────────────────────────────
const log = {
  info:    (m) => console.log(chalk.gray(`[${ts()}] `) + m),
  signal:  (m) => console.log(chalk.bold.white(`\n${'═'.repeat(60)}\n`) + m + chalk.bold.white(`\n${'═'.repeat(60)}\n`)),
  bull:    (m) => console.log(chalk.green(m)),
  bear:    (m) => console.log(chalk.red(m)),
  warn:    (m) => console.log(chalk.yellow(`[${ts()}] ⚠  ${m}`)),
  err:     (m) => console.log(chalk.red(`[${ts()}] ✗  ${m}`)),
  kz:      (m) => console.log(chalk.bgGreen.black(` KZ `) + chalk.green(` ${m}`)),
  header:  ()  => {
    console.clear();
    console.log(chalk.bold.white('\n  DJ30 ICT SIGNAL BOT'));
    console.log(chalk.gray('  NY Kill Zone · 14:00–16:00 GMT · ICT Methodology\n'));
    console.log(chalk.gray('  ') + chalk.gray('─'.repeat(56)));
  }
};

function ts() {
  const { full } = getGMTTime();
  return `${full.getHours().toString().padStart(2,'0')}:${full.getMinutes().toString().padStart(2,'0')}:${full.getSeconds().toString().padStart(2,'0')} GMT`;
}

function fmtPrice(p) { return p.toLocaleString('en-GB', { minimumFractionDigits: 0 }); }

function printSignal(sig, quote) {
  const isLong = sig.direction === 'long';
  const arrow = isLong ? '▲' : '▼';
  const color = isLong ? chalk.green : chalk.red;
  const label = isLong ? 'LONG' : 'SHORT';

  log.signal(
    color(`  ${arrow} ${label} — DJ30  |  Confluence: ${sig.confluence}%\n`) +
    chalk.gray(`  Tags: `) + chalk.white(sig.tags.join(' · ')) + '\n' +
    chalk.gray(`\n  Entry  `) + chalk.bold.white(fmtPrice(sig.entry)) +
    chalk.gray(`\n  SL     `) + chalk.red(fmtPrice(sig.sl)) + chalk.gray(` (${sig.stopPoints} pts)`) +
    chalk.gray(`\n  TP1    `) + chalk.green(fmtPrice(sig.tp1)) + chalk.gray(` (1:${sig.rr} R:R)`) +
    chalk.gray(`\n  TP2    `) + chalk.green(fmtPrice(sig.tp2)) +
    chalk.gray(`\n\n  Price  `) + chalk.white(fmtPrice(quote.price)) +
    chalk.gray(` (${quote.changePct > 0 ? '+' : ''}${quote.changePct.toFixed(2)}%)`) +
    chalk.gray(`\n  Time   `) + chalk.white(ts())
  );
}

function printStatus(kzStatus, quote, analysis) {
  log.header();

  // KZ status
  if (kzStatus.active) {
    log.kz(kzStatus.message);
  } else {
    log.info(chalk.yellow(kzStatus.message));
  }

  // Quote
  if (quote) {
    const chg = quote.changePct > 0 ? chalk.green(`+${quote.changePct.toFixed(2)}%`) : chalk.red(`${quote.changePct.toFixed(2)}%`);
    log.info(`DJ30  ${chalk.bold.white(fmtPrice(quote.price))}  ${chg}`);
  }

  // HTF bias
  if (analysis) {
    const biasColor = analysis.bias === 'bullish' ? chalk.green : analysis.bias === 'bearish' ? chalk.red : chalk.yellow;
    log.info(`HTF Bias: ${biasColor(analysis.bias.toUpperCase())}`);
    if (analysis.mss) {
      log.info(`MSS: ${chalk.cyan(analysis.mss.type)} @ ${fmtPrice(analysis.mss.level)}`);
    }
    if (analysis.liquidity.nearestBSL) log.info(`BSL (target above): ${chalk.yellow(fmtPrice(analysis.liquidity.nearestBSL))}`);
    if (analysis.liquidity.nearestSSL) log.info(`SSL (target below): ${chalk.yellow(fmtPrice(analysis.liquidity.nearestSSL))}`);
  }

  console.log(chalk.gray('\n  ' + '─'.repeat(56)));
}

// ─── Main scan function ──────────────────────────────────────────────────────
let lastSignalTime = null;
let lastAnalysis = null;
let lastQuote = null;

async function scan() {
  const kzStatus = killZoneStatus();

  try {
    log.info('Fetching DJ30 data...');
    const { candles15m, candles5m, quote } = await fetchAllData();
    lastQuote = quote;

    log.info('Running ICT analysis...');
    const analysis = runICTAnalysis(candles15m, candles5m);
    lastAnalysis = analysis;

    printStatus(kzStatus, quote, analysis);

    if (!isKillZone()) {
      log.info('Outside Kill Zone — monitoring only. No signals generated.');
      return;
    }

    // Avoid duplicate signals within 10 minutes
    const now = Date.now();
    if (lastSignalTime && (now - lastSignalTime) < 10 * 60 * 1000) {
      log.info('Signal cooldown active (10m between signals)');
      return;
    }

    if (analysis.signals.length === 0) {
      log.info('No high-confluence setup detected this scan.');
      return;
    }

    for (const sig of analysis.signals) {
      printSignal(sig, quote);
      lastSignalTime = now;
    }

  } catch (err) {
    log.err(err.message);
    if (err.message.includes('API key')) {
      log.warn('Set your TWELVEDATA_API_KEY in .env — get a free key at twelvedata.com');
    }
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────
async function start() {
  log.header();
  console.log(chalk.cyan('  Starting DJ30 Signal Bot...\n'));

  // Run immediately on start
  await scan();

  // Scan every 5 minutes during kill zone, every 15 minutes outside
  cron.schedule('*/5 * * * *', async () => {
    if (isKillZone()) {
      await scan();
    }
  });

  cron.schedule('*/15 * * * *', async () => {
    if (!isKillZone()) {
      await scan();
    }
  });

  log.info('Bot running. Scans every 5m in KZ, every 15m outside.');
  log.info('Press Ctrl+C to stop.\n');
}

start().catch(err => {
  console.error(chalk.red('Fatal error:'), err.message);
  process.exit(1);
});
