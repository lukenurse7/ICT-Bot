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

// XAUUSD scans always during market hours — no kill zone restriction
const SCAN_INTERVAL   = 60;   // every 60s regardless of session
const SIGNAL_COOLDOWN = 600;  // 10 min cooldown between same-direction signals

let lastSignalTime = 0;
let lastSignalDir  = null;
let timer          = null;

async function scan() {
  try {
    printHeader();

    if (!isWeekday()) {
      console.log(chalk.gray('  Market closed (weekend) — resuming Monday.\n'));
      scheduleCountdown(SCAN_INTERVAL * 5);
      return;
    }

    const session = sessionStatus();
    // Pass session but don't gate on it — XAUUSD trades anytime
    const alwaysActive = { ...session, active: true };

    console.log(chalk.gray('  Fetching live XAUUSD data from TwelveData...'));
    const data = await fetchAll();

    const asiaRange = getAsiaSessionBounds(data.h1);

    console.log(chalk.gray('  Running ICT analysis...\n'));
    const result = runAnalysis(data, asiaRange, alwaysActive);

    printStatusBar(result.quote, session, result.htf);
    printKeyLevels(result.lvls);

    console.log(chalk.gray('─'.repeat(62)));
    console.log(chalk.gray('  MARKET STRUCTURE'));
    printSweep(result.sweepResult);
    printMSS(result.mss);
    printFVG(result.fvg);

    printConfluence(result.confluence);

    if (result.signal) {
      const now = Date.now();
      const sameDir = result.signal.direction === lastSignalDir;
      const cooled  = (now - lastSignalTime) > SIGNAL_COOLDOWN * 1000;

      if (!sameDir || cooled) {
        printSignal(result.signal);
        lastSignalTime = now;
        lastSignalDir  = result.signal.direction;
      } else {
        console.log(chalk.gray('\n  Signal active — cooldown: ') +
          chalk.yellow(`${Math.round((SIGNAL_COOLDOWN * 1000 - (now - lastSignalTime)) / 60000)}m remaining`));
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
