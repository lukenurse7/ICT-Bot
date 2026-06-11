'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  DJ30 ICT — BACKTEST v2  (MSS-entry, 2% compounding, £1,500 start)
//
//  New strategy vs old:
//    OLD: KZ + Sweep + MSS + FVG confirmation candle → limit at FVG midpoint
//    NEW: KZ + Fresh Sweep (≤6 bars) + MSS → enter at MSS bar close
//
//  Entry: close of MSS confirmation bar (market execution at signal fire)
//  SL:    sweep level + 0.12% buffer
//  TP1:   1.5R
//  TP2:   2.5R min → 1H swing level
//  TP3:   4.0R min → PDH/PDL or further 1H swing
//  Risk:  2% of current balance (compounds every trade)
//  Start: £1,500
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const axios = require('axios');
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const KEY    = process.env.TWELVEDATA_API_KEY;
const BASE   = 'https://api.twelvedata.com';
const SYMBOL = 'DIA';   // DJ30 proxy (free tier)

const ACCOUNT_START = 1500;
const RISK_PCT      = 0.02;
const TP1_R         = 1.5;
const SIM_BARS      = 288;
const MIN_SCORE     = 80;
const COOLDOWN      = 36;    // 3h in 5m bars
const FRESH_BARS    = 6;     // sweep must be within last 6 bars

function fmt(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }
function fmtDT(iso) { const d = new Date(iso); return `${fmt(d)} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`; }
function fmtGBP(n) { return '£' + n.toFixed(2); }

function threeMonthRange() {
  const now = new Date();
  const day = now.getUTCDay();
  const daysToLastFri = day === 0 ? 1 : (day >= 6 ? day - 5 : day + 2);
  const end = new Date(now);
  end.setUTCDate(now.getUTCDate() - daysToLastFri);
  end.setUTCHours(23, 59, 59, 0);
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - 3);
  start.setUTCHours(0, 0, 0, 0);
  return { start, end, label: `${fmt(start)} → ${fmt(end)}` };
}

const CACHE_DIR = path.join(__dirname, '..', '.cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);
const wait = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(params, label) {
  const cacheFile = path.join(CACHE_DIR, `dj30_${label}.json`);
  if (fs.existsSync(cacheFile)) {
    process.stdout.write(chalk.gray(` (cached)\n`));
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      const delay = [30000,60000,90000,120000][attempt-1]||120000;
      process.stdout.write(chalk.yellow(` retry in ${delay/1000}s...\n`));
      await wait(delay);
    }
    try {
      const r = await axios.get(`${BASE}/time_series`, {
        params: { ...params, apikey: KEY, format: 'JSON', timezone: 'UTC' }, timeout: 25000
      });
      if (r.data.status === 'error') throw new Error(`TwelveData: ${r.data.message}`);
      if (!r.data.values?.length) throw new Error('No data');
      const candles = r.data.values.reverse().map(c => ({
        time: c.datetime, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +(c.volume||0)
      }));
      fs.writeFileSync(cacheFile, JSON.stringify(candles));
      process.stdout.write(chalk.green(` ✓ ${candles.length} bars\n`));
      return candles;
    } catch(e) {
      if (e.response?.status===429||e.message.includes('429')) { lastErr=e; continue; }
      throw e;
    }
  }
  throw lastErr || new Error('Max retries');
}

async function fetchChunked(interval, outputsize, months) {
  const now = new Date(), all = [];
  for (let m = months-1; m >= 0; m--) {
    const ed = new Date(now); ed.setUTCMonth(now.getUTCMonth()-m); ed.setUTCDate(1); ed.setUTCHours(0,0,0,0);
    const sd = new Date(ed); sd.setUTCMonth(sd.getUTCMonth()-1);
    const label = `${interval}_${fmt(sd)}_${fmt(ed)}`;
    process.stdout.write(chalk.gray(`  ${interval} ${fmt(sd)}...`));
    try {
      all.push(...await fetchWithRetry({ symbol:SYMBOL,interval,outputsize,start_date:`${fmt(sd)} 00:00:00`,end_date:`${fmt(ed)} 23:59:59` }, label));
      await wait(8000);
    } catch(e) { process.stdout.write(chalk.yellow(` skip: ${e.message.slice(0,40)}\n`)); }
  }
  const seen = new Set();
  return all.filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;}).sort((a,b)=>new Date(a.time)-new Date(b.time));
}

function rollup(src, factor) {
  const out=[];
  for(let i=0;i<src.length;i+=factor){
    const s=src.slice(i,i+factor);if(!s.length)continue;
    out.push({time:s[0].time,open:s[0].open,high:Math.max(...s.map(c=>c.high)),low:Math.min(...s.map(c=>c.low)),close:s[s.length-1].close,volume:s.reduce((a,c)=>a+c.volume,0)});
  }
  return out;
}

// ─── ICT logic (mirrors new ict.js exactly) ──────────────────────────────────

function detectSweep(c15m, c5m) {
  const recent15 = c15m.slice(-50), levels = [];
  for (let i=2;i<recent15.length-1;i++) {
    const c=recent15[i], prev=recent15.slice(Math.max(0,i-10),i);
    const eqH=prev.find(p=>Math.abs(p.high-c.high)/c.high<0.0005);
    if(eqH) levels.push({price:Math.max(c.high,eqH.high),type:'BSL',name:'Equal Highs (BSL)'});
    const eqL=prev.find(p=>Math.abs(p.low-c.low)/c.low<0.0005);
    if(eqL) levels.push({price:Math.min(c.low,eqL.low),type:'SSL',name:'Equal Lows (SSL)'});
  }
  const yday=c15m.slice(-100).filter(c=>{const h=new Date(c.time).getUTCHours();return h>=21||h<2;});
  if(yday.length){
    levels.push({price:Math.max(...yday.map(c=>c.high)),type:'BSL',name:'Prev Day High'});
    levels.push({price:Math.min(...yday.map(c=>c.low)), type:'SSL',name:'Prev Day Low'});
  }
  const results=[];
  for(let back=0;back<=FRESH_BARS;back++){
    const idx=c5m.length-1-back; if(idx<0) break;
    const c=c5m[idx];
    for(const lvl of levels){
      if(lvl.type==='BSL'&&c.high>lvl.price&&c.close<lvl.price) results.push({dir:'bear',level:lvl.price,levelName:lvl.name,barsAgo:back});
      if(lvl.type==='SSL'&&c.low<lvl.price&&c.close>lvl.price)  results.push({dir:'bull',level:lvl.price,levelName:lvl.name,barsAgo:back});
    }
  }
  if(!results.length) return {detected:false};
  results.sort((a,b)=>a.barsAgo-b.barsAgo);
  return {detected:true,...results[0]};
}

function detectMSS(c5m, sweepDir) {
  const w=c5m.slice(-20); if(w.length<5) return {confirmed:false};
  const last=w[w.length-1], prev=w[w.length-2];
  if(sweepDir==='bear'){
    let swLow=Infinity;
    for(let i=0;i<w.length-3;i++){const c=w[i];if(c.low<(w[i-1]?.low??Infinity)&&c.low<(w[i+1]?.low??Infinity))swLow=Math.min(swLow,c.low);}
    if(swLow<Infinity&&last.close<swLow) return {confirmed:true,type:'BOS_DOWN',level:swLow,entryClose:last.close};
    if(last.close<prev.low)             return {confirmed:true,type:'CHoCH',   level:prev.low,entryClose:last.close};
  }
  if(sweepDir==='bull'){
    let swHigh=-Infinity;
    for(let i=0;i<w.length-3;i++){const c=w[i];if(c.high>(w[i-1]?.high??-Infinity)&&c.high>(w[i+1]?.high??-Infinity))swHigh=Math.max(swHigh,c.high);}
    if(swHigh>-Infinity&&last.close>swHigh) return {confirmed:true,type:'BOS_UP',level:swHigh,entryClose:last.close};
    if(last.close>prev.high)                return {confirmed:true,type:'CHoCH', level:prev.high,entryClose:last.close};
  }
  return {confirmed:false};
}

function calcTPs(dir, entry, risk, h1Candles, c15m) {
  const isLong=dir==='bull';
  function rOf(p){return Math.abs(p-entry)/risk;}
  const c1h=h1Candles.slice(-48), h1L=[];
  for(let i=2;i<c1h.length-2;i++){
    const c=c1h[i];
    if(isLong&&c.high>c1h[i-1].high&&c.high>c1h[i-2].high&&c.high>c1h[i+1].high) h1L.push({price:c.high,source:'1H swing high'});
    if(!isLong&&c.low<c1h[i-1].low&&c.low<c1h[i-2].low&&c.low<c1h[i+1].low)      h1L.push({price:c.low, source:'1H swing low'});
  }
  const yday=c15m.slice(-100).filter(c=>{const h=new Date(c.time).getUTCHours();return h>=21||h<2;});
  const pdh=yday.length?Math.max(...yday.map(c=>c.high)):null;
  const pdl=yday.length?Math.min(...yday.map(c=>c.low)):null;

  // TP2: 1H swing 2.5–8R
  const tp2C=h1L.filter(l=>{const r=rOf(l.price);return r>=2.5&&r<=8&&(isLong?l.price>entry:l.price<entry);}).sort((a,b)=>Math.abs(a.price-entry)-Math.abs(b.price-entry));
  const tp2Obj=tp2C[0];
  const tp2=tp2Obj?tp2Obj.price:(isLong?entry+risk*2.5:entry-risk*2.5);
  const tp2Desc=tp2Obj?tp2Obj.source:'Fixed 2.5R';
  const tp2R=rOf(tp2);

  // TP3: PDH/PDL first, then 1H swings beyond TP2
  const tp3C=[];
  if(isLong&&pdh&&rOf(pdh)>tp2R&&rOf(pdh)<=12) tp3C.push({price:pdh,source:'Prev Day High'});
  if(!isLong&&pdl&&rOf(pdl)>tp2R&&rOf(pdl)<=12) tp3C.push({price:pdl,source:'Prev Day Low'});
  for(const l of h1L){const r=rOf(l.price);if(r>=4&&r>tp2R+0.5&&r<=12&&(isLong?l.price>tp2:l.price<tp2))tp3C.push(l);}
  tp3C.sort((a,b)=>Math.abs(a.price-entry)-Math.abs(b.price-entry));
  const tp3Obj=tp3C[0];
  const tp3=tp3Obj?tp3Obj.price:(isLong?entry+risk*5:entry-risk*5);
  const tp3Desc=tp3Obj?tp3Obj.source:'Fixed 5R';

  return {tp2:parseFloat(tp2.toFixed(2)),tp2Desc,tp3:parseFloat(tp3.toFixed(2)),tp3Desc};
}

function scoreConf(sweep, mss, bias, dir) {
  let score=30; const tags=['KZ'];
  if(sweep.detected){score+=35;tags.push('SWEEP');}
  if(mss.confirmed) {score+=35;tags.push('MSS');}
  const aligned=dir&&((dir==='bull'&&(bias==='bullish'||bias==='pullback_in_bear'))||(dir==='bear'&&(bias==='bearish'||bias==='pullback_in_bull')));
  if(aligned){score=Math.min(score+10,100);tags.push('HTF_ALIGNED');}
  const grade=score>=90?'A+':score>=80?'A':score>=70?'B':score>=60?'C':'D';
  return {score,grade,tags};
}

function simulateOutcome(dir, entry, sl, tp1, tp2, tp3, future) {
  let tp1Hit=false, cSL=sl;
  for(const c of future){
    const slHit  =dir==='bull'?c.low<=cSL:c.high>=cSL;
    const tp1Hit_=dir==='bull'?c.high>=tp1:c.low<=tp1;
    const tp2Hit =dir==='bull'?c.high>=tp2:c.low<=tp2;
    const tp3Hit =dir==='bull'?c.high>=tp3:c.low<=tp3;
    if(!tp1Hit){
      if(slHit)   return {result:'LOSS',      pnlR:-1};
      if(tp3Hit)  return {result:'WIN_TP3',   pnlR:0.5*TP1_R+0.25*2.5+0.25*5};
      if(tp2Hit)  return {result:'WIN_TP2',   pnlR:0.5*TP1_R+0.5*2.5};
      if(tp1Hit_) {tp1Hit=true;cSL=entry;}
    } else {
      if(slHit)   return {result:'WIN_TP1_BE',pnlR:0.5*TP1_R};
      if(tp3Hit)  return {result:'WIN_TP3',   pnlR:0.5*TP1_R+0.25*2.5+0.25*5};
      if(tp2Hit)  return {result:'WIN_TP2',   pnlR:0.5*TP1_R+0.5*2.5};
    }
  }
  if(tp1Hit) return {result:'WIN_TP1_OPEN',pnlR:0.5*TP1_R};
  return {result:'OPEN',pnlR:null};
}

function isKZ(iso) { const h=new Date(iso).getUTCHours(); return (h>=7&&h<9)||(h>=12&&h<15); }
function sessLabel(iso) { const h=new Date(iso).getUTCHours(); return h>=7&&h<9?'🟡 London KZ':h>=12&&h<15?'🟢 NY KZ':'Off'; }

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  console.clear();
  console.log('\n'+chalk.bold.cyan('  ◆ DJ30 ICT v2 — 3 MONTH BACKTEST  [MSS entry · 2% compounding]'));
  console.log(chalk.gray('  Entry: MSS bar close  |  Fresh sweep ≤6 bars  |  No FVG gate  |  2% risk  |  £1,500\n'));

  const range = threeMonthRange();
  console.log(chalk.gray(`  Period: ${range.label}\n`));

  const all5m  = await fetchChunked('5min',4500,4); await wait(15000);
  const all15m = await fetchChunked('15min',1500,4); await wait(15000);
  const allH1  = await fetchChunked('1h',750,4); await wait(15000);

  process.stdout.write(chalk.gray('  4H candles...'));
  const allH4 = await fetchWithRetry({symbol:SYMBOL,interval:'4h',outputsize:200},'4h_3m').catch(()=>{process.stdout.write(chalk.yellow(' rollup\n'));return rollup(allH1,4);});
  await wait(10000);

  process.stdout.write(chalk.gray('  Daily candles...'));
  const allDaily = await fetchWithRetry({symbol:SYMBOL,interval:'1day',outputsize:90},'1day_3m').catch(()=>{process.stdout.write(chalk.yellow(' rollup\n'));return rollup(allH1,24);});

  console.log(chalk.green('\n  ✓ Data ready'));

  const period5m = all5m.filter(c=>{const t=new Date(c.time);return t>=range.start&&t<=range.end;});
  console.log(chalk.gray(`  5m bars in range: ${period5m.length}\n`));
  if(!period5m.length){console.log(chalk.red('  No data.'));return;}

  const signals=[];
  let lastBar=-999, balance=ACCOUNT_START, peakBalance=ACCOUNT_START, maxDrawdown=0;

  // Simple HTF bias
  function htfBiasCalc(daily,h4){
    function sw(arr){const highs=[],lows=[];for(let i=2;i<arr.length-2;i++){const c=arr[i];if(c.high>arr[i-1].high&&c.high>arr[i-2].high&&c.high>arr[i+1].high&&c.high>arr[i+2].high)highs.push(c.high);if(c.low<arr[i-1].low&&c.low<arr[i-2].low&&c.low<arr[i+1].low&&c.low<arr[i+2].low)lows.push(c.low);}return{highs,lows};}
    function b({highs,lows}){if(highs.length<2||lows.length<2)return'ranging';const hh=highs[highs.length-1]>highs[highs.length-2],hl=lows[lows.length-1]>lows[lows.length-2],lh=highs[highs.length-1]<highs[highs.length-2],ll=lows[lows.length-1]<lows[lows.length-2];if(hh&&hl)return'bullish';if(lh&&ll)return'bearish';return'ranging';}
    const d=b(sw(daily)),h=b(sw(h4));
    if(d==='bullish'&&h==='bullish')return'bullish';if(d==='bearish'&&h==='bearish')return'bearish';
    if(d==='bullish'&&h==='bearish')return'pullback_in_bull';if(d==='bearish'&&h==='bullish')return'pullback_in_bear';return'ranging';
  }

  for(let i=50;i<period5m.length-1;i++){
    const bar=period5m[i];
    if(i-lastBar<COOLDOWN) continue;
    if(!isKZ(bar.time)) continue;

    const time=new Date(bar.time);
    const slice5m =all5m.filter(c=>new Date(c.time)<=time);
    const slice15m=all15m.filter(c=>new Date(c.time)<=time);
    const sliceH1 =allH1.filter(c=>new Date(c.time)<=time);
    if(slice5m.length<40||allH4.length<6||allDaily.length<5) continue;

    let sweep,mss,conf,bias;
    try{
      bias  = htfBiasCalc(allDaily,allH4);
      sweep = detectSweep(slice15m,slice5m);
      mss   = sweep.detected?detectMSS(slice5m,sweep.dir):{confirmed:false};
      conf  = scoreConf(sweep,mss,bias,sweep.dir);
    }catch(e){continue;}

    const dir=sweep.dir;
    if(!dir||!sweep.detected||!mss.confirmed||conf.score<MIN_SCORE) continue;

    const isLong=dir==='bull';
    // Entry = MSS bar close (current bar — market execution at signal fire)
    const entry=mss.entryClose||bar.close;
    const slBuf=entry*0.0012;
    const sl=isLong?sweep.level-slBuf:sweep.level+slBuf;
    const risk=Math.abs(entry-sl);
    if(risk<=0||risk>entry*0.012) continue;

    const tp1=isLong?entry+risk*TP1_R:entry-risk*TP1_R;
    const {tp2,tp2Desc,tp3,tp3Desc}=calcTPs(dir,entry,risk,sliceH1,slice15m);

    // Simulate from NEXT bar (entry is this bar's close, fills open of next bar in live)
    const future=period5m.slice(i+1,i+SIM_BARS);
    const outcome=simulateOutcome(dir,entry,sl,tp1,tp2,tp3,future);

    const riskGBP=balance*RISK_PCT;
    const pnlGBP=outcome.pnlR!=null?outcome.pnlR*riskGBP:null;

    if(pnlGBP!==null){
      balance+=pnlGBP;
      if(balance>peakBalance)peakBalance=balance;
      const dd=((peakBalance-balance)/peakBalance)*100;
      if(dd>maxDrawdown)maxDrawdown=dd;
    }

    signals.push({
      time:bar.time, dir:isLong?'BUY':'SELL',
      entry:parseFloat(entry.toFixed(2)),
      sl:parseFloat(sl.toFixed(2)),tp1:parseFloat(tp1.toFixed(2)),
      tp2:parseFloat(tp2.toFixed(2)),tp3:parseFloat(tp3.toFixed(2)),
      tp2Desc,tp3Desc,
      risk:parseFloat(risk.toFixed(2)),
      score:conf.score,grade:conf.grade,tags:conf.tags,
      session:sessLabel(bar.time),htfBias:bias,
      sweep:sweep.levelName,mssType:mss.type,
      riskGBP:parseFloat(riskGBP.toFixed(2)),
      pnlGBP:pnlGBP!==null?parseFloat(pnlGBP.toFixed(2)):null,
      balanceAfter:pnlGBP!==null?parseFloat(balance.toFixed(2)):null,
      ...outcome
    });
    lastBar=i;
  }

  // ─── Print ────────────────────────────────────────────────────────────────
  const sep='═'.repeat(72);
  console.log('\n'+sep);
  console.log(chalk.bold.cyan('  SIGNAL REPORT — DJ30 v2 — 3 MONTHS'));
  console.log(chalk.gray(`  ${range.label}  |  MSS close entry  |  2% compounding`));
  console.log(sep);

  signals.forEach((s,idx)=>{
    const isLong=s.dir==='BUY';
    const clr=isLong?chalk.green:chalk.red;
    const oc=s.result?.startsWith('WIN')?chalk.green:s.result==='LOSS'?chalk.red:chalk.yellow;
    const pnlStr=s.pnlR!=null?(s.pnlR>0?chalk.green(`+${s.pnlR.toFixed(2)}R +£${s.pnlGBP}`):chalk.red(`${s.pnlR.toFixed(2)}R £${s.pnlGBP}`)):chalk.yellow('open');
    console.log(`\n  #${idx+1} ${chalk.gray(fmtDT(s.time))}  ${s.session}  ${clr(`${isLong?'▲':'▼'} ${s.dir}`)}  ${chalk.gray(`${s.score}% ${s.grade}  ${s.sweep} → ${s.mssType}`)}`);
    console.log(`  ${chalk.gray('Entry')} ${chalk.white(`$${s.entry}`)}  ${chalk.gray('SL')} ${chalk.red(`$${s.sl}`)}  ${chalk.gray('TP1')} ${chalk.green(`$${s.tp1}`)}  ${chalk.gray('TP2')} ${chalk.green(`$${s.tp2}`)}  ${chalk.gray('Risk')} ${s.stopPoints||Math.round(s.risk)}pts  ${chalk.gray('£'+s.riskGBP)}`);
    console.log(`  → ${oc(s.result||'OPEN')}  ${pnlStr}${s.balanceAfter?chalk.gray('  bal: ')+chalk.white(fmtGBP(s.balanceAfter)):''}`);
  });

  // ─── Summary ─────────────────────────────────────────────────────────────
  const closed=signals.filter(s=>s.pnlR!=null);
  const wins=closed.filter(s=>s.pnlR>0);
  const losses=closed.filter(s=>s.pnlR<0);
  const totalR=closed.reduce((s,x)=>s+x.pnlR,0);
  const totalGBP=closed.reduce((s,x)=>s+(x.pnlGBP||0),0);
  const wr=closed.length?((wins.length/closed.length)*100).toFixed(0):0;
  const pf=losses.length?(wins.reduce((s,x)=>s+x.pnlR,0)/Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2):'∞';

  const byMonth={};
  signals.forEach(s=>{const d=new Date(s.time);const mk=`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;byMonth[mk]=(byMonth[mk]||[]).concat(s);});

  console.log('\n\n'+sep);
  console.log(chalk.bold.cyan('  3-MONTH SUMMARY — DJ30 v2'));
  console.log(sep);
  console.log(chalk.gray('  Total signals:   ')+chalk.white(signals.length));
  console.log(chalk.gray('  Wins:            ')+chalk.green(wins.length));
  console.log(chalk.gray('  Losses:          ')+chalk.red(losses.length));
  console.log(chalk.gray('  Win rate:        ')+(parseFloat(wr)>=50?chalk.green:chalk.red)(`${wr}%`));
  console.log(chalk.gray('  Net R:           ')+(totalR>=0?chalk.green(`+${totalR.toFixed(2)}R`):chalk.red(`${totalR.toFixed(2)}R`)));
  console.log(chalk.gray('  Profit factor:   ')+chalk.cyan(pf));
  console.log('\n'+chalk.bold.cyan('  ── ACCOUNT (£1,500 · 2% compounding) ──'));
  console.log(chalk.gray('  Start:           ')+chalk.white('£1,500.00'));
  console.log(chalk.gray('  End:             ')+(balance>=ACCOUNT_START?chalk.green:chalk.red)(fmtGBP(balance)));
  console.log(chalk.gray('  Net profit:      ')+(totalGBP>=0?chalk.green(`+${fmtGBP(totalGBP)}`):chalk.red(fmtGBP(totalGBP))));
  console.log(chalk.gray('  Return:          ')+(balance>=ACCOUNT_START?chalk.green:chalk.red)(`${((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)}%`));
  console.log(chalk.gray('  Peak balance:    ')+chalk.white(fmtGBP(peakBalance)));
  console.log(chalk.gray('  Max drawdown:    ')+chalk.yellow(`${maxDrawdown.toFixed(1)}%`));

  console.log(chalk.gray('\n  Month by month:'));
  Object.entries(byMonth).sort().forEach(([mo,sigs])=>{
    const mW=sigs.filter(s=>s.pnlR>0).length,mL=sigs.filter(s=>s.pnlR<0).length;
    const mR=sigs.reduce((s,x)=>s+(x.pnlR||0),0),mGBP=sigs.reduce((s,x)=>s+(x.pnlGBP||0),0);
    const mWR=(mW+mL)>0?Math.round(mW/(mW+mL)*100):0;
    console.log(chalk.gray(`    ${mo}  `)+chalk.white(`${sigs.length} signals`)+chalk.gray('  ')+chalk.green(`${mW}W`)+chalk.gray('/')+chalk.red(`${mL}L`)+chalk.gray(`  ${mWR}% WR  `)+(mR>=0?chalk.green(`+${mR.toFixed(1)}R`):chalk.red(`${mR.toFixed(1)}R`))+chalk.gray('  ')+(mGBP>=0?chalk.green(`+${fmtGBP(mGBP)}`):chalk.red(fmtGBP(mGBP))));
  });

  console.log(chalk.gray('\n  Session breakdown:'));
  const bySess={};
  signals.forEach(s=>{bySess[s.session]=(bySess[s.session]||[]).concat(s);});
  Object.entries(bySess).sort((a,b)=>b[1].length-a[1].length).forEach(([sess,sigs])=>{
    const sW=sigs.filter(s=>s.pnlR>0).length,sL=sigs.filter(s=>s.pnlR<0).length;
    const sWR=(sW+sL)>0?Math.round(sW/(sW+sL)*100):0;
    const sGBP=sigs.reduce((s,x)=>s+(x.pnlGBP||0),0);
    console.log(chalk.gray(`    ${sess.padEnd(16)} ${sigs.length} signals  `)+chalk.green(`${sW}W`)+chalk.gray('/')+chalk.red(`${sL}L`)+chalk.gray(`  ${sWR}% WR  `)+(sGBP>=0?chalk.green(`+${fmtGBP(sGBP)}`):chalk.red(fmtGBP(sGBP))));
  });

  console.log(chalk.gray('\n  Result breakdown:'));
  const byRes={};signals.forEach(s=>{byRes[s.result]=(byRes[s.result]||0)+1;});
  Object.entries(byRes).sort((a,b)=>b[1]-a[1]).forEach(([r,n])=>{
    const c=r?.startsWith('WIN')?chalk.green:r==='LOSS'?chalk.red:chalk.yellow;
    console.log(chalk.gray(`    ${c((r||'?').padEnd(14))}  ${n} trades`));
  });

  const reportPath=path.join(__dirname,'..','backtest_report_dj30_v2.json');
  fs.writeFileSync(reportPath,JSON.stringify({
    period:range.label,generatedAt:new Date().toISOString(),
    settings:{symbol:'DJ30/DIA',entryMethod:'mss_bar_close',freshSweepBars:FRESH_BARS,startBalance:ACCOUNT_START,riskPct:RISK_PCT*100,compounding:true},
    account:{start:ACCOUNT_START,end:parseFloat(balance.toFixed(2)),netGBP:parseFloat(totalGBP.toFixed(2)),returnPct:parseFloat(((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)),peakBalance:parseFloat(peakBalance.toFixed(2)),maxDrawdown:parseFloat(maxDrawdown.toFixed(1))},
    stats:{total:signals.length,wins:wins.length,losses:losses.length,winRate:wr+'%',netR:totalR.toFixed(2),profitFactor:pf},
    signals
  },null,2));
  console.log(chalk.gray('\n  Report → backtest_report_dj30_v2.json'));
  console.log('\n'+sep+'\n');
}

run().catch(e=>{console.log(chalk.red(`\n  ✗ ${e.message}\n`));process.exit(1);});
