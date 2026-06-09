'use strict';

// All times in UTC
// Asia Session:       00:00 – 06:00 UTC
// London KZ:          07:00 – 09:00 UTC  (London Open)
// NY AM KZ:           12:00 – 15:00 UTC  (NY Open / Judas swing window)
// Silver Bullet:      14:00 – 15:00 UTC  (ICT Silver Bullet — NY AM)
// London Close:       15:00 – 16:00 UTC

const SESSIONS = {
  asia:          { start: 0,  end: 6  },
  london:        { start: 7,  end: 9  },
  new_york:      { start: 12, end: 15 },
  silver_bullet: { start: 14, end: 15 },
  london_close:  { start: 15, end: 16 },
};

function getUTCHour() {
  return new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
}

function getUTCTime() {
  const now = new Date();
  return {
    h: now.getUTCHours(),
    m: now.getUTCMinutes(),
    s: now.getUTCSeconds(),
    day: now.getUTCDay(), // 0=Sun
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
    .filter(([, s]) => h >= s.start && h < s.end)
    .map(([name]) => name);
}

function isInKillZone(zones = ['london', 'new_york', 'silver_bullet']) {
  const active = activeKillZones();
  return zones.some(z => active.includes(z));
}

function sessionStatus() {
  const { h, m, day } = getUTCTime();
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  if (!isWeekday()) return { active: false, label: `Market closed — ${days[day]}` };

  const zones = activeKillZones();
  const labels = {
    asia: 'Asia Session',
    london: '🟡 London Kill Zone',
    new_york: '🟢 NY Kill Zone',
    silver_bullet: '⚡ Silver Bullet Window',
    london_close: 'London Close'
  };

  if (zones.length > 0) {
    return {
      active: zones.some(z => ['london','new_york','silver_bullet'].includes(z)),
      label: zones.map(z => labels[z]).join(' + '),
      zones
    };
  }

  // Find next kill zone
  const totalMins = h * 60 + m;
  const kzList = [
    { name: 'London', start: 7 * 60 },
    { name: 'NY', start: 12 * 60 },
    { name: 'Silver Bullet', start: 14 * 60 }
  ];
  const next = kzList.find(kz => kz.start > totalMins);
  if (next) {
    const diff = next.start - totalMins;
    return { active: false, label: `Next: ${next.name} KZ in ${Math.floor(diff/60)}h ${diff%60}m` };
  }
  return { active: false, label: 'All kill zones passed — tomorrow' };
}

function getPreviousDayBounds(dailyCandles) {
  // Returns previous day's high and low
  if (!dailyCandles || dailyCandles.length < 2) return null;
  const prev = dailyCandles[dailyCandles.length - 2];
  return { high: prev.high, low: prev.low, time: prev.time };
}

function getAsiaSessionBounds(candles1h) {
  // Asia = 00:00–06:00 UTC today
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
    low: Math.min(...asiaCandles.map(c => c.low)),
    candles: asiaCandles.length
  };
}

module.exports = {
  activeKillZones, isInKillZone, sessionStatus,
  getPreviousDayBounds, getAsiaSessionBounds, getUTCTime, isWeekday, SESSIONS
};
