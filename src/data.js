'use strict';

const axios = require('axios');
require('dotenv').config();

const API_KEY  = process.env.TWELVEDATA_API_KEY;
const BASE_URL = 'https://api.twelvedata.com';
const SYMBOL   = 'DIA';

// ─── In-memory TTL cache ──────────────────────────────────────────────────────
const cache = {};
const TTL = {
  '1day':  6 * 60 * 60 * 1000,
  '4h':    2 * 60 * 60 * 1000,
  '1h':       30 * 60 * 1000,
  '15min':    15 * 60 * 1000,
  '5min':      5 * 60 * 1000,
  'quote':     5 * 60 * 1000,
};

async function fetchCandles(interval, outputSize = 100) {
  if (!API_KEY || API_KEY === 'your_api_key_here') {
    throw new Error('No TwelveData API key set');
  }

  const key = `${interval}_${outputSize}`;
  const now = Date.now();
  if (cache[key] && (now - cache[key].ts) < TTL[interval]) {
    return cache[key].data;
  }

  const res = await axios.get(`${BASE_URL}/time_series`, {
    params: { symbol: SYMBOL, interval, outputsize: outputSize, apikey: API_KEY, format: 'JSON', timezone: 'UTC' },
    timeout: 12000
  });

  if (res.data.status === 'error') throw new Error(`TwelveData error: ${res.data.message}`);
  const raw = res.data.values;
  if (!raw || raw.length === 0) throw new Error('No candle data returned');

  const data = raw.reverse().map(c => ({
    time: c.datetime, open: parseFloat(c.open), high: parseFloat(c.high),
    low: parseFloat(c.low), close: parseFloat(c.close), volume: parseFloat(c.volume || 0)
  }));
  cache[key] = { data, ts: now };
  return data;
}

async function fetchQuote() {
  const now = Date.now();
  if (cache['quote'] && (now - cache['quote'].ts) < TTL['quote']) {
    return cache['quote'].data;
  }

  const res = await axios.get(`${BASE_URL}/quote`, {
    params: { symbol: SYMBOL, apikey: API_KEY }, timeout: 8000
  });
  if (res.data.status === 'error') throw new Error(res.data.message);
  const data = {
    price: parseFloat(res.data.close), change: parseFloat(res.data.change),
    changePct: parseFloat(res.data.percent_change), open: parseFloat(res.data.open),
    high: parseFloat(res.data.high), low: parseFloat(res.data.low), timestamp: res.data.datetime
  };
  cache['quote'] = { data, ts: now };
  return data;
}

async function fetchAllData() {
  const [daily, h4, h1, candles15m, candles5m, quote] = await Promise.all([
    fetchCandles('1day',  30),
    fetchCandles('4h',    48),
    fetchCandles('1h',    48),
    fetchCandles('15min', 96),
    fetchCandles('5min',  120),
    fetchQuote()
  ]);
  return { daily, h4, h1, candles15m, candles5m, quote };
}

module.exports = { fetchCandles, fetchQuote, fetchAllData, SYMBOL };
