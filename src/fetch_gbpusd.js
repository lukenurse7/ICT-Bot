'use strict';

// Fetches 1 year of GBPUSD 5m + 1H candles from TwelveData and caches them.
// Run once: node src/fetch_gbpusd.js

require('dotenv').config();
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const KEY    = process.env.TWELVEDATA_API_KEY;
const BASE   = 'https://api.twelvedata.com';
const SYMBOL = 'GBP/USD';
const CACHE  = path.join(__dirname, '..', '.cache');

if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function norm(raw) {
  return raw.reverse().map(c => ({
    time:  c.datetime,
    open:  parseFloat(c.open),
    high:  parseFloat(c.high),
    low:   parseFloat(c.low),
    close: parseFloat(c.close)
  }));
}

async function fetchChunk(interval, startDate, endDate) {
  const cacheFile = path.join(CACHE, `gbp_${interval}_${startDate}_${endDate}.json`);
  if (fs.existsSync(cacheFile)) {
    process.stdout.write('(cached) ');
    return JSON.parse(fs.readFileSync(cacheFile));
  }

  const r = await axios.get(`${BASE}/time_series`, {
    params: {
      symbol:     SYMBOL,
      interval,
      start_date: startDate,
      end_date:   endDate,
      outputsize: 5000,
      apikey:     KEY,
      format:     'JSON',
      timezone:   'UTC'
    },
    timeout: 30000
  });

  if (r.data.status === 'error') throw new Error(`TwelveData: ${r.data.message}`);
  if (!r.data.values?.length) { console.log('  No data for', startDate, '→', endDate); return []; }

  const candles = norm(r.data.values);
  fs.writeFileSync(cacheFile, JSON.stringify(candles));
  return candles;
}

async function run() {
  if (!KEY || KEY === 'your_key_here') {
    console.error('Set TWELVEDATA_API_KEY in .env');
    process.exit(1);
  }

  console.log('Fetching GBPUSD data — 1 year (Jun 2025 → Jun 2026)');
  console.log('Symbol:', SYMBOL, '| Intervals: 5min, 1h\n');

  // Monthly chunks: Jun 2025 → Jun 2026
  const months = [];
  for (let y=2025, m=6; !(y===2026&&m===7);) {
    const start = `${y}-${String(m).padStart(2,'0')}-01`;
    const nm = m+1>12?1:m+1, ny = m+1>12?y+1:y;
    const end = `${ny}-${String(nm).padStart(2,'0')}-01`;
    months.push({ start, end });
    m++; if (m>12){m=1;y++;}
  }

  for (const interval of ['5min', '1h']) {
    console.log(`\nFetching ${interval} data...`);
    for (const { start, end } of months) {
      process.stdout.write(`  ${start} → ${end}: `);
      try {
        const data = await fetchChunk(interval, start, end);
        console.log(`${data.length} bars`);
      } catch (e) {
        console.log(`ERROR: ${e.message}`);
      }
      await sleep(1200); // TwelveData rate limit: 8 req/min on free tier
    }
  }

  // Verify total bars
  console.log('\nVerifying cache...');
  function loadAll(interval) {
    const all = [];
    for (const { start, end } of months) {
      const f = path.join(CACHE, `gbp_${interval}_${start}_${end}.json`);
      if (fs.existsSync(f)) all.push(...JSON.parse(fs.readFileSync(f)));
    }
    const seen = new Set();
    return all.filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;})
      .sort((a,b)=>a.time.localeCompare(b.time));
  }

  const bars5m = loadAll('5min');
  const bars1h = loadAll('1h');
  console.log(`  5m bars:  ${bars5m.length}`);
  console.log(`  1h bars:  ${bars1h.length}`);
  if (bars5m.length > 0) {
    console.log(`  5m range: ${bars5m[0].time} → ${bars5m[bars5m.length-1].time}`);
    console.log('\nDone. Run: node src/backtest_gbpusd.js');
  }
}

run().catch(console.error);
