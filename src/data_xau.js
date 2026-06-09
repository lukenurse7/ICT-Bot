'use strict';

const axios = require('axios');
require('dotenv').config();

const KEY    = process.env.TWELVEDATA_API_KEY;
const BASE   = 'https://api.twelvedata.com';
const SYMBOL = 'XAU/USD';

function norm(raw) {
  return raw.reverse().map(c => ({
    time:   c.datetime,
    open:   parseFloat(c.open),
    high:   parseFloat(c.high),
    low:    parseFloat(c.low),
    close:  parseFloat(c.close),
    volume: parseFloat(c.volume || 0)
  }));
}

// ─── In-memory TTL cache ──────────────────────────────────────────────────────
// HTF data changes slowly — no need to re-fetch every 5 minutes
const cache = {};
const TTL = {
  '1day':  6 * 60 * 60 * 1000,   // daily  — refresh every 6h
  '4h':    2 * 60 * 60 * 1000,   // 4H     — refresh every 2h
  '1h':       30 * 60 * 1000,    // 1H     — refresh every 30m
  '15min':    15 * 60 * 1000,    // 15m    — refresh every 15m
  '5min':      5 * 60 * 1000,    // 5m     — refresh every 5m
  'quote':     5 * 60 * 1000,    // quote  — refresh every 5m
};

async function candles(interval, size = 100) {
  if (!KEY || KEY === 'your_key_here') {
    throw new Error('Add your TWELVEDATA_API_KEY to .env — free at twelvedata.com');
  }

  const key = `${interval}_${size}`;
  const now = Date.now();
  if (cache[key] && (now - cache[key].ts) < TTL[interval]) {
    return cache[key].data;
  }

  const r = await axios.get(`${BASE}/time_series`, {
    params: { symbol: SYMBOL, interval, outputsize: size, apikey: KEY, format: 'JSON', timezone: 'UTC' },
    timeout: 12000
  });
  if (r.data.status === 'error') throw new Error(`TwelveData: ${r.data.message}`);
  if (!r.data.values?.length) throw new Error('No candle data returned');
  const data = norm(r.data.values);
  cache[key] = { data, ts: now };
  return data;
}

async function quote() {
  const now = Date.now();
  if (cache['quote'] && (now - cache['quote'].ts) < TTL['quote']) {
    return cache['quote'].data;
  }

  const r = await axios.get(`${BASE}/quote`, {
    params: { symbol: SYMBOL, apikey: KEY }, timeout: 8000
  });
  if (r.data.status === 'error') throw new Error(r.data.message);
  const data = {
    price:     parseFloat(r.data.close),
    open:      parseFloat(r.data.open),
    high:      parseFloat(r.data.high),
    low:       parseFloat(r.data.low),
    change:    parseFloat(r.data.change),
    changePct: parseFloat(r.data.percent_change),
    time:      r.data.datetime
  };
  cache['quote'] = { data, ts: now };
  return data;
}

async function fetchAll() {
  // Only fetches what's stale — HTF data reused from cache until TTL expires
  const [daily, h4, h1, m15, m5, q] = await Promise.all([
    candles('1day',  30),   // HTF bias + prev day H/L  — refreshes every 6h
    candles('4h',    48),   // intermediate structure    — refreshes every 2h
    candles('1h',    48),   // asia session bounds       — refreshes every 30m
    candles('15min', 96),   // liquidity sweep           — refreshes every 15m
    candles('5min',  120),  // MSS + FVG entry           — refreshes every 5m
    quote()                 // live price                — refreshes every 5m
  ]);
  return { daily, h4, h1, m15, m5, quote: q };
}

module.exports = { candles, quote, fetchAll, SYMBOL };
