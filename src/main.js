'use strict';

// ─── ICT NY Kill Zone Signal Engine — Version 1 (5m Permission Only) ──────────
// Instruments: DJ30 (DIA), NAS100 (QQQ)
// Strategy:    NY Kill Zone (08:30–11:00 NY) → 5m sweep → 5m MSS → 5m FVG
// Output:      Telegram alert when permission is granted
// Next:        Version 2 will add 1m execution layer

require('dotenv').config();
const chalk = require('chalk');

const { INSTRUMENTS, SCAN_INTERVAL_MS, SIGNAL_COOLDOWN_MS } = require('./config');
const { isNYKillZone, killZoneStatus, currentSessionKey }   = require('./sessions');
const { fetchAll }                                           = require('./data');
const { Engine5m }                                          = require('./engine5m');
const tg                                                    = require('./telegram');

// One engine + cooldown tracker per instrument
const engines = {};
const lastAlert = {};

for (const key of Object.keys(INSTRUMENTS)) {
  engines[key]    = new Engine5m(key);
  lastAlert[key]  = 0;
}

function ts() {
  return new Date().toUTCString().slice(17, 22) + ' UTC';
}

function divider() {
  return chalk.gray('─'.repeat(60));
}

// ─── Scan one instrument ──────────────────────────────────────────────────────
async function scanInstrument(key) {
  const cfg  = INSTRUMENTS[key];
  const inKZ = isNYKillZone();
  const sk   = currentSessionKey();

  let m5, m1, quote;
  try {
    ({ m5, m1, quote } = await fetchAll(cfg.symbol));
  } catch (err) {
    console.log(chalk.red(`  [${key}] Data error: ${err.message}`));
    return;
  }

  // Tick the 5m permission engine
  const result = engines[key].tick(sk, m5, inKZ);

  // Print instrument header
  const chg = quote.changePct >= 0 ? chalk.green(`+${quote.changePct.toFixed(2)}%`) : chalk.red(`${quote.changePct.toFixed(2)}%`);
  console.log(`\n  ${chalk.bold(key)}  ${chalk.white(quote.price.toLocaleString('en-GB', { minimumFractionDigits: 2 }))}  ${chg}`);
  console.log(`  State: ${chalk.cyan(result.state)}  — ${chalk.gray(result.waitReason)}`);

  if (result.sweep) {
    console.log(`  Sweep: ${chalk.yellow(result.sweep.levelName + ' (' + result.sweep.dir + ')')}`);
  }
  if (result.mss) {
    console.log(`  MSS:   ${chalk.yellow(result.mss.type + ' @ ' + result.mss.level.toFixed(2))}`);
  }
  if (result.fvg) {
    console.log(`  FVG:   ${chalk.yellow(result.fvg.bottom.toFixed(2) + ' – ' + result.fvg.top.toFixed(2))}`);
  }

  // Fire alert if permission granted + cooldown not active
  if (result.permissionGranted && result.permission) {
    const now = Date.now();
    const cooldownActive = (now - lastAlert[key]) < SIGNAL_COOLDOWN_MS;

    if (!cooldownActive) {
      lastAlert[key] = now;
      console.log('\n' + chalk.bold.green('  ★ PERMISSION GRANTED — sending Telegram alert'));
      await tg.send(tg.permissionMessage(result.permission));
    } else {
      const mins = Math.round((SIGNAL_COOLDOWN_MS - (now - lastAlert[key])) / 60000);
      console.log(chalk.gray(`  [${key}] Permission already alerted this session (cooldown: ${mins}m remaining)`));
    }
  }
}

// ─── Main scan loop ───────────────────────────────────────────────────────────
async function runCycle() {
  console.clear();
  const kz = killZoneStatus();

  console.log('\n' + chalk.bold.white('  ◆ ICT SIGNAL ENGINE  —  v1 (5m Permission)'));
  console.log(chalk.gray(`  ${ts()}  —  ${kz.label}`));
  console.log(divider());

  if (kz.active) {
    console.log(chalk.bgGreen.black('  NY KILL ZONE ACTIVE  '));
  } else {
    console.log(chalk.yellow(`  ${kz.label}`));
  }

  // Scan all instruments in parallel
  await Promise.allSettled(
    Object.keys(INSTRUMENTS).map(key => scanInstrument(key))
  );

  console.log('\n' + divider());
  console.log(chalk.gray(`  Next scan in ${SCAN_INTERVAL_MS / 1000}s — Ctrl+C to stop\n`));
}

// Start
console.log(chalk.bold.white('\n  ICT Signal Engine starting...\n'));
runCycle();
setInterval(runCycle, SCAN_INTERVAL_MS);
