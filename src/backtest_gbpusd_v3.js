'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  GBPUSD ICT BACKTEST — 1 YEAR (v3 — strict 2022 Mentorship spec)
//
//  The ICT 2022 Model for GBP/USD:
//    1. SWEEP  — London/NY open wicks above/below Asia session H/L
//    2. DISPLACE — sharp move in opposite direction (displacement candle)
//    3. FVG ENTRY — limit order in the gap left by displacement
//    4. TP — actual Asia Low (SELL) or Asia High (BUY) — price-based target
//    5. SL — above/below the sweep wick extreme
//
//  Direction is 100% defined by the sweep:
//    Asia High swept → SELL (targeting Asia Low)
//    Asia Low swept  → BUY  (targeting Asia High)
//  No external SMA bias filter — the sweep IS the bias signal.
//
//  KZs: London 07:00-10:00 UTC (primary per spec), NY 12:00-15:00 (secondary)
//  Sweep must occur within first 90 min of session open.
//  PO3 logic: sweep = manipulation phase → displacement = distribution start
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const ACCOUNT_START   = 1500;
const RISK_PCT        = 0.02;
const SIM_BARS        = 96;        // 8h max hold
const MIN_WICK_PIPS   = 0.0003;    // 3 pip minimum sweep wick
const MIN_FVG_PIPS    = 0.0003;    // 3 pip FVG gap
const DISPLACE_RATIO  = 0.45;      // displacement body > 45% of range
const SL_BUFFER_PIPS  = 0.0003;    // 3 pips above sweep wick
const MIN_TP_PIPS     = 0.0010;    // Asia target must be >=10 pips away to be valid
const SWEEP_WINDOW_H  = 1.5;       // sweep must happen in first 1.5h of KZ

const CACHE = path.join(__dirname, '..', '.cache');
function pips(n)   { return Math.round(n / 0.0001); }
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

// ─── Session range helper ─────────────────────────────────────────────────────
function sessionRange(dayBars, hStart, hEnd) {
  const s = dayBars.filter(c => {
    const h = new Date(c.time).getUTCHours();
    return h >= hStart && h < hEnd;
  });
  if (s.length < 4) return null;
  return {
    high:  Math.max(...s.map(c=>c.high)),
    low:   Math.min(...s.map(c=>c.low)),
    bars:  s,
  };
}

// ─── Find displacement candle + FVG after a sweep ────────────────────────────
//  Scans forward from sweepBarIdx for: displacement candle → FVG gap
//  sweepExtreme: the wick tip. For bear=high, bull=low.
//  FVG must sit on the correct side of sweepExtreme (bear: below, bull: above).
function findDisplaceFVG(kzBars, sweepBarIdx, dir, sweepExtreme) {
  for (let j = sweepBarIdx + 1; j < Math.min(sweepBarIdx + 15, kzBars.length - 1); j++) {
    const c0 = kzBars[j-1];
    const c1 = kzBars[j];
    const c2 = kzBars[j+1];

    const range = c1.high - c1.low;
    if (range < 0.0003) continue;
    const body = Math.abs(c1.close - c1.open);
    if (body / range < DISPLACE_RATIO) continue;

    // Displacement candle direction must match sweep direction
    if (dir === 'bear' && c1.close >= c1.open) continue;
    if (dir === 'bull' && c1.close <= c1.open) continue;

    // FVG: gap between c0 and c2
    let fvgTop, fvgBot;
    if (dir === 'bear') {
      fvgTop = c0.low;
      fvgBot = c2.high;
    } else {
      fvgTop = c2.low;
      fvgBot = c0.high;
    }

    if (fvgTop <= fvgBot) continue;
    if ((fvgTop - fvgBot) < MIN_FVG_PIPS) continue;

    const fvgMid = (fvgTop + fvgBot) / 2;

    // FVG must sit on the correct side of the sweep extreme:
    // Bear sweep (wick above Asia High): FVG mid must be BELOW the sweep high
    // Bull sweep (wick below Asia Low):  FVG mid must be ABOVE the sweep low
    if (dir === 'bear' && fvgMid >= sweepExtreme) continue;
    if (dir === 'bull' && fvgMid <= sweepExtreme) continue;

    return {
      fvgTop, fvgBot, fvgMid,
      fvgSize: fvgTop - fvgBot,
      displaceBar: j,
      displaceTime: c1.time,
    };
  }
  return null;
}

// ─── Trade simulator ──────────────────────────────────────────────────────────
//  Half off at TP1 (halfway to TP2), then TP2 = Asia target price
//  After TP1 hit → SL moves to entry (breakeven)
function simulate(dir, entry, sl, tp1, tp2, future) {
  let hit = false, sl_ = sl;
  const tp1R = +(Math.abs(tp1-entry)/Math.abs(entry-sl)).toFixed(2);
  const tp2R = +(Math.abs(tp2-entry)/Math.abs(entry-sl)).toFixed(2);

  for (const c of future) {
    const slH = dir==='bull' ? c.low<=sl_  : c.high>=sl_;
    const t1  = dir==='bull' ? c.high>=tp1 : c.low<=tp1;
    const t2  = dir==='bull' ? c.high>=tp2 : c.low<=tp2;
    if (!hit) {
      if (slH) return { pnlR:-1, result:'LOSS', tp1R, tp2R };
      if (t2)  return { pnlR:+(tp2R).toFixed(2), result:'WIN_TP2', tp1R, tp2R };
      if (t1)  { hit=true; sl_=entry; }
    } else {
      if (slH) return { pnlR:+(0.5*tp1R).toFixed(2), result:'WIN_BE', tp1R, tp2R };
      if (t2)  return { pnlR:+(0.5*tp1R + 0.5*tp2R).toFixed(2), result:'WIN_TP2', tp1R, tp2R };
    }
  }
  if (hit) return { pnlR:+(0.5*tp1R).toFixed(2), result:'WIN_OPEN', tp1R, tp2R };
  return { pnlR:null, result:'OPEN', tp1R, tp2R };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
function run() {
  console.log('\n' + chalk.bold.green('  ◆ GBPUSD ICT 2022 MODEL — 1 YEAR BACKTEST'));
  console.log(chalk.gray('  Period: 2025-06-11 → 2026-06-10'));
  console.log(chalk.gray('  Spec: Asia H/L sweep → displacement → FVG limit → Asia target'));
  console.log(chalk.gray('  KZs: London 07-10 UTC (primary) + NY 12-15 UTC (secondary)'));
  console.log(chalk.gray(`  Min wick: ${pips(MIN_WICK_PIPS)}p | Min FVG: ${pips(MIN_FVG_PIPS)}p | Displace >${(DISPLACE_RATIO*100).toFixed(0)}% body`));
  console.log(chalk.gray('  Direction from sweep only | TP = actual Asia H/L price target\n'));

  const all5m  = loadChunks('5min');
  const START  = new Date('2025-06-11T00:00:00Z');
  const END    = new Date('2026-06-10T23:59:59Z');
  const bars5m = all5m.filter(c=>{const t=new Date(c.time);return t>=START&&t<=END;});

  console.log(chalk.gray(`  5m bars loaded: ${bars5m.length}\n`));

  const KZS = [
    { name:'London', hStart:7,  hEnd:10 },
    { name:'NY',     hStart:12, hEnd:15 },
  ];

  const allSignals = [];
  let balance = ACCOUNT_START, peak = ACCOUNT_START, maxDD = 0;

  const funnel = {
    days:0, noAsia:0, noTP:0,
    sweeps:0, noFVG:0, noFill:0,
    filled:0,
  };

  const dateSet = [...new Set(bars5m.map(c=>c.time.slice(0,10)))];

  for (const dateStr of dateSet) {
    const dayBars = bars5m.filter(c=>c.time.startsWith(dateStr));
    funnel.days++;

    // Asia range 00:00-07:00 UTC (prev session)
    const asia = sessionRange(dayBars, 0, 7);
    if (!asia) { funnel.noAsia++; continue; }

    const firedToday = new Set();

    for (const kz of KZS) {
      const kzBars = dayBars.filter(c => {
        const h = new Date(c.time).getUTCHours();
        const m = new Date(c.time).getUTCMinutes();
        return h >= kz.hStart && h < kz.hEnd;
      });
      if (kzBars.length < 4) continue;

      // Scan for Asia H/L sweeps — must occur within first SWEEP_WINDOW_H hours
      const sweepCutoffH = kz.hStart + SWEEP_WINDOW_H;

      for (let i = 0; i < kzBars.length; i++) {
        const c = kzBars[i];
        const barHour = new Date(c.time).getUTCHours() + new Date(c.time).getUTCMinutes()/60;
        if (barHour >= sweepCutoffH) break; // only in opening window

        // ── Bear setup: wick above Asia High → sell targeting Asia Low ──
        if (!firedToday.has(`${kz.name}_bear`)) {
          const asiaHigh = asia.high;
          const asiaLow  = asia.low;
          const swept = c.high > asiaHigh && c.close < asiaHigh
                        && (c.high - asiaHigh) >= MIN_WICK_PIPS;
          if (swept) {
            const tp2 = asiaLow;  // ICT spec: target the Asia Low
            const sweepExtreme = c.high;
            const sl = sweepExtreme + SL_BUFFER_PIPS;

            // TP must be meaningful distance from current price
            if ((c.close - tp2) < MIN_TP_PIPS) { funnel.noTP++; }
            else {
              const fvg = findDisplaceFVG(kzBars, i, 'bear', sweepExtreme);
              if (!fvg) { funnel.noFVG++; }
              else {
                const entry = fvg.fvgMid;
                // Sanity: for a SELL, entry must be above SL
                if (entry <= sl) { funnel.noFVG++; continue; }

                funnel.sweeps++;
                firedToday.add(`${kz.name}_bear`);

                const risk  = Math.abs(entry - sl);
                const tp1   = entry - (tp2 - entry) * 0.5; // midway to Asia Low
                // Safety: tp1 must be below entry for a sell
                const validTp1 = tp1 < entry;

                // Find fill in bars after displacement
                const dispIdx = bars5m.findIndex(b=>b.time===fvg.displaceTime);
                if (dispIdx < 0) continue;
                const fillW = bars5m.slice(dispIdx+1, dispIdx+25);
                let fillIdx = -1;
                for (let f=0; f<fillW.length; f++) {
                  if (fillW[f].high >= entry) { fillIdx=f; break; }
                }

                if (fillIdx === -1) {
                  funnel.noFill++;
                  allSignals.push({
                    date:dateStr, kz:kz.name, dir:'SELL',
                    sweep:'Asia High', entry:+entry.toFixed(5), result:'MISSED',
                    pnlR:0, balanceAfter:+balance.toFixed(2),
                    riskPips:pips(risk), asiaTp:+tp2.toFixed(5),
                  });
                } else {
                  funnel.filled++;
                  const future  = bars5m.slice(dispIdx+fillIdx+2, dispIdx+fillIdx+2+SIM_BARS);
                  const outcome = simulate('bear', entry, sl, validTp1?tp1:entry-risk*0.5, tp2, future);
                  const riskGBP = balance * RISK_PCT;
                  const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;

                  if (pnlGBP !== null) {
                    balance += pnlGBP;
                    if (balance > peak) peak = balance;
                    const dd = (peak-balance)/peak*100;
                    if (dd > maxDD) maxDD = dd;
                  }

                  allSignals.push({
                    date:dateStr, kz:kz.name, dir:'SELL',
                    sweep:'Asia High', entry:+entry.toFixed(5),
                    sl:+sl.toFixed(5), tp1:+(validTp1?tp1:entry-risk*0.5).toFixed(5),
                    tp2:+tp2.toFixed(5), asiaTp:+tp2.toFixed(5),
                    riskPips:pips(risk), tpPips:pips(Math.abs(entry-tp2)),
                    balanceAfter:+balance.toFixed(2),
                    fvgPips:pips(fvg.fvgSize),
                    ...outcome,
                  });
                }
              }
            }
          }
        }

        // ── Bull setup: wick below Asia Low → buy targeting Asia High ──
        if (!firedToday.has(`${kz.name}_bull`)) {
          const asiaLow  = asia.low;
          const asiaHigh = asia.high;
          const swept = c.low < asiaLow && c.close > asiaLow
                        && (asiaLow - c.low) >= MIN_WICK_PIPS;
          if (swept) {
            const tp2 = asiaHigh; // ICT spec: target the Asia High
            const sweepExtreme = c.low;
            const sl = sweepExtreme - SL_BUFFER_PIPS;

            if ((tp2 - c.close) < MIN_TP_PIPS) { funnel.noTP++; }
            else {
              const fvg = findDisplaceFVG(kzBars, i, 'bull', sweepExtreme);
              if (!fvg) { funnel.noFVG++; }
              else {
                const entry = fvg.fvgMid;
                // Sanity: for a BUY, entry must be above SL
                if (entry <= sl) { funnel.noFVG++; continue; }

                funnel.sweeps++;
                firedToday.add(`${kz.name}_bull`);

                const risk  = Math.abs(entry - sl);
                const tp1   = entry + (tp2 - entry) * 0.5;
                const validTp1 = tp1 > entry;

                const dispIdx = bars5m.findIndex(b=>b.time===fvg.displaceTime);
                if (dispIdx < 0) continue;
                const fillW = bars5m.slice(dispIdx+1, dispIdx+25);
                let fillIdx = -1;
                for (let f=0; f<fillW.length; f++) {
                  if (fillW[f].low <= entry) { fillIdx=f; break; }
                }

                if (fillIdx === -1) {
                  funnel.noFill++;
                  allSignals.push({
                    date:dateStr, kz:kz.name, dir:'BUY',
                    sweep:'Asia Low', entry:+entry.toFixed(5), result:'MISSED',
                    pnlR:0, balanceAfter:+balance.toFixed(2),
                    riskPips:pips(risk), asiaTp:+tp2.toFixed(5),
                  });
                } else {
                  funnel.filled++;
                  const future  = bars5m.slice(dispIdx+fillIdx+2, dispIdx+fillIdx+2+SIM_BARS);
                  const outcome = simulate('bull', entry, sl, validTp1?tp1:entry+risk*0.5, tp2, future);
                  const riskGBP = balance * RISK_PCT;
                  const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;

                  if (pnlGBP !== null) {
                    balance += pnlGBP;
                    if (balance > peak) peak = balance;
                    const dd = (peak-balance)/peak*100;
                    if (dd > maxDD) maxDD = dd;
                  }

                  allSignals.push({
                    date:dateStr, kz:kz.name, dir:'BUY',
                    sweep:'Asia Low', entry:+entry.toFixed(5),
                    sl:+sl.toFixed(5), tp1:+(validTp1?tp1:entry+risk*0.5).toFixed(5),
                    tp2:+tp2.toFixed(5), asiaTp:+tp2.toFixed(5),
                    riskPips:pips(risk), tpPips:pips(Math.abs(entry-tp2)),
                    balanceAfter:+balance.toFixed(2),
                    fvgPips:pips(fvg.fvgSize),
                    ...outcome,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  // ─── Output ───────────────────────────────────────────────────────────────
  const sep    = '═'.repeat(72);
  const filled = allSignals.filter(s=>s.result!=='MISSED');
  const missed = allSignals.filter(s=>s.result==='MISSED');
  const closed = filled.filter(s=>s.pnlR!=null);
  const wins   = closed.filter(s=>s.pnlR>0);
  const losses = closed.filter(s=>s.pnlR<0);
  const totalR = +closed.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
  const wr     = closed.length ? Math.round(wins.length/closed.length*100) : 0;
  const pf     = losses.length
    ? +(wins.reduce((s,x)=>s+x.pnlR,0)/Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2)
    : wins.length ? Infinity : 0;

  console.log(sep);
  console.log(chalk.bold('  ══ DETECTION FUNNEL ══'));
  console.log(sep);
  console.log(chalk.gray(`  Trading days:         ${funnel.days}`));
  console.log(chalk.gray(`  → No Asia range:      ${funnel.noAsia}`));
  console.log(chalk.gray(`  → No valid TP dist:   ${funnel.noTP}`));
  console.log(chalk.cyan(`  → Sweeps with FVG:    ${funnel.sweeps}`));
  console.log(chalk.yellow(`  → FVG not found:      ${funnel.noFVG}`));
  console.log(chalk.yellow(`  → FVG not filled:     ${funnel.noFill}`));
  console.log(chalk.green( `  → Trades filled:      ${funnel.filled}`));

  console.log('\n' + sep);
  console.log(chalk.bold.cyan('  ══ 1-YEAR RESULTS — GBPUSD ICT 2022 MODEL ══'));
  console.log(sep);
  console.log(
    chalk.gray('  Trades: ') + chalk.bold.green(closed.length) +
    chalk.gray('  Missed: ') + missed.length +
    chalk.gray(`  Fill rate: ${(funnel.sweeps?(funnel.filled/funnel.sweeps*100).toFixed(0):0)}%`)
  );
  console.log(
    chalk.gray('  Wins: ')   + chalk.green(wins.length) +
    chalk.gray('  Losses: ') + chalk.red(losses.length) +
    chalk.gray('  WR: ')     + (wr>=60?chalk.bold.green:wr>=50?chalk.yellow:chalk.red)(wr+'%') +
    chalk.gray('  Net R: ')  + (totalR>=0?chalk.green(`+${totalR}R`):chalk.red(`${totalR}R`)) +
    chalk.gray('  PF: ')     + chalk.cyan(pf)
  );
  console.log(
    chalk.gray('  Start: £1,500') +
    chalk.gray('  End: ') + (balance>=ACCOUNT_START?chalk.green:chalk.red)('£'+balance.toFixed(2)) +
    chalk.gray('  Return: ') + (balance>=ACCOUNT_START?chalk.green:chalk.yellow)(fmtPct((balance-ACCOUNT_START)/ACCOUNT_START*100)) +
    chalk.gray('  MaxDD: ') + chalk.yellow(maxDD.toFixed(1)+'%')
  );

  if (closed.length) {
    // KZ breakdown
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

    // Direction
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
      if (!qs.length) { console.log(chalk.gray(`    ${q.label.padEnd(16)} 0 trades`)); continue; }
      const qw=qs.filter(s=>s.pnlR>0).length, ql=qs.filter(s=>s.pnlR<0).length;
      const qr=+qs.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
      cumR=+(cumR+qr).toFixed(2);
      const qwr=(qw+ql)?Math.round(qw/(qw+ql)*100):0;
      console.log(chalk.gray(`    ${q.label.padEnd(16)} `)+
        chalk.cyan(`${qs.length}tr  `)+
        chalk.green(`${qw}W`)+'/'+chalk.red(`${ql}L`)+
        chalk.gray(`  ${qwr}%  `)+(qr>=0?chalk.green(`+${qr}R`):chalk.red(`${qr}R`))+
        chalk.gray(` cumul:`)+(cumR>=0?chalk.green(`+${cumR}R`):chalk.red(`${cumR}R`)));
    }

    // Month
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

    // Sample trades
    console.log(chalk.gray('\n  Sample trades (most recent 8):'));
    const sample = closed.slice(-8);
    for (const t of sample) {
      const icon = t.pnlR > 0 ? chalk.green('✓') : chalk.red('✗');
      const r    = t.pnlR > 0 ? chalk.green(`+${t.pnlR}R`) : chalk.red(`${t.pnlR}R`);
      console.log(
        chalk.gray(`    ${t.date} ${t.kz.padEnd(7)} `) +
        (t.dir==='BUY'?chalk.green('▲ BUY '):chalk.red('▼ SELL')) +
        chalk.gray(` ${t.sweep.padEnd(10)} entry:${t.entry} `) +
        chalk.gray(`SL:${t.sl} TP:${t.tp2} `) +
        chalk.gray(`(${t.tpPips||'?'}p target) `) +
        icon + ' ' + r
      );
    }
  }

  // Comparison
  console.log('\n' + sep);
  console.log(chalk.bold('  ══ INSTRUMENT COMPARISON ══'));
  console.log(sep);
  console.log(chalk.gray('  Instrument   Trades/yr  WR     Net R    Return   MaxDD  Notes'));
  console.log(chalk.gray('  ' + '─'.repeat(68)));

  function row(name, trades, wr_, netR, ret, dd, note, hl) {
    const l = `  ${name.padEnd(13)}${String(trades).padEnd(11)}${String(wr_+'%').padEnd(7)}${netR.padEnd(9)}${String(ret+'%').padEnd(9)}${String(dd+'%').padEnd(7)}${note}`;
    return hl ? chalk.bold.green(l) : chalk.gray(l);
  }
  const gbpNetR = (totalR>=0?'+':'')+totalR+'R';
  const gbpRet  = ((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1);
  console.log(row('GBPUSD v3', closed.length, wr, gbpNetR, (balance>=ACCOUNT_START?'+':'')+gbpRet, maxDD.toFixed(1), '← 2022 model', true));
  console.log(row('GBPUSD v2', 36, 47, '+13.3R', '+28.1', '12.5', 'loose params'));
  console.log(row('DJ30',      34, 79, '+52.5R', '+67.9', '~5',   '3-month ann.'));
  console.log(row('XAUUSD',    21, 71, '+9.0R',  '+19.2', '4.0',  'sell-only'));
  console.log(sep + '\n');

  fs.writeFileSync(
    path.join(__dirname, '..', 'backtest_report_gbpusd_v3.json'),
    JSON.stringify({
      instrument:'GBPUSD', version:'v3-2022-model',
      period:'2025-06-11_2026-06-10',
      trades:closed.length, wr, totalR,
      balance:+balance.toFixed(2),
      returnPct:+((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1),
      maxDD:+maxDD.toFixed(1),
      signals:allSignals,
    }, null, 2)
  );
  console.log(chalk.gray('  Report → backtest_report_gbpusd_v3.json\n'));
}

run();
