'use strict';

const axios  = require('axios');
require('dotenv').config();

const KEY  = process.env.TWELVEDATA_API_KEY;
const BASE = 'https://api.twelvedata.com';

// ─── In-memory TTL cache ──────────────────────────────────────────────────────
const cache = {};
const TTL = {
  '1min':  60  * 1000,
  '5min':   5  * 60 * 1000,
  'quote':  5  * 60 * 1000,
};

function norm(raw) {
  return raw.reverse().map(c => ({
    time:  c.datetime,
    open:  parseFloat(c.open),
    high:  parseFloat(c.high),
    low:   parseFloat(c.low),
    close: parseFloat(c.close),
  }));
}

async function fetchCandles(symbol, interval, size = 120) {
  if (!KEY || KEY === 'your_api_key_here') {
    throw new Error('TWELVEDATA_API_KEY not set in .env — get a free key at twelvedata.com');
  }

  const cacheKey = `${symbol}_${interval}_${size}`;
  const now = Date.now();
  if (cache[cacheKey] && (now - cache[cacheKey].ts) < TTL[interval]) {
    return cache[cacheKey].data;
  }

  const res = await axios.get(`${BASE}/time_series`, {
    params: { symbol, interval, outputsize: size, apikey: KEY, format: 'JSON', timezone: 'UTC' },
    timeout: 12000,
  });

  if (res.data.status === 'error') throw new Error(`TwelveData: ${res.data.message}`);
  if (!res.data.values?.length)    throw new Error(`No candle data returned for ${symbol} ${interval}`);

  const data = norm(res.data.values);
  cache[cacheKey] = { data, ts: now };
  return data;
}

async function fetchQuote(symbol) {
  const cacheKey = `quote_${symbol}`;
  const now = Date.now();
  if (cache[cacheKey] && (now - cache[cacheKey].ts) < TTL['quote']) {
    return cache[cacheKey].data;
  }

  const res = await axios.get(`${BASE}/quote`, {
    params: { symbol, apikey: KEY },
    timeout: 8000,
  });

  if (res.data.status === 'error') throw new Error(`TwelveData quote: ${res.data.message}`);

  const data = {
    price:     parseFloat(res.data.close),
    changePct: parseFloat(res.data.percent_change),
    time:      res.data.datetime,
  };
  cache[cacheKey] = { data, ts: now };
  return data;
}

// Fetch all timeframes needed for one instrument
async function fetchAll(symbol) {
  const [m5, m1, quote] = await Promise.all([
    fetchCandles(symbol, '5min', 120),
    fetchCandles(symbol, '1min', 120),
    fetchQuote(symbol),
  ]);
  return { m5, m1, quote };
}

module.exports = { fetchAll, fetchCandles, fetchQuote };
