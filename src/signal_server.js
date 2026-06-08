'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  SIGNAL SERVER — exposes latest ICT signal over HTTP
//  MT5 Python bridge or any EA can poll GET /signal/latest
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const app     = express();
const PORT    = process.env.SIGNAL_PORT || 4000;

app.use(express.json());

// In-memory signal store — updated by the bot engine
let latestSignal   = null;
let signalHistory  = [];
let lastUpdated    = null;
let botStatus      = { running: false, lastScan: null, waitReason: null, confluence: null };

// ── Internal update — called by main.js when a signal fires ─────────────────

function publishSignal(signal) {
  // Avoid duplicate pushes for same signal
  if (latestSignal &&
      latestSignal.direction === signal.direction &&
      latestSignal.entry     === signal.entry) return;

  signal.id       = `${signal.symbol}_${Date.now()}`;
  signal.executed = false;
  latestSignal    = signal;
  signalHistory.unshift(signal);
  if (signalHistory.length > 50) signalHistory.pop();
  lastUpdated = new Date().toISOString();
  console.log(`[Signal Server] Published: ${signal.direction} ${signal.symbol} @ ${signal.entry}`);
}

function updateStatus(status) {
  botStatus = { ...botStatus, ...status, lastScan: new Date().toISOString() };
}

// Mark signal as executed (called back by MT5 bridge)
function markExecuted(id) {
  if (latestSignal?.id === id) latestSignal.executed = true;
  const h = signalHistory.find(s => s.id === id);
  if (h) h.executed = true;
}

// ── HTTP routes ──────────────────────────────────────────────────────────────

// GET /signal/latest — MT5 bridge polls this
app.get('/signal/latest', (req, res) => {
  res.json({
    ok:          true,
    hasSignal:   !!latestSignal && !latestSignal.executed,
    lastUpdated,
    signal:      (latestSignal && !latestSignal.executed) ? latestSignal : null,
    status:      botStatus
  });
});

// GET /signal/history — last 50 signals
app.get('/signal/history', (req, res) => {
  res.json({ ok: true, count: signalHistory.length, signals: signalHistory });
});

// POST /signal/executed — MT5 bridge calls this after placing the trade
app.post('/signal/executed', (req, res) => {
  const { id, ticket, price, time } = req.body;
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  markExecuted(id);
  console.log(`[Signal Server] ✓ Trade executed — ID: ${id}  Ticket: ${ticket}  Price: ${price}`);
  res.json({ ok: true });
});

// GET /status — health check
app.get('/status', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), botStatus, signalCount: signalHistory.length });
});

// ── Start ────────────────────────────────────────────────────────────────────

function startServer() {
  app.listen(PORT, () => {
    console.log(`[Signal Server] Listening on http://localhost:${PORT}`);
    console.log(`[Signal Server] MT5 bridge should poll: GET http://localhost:${PORT}/signal/latest`);
  });
}

module.exports = { publishSignal, updateStatus, startServer };
