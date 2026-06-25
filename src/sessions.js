'use strict';

const { NY_KZ } = require('./config');

// ─── Convert a UTC Date to New York local time ────────────────────────────────
// Uses the Intl API — handles EST/EDT automatically
function toNYTime(date) {
  const str = date.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const ny  = new Date(str);
  return {
    h:   ny.getHours(),
    m:   ny.getMinutes(),
    day: ny.getDay(),  // 0=Sun … 6=Sat
    date: ny,
  };
}

function isWeekday() {
  const { day } = toNYTime(new Date());
  return day >= 1 && day <= 5;
}

// Returns true if we are currently inside the NY Kill Zone
function isNYKillZone() {
  if (!isWeekday()) return false;
  const { h, m } = toNYTime(new Date());
  const totalMins  = h * 60 + m;
  const kzStart    = NY_KZ.startHour * 60 + NY_KZ.startMin;  // 510 (08:30)
  const kzEnd      = NY_KZ.endHour   * 60 + NY_KZ.endMin;    // 660 (11:00)
  return totalMins >= kzStart && totalMins < kzEnd;
}

// Human-readable status string for logging
function killZoneStatus() {
  if (!isWeekday()) {
    const { day } = toNYTime(new Date());
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return { active: false, label: `Market closed — ${days[day]}` };
  }

  const { h, m } = toNYTime(new Date());
  const totalMins = h * 60 + m;
  const kzStart   = NY_KZ.startHour * 60 + NY_KZ.startMin;
  const kzEnd     = NY_KZ.endHour   * 60 + NY_KZ.endMin;

  if (totalMins >= kzStart && totalMins < kzEnd) {
    const remaining = kzEnd - totalMins;
    return { active: true, label: `NY Kill Zone — ${remaining}m remaining` };
  }

  if (totalMins < kzStart) {
    const wait = kzStart - totalMins;
    const wh   = Math.floor(wait / 60);
    const wm   = wait % 60;
    return { active: false, label: `NY KZ opens in ${wh > 0 ? wh + 'h ' : ''}${wm}m (08:30 NY)` };
  }

  return { active: false, label: 'NY Kill Zone ended — next session tomorrow 08:30 NY' };
}

// Unique key for today's NY session — used to know when to reset engine state
function currentSessionKey() {
  const ny = toNYTime(new Date());
  return `${ny.date.getFullYear()}-${String(ny.date.getMonth()+1).padStart(2,'0')}-${String(ny.date.getDate()).padStart(2,'0')}`;
}

module.exports = { isNYKillZone, isWeekday, killZoneStatus, currentSessionKey, toNYTime };
