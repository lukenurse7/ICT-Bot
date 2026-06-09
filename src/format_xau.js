'use strict';

const chalk = require('chalk');

function fmt(n, dec = 2) {
  if (n == null) return '—';
  return parseFloat(n).toFixed(dec);
}

function ts(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getUTCHours().toString().padStart(2,'0')}:${d.getUTCMinutes().toString().padStart(2,'0')} UTC`;
}

function divider(char = '─', len = 62) {
  return chalk.gray(char.repeat(len));
}

function printHeader() {
  console.clear();
  console.log('\n' + chalk.bold.yellow('  ◆ XAUUSD ICT SIGNAL BOT'));
  console.log(chalk.gray('  Liquidity Sweep → MSS → FVG Entry Model\n'));
  console.log(divider());
}

function printStatusBar(quote, session, htf) {
  const chgColor = quote.changePct >= 0 ? chalk.green : chalk.red;
  const biasColor = htf.bias === 'bullish' ? chalk.green : htf.bias === 'bearish' ? chalk.red : chalk.yellow;

  console.log(
    chalk.gray('\n  XAUUSD ') +
    chalk.bold.white(`$${fmt(quote.price)}`) +
    '  ' + chgColor(`${quote.changePct >= 0 ? '+' : ''}${fmt(quote.changePct)}%`) +
    '   ' +
    chalk.gray('Bias: ') + biasColor(htf.bias.toUpperCase().replace(/_/g,' ')) +
    '   ' +
    chalk.gray('Session: ') + (session.active ? chalk.green(session.label) : chalk.gray(session.label))
  );
  console.log(chalk.gray(`  H: ${fmt(quote.high)}  L: ${fmt(quote.low)}  Open: ${fmt(quote.open)}\n`));
}

function printKeyLevels(lvls) {
  console.log(chalk.gray('  KEY LEVELS'));
  console.log(chalk.gray('  ') + chalk.yellow('PDH') + chalk.gray(` ${fmt(lvls.pdh)}   `) + chalk.yellow('PDL') + chalk.gray(` ${fmt(lvls.pdl)}`));
  if (lvls.asiaHigh) {
    console.log(chalk.gray('  ') + chalk.cyan('Asia High') + chalk.gray(` ${fmt(lvls.asiaHigh)}   `) + chalk.cyan('Asia Low') + chalk.gray(` ${fmt(lvls.asiaLow)}`));
  }
  console.log(chalk.gray('  ') + chalk.gray('PWH') + chalk.gray(` ${fmt(lvls.pwh)}   `) + chalk.gray('PWL') + chalk.gray(` ${fmt(lvls.pwl)}`));
  console.log();
}

function printSweep(sweepResult) {
  const s = sweepResult.mostRecent;
  if (!s) {
    console.log(chalk.gray('  SWEEP  ') + chalk.gray('None detected on key levels'));
    return;
  }
  const arrow = s.dir === 'bull' ? chalk.green('↓ SSL SWEEP') : chalk.red('↑ BSL SWEEP');
  console.log(
    chalk.gray('  SWEEP  ') + arrow +
    chalk.gray(` @ ${fmt(s.level)}  (${s.levelName})`) +
    chalk.gray(`  ${s.barsAgo} bars ago  wick: ${fmt(s.dir === 'bull' ? s.wickBelow : s.wickAbove, 2)} pts`)
  );
}

function printMSS(mss) {
  if (!mss.confirmed) {
    console.log(chalk.gray('  MSS    ') + chalk.yellow(`Waiting — ${mss.reason}`));
    return;
  }
  const color = mss.dir === 'bull' ? chalk.green : chalk.red;
  console.log(chalk.gray('  MSS    ') + color(`${mss.type} confirmed`) + chalk.gray(` — ${mss.description}`));
}

function printFVG(fvg) {
  if (!fvg) {
    console.log(chalk.gray('  FVG    ') + chalk.yellow('None post-MSS — use OB for entry'));
    return;
  }
  const arrow = fvg.type === 'bullish' ? chalk.green('▲ BULL FVG') : chalk.red('▼ BEAR FVG');
  const inZone = fvg.inFVG ? chalk.bgGreen.black(' IN ZONE ') : chalk.gray('approaching');
  console.log(
    chalk.gray('  FVG    ') + arrow +
    chalk.gray(` ${fvg.entryZone}`) +
    '  ' + inZone +
    chalk.gray(`  mid: ${fmt(fvg.mid)}  size: ${fmt(fvg.size, 2)} pts`)
  );
}

function printConfluence(confluence) {
  const gradeColors = { A: chalk.green, B: chalk.cyan, C: chalk.yellow, D: chalk.red };
  const gc = gradeColors[confluence.grade] || chalk.gray;

  console.log('\n' + divider());
  console.log(chalk.gray('  CONFLUENCE ANALYSIS') + '  ' + gc(`Grade: ${confluence.grade}`) + chalk.gray(`  Score: ${confluence.score}/100`));

  // Bar
  const filled = Math.round(confluence.score / 5);
  const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
  const barColor = confluence.score >= 80 ? chalk.green : confluence.score >= 60 ? chalk.yellow : chalk.red;
  console.log('  ' + barColor(bar) + ' ' + chalk.bold(confluence.score + '%'));
  console.log();

  confluence.reasons.forEach(r => {
    console.log('  ' + r);
  });
}

function printSignal(signal) {
  if (!signal) return;

  const isLong = signal.direction === 'BUY';
  const color = isLong ? chalk.green : chalk.red;
  const arrow = isLong ? '▲' : '▼';

  console.log('\n' + divider('═'));
  console.log(color(`  ${arrow} ${signal.direction} SIGNAL — XAUUSD`) + chalk.gray(`  [${ts(signal.timestamp)}]`));
  console.log(chalk.gray(`  Confluence: ${signal.confluence}%  Grade: ${signal.grade}`));
  console.log(divider('─'));

  console.log(
    chalk.gray('\n  ENTRY     ') + chalk.bold.white(`$${fmt(signal.entry)}`) +
    chalk.gray(`  (${signal.fvg ? 'FVG midpoint' : 'OB equilibrium'})`)
  );
  console.log(
    chalk.gray('  STOP LOSS ') + chalk.red(`$${fmt(signal.sl)}`) +
    chalk.gray(`  — ${signal.slDesc}`)
  );
  console.log(chalk.gray(`             Risk: ${fmt(signal.riskPoints, 2)} pts`));

  console.log('\n' + chalk.gray('  TARGETS'));
  console.log(
    chalk.gray('  TP1  ') + chalk.green(`$${fmt(signal.tp1)}`) +
    chalk.gray(`  (1:${signal.rr1} R:R)  — ${signal.tp1Desc}`)
  );
  console.log(
    chalk.gray('  TP2  ') + chalk.green(`$${fmt(signal.tp2)}`) +
    chalk.gray(`  (1:${signal.rr2} R:R)  — ${signal.tp2Desc}`)
  );
  console.log(
    chalk.gray('  TP3  ') + chalk.green(`$${fmt(signal.tp3)}`) +
    chalk.gray(`  — ${signal.tp3Desc}`)
  );

  console.log('\n' + chalk.gray('  SETUP BREAKDOWN'));
  const s = signal.setup;
  console.log(chalk.gray(`  Daily Bias:  `) + (s.htfBias === 'bullish' ? chalk.green : chalk.red)(s.htfBias.toUpperCase().replace(/_/g,' ')));
  console.log(chalk.gray(`  Daily:  ${s.htfDaily.toUpperCase()}   4H: ${s.htfH4.toUpperCase()}`));
  if (s.sweep) {
    console.log(chalk.gray(`  Sweep:       `) + chalk.white(`${s.sweep.levelName} swept`));
  }
  if (s.mss) {
    console.log(chalk.gray(`  MSS:         `) + chalk.white(s.mss.description));
  }
  if (s.fvg) {
    console.log(chalk.gray(`  FVG:         `) + chalk.white(s.fvg.entryZone));
  }
  if (s.ob) {
    console.log(chalk.gray(`  OB:          `) + chalk.white(s.ob.desc));
  }
  console.log(divider('═') + '\n');
}

function printWaiting(waitReason, result) {
  console.log(chalk.gray('\n  STATUS  ') + chalk.yellow('⏳ ' + (waitReason || 'Monitoring...')));

  // Show partial progress
  if (result.sweepResult?.mostRecent) {
    const s = result.sweepResult.mostRecent;
    console.log(chalk.gray('  Step 1 ✅ Sweep: ') + chalk.white(`${s.levelName} — ${s.dir === 'bull' ? 'SSL' : 'BSL'} taken`));
  } else {
    console.log(chalk.gray('  Step 1 ⏳ Waiting for liquidity sweep on PDH/PDL/Asia H/L'));
  }

  if (result.mss?.confirmed) {
    console.log(chalk.gray('  Step 2 ✅ MSS: ') + chalk.white(result.mss.description));
  } else if (result.sweepResult?.mostRecent) {
    console.log(chalk.gray('  Step 2 ⏳ Waiting for 5m MSS/BOS after sweep'));
  }

  if (result.fvg) {
    console.log(chalk.gray('  Step 3 ✅ FVG: ') + chalk.white(result.fvg.entryZone));
  } else if (result.mss?.confirmed) {
    console.log(chalk.gray('  Step 3 ⏳ Waiting for displacement FVG to form'));
  }
}

function printScanTime(next) {
  console.log('\n' + divider());
  console.log(chalk.gray(`  Next scan in ${next}s — Ctrl+C to stop\n`));
}

module.exports = { printHeader, printStatusBar, printKeyLevels, printSweep, printMSS, printFVG, printConfluence, printSignal, printWaiting, printScanTime, fmt };
