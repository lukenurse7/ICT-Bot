"""
MT5 AUTO-EXECUTION BRIDGE
==========================
Runs on your LOCAL machine (Windows) alongside MetaTrader 5.
Polls the signal bot every 30s, auto-executes trades on your MT5 demo account.

Requirements:
  pip install MetaTrader5 requests

Usage:
  python mt5_bridge.py

Config:
  Edit the CONFIG section below — set your MT5 account number,
  password, server, and the bot's signal URL.
"""

import MetaTrader5 as mt5
import requests
import time
import json
from datetime import datetime

# ─── CONFIG ──────────────────────────────────────────────────────────────────

BOT_URL        = "http://localhost:4000"   # signal server URL (or your cloud IP)
POLL_INTERVAL  = 30                        # seconds between polls

MT5_LOGIN      = 12345678                  # your MT5 demo account number
MT5_PASSWORD   = "your_demo_password"
MT5_SERVER     = "ICMarkets-Demo"          # your broker's MT5 server name

# Trade sizing — fixed fractional risk per trade
ACCOUNT_RISK_PCT = 1.0    # risk 1% of balance per trade
MIN_LOTS         = 0.01
MAX_LOTS         = 5.0

# Symbol mapping from bot → MT5
SYMBOL_MAP = {
    "XAUUSD": "XAUUSD",   # adjust if your broker uses "GOLD" or "XAUUSDm" etc
    "DJ30":   "US30",
}

# ─── LOGGING ─────────────────────────────────────────────────────────────────

def log(msg, level="INFO"):
    ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC")
    print(f"[{ts}] [{level}] {msg}")

# ─── MT5 CONNECTION ──────────────────────────────────────────────────────────

def connect():
    if not mt5.initialize(login=MT5_LOGIN, password=MT5_PASSWORD, server=MT5_SERVER):
        log(f"MT5 init failed: {mt5.last_error()}", "ERROR")
        return False
    info = mt5.account_info()
    log(f"Connected — Account: {info.login}  Balance: {info.balance} {info.currency}  Server: {info.server}")
    return True

def disconnect():
    mt5.shutdown()
    log("MT5 disconnected")

# ─── LOT SIZE CALCULATOR ─────────────────────────────────────────────────────

def calc_lots(symbol, entry, sl):
    """Risk fixed % of balance, size based on stop distance."""
    info    = mt5.account_info()
    balance = info.balance
    risk_amt = balance * (ACCOUNT_RISK_PCT / 100)

    sym_info = mt5.symbol_info(symbol)
    if not sym_info:
        log(f"Symbol info not found for {symbol}", "ERROR")
        return MIN_LOTS

    tick_size  = sym_info.trade_tick_size
    tick_value = sym_info.trade_tick_value
    stop_ticks = abs(entry - sl) / tick_size

    if stop_ticks == 0:
        return MIN_LOTS

    # value per lot per tick * ticks in stop = loss per lot at SL
    loss_per_lot = stop_ticks * tick_value
    if loss_per_lot == 0:
        return MIN_LOTS

    lots = risk_amt / loss_per_lot
    lots = round(max(MIN_LOTS, min(MAX_LOTS, lots)) / sym_info.volume_step) * sym_info.volume_step
    log(f"Lot calc: balance={balance:.0f}  risk={risk_amt:.2f}  stop_ticks={stop_ticks:.0f}  loss/lot={loss_per_lot:.2f}  lots={lots}")
    return lots

# ─── ORDER EXECUTION ─────────────────────────────────────────────────────────

def place_order(signal):
    symbol    = SYMBOL_MAP.get(signal["symbol"], signal["symbol"])
    direction = signal["direction"]   # "BUY" or "SELL"
    entry     = signal["entry"]
    sl        = signal["sl"]
    tp1       = signal["tp1"]
    tp2       = signal["tp2"]

    # Ensure symbol is selected in MarketWatch
    if not mt5.symbol_select(symbol, True):
        log(f"Cannot select symbol {symbol}", "ERROR")
        return None

    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        log(f"No tick data for {symbol}", "ERROR")
        return None

    order_type = mt5.ORDER_TYPE_BUY if direction == "BUY" else mt5.ORDER_TYPE_SELL
    price      = tick.ask if direction == "BUY" else tick.bid
    lots       = calc_lots(symbol, entry, sl)

    # Use TP1 as the initial take-profit (conservative — we'll trail to TP2 manually)
    request = {
        "action":      mt5.TRADE_ACTION_DEAL,
        "symbol":      symbol,
        "volume":      lots,
        "type":        order_type,
        "price":       price,
        "sl":          sl,
        "tp":          tp1,
        "deviation":   20,
        "magic":       202600,
        "comment":     f"ICT Bot | score={signal.get('confluence','?')}%",
        "type_time":   mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    log(f"Placing {direction} {symbol} @ {price:.2f}  SL={sl:.2f}  TP1={tp1:.2f}  Lots={lots}")
    result = mt5.order_send(request)

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        log(f"Order failed — retcode: {result.retcode}  comment: {result.comment}", "ERROR")
        return None

    log(f"✓ Order executed — Ticket: {result.order}  Price: {result.price}  Lots: {result.volume}")
    return result

# ─── CONFIRM BACK TO BOT ─────────────────────────────────────────────────────

def confirm_execution(signal_id, ticket, price):
    try:
        requests.post(f"{BOT_URL}/signal/executed", json={
            "id":     signal_id,
            "ticket": ticket,
            "price":  price,
            "time":   datetime.utcnow().isoformat()
        }, timeout=5)
    except Exception as e:
        log(f"Could not confirm to bot: {e}", "WARN")

# ─── POLL LOOP ───────────────────────────────────────────────────────────────

def poll_and_execute():
    try:
        r = requests.get(f"{BOT_URL}/signal/latest", timeout=10)
        data = r.json()
    except Exception as e:
        log(f"Could not reach signal server: {e}", "WARN")
        return

    if not data.get("hasSignal") or not data.get("signal"):
        status = data.get("status", {})
        log(f"No signal — {status.get('waitReason', 'monitoring')}  "
            f"Confluence: {status.get('confluence', '?')}%")
        return

    signal = data["signal"]
    log(f"Signal received: {signal['direction']} {signal['symbol']} "
        f"@ {signal['entry']}  Score: {signal.get('confluence','?')}%  "
        f"Grade: {signal.get('grade','?')}")
    log(f"  SL={signal['sl']}  TP1={signal['tp1']}  TP2={signal['tp2']}")

    result = place_order(signal)
    if result:
        confirm_execution(signal["id"], result.order, result.price)

def main():
    log("═" * 60)
    log("  ICT BOT — MT5 AUTO-EXECUTION BRIDGE")
    log(f"  Polling: {BOT_URL}/signal/latest  every {POLL_INTERVAL}s")
    log(f"  Account risk per trade: {ACCOUNT_RISK_PCT}%")
    log("═" * 60)

    if not connect():
        log("Could not connect to MT5 — is MetaTrader 5 running?", "ERROR")
        return

    log("Bridge running. Ctrl+C to stop.\n")

    try:
        while True:
            poll_and_execute()
            time.sleep(POLL_INTERVAL)
    except KeyboardInterrupt:
        log("\nStopped by user.")
    finally:
        disconnect()

if __name__ == "__main__":
    main()
