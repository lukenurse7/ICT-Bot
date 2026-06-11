'use strict';

// Combined 1-Year Portfolio — NAS100 + XAUUSD
// £2,000 start · 3% risk · compounding after every trade

const fs    = require('fs');
const path  = require('path');
const chalk = require('chalk');

const ACCOUNT_START = 2000;
const RISK_PCT      = 0.03;

function fmtGBP(n) { return (n >= 0 ? '+' : '') + '£' + n.toFixed(2); }

const nas = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'backtest_report_nas100_1yr.json'), 'utf8'));
const xau = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'backtest_report_xau_1yr.json'), 'utf8'));

const nasTrades = nas.signals
  .filter(s => s.pnlR != null && s.result !== 'NO_FILL' && s.result !== 'OPEN')
  .map(s => ({ date: s.date, market: 'NAS100', dir: s.dir, pnlR: s.pnlR, result: s.result }));

const xauTrades = xau.signals
  .filter(s => !['MISSED','NO_FILL','OPEN','WIN_TP1_OPEN'].includes(s.result) && s.pnlR != null)
  .map(s => ({ date: s.time.slice(0,10), market: 'XAUUSD', dir: s.dir, pnlR: s.pnlR, result: s.result }));

const all = [...nasTrades, ...xauTrades].sort((a, b) => {
  if (a.date < b.date) return -1;
  if (a.date > b.date) return  1;
  return a.market === 'XAUUSD' ? -1 : 1;
});

let balance = ACCOUNT_START, peakBalance = ACCOUNT_START, maxDrawdown = 0;
const results = [];
const monthly = {};

for (const t of all) {
  const riskGBP = balance * RISK_PCT;
  const pnlGBP  = t.pnlR * riskGBP;
  balance += pnlGBP;
  if (balance > peakBalance) peakBalance = balance;
  const dd = (peakBalance - balance) / peakBalance * 100;
  if (dd > maxDrawdown) maxDrawdown = dd;

  const mo = t.date.slice(0, 7);
  if (!monthly[mo]) monthly[mo] = { trades:0, wins:0, losses:0, netR:0, pnl:0, nas:0, xau:0 };
  monthly[mo].trades++;
  monthly[mo].netR += t.pnlR;
  monthly[mo].pnl  += pnlGBP;
  if (t.pnlR > 0) monthly[mo].wins++; else monthly[mo].losses++;
  monthly[mo][t.market === 'NAS100' ? 'nas' : 'xau']++;

  results.push({ ...t, riskGBP, pnlGBP, balanceAfter: balance });
}

const sep  = '═'.repeat(72);
console.log('\n' + sep);
console.log(chalk.bold.cyan('  COMBINED PORTFOLIO — NAS100 + XAUUSD  (1 YEAR)'));
console.log(chalk.gray('  £2,000 start · 3% risk · compounding after every trade'));
console.log(chalk.gray('  2025-06-11 → 2026-06-10'));
console.log(sep + '\n');

const wins   = results.filter(t => t.pnlR > 0);
const losses = results.filter(t => t.pnlR <= 0);
const netR   = results.reduce((s,t) => s+t.pnlR, 0);
const grossW = wins.reduce((s,t)=>s+t.pnlR,0);
const grossL = Math.abs(losses.reduce((s,t)=>s+t.pnlR,0));
const pf     = grossL > 0 ? (grossW/grossL).toFixed(2) : '∞';

const nasRes = results.filter(t=>t.market==='NAS100');
const xauRes = results.filter(t=>t.market==='XAUUSD');
const nasW = nasRes.filter(t=>t.pnlR>0).length;
const xauW = xauRes.filter(t=>t.pnlR>0).length;
const nasPnl = nasRes.reduce((s,t)=>s+t.pnlGBP,0);
const xauPnl = xauRes.reduce((s,t)=>s+t.pnlGBP,0);
const nasNetR = nasRes.reduce((s,t)=>s+t.pnlR,0);
const xauNetR = xauRes.reduce((s,t)=>s+t.pnlR,0);

console.log(`  Total trades:    ${results.length}  (NAS100: ${nasRes.length}  XAUUSD: ${xauRes.length})`);
console.log(`  Wins:            ${wins.length}`);
console.log(`  Losses:          ${losses.length}`);
console.log(`  Win rate:        ${(wins.length/results.length*100).toFixed(0)}%`);
console.log(`  Avg win:         ${(grossW/wins.length).toFixed(2)}R`);
console.log(`  Net R:           ${netR>=0?'+':''}${netR.toFixed(2)}R`);
console.log(`  Profit factor:   ${pf}`);

console.log('\n  ── ACCOUNT (£2,000 · 3% compounding) ──');
console.log(`  Start:           £${ACCOUNT_START.toFixed(2)}`);
console.log(`  End:             ${balance>=ACCOUNT_START?chalk.green('£'+balance.toFixed(2)):chalk.red('£'+balance.toFixed(2))}`);
console.log(`  Net P&L:         ${balance>=ACCOUNT_START?chalk.green(fmtGBP(balance-ACCOUNT_START)):chalk.red(fmtGBP(balance-ACCOUNT_START))}`);
console.log(`  Return:          ${balance>=ACCOUNT_START?chalk.green(((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)+'%'):chalk.red(((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)+'%')}`);
console.log(`  Peak balance:    £${peakBalance.toFixed(2)}`);
console.log(`  Max drawdown:    ${chalk.yellow(maxDrawdown.toFixed(1)+'%')}`);

console.log('\n  ── By market ──');
console.log(`  NAS100:  ${nasRes.length} trades  ${nasW}W/${nasRes.length-nasW}L  ${(nasW/nasRes.length*100).toFixed(0)}% WR  ${nasNetR>=0?'+':''}${nasNetR.toFixed(2)}R  ${fmtGBP(nasPnl)}`);
console.log(`  XAUUSD:  ${xauRes.length} trades  ${xauW}W/${xauRes.length-xauW}L  ${(xauW/xauRes.length*100).toFixed(0)}% WR  ${xauNetR>=0?'+':''}${xauNetR.toFixed(2)}R  ${fmtGBP(xauPnl)}`);

console.log('\n  ── Month by month ──');
let maxConsecLoss=0, curLoss=0, maxConsecWin=0, curWin=0;
for (const t of results) {
  if (t.pnlR<=0){curLoss++;curWin=0;maxConsecLoss=Math.max(maxConsecLoss,curLoss);}
  else{curWin++;curLoss=0;maxConsecWin=Math.max(maxConsecWin,curWin);}
}
for (const [mo, m] of Object.entries(monthly).sort()) {
  const wr = (m.wins/m.trades*100).toFixed(0);
  const rStr = (m.netR>=0?'+':'')+m.netR.toFixed(2)+'R';
  console.log(`  ${mo}  ${m.trades} trades (NAS:${m.nas} XAU:${m.xau})  ${m.wins}W/${m.losses}L  ${wr}% WR  ${rStr}  ${fmtGBP(m.pnl)}`);
}
console.log(`\n  Max consecutive losses: ${maxConsecLoss}`);
console.log(`  Max consecutive wins:   ${maxConsecWin}`);

console.log('\n' + sep + '\n');

fs.writeFileSync(path.join(__dirname,'..','backtest_report_combined_1yr.json'),
  JSON.stringify({ period:'2025-06-11 → 2026-06-10', generatedAt:new Date().toISOString(),
    settings:{startBalance:ACCOUNT_START,riskPct:RISK_PCT,markets:['NAS100','XAUUSD']},
    account:{start:ACCOUNT_START,end:parseFloat(balance.toFixed(2)),peak:parseFloat(peakBalance.toFixed(2)),
      netPnl:parseFloat((balance-ACCOUNT_START).toFixed(2)),
      returnPct:parseFloat(((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(2)),
      maxDrawdown:parseFloat(maxDrawdown.toFixed(2))},
    stats:{trades:results.length,wins:wins.length,losses:losses.length,
      winRate:parseFloat((wins.length/results.length*100).toFixed(1)),
      netR:parseFloat(netR.toFixed(2)),profitFactor:parseFloat(pf)},
    byMonth:monthly, trades:results },null,2));
console.log(chalk.gray('  Report → backtest_report_combined_1yr.json\n'));
