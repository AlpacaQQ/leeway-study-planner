/*
 * Leeway planning engine.
 * Pure functions only: no DOM, no storage. Works in the browser (window.Planner)
 * and in Node (module.exports) so it can be unit tested.
 *
 * All scheduling is done in whole quarter-hours ("units") to avoid floating-point drift.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Planner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const UNIT_MIN = 15;              // one scheduling unit = 15 minutes
  const UNITS_PER_HOUR = 60 / UNIT_MIN;
  const MIN_BLOCK = 2;              // don't schedule blocks shorter than 30 min (unless that's all that's left)
  const MAX_HORIZON_DAYS = 180;
  const NOON = 12 * 60;

  // ---------- date helpers (always local time) ----------
  function pad(n) { return String(n).padStart(2, '0'); }

  function dayKey(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function addDays(d, n) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  }

  /** Parse "YYYY-MM-DDTHH:mm" (or "YYYY-MM-DD") as LOCAL time. Returns null if invalid. */
  function parseLocal(str) {
    if (!str || typeof str !== 'string') return null;
    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 23, m[5] ? +m[5] : 59);
    return isNaN(d.getTime()) ? null : d;
  }

  /** Whole calendar days between two dates (b - a), ignoring time of day and DST. */
  function dayDiff(a, b) {
    const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((ub - ua) / 86400000);
  }

  // ---------- unit helpers ----------
  function hoursToUnits(h) { return Math.max(0, Math.round((Number(h) || 0) * UNITS_PER_HOUR)); }
  function hoursToUnitsFloor(h) { return Math.max(0, Math.floor((Number(h) || 0) * UNITS_PER_HOUR + 1e-9)); }
  function unitsToHours(u) { return u / UNITS_PER_HOUR; }

  /** "2 h 30 min", "45 min", "0 min". Accepts hours. */
  function formatHours(hours) {
    const totalMin = Math.round(Math.abs(Number(hours) || 0) * 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    const sign = hours < 0 ? '−' : '';
    if (h && m) return sign + h + ' h ' + m + ' min';
    if (h) return sign + h + ' h';
    return sign + m + ' min';
  }

  function remainingHours(a) {
    return Math.max(0, (Number(a.estHours) || 0) - (Number(a.doneHours) || 0));
  }

  /**
   * The last calendar day you can realistically work on an assignment.
   * Due in the afternoon/evening → the due day itself counts. Due in the morning → the day before.
   * Never earlier than today while the deadline is still in the future.
   */
  function lastWorkDay(due, now) {
    const today = startOfDay(now);
    const mins = due.getHours() * 60 + due.getMinutes();
    let last = startOfDay(due);
    if (mins < NOON) last = addDays(last, -1);
    if (dayDiff(today, last) < 0) last = today;
    return last;
  }

  /**
   * Capacity (in units) for each day in the horizon.
   * Today is limited by: the weekday setting, minus what you've already logged today,
   * and by how many hours are left before midnight.
   */
  function buildCapacity(numDays, now, settings, loggedTodayHours) {
    const caps = [];
    const weekly = settings.capacity || [2, 3, 3, 3, 3, 3, 2];
    for (let i = 0; i < numDays; i++) {
      const d = addDays(startOfDay(now), i);
      let units = hoursToUnitsFloor(weekly[d.getDay()]);
      if (i === 0) {
        units -= hoursToUnits(loggedTodayHours || 0);
        const minsLeft = 24 * 60 - (now.getHours() * 60 + now.getMinutes());
        const leftUnits = Math.floor(minsLeft / UNIT_MIN) - 2; // leave a half-hour buffer before midnight
        units = Math.min(units, leftUnits);
      }
      caps.push(Math.max(0, units));
    }
    return caps;
  }

  function byDeadline(a, b) {
    if (a.dueTime !== b.dueTime) return a.dueTime - b.dueTime;
    if (b.rem !== a.rem) return b.rem - a.rem;
    return String(a.id).localeCompare(String(b.id));
  }

  /** Earliest-deadline-first, as-soon-as-possible. Optimal for "can everything fit?". */
  function scheduleAsap(tasks, caps) {
    const free = caps.slice();
    const alloc = caps.map(() => ({}));
    const short = {};
    tasks.slice().sort(byDeadline).forEach(t => {
      let rem = t.rem;
      for (let i = 0; i <= t.lastIdx && rem > 0; i++) {
        const take = Math.min(free[i], rem);
        if (take > 0) {
          alloc[i][t.id] = (alloc[i][t.id] || 0) + take;
          free[i] -= take;
          rem -= take;
        }
      }
      short[t.id] = rem;
    });
    return { alloc, short };
  }

  /**
   * Spread mode: each day, every open assignment gets the daily rate it needs to finish
   * on time (remaining ÷ days left), earliest deadline first. Unused capacity stays free,
   * so you are not told to grind every available hour.
   */
  function scheduleSpread(tasks, caps) {
    const free = caps.slice();
    const alloc = caps.map(() => ({}));
    const rem = {};
    tasks.forEach(t => { rem[t.id] = t.rem; });
    const sorted = tasks.slice().sort(byDeadline);
    for (let i = 0; i < caps.length; i++) {
      for (const t of sorted) {
        if (free[i] <= 0) break;
        if (rem[t.id] <= 0 || t.lastIdx < i) continue;
        // Share of the remaining work proportional to today's share of the capacity left before the deadline.
        let capLeft = 0;
        for (let j = i; j <= t.lastIdx; j++) capLeft += caps[j];
        let rate = capLeft > 0 ? Math.ceil(rem[t.id] * caps[i] / capLeft) : rem[t.id];
        rate = Math.max(rate, Math.min(MIN_BLOCK, rem[t.id]));
        const take = Math.min(rate, free[i], rem[t.id]);
        if (take > 0) {
          alloc[i][t.id] = (alloc[i][t.id] || 0) + take;
          free[i] -= take;
          rem[t.id] -= take;
        }
      }
    }
    return { alloc, short: rem };
  }

  function totalShort(short) {
    return Object.values(short).reduce((s, v) => s + v, 0);
  }

  /**
   * Build the full plan.
   * @param {Array} assignments  [{id,title,courseId,due:'YYYY-MM-DDTHH:mm',estHours,doneHours,done}]
   * @param {Object} settings    {capacity:[sun..sat hours], mode:'spread'|'asap'}
   * @param {Date} now
   * @param {number} loggedTodayHours  hours already logged today (focus sessions / manual logs)
   */
  function buildPlan(assignments, settings, now, loggedTodayHours) {
    settings = settings || {};
    now = now || new Date();
    const today = startOfDay(now);
    const info = {};
    const tasks = [];
    let maxIdx = 0;

    (assignments || []).forEach(a => {
      const due = parseLocal(a.due);
      const rem = hoursToUnits(remainingHours(a));
      const base = {
        id: a.id, due, remaining: unitsToHours(rem), leeway: 0, shortfall: 0,
        scheduled: 0, finishDay: null, lastDay: null, status: 'comfortable'
      };
      if (a.done || rem === 0) { base.status = 'done'; info[a.id] = base; return; }
      if (!due) { base.status = 'no-date'; info[a.id] = base; return; }
      if (due.getTime() <= now.getTime()) {
        base.status = 'overdue';
        base.shortfall = unitsToHours(rem);
        info[a.id] = base;
        return;
      }
      const last = lastWorkDay(due, now);
      const lastIdx = Math.min(dayDiff(today, last), MAX_HORIZON_DAYS - 1);
      maxIdx = Math.max(maxIdx, lastIdx);
      base.lastDay = dayKey(last);
      info[a.id] = base;
      tasks.push({ id: a.id, dueTime: due.getTime(), rem, lastIdx });
    });

    const numDays = Math.max(maxIdx + 1, 14);
    const caps = buildCapacity(numDays, now, settings, loggedTodayHours);

    // Leeway: spare capacity before each deadline after everything due earlier (EDF cumulative).
    const prefix = [];
    caps.reduce((s, c, i) => (prefix[i] = s + c), 0);
    let cumulative = 0;
    tasks.slice().sort(byDeadline).forEach(t => {
      cumulative += t.rem;
      info[t.id].leeway = unitsToHours(prefix[t.lastIdx] - cumulative);
    });

    const asap = scheduleAsap(tasks, caps);
    let chosen = asap;
    let modeUsed = 'asap';
    if (settings.mode !== 'asap') {
      const spread = scheduleSpread(tasks, caps);
      if (totalShort(spread.short) <= totalShort(asap.short)) {
        chosen = spread;
        modeUsed = 'spread';
      } else {
        modeUsed = 'asap-fallback';
      }
    }

    const days = caps.map((cap, i) => {
      const d = addDays(today, i);
      const blocks = Object.keys(chosen.alloc[i]).map(id => ({ id, hours: unitsToHours(chosen.alloc[i][id]) }));
      blocks.sort((x, y) => (info[x.id].due - info[y.id].due));
      const used = blocks.reduce((s, b) => s + b.hours, 0);
      return { key: dayKey(d), date: d, index: i, capacity: unitsToHours(cap), used, blocks };
    });

    days.forEach(day => day.blocks.forEach(b => {
      const t = info[b.id];
      t.scheduled += b.hours;
      t.finishDay = day.key;
    }));

    tasks.forEach(t => {
      const i = info[t.id];
      i.shortfall = unitsToHours(chosen.short[t.id] || 0);
      if (i.shortfall > 0) i.status = 'at-risk';
      else if (i.leeway <= Math.max(1, i.remaining * 0.25)) i.status = 'tight';
      else i.status = 'comfortable';
    });

    const atRisk = Object.values(info).filter(i => i.status === 'at-risk' || i.status === 'overdue');
    return { days, info, modeUsed, atRisk, totalShortfall: atRisk.reduce((s, i) => s + i.shortfall, 0) };
  }

  /** Human countdown: "in 3 d 4 h", "in 45 min", "2 d ago". */
  function countdown(due, now) {
    const diff = due.getTime() - now.getTime();
    const abs = Math.abs(diff);
    const mins = Math.round(abs / 60000);
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    let s;
    if (days >= 2) s = days + ' d' + (hours ? ' ' + hours + ' h' : '');
    else if (mins >= 60) s = Math.floor(mins / 60) + ' h' + (mins % 60 && days === 0 && mins < 600 ? ' ' + (mins % 60) + ' min' : '');
    else s = mins + ' min';
    return diff >= 0 ? 'in ' + s : s + ' ago';
  }

  return {
    UNIT_MIN, dayKey, startOfDay, addDays, parseLocal, dayDiff, formatHours,
    remainingHours, lastWorkDay, buildCapacity, scheduleAsap, scheduleSpread,
    buildPlan, countdown, hoursToUnits, unitsToHours
  };
});
