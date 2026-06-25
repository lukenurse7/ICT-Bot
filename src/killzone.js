'use strict';

// Kill Zone: NY  14:00–16:00 GMT (DJ30 window)
// Markets closed Saturday/Sunday

function getGMTTime() {
  const now = new Date();
  // Convert to GMT
  const gmt = new Date(now.toLocaleString('en-GB', { timeZone: 'UTC' }));
  return {
    hours: gmt.getHours(),
    minutes: gmt.getMinutes(),
    day: gmt.getDay(), // 0=Sun, 1=Mon ... 6=Sat
    full: gmt,
    iso: gmt.toISOString()
  };
}

function isMarketOpen() {
  const { day } = getGMTTime();
  return day >= 1 && day <= 5; // Mon–Fri
}

function isKillZone() {
  if (!isMarketOpen()) return false;
  const { hours, minutes } = getGMTTime();
  const totalMins = hours * 60 + minutes;
  const kzStart = 14 * 60; // 14:00
  const kzEnd   = 16 * 60; // 16:00
  return totalMins >= kzStart && totalMins < kzEnd;
}

function minutesUntilKillZone() {
  const { hours, minutes, day } = getGMTTime();
  if (!isMarketOpen()) {
    // Return mins until Monday 14:00
    const daysUntilMon = day === 0 ? 1 : 8 - day;
    return daysUntilMon * 24 * 60 + 14 * 60;
  }
  const totalMins = hours * 60 + minutes;
  const kzStart = 14 * 60;
  if (totalMins < kzStart) return kzStart - totalMins;
  return 0; // already in KZ or past it
}

function killZoneStatus() {
  const { hours, minutes, day } = getGMTTime();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  if (!isMarketOpen()) {
    return { active: false, message: `Market closed — ${days[day]}. Opens Mon 14:00 GMT` };
  }

  const totalMins = hours * 60 + minutes;
  const kzStart = 14 * 60;
  const kzEnd   = 16 * 60;

  if (totalMins >= kzStart && totalMins < kzEnd) {
    const remaining = kzEnd - totalMins;
    return {
      active: true,
      message: `DJ30 KILL ZONE ACTIVE — ${remaining}m remaining`,
      minutesRemaining: remaining
    };
  }

  if (totalMins < kzStart) {
    const wait = kzStart - totalMins;
    const h = Math.floor(wait / 60);
    const m = wait % 60;
    return {
      active: false,
      message: `DJ30 Kill Zone opens in ${h > 0 ? h + 'h ' : ''}${m}m (14:00 GMT)`
    };
  }

  return { active: false, message: 'DJ30 Kill Zone ended — next session tomorrow 14:00 GMT' };
}

module.exports = { isKillZone, isMarketOpen, minutesUntilKillZone, killZoneStatus, getGMTTime };
