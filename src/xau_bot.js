'use strict';

require('dotenv').config();
const chalk = require('chalk');
const { fetchAll } = require('./data_xau');
const { runAnalysis } = require('./ict_xau');
const { sessionStatus, getAsiaSessionBounds, isWeekday } = require('./sessions');
const {
  printHeader, printStatusBar, printKeyLevels, printSweep,
  printMSS, printFVG, printConfluence, printSignal, printWaiting
} = require('./format_xau');

const SCAN_INTERVAL = 60;

// Kill zone windows: London 07:00-09:00 UTC, NY 12:00-15:00 UTC
function isKillZone() {
  const h = new Date().getUTCHours();
  return (h >= 7 && h < 9) || (h >= 12 && h < 15);
}
function currentKZWindow() {
  const h = new Date().getUTCHours();
  const d = new Date().toISOString().slice(0, 10);
  if (h >= 7 && h < 9)  return `${d}_LON`;
  if (h >= 12 && h < 15) return `${d}_NY`;
  return null;
}

let lastSignalTime  = 0;
let lastSignalDir   = null;
let lastKZWindow    = null;
let timer           = null;

async function scan() {
  try {
    printHeader();

    if (!isWeekday()) {
      console.log(chalk.gray('  Market closed (weekend) — resuming Monday.\n'));
      scheduleCountdown(SCAN_INTERVAL * 5);
      return;
    }

    const session = sessionStatus();
    const inKZ    = isKillZone();
    // Signal gate: only active during London or NY kill zone
    const kzSession = { ...session, active: inKZ };

    console.log(chalk.gray('  Fetching live XAUUSD data from TwelveData...'));
    const data = await fetchAll();

    const asiaRange = getAsiaSessionBounds(data.h1);

    console.log(chalk.gray('  Running ICT analysis...\n'));
    const result = runAnalysis(data, asiaRange, kzSession);

    printStatusBar(result.quote, session, result.htf);
    printKeyLevels(result.lvls);

    console.log(chalk.gray('─'.repeat(62)));
    console.log(chalk.gray('  MARKET STRUCTURE'));
    printSweep(result.sweepResult);
    printMSS(result.mss);
    printFVG(result.fvg);

    printConfluence(result.confluence);

    if (result.signal) {
      const now    = Date.now();
      const kzWin  = currentKZWindow();
      const sameWindow = kzWin && kzWin === lastKZWindow && result.signal.direction === lastSignalDir;
      const outsideKZ  = !inKZ;

      if (outsideKZ) {
        console.log(chalk.gray('\n  Setup valid but outside KZ — no signal sent'));
      } else if (sameWindow) {
        const elapsed = Math.round((now - lastSignalTime) / 60000);
        console.log(chalk.gray(`\n  Signal already fired this ${kzWin?.split('_')[1]} session (${elapsed}m ago)`));
      } else {
        printSignal(result.signal);
        lastSignalTime = now;
        lastSignalDir  = result.signal.direction;
        lastKZWindow   = kzWin;
      }
    } else {
      printWaiting(result.waitReason, result);
    }

    scheduleCountdown(SCAN_INTERVAL);

  } catch (err) {
    printHeader();
    console.log(chalk.red(`\n  ✗ ${err.message}\n`));
    scheduleCountdown(60);
  }
}

function scheduleCountdown(seconds) {
  if (timer) clearInterval(timer);
  let countdown = seconds;
  timer = setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      clearInterval(timer);
      scan();
    } else {
      process.stdout.write(chalk.gray(`\r  [XAU] Next scan in ${countdown}s...   `));
    }
  }, 1000);
}

module.exports = { scan };

if (require.main === module) {
  console.log(chalk.yellow('\n  ◆ XAUUSD ICT Signal Bot — scanning 24/5\n'));
  scan();
}
