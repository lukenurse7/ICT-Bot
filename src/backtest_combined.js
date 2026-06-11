'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  Combined Portfolio Backtest — NAS100 + XAUUSD
//  £2,000 start · 3% risk per trade · compounds after every closed trade
//  Signals pulled from latest backtest JSON reports for each market
// ═══════════════════════════════════════════════════════════════════════════

const fs    = require('fs');
const path  = require('path');
const chalk = require('chalk');

const ACCOUNT_START = 2000;
const RISK_PCT      = 0.03;

function fmtGBP(n) {
  return (n >= 0 ? '+' : '') + '£' + n.toFixed(2);
}

// ─── Load NAS100 signals ──────────────────────────────────────────────────
const nas100Report = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'backtest_report_nas100.json'), 'utf8'));
const nas100Signals = nas100Report.signals
  .filter(s => s.result !== 'NO_FILL' && s.pnlR != null)
  .map(s => ({
    date:   s.date,
    market: 'NAS100',
    dir:    s.dir,
    pnlR:   s.pnlR,
    result: s.result,
    rrPot:  s.rrPot,
  }));

// ─── Load XAUUSD signals ─────────────────────────────────────────────────
const xauReport = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'backtest_report_limit_xau_kz.json'), 'utf8'));
const xauSignals = xauReport.signals
  .filter(s => !['MISSED', 'NO_FILL', 'SKIP', 'FILTERED'].includes(s.result) && s.pnlR != null)
  .map(s => ({
    date:   s.time ? s.time.slice(0, 10) : s.date,
    market: 'XAUUSD',
    dir:    s.dir,
    pnlR:   s.pnlR,
    result: s.result,
    rrPot:  s.potentialR || null,
  }));

// ─── Merge + sort chronologically ────────────────────────────────────────
const allTrades = [...nas100Signals, ...xauSignals]
  .sort((a, b) => {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return  1;
    // Same day: XAUUSD (London KZ) usually fires before NAS100 (NY KZ)
    if (a.market === 'XAUUSD' && b.market === 'NAS100') return -1;
    if (a.market === 'NAS100' && b.market === 'XAUUSD') return  1;
    return 0;
  });

// ─── Simulate ────────────────────────────────────────────────────────────
let balance     = ACCOUNT_START;
let peakBalance = ACCOUNT_START;
let maxDrawdown = 0;
let tradeNum    = 0;

const results   = [];
const monthly   = {};

for (const trade of allTrades) {
  tradeNum++;
  const riskGBP = balance * RISK_PCT;
  const pnlGBP  = trade.pnlR * riskGBP;
  balance      += pnlGBP;

  if (balance > peakBalance) peakBalance = balance;
  const dd = (peakBalance - balance) / peakBalance * 100;
  if (dd > maxDrawdown) maxDrawdown = dd;

  const month = trade.date.slice(0, 7);
  if (!monthly[month]) monthly[month] = { trades: 0, wins: 0, losses: 0, netR: 0, pnl: 0, nas: 0, xau: 0 };
  monthly[month].trades++;
  monthly[month].netR  += trade.pnlR;
  monthly[month].pnl   += pnlGBP;
  if (trade.pnlR > 0) monthly[month].wins++;
  else                monthly[month].losses++;
  monthly[month][trade.market === 'NAS100' ? 'nas' : 'xau']++;

  results.push({ ...trade, tradeNum, riskGBP, pnlGBP, balanceAfter: balance });
}

// ─── Print ────────────────────────────────────────────────────────────────
const sep  = '═'.repeat(72);
const sep2 = '─'.repeat(72);

console.log('\n' + sep);
console.log(chalk.bold.cyan('  COMBINED PORTFOLIO — NAS100 + XAUUSD'));
console.log(chalk.gray('  £2,000 start · 3% risk · compounding after every trade'));
console.log(sep + '\n');

results.forEach(t => {
  const mclr   = t.market === 'NAS100' ? chalk.cyan : chalk.yellow;
  const dirClr = t.dir === 'BUY' ? chalk.green : chalk.red;
  const arrow  = t.dir === 'BUY' ? '▲' : '▼';
  const isWin  = t.pnlR > 0;
  const pnlStr = isWin
    ? chalk.green(`+${t.pnlR.toFixed(2)}R  ${fmtGBP(t.pnlGBP)}`)
    : chalk.red(`-1.0R  ${fmtGBP(t.pnlGBP)}`);
  const balStr = chalk.gray(`bal: £${t.balanceAfter.toFixed(2)}`);
  const riskStr = chalk.gray(`risk: £${t.riskGBP.toFixed(2)}`);

  console.log(
    `  #${String(t.tradeNum).padStart(2)}  ${chalk.gray(t.date)}  ${mclr(t.market.padEnd(6))}  ` +
    `${dirClr(arrow + ' ' + t.dir)}  → ${pnlStr}   ${riskStr}   ${balStr}`
  );
});

// ─── Summary ─────────────────────────────────────────────────────────────
const closed   = results;
const wins     = closed.filter(t => t.pnlR > 0);
const losses   = closed.filter(t => t.pnlR <= 0);
const netR     = closed.reduce((s, t) => s + t.pnlR, 0);
const grossW   = wins.reduce((s, t) => s + t.pnlR, 0);
const grossL   = Math.abs(losses.reduce((s, t) => s + t.pnlR, 0));
const pf       = grossL > 0 ? (grossW / grossL).toFixed(2) : '∞';
const avgWin   = wins.length  ? (grossW / wins.length).toFixed(2)  : '0';
const avgLoss  = losses.length ? (grossL / losses.length).toFixed(2) : '0';

const nasResults = results.filter(t => t.market === 'NAS100');
const xauResults = results.filter(t => t.market === 'XAUUSD');

console.log('\n' + sep);
console.log(chalk.bold.white('  SUMMARY'));
console.log(sep);

console.log(`
  Total trades:    ${closed.length}  (NAS100: ${nasResults.length}  XAUUSD: ${xauResults.length})
  Wins:            ${wins.length}
  Losses:          ${losses.length}
  Win rate:        ${(wins.length / closed.length * 100).toFixed(0)}%
  Avg win:         ${avgWin}R
  Avg loss:        -${avgLoss}R
  Net R:           ${netR >= 0 ? '+' : ''}${netR.toFixed(2)}R
  Profit factor:   ${pf}
`);

console.log('  ── ACCOUNT (£2,000 · 3% compounding) ──');
console.log(`  Start:           £${ACCOUNT_START.toFixed(2)}`);
console.log(`  End:             £${balance.toFixed(2)}`);
console.log(`  Net P&L:         ${fmtGBP(balance - ACCOUNT_START)}`);
console.log(`  Return:          ${((balance - ACCOUNT_START) / ACCOUNT_START * 100).toFixed(1)}%`);
console.log(`  Peak balance:    £${peakBalance.toFixed(2)}`);
console.log(`  Max drawdown:    ${maxDrawdown.toFixed(1)}%`);

console.log('\n  ── By market ──');
const nasWins = nasResults.filter(t => t.pnlR > 0).length;
const xauWins = xauResults.filter(t => t.pnlR > 0).length;
const nasPnl  = nasResults.reduce((s, t) => s + t.pnlGBP, 0);
const xauPnl  = xauResults.reduce((s, t) => s + t.pnlGBP, 0);
const nasNetR = nasResults.reduce((s, t) => s + t.pnlR, 0);
const xauNetR = xauResults.reduce((s, t) => s + t.pnlR, 0);
console.log(`  NAS100:  ${nasResults.length} trades  ${nasWins}W/${nasResults.length - nasWins}L  ` +
  `${(nasWins/nasResults.length*100).toFixed(0)}% WR  ${nasNetR >= 0 ? '+' : ''}${nasNetR.toFixed(2)}R  ${fmtGBP(nasPnl)}`);
console.log(`  XAUUSD:  ${xauResults.length} trades  ${xauWins}W/${xauResults.length - xauWins}L  ` +
  `${(xauWins/xauResults.length*100).toFixed(0)}% WR  ${xauNetR >= 0 ? '+' : ''}${xauNetR.toFixed(2)}R  ${fmtGBP(xauPnl)}`);

console.log('\n  ── Month by month ──');
for (const [month, m] of Object.entries(monthly).sort()) {
  const wr = (m.wins / m.trades * 100).toFixed(0);
  const rStr = (m.netR >= 0 ? '+' : '') + m.netR.toFixed(2) + 'R';
  console.log(`  ${month}  ${m.trades} trades (NAS:${m.nas} XAU:${m.xau})  ${m.wins}W/${m.losses}L  ${wr}% WR  ${rStr}  ${fmtGBP(m.pnl)}`);
}

// ─── Consecutive run analysis ─────────────────────────────────────────────
let maxConsecLoss = 0, curLoss = 0, maxConsecWin = 0, curWin = 0;
for (const t of results) {
  if (t.pnlR <= 0) { curLoss++; curWin = 0; maxConsecLoss = Math.max(maxConsecLoss, curLoss); }
  else             { curWin++;  curLoss = 0; maxConsecWin  = Math.max(maxConsecWin,  curWin); }
}
console.log(`\n  Max consecutive losses: ${maxConsecLoss}`);
console.log(`  Max consecutive wins:   ${maxConsecWin}`);

// ─── Save JSON ────────────────────────────────────────────────────────────
const report = {
  generatedAt: new Date().toISOString(),
  settings: { startBalance: ACCOUNT_START, riskPct: RISK_PCT, markets: ['NAS100', 'XAUUSD'] },
  account:  { start: ACCOUNT_START, end: parseFloat(balance.toFixed(2)), peak: parseFloat(peakBalance.toFixed(2)),
               netPnl: parseFloat((balance - ACCOUNT_START).toFixed(2)),
               returnPct: parseFloat(((balance - ACCOUNT_START) / ACCOUNT_START * 100).toFixed(2)),
               maxDrawdown: parseFloat(maxDrawdown.toFixed(2)) },
  stats:    { trades: closed.length, wins: wins.length, losses: losses.length,
               winRate: parseFloat((wins.length / closed.length * 100).toFixed(1)),
               netR: parseFloat(netR.toFixed(2)), profitFactor: parseFloat(pf),
               avgWinR: parseFloat(avgWin), avgLossR: parseFloat(avgLoss) },
  byMonth:  monthly,
  trades:   results,
};
fs.writeFileSync(path.join(__dirname, '..', 'backtest_report_combined.json'), JSON.stringify(report, null, 2));
console.log(chalk.gray('\n  Report → backtest_report_combined.json'));
console.log('\n' + sep + '\n');
