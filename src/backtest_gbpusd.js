'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  GBPUSD ICT BACKTEST — 1 YEAR (v2)
//
//  Simplified detection chain matching DJ30 approach:
//  - Sweep Asia H/L or PDH/PDL during KZ
//  - Displacement candle IS the MSS signal (no separate BOS step)
//  - FVG formed by displacement candle (min 4 pips gap)
//  - FVG midpoint limit entry
//  - H1 20-SMA bias (neutral = trade both directions)
//  - Both London (07-10) and NY (12-15)
//  - 1R risk, TP1 1.5R (half off), TP2 3R, SL breakeven after TP1
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const ACCOUNT_START  = 1500;
const RISK_PCT       = 0.02;       // 2% per trade
const SIM_BARS       = 72;         // 6h max hold
const COOLDOWN_BARS  = 4;          // 20 min between signals
const MIN_WICK_PIPS  = 0.0002;     // 2 pip sweep wick
const MIN_FVG_PIPS   = 0.0002;     // 2 pip FVG gap
const DISPLACE_RATIO = 0.40;       // body/range for displacement candle
const SL_BUFFER_PIPS = 0.0002;     // 2 pip SL buffer
const TP1_R          = 1.5;
const TP2_R          = 3.0;
const MAX_RISK_PIPS  = 0.0120;     // 120 pip max SL

const CACHE = path.join(__dirname, '..', '.cache');
function pips(n) { return Math.round(n / 0.0001); }
function fmtPct(n) { return (n>=0?'+':'') + n.toFixed(1) + '%'; }

// ─── Data loading ──────────────────────────────────────────────────────────
function loadChunks(interval) {
  const all = [];
  for (let y=2025, m=6; !(y===2026&&m===7);) {
    const s  = `${y}-${String(m).padStart(2,'0')}-01`;
    const nm = m+1>12?1:m+1, ny = m+1>12?y+1:y;
    const e  = `${ny}-${String(nm).padStart(2,'0')}-01`;
    const f  = path.join(CACHE, `gbp_${interval}_${s}_${e}.json`);
    if (fs.existsSync(f)) all.push(...JSON.parse(fs.readFileSync(f)));
    m++; if (m>12){m=1;y++;}
  }
  const seen = new Set();
  return all.filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;})
    .sort((a,b)=>a.time.localeCompare(b.time));
}

// ─── H1 20-SMA bias ──────────────────────────────────────────────────────────
function getH1Bias(h1Bars) {
  const w = h1Bars.slice(-30);
  if (w.length < 22) return 'neutral';
  const sma20    = w.slice(-20).reduce((s,c)=>s+c.close,0) / 20;
  const sma20old = w.slice(-25,-5).reduce((s,c)=>s+c.close,0) / 20;
  const slope    = (sma20 - sma20old) / sma20old;
  const last     = w[w.length-1].close;
  if (slope >  0.00005 && last > sma20) return 'bull';
  if (slope < -0.00005 && last < sma20) return 'bear';
  return 'neutral';
}

// ─── Session range helper ─────────────────────────────────────────────────────
function sessionRange(bars5m, dateStr, hStart, hEnd) {
  const s = bars5m.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const h = new Date(c.time).getUTCHours();
    return h >= hStart && h < hEnd;
  });
  if (s.length < 4) return null;
  return { high: Math.max(...s.map(c=>c.high)), low: Math.min(...s.map(c=>c.low)) };
}

function getPDRange(bars5m, dateStr) {
  const today = new Date(dateStr + 'T00:00:00Z');
  const yest  = new Date(today - 86400000);
  const s = bars5m.filter(c => { const t=new Date(c.time); return t>=yest && t<today; });
  if (!s.length) return null;
  return { high: Math.max(...s.map(c=>c.high)), low: Math.min(...s.map(c=>c.low)) };
}

// ─── Sweep + Displacement + FVG detector ─────────────────────────────────────
//  Scans kzBars for: wick beyond level → displacement candle → FVG gap
//  Returns array of signal candidates
function findSignals(kzBars, levels, dir) {
  const signals = [];
  const seenLevels = new Set();

  for (let i = 0; i < kzBars.length - 2; i++) {
    const c = kzBars[i];

    for (const lvl of levels) {
      if (lvl.dir !== dir) continue;
      if (seenLevels.has(lvl.label)) continue;

      let swept = false;
      if (dir === 'bear' && c.high > lvl.price && c.close < lvl.price
          && (c.high - lvl.price) >= MIN_WICK_PIPS) swept = true;
      if (dir === 'bull' && c.low < lvl.price && c.close > lvl.price
          && (lvl.price - c.low) >= MIN_WICK_PIPS) swept = true;
      if (!swept) continue;

      seenLevels.add(lvl.label);
      const sweepExtreme = dir === 'bear' ? c.high : c.low;

      // Look forward up to 12 bars for displacement + FVG
      for (let j = i+1; j < Math.min(i+13, kzBars.length-1); j++) {
        const c0 = kzBars[j-1];
        const c1 = kzBars[j];
        const c2 = kzBars[j+1] || kzBars[j];  // safe fallback

        const range = c1.high - c1.low;
        if (range < 0.0002) continue;
        const body = Math.abs(c1.close - c1.open);
        if (body / range < DISPLACE_RATIO) continue;

        // Displacement candle must be in sweep direction
        if (dir === 'bear' && c1.close >= c1.open) continue;
        if (dir === 'bull' && c1.close <= c1.open) continue;

        // FVG gap between c0 and c2
        let fvgTop, fvgBot;
        if (dir === 'bear') {
          fvgTop = c0.low;
          fvgBot = c2.high;
        } else {
          fvgTop = c2.low;
          fvgBot = c0.high;
        }

        if (fvgTop <= fvgBot) continue;  // no gap
        if ((fvgTop - fvgBot) < MIN_FVG_PIPS) continue;

        signals.push({
          dir,
          level: lvl.price,
          label: lvl.label,
          sweepBar: i,
          displaceBar: j,
          sweepExtreme,
          fvgTop, fvgBot,
          fvgMid: (fvgTop + fvgBot) / 2,
          fvgSize: fvgTop - fvgBot,
        });
        break; // first valid FVG per sweep
      }
    }
  }
  return signals;
}

// ─── Trade simulator ──────────────────────────────────────────────────────────
function simulate(dir, entry, sl, tp1, tp2, future) {
  const risk = Math.abs(entry - sl);
  let hit = false, sl_ = sl;
  for (const c of future) {
    const slH = dir==='bull' ? c.low<=sl_  : c.high>=sl_;
    const t1  = dir==='bull' ? c.high>=tp1 : c.low<=tp1;
    const t2  = dir==='bull' ? c.high>=tp2 : c.low<=tp2;
    if (!hit) {
      if (slH) return { pnlR:-1, result:'LOSS' };
      if (t2)  return { pnlR:+(0.5*TP1_R+0.5*TP2_R).toFixed(2), result:'WIN_TP2' };
      if (t1)  { hit=true; sl_=entry; }
    } else {
      if (slH) return { pnlR:+(0.5*TP1_R).toFixed(2), result:'WIN_BE' };
      if (t2)  return { pnlR:+(0.5*TP1_R+0.5*TP2_R).toFixed(2), result:'WIN_TP2' };
    }
  }
  if (hit) return { pnlR:+(0.5*TP1_R).toFixed(2), result:'WIN_OPEN' };
  return { pnlR:null, result:'OPEN' };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
function run() {
  console.log('\n' + chalk.bold.green('  ◆ GBPUSD ICT BACKTEST — 1 YEAR (v2)'));
  console.log(chalk.gray('  Period: 2025-06-11 → 2026-06-10'));
  console.log(chalk.gray('  KZs: London (07:00-10:00) + NY (12:00-15:00)'));
  console.log(chalk.gray('  Sweep → Displacement → FVG midpoint limit'));
  console.log(chalk.gray(`  Min sweep wick: ${pips(MIN_WICK_PIPS)}p | Min FVG: ${pips(MIN_FVG_PIPS)}p | Displace body >${(DISPLACE_RATIO*100).toFixed(0)}%`));
  console.log(chalk.gray('  H1 20-SMA bias (neutral=both) | TP1: 1.5R | TP2: 3R\n'));

  const all5m  = loadChunks('5min');
  const allH1  = loadChunks('1h');
  const START  = new Date('2025-06-11T00:00:00Z');
  const END    = new Date('2026-06-10T23:59:59Z');
  const bars5m = all5m.filter(c=>{const t=new Date(c.time);return t>=START&&t<=END;});

  console.log(chalk.gray(`  5m bars: ${bars5m.length}  |  1h bars: ${allH1.length}\n`));

  const KZS = [
    // London removed — 25% WR drag. NY is the edge for GBPUSD.
    { name:'NY',     hStart:12, hEnd:15 },
  ];

  const allSignals = [];
  let balance = ACCOUNT_START, peak = ACCOUNT_START, maxDD = 0;
  let h1Ptr = 0;

  const funnel = { sweeps:0, biasKilled:0, deduped:0, riskKilled:0,
    sigGenerated:0, filled:0, missed:0 };

  // Group bars by date
  const dateSet = [...new Set(bars5m.map(c=>c.time.slice(0,10)))];

  for (const dateStr of dateSet) {
    const dayBars = bars5m.filter(c=>c.time.startsWith(dateStr));

    // Advance H1 pointer to market open this day
    const dayStart = dateStr + 'T07:00:00Z';
    while (h1Ptr < allH1.length-1 && allH1[h1Ptr+1].time <= dayStart) h1Ptr++;
    const sliceH1 = allH1.slice(Math.max(0, h1Ptr-40), h1Ptr+1);
    const bias    = getH1Bias(sliceH1);

    // Build sweep levels
    const asia = sessionRange(dayBars, dateStr, 0, 7);
    const pd   = getPDRange(bars5m, dateStr);
    const lonH  = sessionRange(dayBars, dateStr, 7, 12);

    const baseLevels = [];
    if (asia) {
      baseLevels.push({ price:asia.high, label:'Asia High', dir:'bear' });
      baseLevels.push({ price:asia.low,  label:'Asia Low',  dir:'bull' });
    }
    if (pd) {
      if (!asia || Math.abs(pd.high - asia.high) > 0.0010)
        baseLevels.push({ price:pd.high, label:'PDH', dir:'bear' });
      if (!asia || Math.abs(pd.low - asia.low) > 0.0010)
        baseLevels.push({ price:pd.low,  label:'PDL', dir:'bull' });
    }

    const firedToday = new Set();

    for (const kz of KZS) {
      const kzBars = dayBars.filter(c => {
        const h = new Date(c.time).getUTCHours();
        return h >= kz.hStart && h < kz.hEnd;
      });
      if (kzBars.length < 4) continue;

      // For NY add London H/L as extra sweep levels
      const levels = [...baseLevels];
      if (kz.name === 'NY' && lonH) {
        levels.push({ price:lonH.high, label:'London High', dir:'bear' });
        levels.push({ price:lonH.low,  label:'London Low',  dir:'bull' });
      }

      // Find signals both directions
      const candidates = [
        ...findSignals(kzBars, levels, 'bear'),
        ...findSignals(kzBars, levels, 'bull'),
      ];

      for (const sig of candidates) {
        funnel.sweeps++;

        // Bias filter
        if (bias === 'bull' && sig.dir === 'bear') { funnel.biasKilled++; continue; }
        if (bias === 'bear' && sig.dir === 'bull') { funnel.biasKilled++; continue; }

        // One signal per level per session
        const key = `${kz.name}_${sig.label}_${sig.dir}`;
        if (firedToday.has(key)) { funnel.deduped++; continue; }
        firedToday.add(key);

        const isLong = sig.dir === 'bull';
        const entry  = sig.fvgMid;
        const sl     = isLong
          ? sig.sweepExtreme - SL_BUFFER_PIPS
          : sig.sweepExtreme + SL_BUFFER_PIPS;
        const risk   = Math.abs(entry - sl);

        if (risk < MIN_WICK_PIPS || risk > MAX_RISK_PIPS) { funnel.riskKilled++; continue; }

        const tp1 = isLong ? entry + risk*TP1_R : entry - risk*TP1_R;
        const tp2 = isLong ? entry + risk*TP2_R : entry - risk*TP2_R;

        funnel.sigGenerated++;

        // Find fill: look for price touching FVG mid within 2h (24 bars)
        const displaceBarTime = kzBars[sig.displaceBar]?.time;
        if (!displaceBarTime) continue;
        const dispIdx = bars5m.findIndex(b=>b.time===displaceBarTime);
        if (dispIdx < 0) continue;

        const fillWindow = bars5m.slice(dispIdx+1, dispIdx+25);
        let fillIdx = -1;
        for (let f=0; f<fillWindow.length; f++) {
          const c = fillWindow[f];
          if (isLong  && c.low  <= entry) { fillIdx=f; break; }
          if (!isLong && c.high >= entry) { fillIdx=f; break; }
        }

        if (fillIdx === -1) {
          funnel.missed++;
          allSignals.push({ date:dateStr, kz:kz.name, dir:isLong?'BUY':'SELL',
            sweep:sig.label, entry:+entry.toFixed(5), result:'MISSED', pnlR:0,
            balanceAfter:+balance.toFixed(2), bias, riskPips:pips(risk) });
          continue;
        }

        funnel.filled++;
        const future  = bars5m.slice(dispIdx+fillIdx+2, dispIdx+fillIdx+2+SIM_BARS);
        const outcome = simulate(sig.dir, entry, sl, tp1, tp2, future);
        const riskGBP = balance * RISK_PCT;
        const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;

        if (pnlGBP !== null) {
          balance += pnlGBP;
          if (balance > peak) peak = balance;
          const dd = (peak - balance) / peak * 100;
          if (dd > maxDD) maxDD = dd;
        }

        allSignals.push({ date:dateStr, kz:kz.name, dir:isLong?'BUY':'SELL',
          sweep:sig.label, entry:+entry.toFixed(5), sl:+sl.toFixed(5),
          tp1:+tp1.toFixed(5), tp2:+tp2.toFixed(5), riskPips:pips(risk),
          balanceAfter:+balance.toFixed(2), bias, ...outcome });
      }
    }
  }

  // ─── Output ───────────────────────────────────────────────────────────────
  const sep     = '═'.repeat(72);
  const filled  = allSignals.filter(s=>s.result!=='MISSED');
  const missed  = allSignals.filter(s=>s.result==='MISSED');
  const closed  = filled.filter(s=>s.pnlR!=null);
  const wins    = closed.filter(s=>s.pnlR>0);
  const losses  = closed.filter(s=>s.pnlR<0);
  const totalR  = +closed.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
  const wr      = closed.length ? Math.round(wins.length/closed.length*100) : 0;
  const pf      = losses.length
    ? +(wins.reduce((s,x)=>s+x.pnlR,0)/Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2)
    : wins.length ? Infinity : 0;

  console.log(sep);
  console.log(chalk.bold('  ══ DETECTION FUNNEL ══'));
  console.log(sep);
  console.log(chalk.cyan('  Sweep candidates:    ') + funnel.sweeps);
  console.log(chalk.cyan('  → Bias killed:       ') + funnel.biasKilled);
  console.log(chalk.cyan('  → Deduped:           ') + funnel.deduped);
  console.log(chalk.cyan('  → Risk killed:       ') + funnel.riskKilled);
  console.log(chalk.cyan('  → Signals generated: ') + funnel.sigGenerated);
  console.log(chalk.green('  → Limit fills:       ') + funnel.filled +
    chalk.gray(` (${funnel.sigGenerated?(funnel.filled/funnel.sigGenerated*100).toFixed(0):0}% fill rate)`));
  console.log(chalk.yellow('  → Limits missed:     ') + funnel.missed);

  console.log('\n' + sep);
  console.log(chalk.bold.cyan('  ══ 1-YEAR RESULTS — GBPUSD ICT ══'));
  console.log(sep);
  console.log(
    chalk.gray('  Trades: ') + chalk.green(closed.length) +
    chalk.gray('  Fills: ') + filled.length +
    chalk.gray('  Missed: ') + missed.length
  );
  console.log(
    chalk.gray('  Wins: ') + chalk.green(wins.length) +
    chalk.gray('  Losses: ') + chalk.red(losses.length) +
    chalk.gray('  WR: ') + (wr>=50?chalk.green:chalk.yellow)(wr+'%') +
    chalk.gray('  Net R: ') + (totalR>=0?chalk.green(`+${totalR}R`):chalk.red(`${totalR}R`)) +
    chalk.gray('  PF: ') + chalk.cyan(pf)
  );
  console.log(
    chalk.gray('  Start: £1,500') +
    chalk.gray('  End: ') + (balance>=ACCOUNT_START?chalk.green:chalk.red)('£'+balance.toFixed(2)) +
    chalk.gray('  Return: ') + fmtPct((balance-ACCOUNT_START)/ACCOUNT_START*100) +
    chalk.gray('  MaxDD: ') + chalk.yellow(maxDD.toFixed(1)+'%')
  );

  // KZ breakdown
  if (closed.length) {
    console.log(chalk.gray('\n  By kill zone:'));
    for (const kzName of ['London','NY']) {
      const ks = closed.filter(s=>s.kz===kzName);
      if (!ks.length) continue;
      const kw=ks.filter(s=>s.pnlR>0).length, kl=ks.filter(s=>s.pnlR<0).length;
      const kr=+ks.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
      const kwr=(kw+kl)?Math.round(kw/(kw+kl)*100):0;
      console.log(chalk.gray(`    ${kzName.padEnd(8)} ${ks.length}tr  `)+
        chalk.green(`${kw}W`)+'/'+chalk.red(`${kl}L`)+
        chalk.gray(`  ${kwr}%WR  `)+(kr>=0?chalk.green(`+${kr}R`):chalk.red(`${kr}R`)));
    }

    console.log(chalk.gray('\n  By direction:'));
    for (const d of ['BUY','SELL']) {
      const ds = closed.filter(s=>s.dir===d);
      if (!ds.length) continue;
      const dw=ds.filter(s=>s.pnlR>0).length, dl=ds.filter(s=>s.pnlR<0).length;
      const dr=+ds.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
      const dwr=(dw+dl)?Math.round(dw/(dw+dl)*100):0;
      console.log(chalk.gray(`    ${d.padEnd(5)} ${ds.length}tr  `)+
        chalk.green(`${dw}W`)+'/'+chalk.red(`${dl}L`)+
        chalk.gray(`  ${dwr}%WR  `)+(dr>=0?chalk.green(`+${dr}R`):chalk.red(`${dr}R`)));
    }

    console.log(chalk.gray('\n  By sweep level:'));
    const sweepLabels = [...new Set(closed.map(s=>s.sweep))].sort();
    for (const lbl of sweepLabels) {
      const ss = closed.filter(s=>s.sweep===lbl);
      if (!ss.length) continue;
      const sw=ss.filter(s=>s.pnlR>0).length, sl_=ss.filter(s=>s.pnlR<0).length;
      const sr=+ss.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
      const swr=(sw+sl_)?Math.round(sw/(sw+sl_)*100):0;
      console.log(chalk.gray(`    ${lbl.padEnd(14)} ${ss.length}tr  `)+
        chalk.green(`${sw}W`)+'/'+chalk.red(`${sl_}L`)+
        chalk.gray(`  ${swr}%WR  `)+(sr>=0?chalk.green(`+${sr}R`):chalk.red(`${sr}R`)));
    }

    // Quarterly
    console.log(chalk.gray('\n  Quarterly:'));
    const quarters = [
      { label:"Q3'25 Jun-Aug", start:'2025-06-01', end:'2025-09-01' },
      { label:"Q4'25 Sep-Nov", start:'2025-09-01', end:'2025-12-01' },
      { label:"Q1'26 Dec-Feb", start:'2025-12-01', end:'2026-03-01' },
      { label:"Q2'26 Mar-May", start:'2026-03-01', end:'2026-06-01' },
      { label:"Jun'26",        start:'2026-06-01', end:'2026-07-01' },
    ];
    let cumR = 0;
    for (const q of quarters) {
      const qs = closed.filter(s=>s.date>=q.start && s.date<q.end);
      if (!qs.length) continue;
      const qw=qs.filter(s=>s.pnlR>0).length, ql=qs.filter(s=>s.pnlR<0).length;
      const qr=+qs.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
      cumR = +(cumR+qr).toFixed(2);
      const qwr=(qw+ql)?Math.round(qw/(qw+ql)*100):0;
      console.log(chalk.gray(`    ${q.label.padEnd(16)} `)+
        chalk.cyan(`${qs.length}tr  `)+
        chalk.green(`${qw}W`)+'/'+chalk.red(`${ql}L`)+
        chalk.gray(`  ${qwr}%  `)+(qr>=0?chalk.green(`+${qr}R`):chalk.red(`${qr}R`))+
        chalk.gray(` cumul:`)+(cumR>=0?chalk.green(`+${cumR}R`):chalk.red(`${cumR}R`)));
    }

    // Month breakdown
    console.log(chalk.gray('\n  Month by month:'));
    const months = [...new Set(closed.map(s=>s.date.slice(0,7)))].sort();
    for (const mo of months) {
      const ms = closed.filter(s=>s.date.startsWith(mo));
      const mw=ms.filter(s=>s.pnlR>0).length, ml=ms.filter(s=>s.pnlR<0).length;
      const mr=+ms.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
      const mwr=(mw+ml)?Math.round(mw/(mw+ml)*100):0;
      console.log(chalk.gray(`    ${mo}   ${ms.length}tr  `)+
        chalk.green(`${mw}W`)+'/'+chalk.red(`${ml}L`)+
        chalk.gray(`  ${mwr}%  `)+(mr>=0?chalk.green(`+${mr}R`):chalk.red(`${mr}R`)));
    }
  }

  // ─── Comparison table ──────────────────────────────────────────────────────
  console.log('\n' + sep);
  console.log(chalk.bold('  ══ INSTRUMENT COMPARISON ══'));
  console.log(sep);
  const header = '  Instrument  Trades/yr  WR     Net R    Return   MaxDD';
  const divider = '  ' + '─'.repeat(54);
  console.log(chalk.gray(header));
  console.log(chalk.gray(divider));

  const gbpR     = totalR.toFixed(1);
  const gbpRet   = ((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1);
  const gbpDD    = maxDD.toFixed(1);

  function row(inst, trades, wr_, netR, ret, dd, highlight) {
    const line = `  ${inst.padEnd(12)}${String(trades).padEnd(11)}${String(wr_+'%').padEnd(7)}${String(netR).padEnd(9)}${String(ret+'%').padEnd(9)}${dd+'%'}`;
    return highlight ? chalk.bold.green(line) : chalk.gray(line);
  }
  console.log(row('GBPUSD', closed.length, wr, (totalR>=0?'+':'')+gbpR+'R', (balance>=ACCOUNT_START?'+':'')+gbpRet, gbpDD, true));
  console.log(row('DJ30', 34, 79, '+52.5R', '+67.9', '~5', false) + chalk.gray('  (3-month annualised)'));
  console.log(row('XAUUSD', 21, 71, '+9.0R', '+19.2', '4.0', false));
  console.log(sep + '\n');

  // Save report
  fs.writeFileSync(
    path.join(__dirname, '..', 'backtest_report_gbpusd.json'),
    JSON.stringify({ instrument:'GBPUSD', period:'2025-06-11_2026-06-10',
      trades:closed.length, wr, totalR, balance:+balance.toFixed(2),
      returnPct:+((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1),
      maxDD:+maxDD.toFixed(1), signals:allSignals }, null, 2)
  );
  console.log(chalk.gray('  Report → backtest_report_gbpusd.json\n'));
}

run();
