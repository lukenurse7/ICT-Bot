'use strict';

// ─── ICT NY Kill Zone Signal Engine — Version 2 (5m Permission + 1m Entry) ───
// Instruments: DJ30 (DIA), NAS100 (QQQ)
// Flow: NY KZ opens → 5m sweep/MSS/FVG → 1m sweep/MSS/FVG → entry alert

require('dotenv').config();
const chalk = require('chalk');

const { INSTRUMENTS, SCAN_INTERVAL_MS, SIGNAL_COOLDOWN_MS } = require('./config');
const { isNYKillZone, killZoneStatus, currentSessionKey }   = require('./sessions');
const { fetchAll }                                           = require('./data');
const { Engine5m }                                          = require('./engine5m');
const { Engine1m }                                          = require('./engine1m');
const tg                                                    = require('./telegram');

// One 5m + one 1m engine per instrument
const engines5m  = {};
const engines1m  = {};
const lastAlert  = {};

for (const key of Object.keys(INSTRUMENTS)) {
  engines5m[key]  = new Engine5m(key);
  engines1m[key]  = new Engine1m(key);
  lastAlert[key]  = 0;
}

function ts() { return new Date().toUTCString().slice(17, 22) + ' UTC'; }
function divider() { return chalk.gray('─'.repeat(60)); }

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

  // ── 5m Permission Engine ──────────────────────────────────────────────────
  const r5 = engines5m[key].tick(sk, m5, inKZ);

  const chg = quote.changePct >= 0
    ? chalk.green(`+${quote.changePct.toFixed(2)}%`)
    : chalk.red(`${quote.changePct.toFixed(2)}%`);

  console.log(`\n  ${chalk.bold(key)}  ${chalk.white(quote.price.toLocaleString('en-GB', { minimumFractionDigits: 2 }))}  ${chg}`);
  console.log(`  5m: ${chalk.cyan(r5.state)}  — ${chalk.gray(r5.waitReason)}`);

  // ── 1m Execution Engine ───────────────────────────────────────────────────
  // Activate 1m engine when 5m grants permission
  if (r5.permissionGranted && r5.permission && !engines1m[key].active) {
    engines1m[key].activate(r5.permission);
    console.log(chalk.yellow(`  ★ 5m permission granted (${r5.permission.direction}) — 1m engine activated`));
    await tg.send(tg.permissionMessage(r5.permission));
  }

  if (engines1m[key].active) {
    const r1 = engines1m[key].tick(m1);
    console.log(`  1m: ${chalk.cyan(r1.state)}  — ${chalk.gray(r1.waitReason)}`);

    if (r1.entryReady && r1.signal) {
      const now          = Date.now();
      const onCooldown   = (now - lastAlert[key]) < SIGNAL_COOLDOWN_MS;

      if (!onCooldown) {
        lastAlert[key] = now;
        console.log('\n' + chalk.bold.green(`  ▶ ENTRY SIGNAL — ${r1.signal.direction} ${key}`));
        console.log(chalk.white(`    Entry ${r1.signal.entry}  SL ${r1.signal.sl}  TP1 ${r1.signal.tp1}  TP2 ${r1.signal.tp2}`));
        await tg.send(tg.entryMessage(r1.signal));

        // Reset 1m engine after firing so it doesn't re-alert
        engines1m[key]._reset();
      }
    }

    // Deactivate 1m engine if it expired
    if (!engines1m[key].active) {
      console.log(chalk.gray(`  [${key}] 1m engine expired — waiting for next 5m setup`));
    }
  }
}

async function runCycle() {
  console.clear();
  const kz = killZoneStatus();

  console.log('\n' + chalk.bold.white('  ◆ ICT SIGNAL ENGINE  —  v2 (5m + 1m)'));
  console.log(chalk.gray(`  ${ts()}  —  ${kz.label}`));
  console.log(divider());

  if (kz.active) {
    console.log(chalk.bgGreen.black('  NY KILL ZONE ACTIVE  '));
  } else {
    console.log(chalk.yellow(`  ${kz.label}`));
  }

  await Promise.allSettled(
    Object.keys(INSTRUMENTS).map(key => scanInstrument(key))
  );

  console.log('\n' + divider());
  console.log(chalk.gray(`  Next scan in ${SCAN_INTERVAL_MS / 1000}s — Ctrl+C to stop\n`));
}

console.log(chalk.bold.white('\n  ICT Signal Engine starting...\n'));
tg.send('🤖 <b>ICT Signal Engine v2 started</b>\nScanning DJ30 + NAS100\n5m permission + 1m entry layer active.');

runCycle();
setInterval(runCycle, SCAN_INTERVAL_MS);
