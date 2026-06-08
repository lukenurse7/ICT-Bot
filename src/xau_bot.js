'use strict';

require('dotenv').config();
const chalk = require('chalk');
const { fetchAll } = require('./data_xau');
const { runAnalysis } = require('./ict_xau');
const { sessionStatus, getAsiaSessionBounds } = require('./sessions');
const {
  printHeader, printStatusBar, printKeyLevels, printSweep,
  printMSS, printFVG, printConfluence, printSignal, printWaiting
} = require('./format_xau');

const SCAN_INTERVAL_KZ   = 60;
const SCAN_INTERVAL_IDLE = 300;
const SIGNAL_COOLDOWN    = 600;

let lastSignalTime = 0;
let lastSignalDir  = null;
let timer          = null;

async function scan() {
  try {
    printHeader();

    const session = sessionStatus();
    const scanInterval = session.active ? SCAN_INTERVAL_KZ : SCAN_INTERVAL_IDLE;

    console.log(chalk.gray('  Fetching live XAUUSD data from TwelveData...'));
    const data = await fetchAll();

    const asiaRange = getAsiaSessionBounds(data.h1);

    console.log(chalk.gray('  Running ICT analysis...\n'));
    const result = runAnalysis(data, asiaRange, session);

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

    scheduleCountdown(scanInterval);

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
      process.stdout.write(chalk.gray(`\r  Next scan in ${countdown}s...   `));
    }
  }, 1000);
}

console.log(chalk.yellow('\n  ◆ XAUUSD ICT Signal Bot starting — live data\n'));
scan();
