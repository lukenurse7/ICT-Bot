'use strict';

const axios = require('axios');
require('dotenv').config();

const KEY = process.env.TWELVEDATA_API_KEY;
const BASE = 'https://api.twelvedata.com';
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

async function candles(interval, size = 100) {
  if (!KEY || KEY === 'your_key_here') {
    throw new Error('Add your TWELVEDATA_API_KEY to .env — free at twelvedata.com');
  }
  const r = await axios.get(`${BASE}/time_series`, {
    params: { symbol: SYMBOL, interval, outputsize: size, apikey: KEY, format: 'JSON', timezone: 'UTC' },
    timeout: 12000
  });
  if (r.data.status === 'error') throw new Error(`TwelveData: ${r.data.message}`);
  if (!r.data.values?.length) throw new Error('No candle data returned');
  return norm(r.data.values);
}

async function quote() {
  const r = await axios.get(`${BASE}/quote`, {
    params: { symbol: SYMBOL, apikey: KEY }, timeout: 8000
  });
  if (r.data.status === 'error') throw new Error(r.data.message);
  return {
    price:     parseFloat(r.data.close),
    open:      parseFloat(r.data.open),
    high:      parseFloat(r.data.high),
    low:       parseFloat(r.data.low),
    change:    parseFloat(r.data.change),
    changePct: parseFloat(r.data.percent_change),
    time:      r.data.datetime
  };
}

async function fetchAll() {
  const [daily, h4, h1, m15, m5, q] = await Promise.all([
    candles('1day', 30),    // 30 daily candles — HTF bias + prev day H/L
    candles('4h',   48),    // 48 x 4H — intermediate structure
    candles('1h',   48),    // 48 x 1H — asia session bounds
    candles('15min',96),    // 96 x 15m — liquidity sweep detection
    candles('5min', 120),   // 120 x 5m — MSS + FVG entry
    quote()
  ]);
  return { daily, h4, h1, m15, m5, quote: q };
}

module.exports = { candles, quote, fetchAll, SYMBOL };
