'use strict';

// ─── ICT Kill Zone Schedule (UTC) ─────────────────────────────────────────────
// Asia KZ:       02:00 – 05:00  (Asian session liquidity sweep)
// London KZ:     07:00 – 09:00  (London open — main KZ for XAU)
// NY KZ:         12:00 – 15:00  (NY open / Judas swing)
// Silver Bullet: 10:00 – 11:00  (ICT Silver Bullet AM)
//                14:00 – 15:00  (ICT Silver Bullet PM)

const SESSIONS = {
  asia_kz:            { start: 2,  end: 5,  label: '🔵 Asia Kill Zone',         active: true  },
  london:             { start: 7,  end: 9,  label: '🟡 London Kill Zone',        active: true  },
  silver_bullet_am:   { start: 10, end: 11, label: '⚡ Silver Bullet AM',        active: false },
  new_york:           { start: 12, end: 15, label: '🟢 NY Kill Zone',            active: true  },
  silver_bullet_pm:   { start: 14, end: 15, label: '⚡ Silver Bullet PM',        active: false },
  london_close:       { start: 15, end: 16, label: 'London Close',               active: false },
};

function getUTCHour() {
  return new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
}

function getUTCTime() {
  const now = new Date();
  return {
    h: now.getUTCHours(), m: now.getUTCMinutes(), s: now.getUTCSeconds(),
    day: now.getUTCDay(),
    iso: now.toISOString(),
    label: `${now.getUTCHours().toString().padStart(2,'0')}:${now.getUTCMinutes().toString().padStart(2,'0')} UTC`
  };
}

function isWeekday() {
  const day = new Date().getUTCDay();
  return day >= 1 && day <= 5;
}

function activeKillZones() {
  if (!isWeekday()) return [];
  const h = getUTCHour();
  return Object.entries(SESSIONS)
    .filter(([, s]) => s.active && h >= s.start && h < s.end)
    .map(([name]) => name);
}

function sessionStatus() {
  const { h, m, day } = getUTCTime();
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  if (!isWeekday()) return { active: false, label: `Market closed — ${days[day]}` };

  const zones = activeKillZones();

  if (zones.length > 0) {
    const labels = zones.map(z => SESSIONS[z].label).join(' + ');
    return { active: true, label: labels, zones };
  }

  // Find next kill zone
  const totalMins = h * 60 + m;
  const kzList = [
    { name: 'Asia',   start: 2  * 60 },
    { name: 'London', start: 7  * 60 },
    { name: 'NY',     start: 12 * 60 },
  ];
  const next = kzList.find(kz => kz.start > totalMins);
  if (next) {
    const diff = next.start - totalMins;
    return { active: false, label: `Next: ${next.name} KZ in ${Math.floor(diff/60)}h ${diff%60}m` };
  }
  return { active: false, label: 'All kill zones passed — next: Asia KZ 02:00 UTC' };
}

function getPreviousDayBounds(dailyCandles) {
  if (!dailyCandles || dailyCandles.length < 2) return null;
  const prev = dailyCandles[dailyCandles.length - 2];
  return { high: prev.high, low: prev.low, time: prev.time };
}

function getAsiaSessionBounds(candles1h) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const asiaEnd = new Date(today);
  asiaEnd.setUTCHours(6);
  const asiaCandles = candles1h.filter(c => {
    const t = new Date(c.time);
    return t >= today && t < asiaEnd;
  });
  if (asiaCandles.length === 0) return null;
  return {
    high: Math.max(...asiaCandles.map(c => c.high)),
    low:  Math.min(...asiaCandles.map(c => c.low)),
    candles: asiaCandles.length
  };
}

module.exports = {
  activeKillZones, sessionStatus, getPreviousDayBounds,
  getAsiaSessionBounds, getUTCTime, isWeekday, SESSIONS,
  isInKillZone: (zones = ['london','new_york']) => activeKillZones().some(z => zones.includes(z))
};
