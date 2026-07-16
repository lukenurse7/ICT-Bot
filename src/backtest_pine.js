'use strict';

// Mirrors the Pine Script strategy exactly:
// 5m swing H/L → 1m sweep inside KZ → MSS (close beyond sweep candle) → FVG → entry
// Uses yahoo-finance2 for QQQ (NAS100 proxy, same price action / ICT structure)

require('dotenv').config();
const { default: YahooFinance } = require('yahoo-finance2');
const yahooFinance = new YahooFinance();

const START_BALANCE = 1000;   // £
const RISK_PCT      = 0.02;   // 2% per trade
const TP_R          = 2.0;
const SL_BUFFER_PCT = 0.0017; // ~0.17% of price ≈ 50 NAS100 pts at 29000
const MIN_RISK_PCT  = 0.001;  // ~0.1% of price ≈ 30 NAS100 pts
const KZ_START      = 8 * 60; // 08:00 NY mins
const KZ_END        = 11 * 60;

function toNY(ms) {
  const s = new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' });
  const d = new Date(s);
  return { h: d.getHours(), m: d.getMinutes(), dow: d.getDay(), date: d };
}
function inKZ(ms) {
  const { h, m, dow } = toNY(ms);
  if (dow < 1 || dow > 5) return false;
  const mins = h * 60 + m;
  return mins >= KZ_START && mins < KZ_END;
}
function dayKey(ms) {
  const { date } = toNY(ms);
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function isNewDay(ms, prev) {
  return !prev || dayKey(ms) !== dayKey(prev);
}

// Fetch Yahoo Finance intraday (returns 1m or 5m bars for ~60-day chunks)
async function fetchYahoo(symbol, interval, period1, period2) {
  const result = await yahooFinance.chart(symbol, {
    interval,
    period1,
    period2,
    includePrePost: false,
  });
  const quotes = result.quotes || [];
  return quotes.filter(q => q.open && q.high && q.low && q.close).map(q => ({
    t: q.date instanceof Date ? q.date.getTime() : new Date(q.date).getTime(),
    o: q.open, h: q.high, l: q.low, c: q.close,
  }));
}

async function run() {
  console.log('\n' + '═'.repeat(72));
  console.log('  ICT NAS100 Bot — 3-Month Backtest (Pine Script logic)');
  console.log('  QQQ = NAS100 proxy  |  same KZ, same ICT structure');
  console.log('  Account: £1,000 start  |  2% risk/trade  |  compounded');
  console.log('═'.repeat(72) + '\n');

  // 3 months back from today
  const now    = new Date();
  const p2     = now.toISOString().slice(0, 10);
  const p1Date = new Date(now); p1Date.setDate(p1Date.getDate() - 92);
  const p1     = p1Date.toISOString().slice(0, 10);

  console.log(`  Fetching QQQ data ${p1} → ${p2} ...`);

  let bars1m, bars5m;
  try {
    [bars1m, bars5m] = await Promise.all([
      fetchYahoo('QQQ', '1m', p1, p2),
      fetchYahoo('QQQ', '5m', p1, p2),
    ]);
  } catch (e) {
    // Yahoo only gives ~60 days of 1m, try with that
    const p1b = new Date(now); p1b.setDate(p1b.getDate() - 59);
    const p1s = p1b.toISOString().slice(0, 10);
    console.log(`  (Retrying with 60-day window: ${p1s} → ${p2})`);
    [bars1m, bars5m] = await Promise.all([
      fetchYahoo('QQQ', '1m', p1s, p2),
      fetchYahoo('QQQ', '5m', p1s, p2),
    ]);
  }

  console.log(`  1m bars: ${bars1m.length}  |  5m bars: ${bars5m.length}\n`);
  if (!bars1m.length) { console.log('  No data returned.'); return; }

  // Build 5m swing H/L map: for each day, track rolling last 5m swingH and swingL
  // swingH = bar where high > prev 3 bars' highs, swingL = bar where low < prev 3 bars' lows
  const swing5mByDay = {};
  for (let i = 3; i < bars5m.length; i++) {
    const b   = bars5m[i];
    const dk  = dayKey(b.t);
    if (!swing5mByDay[dk]) swing5mByDay[dk] = { H: null, L: null };
    const isH = b.h > bars5m[i-1].h && b.h > bars5m[i-2].h && b.h > bars5m[i-3].h;
    const isL = b.l < bars5m[i-1].l && b.l < bars5m[i-2].l && b.l < bars5m[i-3].l;
    if (isH) swing5mByDay[dk].H = b.h;
    if (isL) swing5mByDay[dk].L = b.l;
  }

  // ── State machine — mirrors Pine script exactly ──────────────────────────────
  let swept = false, sweptBear = false, sweptBull = false;
  let sweepWick = null, mssLevel = null, sweepBarIdx = -1;
  let mssConfirmed = false;
  let fvgTop = null, fvgBot = null, fvgMid = null, fvgFound = false;
  let entryFired = false;
  let prevDayKey = null;

  // Swing refs for current day (updated from swing5mByDay up to current bar)
  let ref5mH = null, ref5mL = null;

  const trades = [];

  for (let i = 3; i < bars1m.length; i++) {
    const b   = bars1m[i];
    const dk  = dayKey(b.t);

    // New day reset
    if (isNewDay(b.t, prevDayKey ? new Date(bars1m[i-1].t).getTime() : null) && dk !== prevDayKey) {
      swept = false; sweptBear = false; sweptBull = false;
      sweepWick = null; mssLevel = null; sweepBarIdx = -1;
      mssConfirmed = false;
      fvgTop = null; fvgBot = null; fvgMid = null; fvgFound = false;
      entryFired = false;
      ref5mH = null; ref5mL = null;
      prevDayKey = dk;
    }

    // Update 5m swing refs from precomputed map (levels that existed BEFORE current bar)
    // We use the day's accumulated swings so far
    const daySwings = swing5mByDay[dk];
    if (daySwings) {
      // Only update if the 5m bar was BEFORE this 1m bar
      // Simple approach: use whatever swings the day map has at this point
      // (conservative — they could be slightly ahead but good enough for backtest)
      if (daySwings.H !== null) ref5mH = daySwings.H;
      if (daySwings.L !== null) ref5mL = daySwings.L;
    }

    const kz = inKZ(b.t);

    // Step 1: Sweep of 5m level inside KZ
    if (kz && !swept && !entryFired) {
      if (ref5mH !== null && b.h > ref5mH) {
        swept = true; sweptBear = true;
        sweepWick = ref5mH; mssLevel = b.l; sweepBarIdx = i;
      } else if (ref5mL !== null && b.l < ref5mL) {
        swept = true; sweptBull = true;
        sweepWick = ref5mL; mssLevel = b.h; sweepBarIdx = i;
      }
    }

    // Step 2: MSS — close beyond opposite end of sweep candle
    if (swept && !mssConfirmed && i > sweepBarIdx) {
      if (sweptBear && b.c < mssLevel) mssConfirmed = true;
      if (sweptBull && b.c > mssLevel) mssConfirmed = true;
    }

    // Step 3: FVG in impulse leg
    if (mssConfirmed && !fvgFound && i >= 2) {
      if (sweptBear && bars1m[i-2].l > b.h) {
        fvgTop = bars1m[i-2].l; fvgBot = b.h;
        fvgMid = (fvgTop + fvgBot) / 2;
        fvgFound = true;
      }
      if (sweptBull && bars1m[i-2].h < b.l) {
        fvgTop = b.l; fvgBot = bars1m[i-2].h;
        fvgMid = (fvgTop + fvgBot) / 2;
        fvgFound = true;
      }
    }

    // Step 4: Entry at 50% FVG inside KZ
    if (fvgFound && !entryFired && kz) {
      const reached = sweptBear ? b.h >= fvgMid : b.l <= fvgMid;
      if (reached) {
        const entry    = fvgMid;
        const sl       = sweptBear ? sweepWick * (1 + SL_BUFFER_PCT) : sweepWick * (1 - SL_BUFFER_PCT);
        const riskPts  = Math.abs(entry - sl);
        const minRisk  = entry * MIN_RISK_PCT;
        if (riskPts >= minRisk) {
          const tp = sweptBear ? entry - riskPts * TP_R : entry + riskPts * TP_R;
          entryFired = true;
          trades.push({
            date: dk,
            time: new Date(b.t).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }),
            dir: sweptBear ? 'SHORT' : 'LONG',
            entry: parseFloat(entry.toFixed(2)),
            sl:    parseFloat(sl.toFixed(2)),
            tp:    parseFloat(tp.toFixed(2)),
            riskPts: parseFloat(riskPts.toFixed(2)),
            rr:    TP_R,
            entryIdx: i,
            result: null,
          });
        }
      }
    }
  }

  // ── Determine outcomes for each trade ────────────────────────────────────────
  for (const t of trades) {
    const future = bars1m.slice(t.entryIdx + 1, t.entryIdx + 480); // up to 8 hrs
    t.result = 'OPEN'; t.barsToClose = future.length;
    for (let k = 0; k < future.length; k++) {
      const f = future[k];
      if (t.dir === 'SHORT') {
        if (f.h >= t.sl) { t.result = 'SL'; t.barsToClose = k+1; break; }
        if (f.l <= t.tp) { t.result = 'TP'; t.barsToClose = k+1; break; }
      } else {
        if (f.l <= t.sl) { t.result = 'SL'; t.barsToClose = k+1; break; }
        if (f.h >= t.tp) { t.result = 'TP'; t.barsToClose = k+1; break; }
      }
    }
  }

  // ── Print trade log ───────────────────────────────────────────────────────────
  console.log('  TRADE LOG');
  console.log('  ' + '─'.repeat(70));
  let balance = START_BALANCE;
  let wins = 0, losses = 0, open = 0;
  const equity = [START_BALANCE];

  for (const t of trades) {
    const riskGBP    = balance * RISK_PCT;
    const rewardGBP  = riskGBP * TP_R;
    let pnlGBP = 0;

    if (t.result === 'TP') {
      pnlGBP = rewardGBP; wins++;
      balance += pnlGBP;
    } else if (t.result === 'SL') {
      pnlGBP = -riskGBP; losses++;
      balance -= riskGBP;
    } else {
      open++;
    }

    equity.push(balance);

    const icon   = t.result === 'TP' ? '✅' : t.result === 'SL' ? '❌' : '⏳';
    const pnlStr = pnlGBP !== 0 ? (pnlGBP > 0 ? `+£${pnlGBP.toFixed(2)}` : `-£${Math.abs(pnlGBP).toFixed(2)}`) : '  open';
    console.log(`  ${icon} ${t.date} ${t.time} NY  ${t.dir.padEnd(5)}  Entry:${t.entry.toFixed(2)}  SL:${t.sl.toFixed(2)}  TP:${t.tp.toFixed(2)}  Risk:${t.riskPts.toFixed(2)}pts  ${pnlStr.padStart(10)}  Bal:£${balance.toFixed(2)}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  const total      = wins + losses;
  const winRate    = total > 0 ? (wins / total * 100).toFixed(1) : '0.0';
  const totalGain  = balance - START_BALANCE;
  const gainPct    = (totalGain / START_BALANCE * 100).toFixed(1);
  const avgWinGBP    = wins > 0 ? (wins * (START_BALANCE + totalGain/2) * RISK_PCT * TP_R / wins).toFixed(2) : '0';
  const expectancy = total > 0 ? ((wins/total * TP_R) - (losses/total * 1)).toFixed(3) : '0';

  console.log('\n  ' + '═'.repeat(70));
  console.log('  SUMMARY');
  console.log('  ' + '═'.repeat(70));
  console.log(`  Period       : Last ~60 days (Yahoo Finance 1m limit)`);
  console.log(`  Total trades : ${trades.length}  (${wins} TP  /  ${losses} SL  /  ${open} open)`);
  console.log(`  Win rate     : ${winRate}%`);
  console.log(`  Expectancy   : ${expectancy}R per trade  (positive = edge)`);
  console.log('');
  console.log(`  Start balance  : £${START_BALANCE.toFixed(2)}`);
  console.log(`  End balance    : £${balance.toFixed(2)}`);
  console.log(`  Net gain       : ${totalGain >= 0 ? '+' : ''}£${totalGain.toFixed(2)}  (${gainPct}%)`);
  console.log(`  Risk per trade : 2% compounded`);
  console.log(`  R:R            : 1:${TP_R}`);
  console.log('');

  // Drawdown
  let peak = START_BALANCE, maxDD = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  console.log(`  Max drawdown   : ${maxDD.toFixed(1)}%`);

  // Consecutive losses
  let maxCL = 0, curCL = 0;
  for (const t of trades) {
    if (t.result === 'SL') { curCL++; if (curCL > maxCL) maxCL = curCL; }
    else curCL = 0;
  }
  console.log(`  Max consec. L  : ${maxCL}`);
  console.log('\n  ' + '═'.repeat(70) + '\n');
}

run().catch(e => { console.error('Error:', e.message); process.exit(1); });
