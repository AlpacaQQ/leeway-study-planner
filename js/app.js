/* Leeway – UI layer. Vanilla JS, no build step. State lives in localStorage. */
(function () {
  'use strict';
  const P = window.Planner;
  const STORAGE_KEY = 'leeway.v1';
  const COLORS = ['#2B49D1', '#0E8A8C', '#8A4FB3', '#B9542A', '#5E8A1E', '#C2457A', '#55606E'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

  // Tests and demos can freeze the clock with window.LEEWAY_NOW = '2026-11-02T09:00'
  const clock = () => (window.LEEWAY_NOW ? new Date(window.LEEWAY_NOW) : new Date());

  // ---------------- state ----------------
  function defaultState() {
    return {
      version: 1,
      courses: [],
      assignments: [],
      sessions: [],
      settings: { capacity: [2, 3, 3, 3, 3, 2, 2], focusMin: 25, breakMin: 5, longBreakMin: 15, mode: 'spread', theme: 'auto' },
      timer: null,
      ui: { filter: 'active' }
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      return normalize(JSON.parse(raw));
    } catch (e) {
      return defaultState();
    }
  }

  function normalize(s) {
    const d = defaultState();
    if (!s || typeof s !== 'object') return d;
    const out = Object.assign(d, s);
    out.settings = Object.assign(defaultState().settings, s.settings || {});
    if (!Array.isArray(out.settings.capacity) || out.settings.capacity.length !== 7) out.settings.capacity = defaultState().settings.capacity;
    out.courses = Array.isArray(s.courses) ? s.courses : [];
    out.assignments = Array.isArray(s.assignments) ? s.assignments : [];
    out.sessions = Array.isArray(s.sessions) ? s.sessions : [];
    out.ui = Object.assign({ filter: 'active' }, s.ui || {});
    return out;
  }

  let state = load();
  let saveWarned = false;
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      if (!saveWarned) { toast('Your browser blocked saving. Changes will be lost when you close this tab.'); saveWarned = true; }
    }
  }

  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

  // ---------------- helpers ----------------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtH = P.formatHours;
  const $ = (sel, root) => (root || document).querySelector(sel);

  function course(id) { return state.courses.find(c => c.id === id) || null; }
  function colorOf(a) { const c = course(a.courseId); return c ? c.color : '#55606E'; }
  function assignment(id) { return state.assignments.find(a => a.id === id) || null; }

  function fmtDay(d, opts) {
    const now = clock();
    const diff = P.dayDiff(P.startOfDay(now), d);
    if (!opts || !opts.noRelative) {
      if (diff === 0) return 'Today';
      if (diff === 1) return 'Tomorrow';
      if (diff === -1) return 'Yesterday';
    }
    return DOW[d.getDay()] + ' ' + d.getDate() + ' ' + d.toLocaleString('en-GB', { month: 'short' });
  }
  function fmtTime(d) { return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function fmtDue(a) {
    const d = P.parseLocal(a.due);
    if (!d) return 'no due date';
    const day = fmtDay(d);
    return (/^(Today|Tomorrow|Yesterday)$/.test(day) ? day.toLowerCase() : day) + ' at ' + fmtTime(d);
  }

  function sessionsOn(key) { return state.sessions.filter(s => P.dayKey(new Date(s.at)) === key); }
  function loggedTodayHours() {
    return sessionsOn(P.dayKey(clock())).reduce((sum, s) => sum + s.minutes / 60, 0);
  }

  function computePlan() {
    return P.buildPlan(state.assignments, state.settings, clock(), loggedTodayHours());
  }

  function statusLabel(info) {
    switch (info.status) {
      case 'comfortable': return fmtH(info.leeway) + ' spare';
      case 'tight': return info.leeway > 0 ? 'Tight: ' + fmtH(info.leeway) + ' spare' : 'Tight: no spare time';
      case 'at-risk': return 'Short by ' + fmtH(info.shortfall);
      case 'overdue': return 'Overdue';
      case 'done': return 'Done';
      default: return 'No date';
    }
  }

  function weekHours() {
    const now = clock();
    const start = P.addDays(P.startOfDay(now), -6); // last 7 days, including today
    return state.sessions.filter(s => new Date(s.at) >= start).reduce((sum, s) => sum + s.minutes / 60, 0);
  }

  function streak() {
    const days = new Set(state.sessions.map(s => P.dayKey(new Date(s.at))));
    let d = P.startOfDay(clock());
    if (!days.has(P.dayKey(d))) d = P.addDays(d, -1);
    let n = 0;
    while (days.has(P.dayKey(d))) { n++; d = P.addDays(d, -1); }
    return n;
  }

  // ---------------- toast ----------------
  let toastTimer = null;
  function toast(msg, actionLabel, action) {
    const el = $('#toast');
    el.innerHTML = '<span>' + esc(msg) + '</span>' + (actionLabel ? '<button type="button">' + esc(actionLabel) + '</button>' : '');
    if (actionLabel) el.querySelector('button').onclick = () => { el.classList.remove('show'); action(); };
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), actionLabel ? 6000 : 3200);
  }

  // ---------------- routing ----------------
  const ROUTES = ['today', 'plan', 'assignments', 'focus', 'settings'];
  function route() {
    const r = (location.hash || '#today').slice(1).split('/')[0];
    return ROUTES.includes(r) ? r : 'today';
  }

  function render() {
    const r = route();
    document.querySelectorAll('.nav a').forEach(a => {
      if (a.dataset.route === r) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    const main = $('#main');
    main.innerHTML = VIEWS[r]();
    main.dataset.view = r;
    if (r === 'focus') updateTimerUI();
    updateMiniTimer();
    applyTheme();
  }

  // ---------------- views ----------------
  const VIEWS = {};

  function emptyState(title, text) {
    return '<div class="empty"><h2>' + esc(title) + '</h2><p>' + esc(text) + '</p><div class="btns">' +
      '<button class="btn primary" data-action="add">Add an assignment</button>' +
      '<button class="btn ghost" data-action="demo">Try it with sample data</button></div></div>';
  }

  function taskRef(a) {
    return '<span class="task-ref" style="--c:' + colorOf(a) + '">' + esc(a.title) + '</span>';
  }

  VIEWS.today = function () {
    const now = clock();
    const head = '<p class="today-date">' + esc(now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })) + '</p>';
    const active = state.assignments.filter(a => !a.done);
    if (!state.assignments.length) {
      return '<section class="hero">' + head + '<h1 class="hero-sentence">Know how much leeway you have before every deadline.</h1>' +
        '<p class="hero-sub">Add your assignments with a due date and a rough estimate of the work. Leeway plans your days around the hours you actually have, and tells you early when something won’t fit.</p></section>' +
        emptyState('Start with one assignment', 'You can always change the estimate later. Most people underestimate by about a third.');
    }

    const plan = computePlan();
    const today = plan.days[0];
    let sentence;
    if (today.blocks.length) {
      const parts = today.blocks.map(b => {
        const a = assignment(b.id);
        return '<span class="amount" style="--c:' + colorOf(a) + '">' + fmtH(b.hours) + '</span> on ' + taskRef(a);
      });
      const joined = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ', then ' + parts[parts.length - 1];
      sentence = 'Today: ' + joined + '.';
    } else if (!active.length) {
      sentence = 'Everything is handed in. Enjoy the leeway.';
    } else if (today.capacity === 0 && loggedTodayHours() > 0) {
      sentence = 'You’ve done today’s study time. The rest of the plan still fits.';
    } else {
      const next = plan.days.find(d => d.blocks.length);
      sentence = next
        ? 'Nothing planned for today. Next up: ' + taskRef(assignment(next.blocks[0].id)) + ' on ' + esc(fmtDay(next.date)) + '.'
        : 'Nothing planned for today.';
    }

    const upcoming = active.filter(a => plan.info[a.id] && plan.info[a.id].status !== 'no-date')
      .sort((x, y) => P.parseLocal(x.due) - P.parseLocal(y.due));
    const nextDue = upcoming.find(a => plan.info[a.id].status !== 'overdue');
    let sub = '';
    if (today.blocks.length) sub += 'That’s ' + fmtH(today.used) + ' of the ' + fmtH(today.capacity) + ' you have left today. ';
    if (nextDue) sub += 'Next deadline: ' + esc(nextDue.title) + ', ' + esc(P.countdown(P.parseLocal(nextDue.due), now)) + '.';

    const alerts = plan.atRisk.map(info => {
      const a = assignment(info.id);
      if (info.status === 'overdue') {
        return '<div class="alert risk"><strong>' + esc(a.title) + ' was due ' + esc(fmtDue(a)) + '.</strong>' +
          '<span>Mark it done if you handed it in, or move the due date if you got an extension.</span>' +
          '<div class="btn-row" style="margin-top:6px"><button class="btn small ghost" data-action="done" data-id="' + a.id + '">Mark done</button>' +
          '<button class="btn small ghost" data-action="edit" data-id="' + a.id + '">Change due date</button></div></div>';
      }
      return '<div class="alert risk"><strong>' + esc(a.title) + ' needs ' + fmtH(info.shortfall) + ' more than you have before ' + esc(fmtDue(a)) + '.</strong>' +
        '<span>Add study hours on the days before it, lower the estimate, or ask for an extension.</span>' +
        '<div class="btn-row" style="margin-top:6px"><a class="btn small ghost" href="#settings">Adjust study hours</a>' +
        '<button class="btn small ghost" data-action="edit" data-id="' + a.id + '">Edit estimate</button></div></div>';
    }).join('');

    const blocksHtml = today.blocks.length
      ? '<ul class="blocks">' + today.blocks.map(b => {
        const a = assignment(b.id);
        const c = course(a.courseId);
        return '<li class="block" style="--c:' + colorOf(a) + '"><span class="bar"></span><div><div class="title">' + esc(a.title) + '</div>' +
          '<div class="meta">' + esc(c ? c.name : 'No course') + ', due ' + esc(fmtDue(a)) + '</div>' +
          '<div class="actions" style="justify-content:flex-start;margin-left:-8px">' +
          '<button class="icon-btn" data-action="focus" data-id="' + a.id + '">Start focus</button>' +
          '<button class="icon-btn" data-action="log" data-id="' + a.id + '">Log time</button>' +
          '<button class="icon-btn" data-action="done" data-id="' + a.id + '">Mark done</button></div></div>' +
          '<div class="amount">' + fmtH(b.hours) + '</div></li>';
      }).join('') + '</ul>'
      : '<p class="muted">No study blocks today. ' + (active.length ? '<a href="#plan">See the full plan</a>.' : '') + '</p>';

    const doneToday = sessionsOn(P.dayKey(now));
    const doneTodayHtml = doneToday.length
      ? '<p class="muted" style="margin-top:14px">Logged today: ' + fmtH(loggedTodayHours()) + ' across ' + doneToday.length + ' session' + (doneToday.length > 1 ? 's' : '') + '.</p>'
      : '';

    const deadlinesHtml = upcoming.length
      ? '<ul class="deadlines">' + upcoming.slice(0, 6).map(a => deadlineRow(a, plan.info[a.id], now)).join('') + '</ul>'
      : '<p class="muted">No upcoming deadlines.</p>';

    const remainingAll = active.reduce((s, a) => s + P.remainingHours(a), 0);
    const st = streak();

    return '<section class="hero">' + head + '<h1 class="hero-sentence">' + sentence + '</h1>' +
      (sub ? '<p class="hero-sub">' + sub + '</p>' : '') + '</section>' + alerts +
      '<div class="grid-today"><section class="panel"><h2>Today’s plan <small>' + fmtH(today.capacity) + ' available</small></h2>' + blocksHtml + doneTodayHtml +
      '<div class="stats"><div class="stat"><b>' + fmtH(remainingAll) + '</b><span>work left in total</span></div>' +
      '<div class="stat"><b>' + fmtH(weekHours()) + '</b><span>studied in the last 7 days</span></div>' +
      '<div class="stat"><b>' + st + ' day' + (st === 1 ? '' : 's') + '</b><span>study streak</span></div></div></section>' +
      '<section class="panel"><h2>Coming up <small><a href="#assignments">All</a></small></h2>' + deadlinesHtml + '</section></div>';
  };

  function deadlineRow(a, info, now) {
    const due = P.parseLocal(a.due);
    const pct = a.estHours > 0 ? Math.min(100, Math.round((a.doneHours || 0) / a.estHours * 100)) : 0;
    const c = course(a.courseId);
    return '<li class="deadline" style="--c:' + colorOf(a) + '"><div><div class="title"><span class="course-dot"></span>' + esc(a.title) + '</div>' +
      '<div class="when">' + esc(c ? c.name + ', ' : '') + esc(fmtDue(a)) + ' (' + esc(P.countdown(due, now)) + ')</div></div>' +
      '<span class="status ' + info.status + '">' + esc(statusLabel(info)) + '</span>' +
      '<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="Progress"><span style="width:' + pct + '%"></span></div></li>';
  }

  VIEWS.plan = function () {
    if (!state.assignments.some(a => !a.done)) {
      return '<div class="page-head"><div><h1>Plan</h1><p>Your study days, built from deadlines and the hours you have.</p></div></div>' +
        emptyState('Nothing to plan yet', 'Add an assignment and Leeway will spread the work across your days.');
    }
    const plan = computePlan();
    const now = clock();
    let lastUsed = 0;
    plan.days.forEach((d, i) => { if (d.blocks.length) lastUsed = i; });
    const dueDays = {};
    state.assignments.filter(a => !a.done).forEach(a => {
      const d = P.parseLocal(a.due); if (!d) return;
      (dueDays[P.dayKey(d)] = dueDays[P.dayKey(d)] || []).push(a);
    });
    let lastDue = 0;
    plan.days.forEach((d, i) => { if (dueDays[d.key]) lastDue = i; });
    const count = Math.min(plan.days.length, Math.max(14, lastUsed + 1, lastDue + 1, 0), 60);
    const days = plan.days.slice(0, count);
    const scale = Math.max(1, ...days.map(d => Math.max(d.capacity, d.used)));
    const mode = state.settings.mode === 'asap' ? 'asap' : 'spread';

    const cols = days.map(d => {
      const segs = d.blocks.map(b => {
        const a = assignment(b.id);
        return '<div class="seg" style="--c:' + colorOf(a) + ';height:' + (b.hours / scale * 100) + '%" title="' + esc(a.title + ': ' + fmtH(b.hours)) + '"></div>';
      }).join('');
      const flags = (dueDays[d.key] || []).map(a => '<span class="due-flag" style="--c:' + colorOf(a) + '" title="' + esc('Due: ' + a.title) + '"></span>').join('');
      const wk = d.date.getDay() === 0 || d.date.getDay() === 6;
      const label = fmtDay(d.date, { noRelative: true }) + ': ' + fmtH(d.used) + ' planned of ' + fmtH(d.capacity);
      return '<button type="button" class="load-day' + (wk ? ' weekend' : '') + (d.index === 0 ? ' is-today' : '') + '" data-action="day" data-key="' + d.key + '" aria-label="' + esc(label) + '" title="' + esc(label) + '">' +
        '<div class="load-col' + (d.capacity === 0 ? ' zero' : '') + '">' + segs + '<span class="cap" style="bottom:' + (d.capacity / scale * 100) + '%"></span>' + flags + '</div>' +
        '<span class="dow">' + (d.index === 0 ? 'Today' : DOW[d.date.getDay()]) + '</span><span class="dnum">' + d.date.getDate() + '/' + (d.date.getMonth() + 1) + '</span></button>';
    }).join('');

    const usedCourses = state.courses.filter(c => state.assignments.some(a => !a.done && a.courseId === c.id));
    const legend = '<div class="legend"><span><span class="cap-key"></span>Your available hours</span>' +
      usedCourses.map(c => '<span><span class="course-dot" style="--c:' + c.color + '"></span>' + esc(c.name) + '</span>').join('') +
      '<span><span class="course-dot" style="--c:var(--muted);width:8px;height:8px"></span>Dot on top: a deadline</span></div>';

    const cards = days.map(d => {
      const dues = (dueDays[d.key] || []).map(a => '<li class="muted"><span><span class="course-dot" style="--c:' + colorOf(a) + '"></span>Due ' + esc(fmtTime(P.parseLocal(a.due))) + ': ' + esc(a.title) + '</span></li>').join('');
      if (!d.blocks.length && !dues) return '';
      const items = d.blocks.map(b => {
        const a = assignment(b.id);
        return '<li><span><span class="course-dot" style="--c:' + colorOf(a) + '"></span>' + esc(a.title) + '</span><b>' + fmtH(b.hours) + '</b></li>';
      }).join('');
      return '<article class="day-card" id="day-' + d.key + '"><header><h3>' + esc(fmtDay(d.date)) + (d.index > 1 ? '' : ' <span class="muted" style="font-weight:400">' + esc(fmtDay(d.date, { noRelative: true })) + '</span>') + '</h3>' +
        '<span class="fill-meter">' + fmtH(d.used) + ' of ' + fmtH(d.capacity) + '</span></header><ul>' + items + dues + '</ul></article>';
    }).join('');

    const fallback = plan.modeUsed === 'asap-fallback'
      ? '<div class="alert tight"><strong>Spreading the work evenly would miss a deadline, so this plan front-loads instead.</strong></div>' : '';
    const risk = plan.atRisk.length
      ? '<div class="alert risk"><strong>' + plan.atRisk.length + ' assignment' + (plan.atRisk.length > 1 ? 's don’t' : ' doesn’t') + ' fit in the time you have.</strong><span>See Today for what to change.</span></div>' : '';

    return '<div class="page-head"><div><h1>Plan</h1><p>Each bar is a day. Coloured blocks are planned study time, the dashed line is how many hours you have that day.</p></div>' +
      '<div class="btn-row"><div class="segmented" role="group" aria-label="Planning style">' +
      '<button type="button" data-action="mode" data-mode="spread" aria-pressed="' + (mode === 'spread') + '">Spread it out</button>' +
      '<button type="button" data-action="mode" data-mode="asap" aria-pressed="' + (mode === 'asap') + '">Get ahead</button></div>' +
      '<button class="btn ghost" data-action="export-ics">Export to calendar</button></div></div>' + risk + fallback +
      '<section class="panel"><div class="load" style="--h:' + (window.innerWidth < 600 ? 160 : 220) + 'px">' + cols + '</div>' + legend + '</section>' +
      '<div class="days">' + cards + '</div>';
  };

  VIEWS.assignments = function () {
    const plan = computePlan();
    const now = clock();
    const filter = state.ui.filter || 'active';
    const list = state.assignments.filter(a => filter === 'all' || (filter === 'done' ? a.done : !a.done))
      .sort((x, y) => (x.done - y.done) || ((P.parseLocal(x.due) || 0) - (P.parseLocal(y.due) || 0)));

    const seg = ['active', 'done', 'all'].map(f => '<button type="button" data-action="filter" data-filter="' + f + '" aria-pressed="' + (filter === f) + '">' +
      ({ active: 'Active', done: 'Done', all: 'All' })[f] + ' <span class="muted">' + state.assignments.filter(a => f === 'all' || (f === 'done' ? a.done : !a.done)).length + '</span></button>').join('');

    let body;
    if (!state.assignments.length) {
      body = emptyState('No assignments yet', 'Add what you need to hand in, when it’s due, and roughly how many hours it will take.');
    } else if (!list.length) {
      body = '<div class="empty"><h2>' + (filter === 'done' ? 'Nothing finished yet' : 'Nothing left to do') + '</h2><p>' +
        (filter === 'done' ? 'Assignments you mark done will show up here.' : 'Every assignment is marked done.') + '</p></div>';
    } else {
      body = '<div class="cards">' + list.map(a => assignmentCard(a, plan.info[a.id], now)).join('') + '</div>';
    }

    return '<div class="page-head"><div><h1>Assignments</h1><p>Everything you need to hand in, with how much work is left.</p></div>' +
      '<button class="btn primary" data-action="add">Add assignment</button></div>' +
      '<div class="toolbar"><div class="segmented" role="group" aria-label="Show">' + seg + '</div></div>' + body +
      coursesPanel();
  };

  function assignmentCard(a, info, now) {
    const c = course(a.courseId);
    const due = P.parseLocal(a.due);
    const pct = a.estHours > 0 ? Math.min(100, Math.round((a.doneHours || 0) / a.estHours * 100)) : 0;
    const finish = info && info.finishDay && !a.done ? 'Planned to finish <b>' + esc(fmtDay(P.parseLocal(info.finishDay))) + '</b>' : '';
    return '<article class="a-card' + (a.done ? ' is-done' : '') + '" style="--c:' + colorOf(a) + '">' +
      '<div><div class="title">' + esc(a.title) + '</div><div class="sub">' + esc(c ? c.name : 'No course') + ', due ' + esc(fmtDue(a)) +
      (due && !a.done ? ' (' + esc(P.countdown(due, now)) + ')' : '') + '</div></div>' +
      '<span class="status ' + (info ? info.status : 'done') + '">' + esc(info ? statusLabel(info) : 'Done') + '</span>' +
      '<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="Progress"><span style="width:' + pct + '%"></span></div>' +
      '<div class="numbers"><span><b>' + fmtH(a.doneHours || 0) + '</b> of ' + fmtH(a.estHours) + ' done</span>' +
      (a.done ? '' : '<span><b>' + fmtH(P.remainingHours(a)) + '</b> left</span>') + (finish ? '<span>' + finish + '</span>' : '') + '</div>' +
      (a.notes ? '<p class="notes">' + esc(a.notes) + '</p>' : '') +
      '<div class="card-actions">' +
      (a.done
        ? '<button class="icon-btn" data-action="undone" data-id="' + a.id + '">Move back to active</button>'
        : '<button class="icon-btn" data-action="focus" data-id="' + a.id + '">Start focus</button>' +
          '<button class="icon-btn" data-action="log" data-id="' + a.id + '">Log time</button>' +
          '<button class="icon-btn" data-action="done" data-id="' + a.id + '">Mark done</button>') +
      '<button class="icon-btn" data-action="edit" data-id="' + a.id + '">Edit</button>' +
      '<button class="icon-btn" data-action="delete" data-id="' + a.id + '">Delete</button></div></article>';
  }

  function coursesPanel() {
    const items = state.courses.map(c => {
      const sw = COLORS.map(col => '<button type="button" class="swatch" style="--c:' + col + '" data-action="course-color" data-id="' + c.id + '" data-color="' + col + '" aria-pressed="' + (c.color === col) + '" aria-label="Colour ' + col + '"></button>').join('');
      const used = state.assignments.filter(a => a.courseId === c.id).length;
      return '<li><span class="course-dot" style="--c:' + c.color + '"></span><input type="text" value="' + esc(c.name) + '" data-course-name="' + c.id + '" aria-label="Course name" maxlength="40">' +
        '<div class="swatches">' + sw + '</div><button class="icon-btn" data-action="course-del" data-id="' + c.id + '" title="' + used + ' assignment(s)">Remove</button></li>';
    }).join('');
    return '<section class="panel" style="margin-top:28px"><h2>Courses <small>Colours carry through the whole app</small></h2>' +
      (items ? '<ul class="course-list">' + items + '</ul>' : '<p class="muted">No courses yet.</p>') +
      '<form class="btn-row" style="margin-top:14px" data-form="course-add"><input name="name" placeholder="New course, e.g. Operating Systems" maxlength="40" style="flex:1;min-width:200px" aria-label="New course name">' +
      '<button class="btn ghost" type="submit">Add course</button></form></section>';
  }

  VIEWS.focus = function () {
    const active = state.assignments.filter(a => !a.done).sort((x, y) => (P.parseLocal(x.due) || 0) - (P.parseLocal(y.due) || 0));
    const t = timer();
    const opts = '<option value="">No assignment (just focus)</option>' + active.map(a => '<option value="' + a.id + '"' + (t.taskId === a.id ? ' selected' : '') + '>' + esc(a.title) + '</option>').join('');
    const todaySessions = sessionsOn(P.dayKey(clock())).slice().reverse();
    const list = todaySessions.length
      ? '<ul class="session-list">' + todaySessions.map(s => {
        const a = assignment(s.assignmentId);
        return '<li><span>' + esc(fmtTime(new Date(s.at))) + '  ' + esc(a ? a.title : 'Free focus') + '</span><b>' + s.minutes + ' min</b></li>';
      }).join('') + '</ul>'
      : '<p class="muted">Finished focus sessions are logged here and count toward the assignment automatically.</p>';
    const C = 2 * Math.PI * 140;
    return '<div class="page-head"><div><h1>Focus</h1><p>' + state.settings.focusMin + ' minutes of work, then a ' + state.settings.breakMin + '-minute break. Every fourth break is ' + state.settings.longBreakMin + ' minutes.</p></div></div>' +
      '<div class="focus-wrap"><section class="panel"><label class="field focus-task"><span>Working on</span><select id="focusTask">' + opts + '</select></label>' +
      '<div class="dial" id="dial"><svg viewBox="0 0 320 320" aria-hidden="true"><circle class="track" cx="160" cy="160" r="140" fill="none" stroke-width="14"/>' +
      '<circle class="ring" id="ring" cx="160" cy="160" r="140" fill="none" stroke-width="14" stroke-linecap="round" stroke-dasharray="' + C + '" stroke-dashoffset="0"/></svg>' +
      '<div class="dial-center"><div class="dial-time" id="dialTime" role="timer" aria-live="off">25:00</div><div class="dial-phase" id="dialPhase">Focus</div></div></div>' +
      '<div class="focus-controls" id="focusControls"></div><div class="pips" id="pips" role="img" aria-label="Focus sessions this round"></div></section>' +
      '<section class="panel"><h2>Today’s sessions</h2>' + list + '</section></div>';
  };

  VIEWS.settings = function () {
    const s = state.settings;
    const week = WEEK_ORDER.map(i => '<label>' + DOW[i] + '<input type="number" min="0" max="16" step="0.5" value="' + s.capacity[i] + '" data-cap="' + i + '" inputmode="decimal"></label>').join('');
    const total = s.capacity.reduce((a, b) => a + Number(b || 0), 0);
    const themeBtn = t => '<button type="button" data-action="theme" data-theme="' + t + '" aria-pressed="' + (s.theme === t) + '">' + ({ auto: 'Match system', light: 'Light', dark: 'Dark' })[t] + '</button>';
    return '<div class="page-head"><div><h1>Settings</h1><p>Leeway only plans inside the hours you say you have. Be honest here and the warnings will be worth listening to.</p></div></div>' +
      '<div class="settings-grid">' +
      '<section class="panel"><h2>Study hours per day</h2><p class="muted">Time you can realistically spend on assignments, outside lectures. <span id="weekTotal">' + fmtH(total) + '</span> a week.</p><div class="week-grid">' + week + '</div></section>' +
      '<section class="panel"><h2>Focus timer</h2><div class="row2" style="grid-template-columns:repeat(3,1fr)">' +
      '<label class="field"><span>Focus (min)</span><input type="number" min="5" max="120" step="5" value="' + s.focusMin + '" data-setting="focusMin"></label>' +
      '<label class="field"><span>Break (min)</span><input type="number" min="1" max="30" step="1" value="' + s.breakMin + '" data-setting="breakMin"></label>' +
      '<label class="field"><span>Long break (min)</span><input type="number" min="5" max="60" step="5" value="' + s.longBreakMin + '" data-setting="longBreakMin"></label></div></section>' +
      '<section class="panel"><h2>Appearance</h2><div class="segmented" role="group" aria-label="Theme" style="margin-top:4px">' + themeBtn('auto') + themeBtn('light') + themeBtn('dark') + '</div></section>' +
      '<section class="panel"><h2>Your data</h2><p class="muted">Everything is stored in this browser only. Nothing is sent anywhere. Export a backup to move it to another device.</p>' +
      '<div class="btn-row"><button class="btn ghost" data-action="export-json">Export backup</button>' +
      '<button class="btn ghost" data-action="import-json">Import backup</button>' +
      '<button class="btn ghost" data-action="demo">Load sample data</button>' +
      '<button class="btn danger" data-action="clear-all">Delete all data</button></div>' +
      '<input type="file" id="importFile" accept="application/json,.json" hidden></section></div>';
  };

  // ---------------- dialogs ----------------
  const aDialog = () => $('#assignmentDialog');

  function openAssignmentDialog(id) {
    const dlg = aDialog();
    const form = $('#assignmentForm');
    const a = id ? assignment(id) : null;
    form.reset();
    form.dataset.id = id || '';
    $('#assignmentDialogTitle').textContent = a ? 'Edit assignment' : 'Add assignment';
    const sel = form.elements.courseId;
    sel.innerHTML = '<option value="">No course</option>' + state.courses.map(c => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('') +
      '<option value="__new">+ New course…</option>';
    form.querySelectorAll('[data-edit-only]').forEach(el => { el.hidden = !a; });
    form.querySelector('.form-error').hidden = true;
    form.querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
    if (a) {
      const d = P.parseLocal(a.due);
      form.elements.title.value = a.title;
      sel.value = a.courseId || '';
      form.elements.estHours.value = a.estHours;
      form.elements.doneHours.value = a.doneHours || 0;
      form.elements.dueDate.value = d ? P.dayKey(d) : '';
      form.elements.dueTime.value = d ? fmtTime(d) : '23:59';
      form.elements.notes.value = a.notes || '';
    } else {
      const lastCourse = state.assignments.length ? state.assignments[state.assignments.length - 1].courseId : '';
      sel.value = course(lastCourse) ? lastCourse : '';
      form.elements.estHours.value = 3;
      form.elements.dueDate.value = P.dayKey(P.addDays(clock(), 7));
      form.elements.dueTime.value = '23:59';
    }
    dlg.showModal();
    form.elements.title.focus();
  }

  function submitAssignment(e) {
    e.preventDefault();
    const form = e.target;
    const f = form.elements;
    const err = form.querySelector('.form-error');
    const problems = [];
    const title = f.title.value.trim();
    const est = parseFloat(f.estHours.value);
    const done = f.doneHours.value === '' ? 0 : parseFloat(f.doneHours.value);
    const due = f.dueDate.value + 'T' + (f.dueTime.value || '23:59');
    form.querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
    if (!title) { problems.push('Give the assignment a title.'); f.title.setAttribute('aria-invalid', 'true'); }
    if (!(est > 0) || est > 200) { problems.push('Estimate the work in hours, between 0.25 and 200.'); f.estHours.setAttribute('aria-invalid', 'true'); }
    if (!f.dueDate.value || !P.parseLocal(due)) { problems.push('Pick a due date.'); f.dueDate.setAttribute('aria-invalid', 'true'); }
    if (!(done >= 0)) { problems.push('Hours done can’t be negative.'); f.doneHours.setAttribute('aria-invalid', 'true'); }
    if (problems.length) {
      err.textContent = problems.join(' ');
      err.hidden = false;
      const first = form.querySelector('[aria-invalid="true"]');
      if (first) first.focus();
      return;
    }
    let courseId = f.courseId.value;
    if (courseId === '__new') courseId = '';
    const id = form.dataset.id;
    if (id) {
      const a = assignment(id);
      Object.assign(a, { title, courseId, estHours: est, doneHours: Math.min(done, 200), due, notes: f.notes.value.trim() });
      toast('Saved ' + title + '.');
    } else {
      state.assignments.push({ id: uid(), title, courseId, estHours: est, doneHours: 0, due, notes: f.notes.value.trim(), done: false, createdAt: new Date().toISOString() });
      const d = P.parseLocal(due);
      if (d && d.getTime() <= clock().getTime()) toast('Added. That due date is already in the past.');
      else toast('Added ' + title + '. Your plan is updated.');
    }
    save();
    aDialog().close();
    render();
  }

  let logTarget = null;
  function openLogDialog(id) {
    const a = assignment(id);
    if (!a) return;
    logTarget = id;
    const form = $('#logForm');
    form.reset();
    form.elements.minutes.value = 30;
    $('#logFor').textContent = a.title + ' (' + fmtH(a.doneHours || 0) + ' of ' + fmtH(a.estHours) + ' done)';
    $('#logDialog').showModal();
    form.elements.minutes.focus();
  }

  function logMinutes(id, minutes, source) {
    const a = id ? assignment(id) : null;
    state.sessions.push({ id: uid(), assignmentId: a ? a.id : null, at: clock().toISOString(), minutes: Math.round(minutes), source: source || 'manual' });
    if (a) {
      const before = a.doneHours || 0;
      a.doneHours = Math.round((before + minutes / 60) * 100) / 100;
      save();
      if (before < a.estHours && a.doneHours >= a.estHours) {
        toast('You’ve hit your estimate for ' + a.title + '.', 'Mark done', () => setDone(a.id, true));
        return;
      }
    }
    save();
  }

  function setDone(id, done) {
    const a = assignment(id);
    if (!a) return;
    a.done = done;
    a.doneAt = done ? new Date().toISOString() : null;
    if (timer().taskId === id && done) { timer().taskId = null; }
    save();
    render();
    if (done) toast('Marked ' + a.title + ' done.', 'Undo', () => setDone(id, false));
  }

  // ---------------- focus timer ----------------
  function phaseMinutes(phase) {
    const s = state.settings;
    return phase === 'focus' ? s.focusMin : phase === 'long' ? s.longBreakMin : s.breakMin;
  }
  function timer() {
    if (!state.timer) state.timer = { phase: 'focus', running: false, endsAt: null, remainingMs: phaseMinutes('focus') * 60000, taskId: null, round: 0 };
    return state.timer;
  }
  function timerRemaining() {
    const t = timer();
    return t.running ? Math.max(0, t.endsAt - Date.now()) : t.remainingMs;
  }
  function startTimer() {
    const t = timer();
    if (t.running) return;
    t.endsAt = Date.now() + t.remainingMs;
    t.running = true;
    t.startedAt = t.startedAt || Date.now();
    unlockAudio();
    if ('Notification' in window && Notification.permission === 'default') { try { Notification.requestPermission(); } catch (e) { /* ignore */ } }
    save(); updateTimerUI();
  }
  function pauseTimer() {
    const t = timer();
    if (!t.running) return;
    t.remainingMs = Math.max(0, t.endsAt - Date.now());
    t.running = false;
    save(); updateTimerUI();
  }
  function resetTimer() {
    const t = timer();
    t.running = false; t.remainingMs = phaseMinutes(t.phase) * 60000; t.startedAt = null;
    save(); updateTimerUI();
  }
  function nextPhase(skip) {
    const t = timer();
    if (t.phase === 'focus') {
      if (!skip) {
        logMinutes(t.taskId, state.settings.focusMin, 'focus');
        t.round = (t.round || 0) + 1;
      }
      t.phase = t.round > 0 && t.round % 4 === 0 && !skip ? 'long' : 'short';
    } else {
      t.phase = 'focus';
      if (t.round >= 4) t.round = 0;
    }
    t.running = false; t.startedAt = null;
    t.remainingMs = phaseMinutes(t.phase) * 60000;
    save();
  }
  function finishEarly() {
    const t = timer();
    if (t.phase !== 'focus') return;
    const elapsedMin = Math.floor((phaseMinutes('focus') * 60000 - timerRemaining()) / 60000);
    if (elapsedMin < 1) { resetTimer(); return; }
    logMinutes(t.taskId, elapsedMin, 'focus');
    const a = assignment(t.taskId);
    t.running = false; t.startedAt = null; t.remainingMs = phaseMinutes('focus') * 60000;
    save(); render();
    toast('Logged ' + elapsedMin + ' min' + (a ? ' on ' + a.title : '') + '.');
  }

  function completePhase() {
    const t = timer();
    const wasFocus = t.phase === 'focus';
    const a = assignment(t.taskId);
    nextPhase(false);
    beep();
    const msg = wasFocus
      ? 'Focus done' + (a ? ': ' + state.settings.focusMin + ' min logged on ' + a.title : '') + '. Take a break.'
      : 'Break over. Ready for the next round?';
    toast(msg);
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      try { new Notification('Leeway', { body: msg }); } catch (e) { /* ignore */ }
    }
    render();
  }

  function fmtClock(ms) {
    const s = Math.ceil(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function updateTimerUI() {
    const t = timer();
    const rem = timerRemaining();
    const total = phaseMinutes(t.phase) * 60000;
    const timeEl = $('#dialTime');
    if (timeEl) {
      timeEl.textContent = fmtClock(rem);
      $('#dialPhase').textContent = t.phase === 'focus' ? (t.running ? 'Focusing' : 'Focus') : t.phase === 'long' ? 'Long break' : 'Short break';
      const ring = $('#ring');
      const C = 2 * Math.PI * 140;
      ring.style.strokeDashoffset = String(C * (1 - rem / total));
      $('#dial').classList.toggle('break', t.phase !== 'focus');
      const controls = $('#focusControls');
      const sig = [t.running, t.phase, rem < total].join();
      if (controls.dataset.sig !== sig) {
        controls.dataset.sig = sig;
        controls.innerHTML = (t.running
          ? '<button class="btn primary" data-action="timer-pause">Pause</button>'
          : '<button class="btn primary" data-action="timer-start">' + (rem < total ? 'Resume' : t.phase === 'focus' ? 'Start focus' : 'Start break') + '</button>') +
          (t.phase === 'focus'
            ? (rem < total ? '<button class="btn ghost" data-action="timer-finish">Finish and log</button>' : '')
            : '<button class="btn ghost" data-action="timer-skip">Skip break</button>') +
          (rem < total ? '<button class="btn ghost" data-action="timer-reset">Reset</button>' : '');
      }
      const pips = $('#pips');
      pips.setAttribute('aria-label', (t.round || 0) + ' of 4 focus sessions done this round');
      pips.innerHTML = [0, 1, 2, 3].map(i => '<span class="pip' + (i < (t.round || 0) ? ' on' : '') + '"></span>').join('');
    }
    document.title = t.running ? fmtClock(rem) + ' ' + (t.phase === 'focus' ? 'Focus' : 'Break') + ' – Leeway' : 'Leeway – study planner';
    updateMiniTimer();
  }

  function updateMiniTimer() {
    const t = state.timer;
    const el = $('#miniTimer');
    if (!t || (!t.running && !t.startedAt) || route() === 'focus') { el.hidden = true; return; }
    const a = assignment(t.taskId);
    el.hidden = false;
    el.innerHTML = '<strong>' + fmtClock(timerRemaining()) + '</strong><span>' + (t.phase === 'focus' ? (a ? esc(a.title) : 'Focus') : 'Break') + (t.running ? '' : ' (paused)') + '</span>';
  }

  let audioCtx = null;
  function unlockAudio() {
    try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audioCtx = null; }
  }
  function beep() {
    if (!audioCtx) return;
    try {
      [0, 0.25, 0.5].forEach((delay, i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.frequency.value = i === 2 ? 880 : 660;
        g.gain.setValueAtTime(0.0001, audioCtx.currentTime + delay);
        g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + delay + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + delay + 0.22);
        o.connect(g).connect(audioCtx.destination);
        o.start(audioCtx.currentTime + delay);
        o.stop(audioCtx.currentTime + delay + 0.25);
      });
    } catch (e) { /* ignore */ }
  }

  setInterval(() => {
    const t = state.timer;
    if (!t || !t.running) return;
    if (Date.now() >= t.endsAt) completePhase();
    else updateTimerUI();
  }, 250);

  // ---------------- export / import ----------------
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportIcs() {
    const plan = computePlan();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const ymd = d => P.dayKey(d).replace(/-/g, '');
    const icsText = s => String(s).replace(/\\/g, '\\\\').replace(/[,;]/g, m => '\\' + m).replace(/\n/g, '\\n');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Leeway//Study planner//EN', 'CALSCALE:GREGORIAN'];
    plan.days.forEach(d => d.blocks.forEach(b => {
      const a = assignment(b.id);
      lines.push('BEGIN:VEVENT', 'UID:' + d.key + '-' + b.id + '@leeway', 'DTSTAMP:' + stamp,
        'DTSTART;VALUE=DATE:' + ymd(d.date), 'DTEND;VALUE=DATE:' + ymd(P.addDays(d.date, 1)),
        'SUMMARY:' + icsText('Study ' + fmtH(b.hours) + ': ' + a.title), 'TRANSP:TRANSPARENT', 'END:VEVENT');
    }));
    state.assignments.filter(a => !a.done).forEach(a => {
      const d = P.parseLocal(a.due);
      if (!d) return;
      const t = ymd(d) + 'T' + fmtTime(d).replace(':', '') + '00';
      lines.push('BEGIN:VEVENT', 'UID:due-' + a.id + '@leeway', 'DTSTAMP:' + stamp, 'DTSTART:' + t, 'DTEND:' + t,
        'SUMMARY:' + icsText('Due: ' + a.title), 'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    download('leeway-plan.ics', lines.join('\r\n'), 'text/calendar');
    toast('Calendar file downloaded. Open it to add the plan to your calendar.');
  }

  function importJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.assignments)) throw new Error('shape');
        state = normalize(data);
        state.timer = null;
        save(); render();
        toast('Imported ' + state.assignments.length + ' assignments.');
      } catch (e) {
        toast('That file isn’t a Leeway backup. Nothing was changed.');
      }
    };
    reader.readAsText(file);
  }

  // ---------------- sample data ----------------
  function loadDemo() {
    const now = clock();
    const at = (days, time) => P.dayKey(P.addDays(now, days)) + 'T' + time;
    const courses = [
      { id: 'c-net', name: 'Networking', color: COLORS[0] },
      { id: 'c-os', name: 'Operating Systems', color: COLORS[1] },
      { id: 'c-cloud', name: 'Cloud Computing', color: COLORS[2] },
      { id: 'c-chem', name: 'Chemistry', color: COLORS[3] }
    ];
    const A = (id, title, courseId, due, est, done, extra) => Object.assign({ id, title, courseId, due, estHours: est, doneHours: done, done: false, notes: '', createdAt: now.toISOString() }, extra);
    const assignments = [
      A('a1', 'Subnetting lab report', 'c-net', at(2, '23:59'), 5, 1.5, { notes: 'Include the VLSM table and the Packet Tracer file.' }),
      A('a2', 'Titration pre-lab quiz', 'c-chem', at(1, '09:00'), 1, 0),
      A('a3', 'Group project milestone 2', 'c-cloud', at(3, '16:00'), 10, 2, { notes: 'Architecture diagram and cost estimate.' }),
      A('a4', 'Process scheduling essay', 'c-os', at(6, '14:00'), 6, 0),
      A('a5', 'Deploy a container to the cloud', 'c-cloud', at(10, '23:59'), 8, 1),
      A('a6', 'Virtualization reading notes', 'c-os', at(13, '23:59'), 3, 0),
      A('a7', 'Midterm prep: TCP/IP', 'c-net', at(17, '10:00'), 10, 0),
      A('a8', 'Lab 1: VLAN setup', 'c-net', at(-4, '23:59'), 3, 3, { done: true })
    ];
    const sess = (daysAgo, hour, id, min) => {
      const d = P.addDays(now, -daysAgo); d.setHours(hour, 10);
      return { id: uid(), assignmentId: id, at: d.toISOString(), minutes: min, source: 'focus' };
    };
    const sessions = [sess(1, 10, 'a1', 50), sess(1, 14, 'a3', 75), sess(2, 11, 'a1', 40), sess(2, 19, 'a5', 60), sess(3, 13, 'a3', 45)];
    state = normalize({ courses, assignments, sessions, settings: state.settings, ui: { filter: 'active' } });
    save();
    if (route() === 'settings') location.hash = '#today'; else render();
    toast('Sample data loaded. It’s all made up.');
  }

  // ---------------- theme ----------------
  function applyTheme() {
    const t = state.settings.theme;
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }

  // ---------------- events ----------------
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const id = el.dataset.id;
    switch (el.dataset.action) {
      case 'add': openAssignmentDialog(); break;
      case 'edit': openAssignmentDialog(id); break;
      case 'log': openLogDialog(id); break;
      case 'done': setDone(id, true); break;
      case 'undone': setDone(id, false); break;
      case 'delete': {
        const idx = state.assignments.findIndex(a => a.id === id);
        if (idx < 0) break;
        const [removed] = state.assignments.splice(idx, 1);
        if (timer().taskId === id) timer().taskId = null;
        save(); render();
        toast('Deleted ' + removed.title + '.', 'Undo', () => { state.assignments.splice(idx, 0, removed); save(); render(); });
        break;
      }
      case 'focus': {
        const t = timer();
        if (t.running && t.phase === 'focus' && t.taskId !== id) pauseTimer();
        t.taskId = id;
        if (t.phase !== 'focus') { t.phase = 'focus'; t.remainingMs = phaseMinutes('focus') * 60000; t.running = false; }
        save();
        location.hash = '#focus';
        setTimeout(startTimer, 0);
        break;
      }
      case 'day': {
        const card = document.getElementById('day-' + el.dataset.key);
        document.querySelectorAll('.day-card.highlight').forEach(c => c.classList.remove('highlight'));
        if (card) {
          card.classList.add('highlight');
          card.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
        } else toast('Nothing planned or due on that day.');
        break;
      }
      case 'mode': state.settings.mode = el.dataset.mode; save(); render(); break;
      case 'filter': state.ui.filter = el.dataset.filter; save(); render(); break;
      case 'demo':
        if (state.assignments.length && !confirm('Replace your current assignments with sample data?')) break;
        loadDemo(); break;
      case 'timer-start': startTimer(); break;
      case 'timer-pause': pauseTimer(); break;
      case 'timer-reset': resetTimer(); break;
      case 'timer-skip': nextPhase(true); render(); break;
      case 'timer-finish': finishEarly(); break;
      case 'course-color': { const c = course(id); if (c) { c.color = el.dataset.color; save(); render(); } break; }
      case 'course-del': {
        const c = course(id);
        if (!c) break;
        const n = state.assignments.filter(a => a.courseId === id).length;
        if (n && !confirm('Remove ' + c.name + '? Its ' + n + ' assignment(s) will be kept without a course.')) break;
        state.courses = state.courses.filter(x => x.id !== id);
        state.assignments.forEach(a => { if (a.courseId === id) a.courseId = ''; });
        save(); render();
        break;
      }
      case 'theme': state.settings.theme = el.dataset.theme; save(); render(); break;
      case 'export-json': download('leeway-backup-' + P.dayKey(new Date()) + '.json', JSON.stringify(state, null, 2), 'application/json'); toast('Backup downloaded.'); break;
      case 'import-json': $('#importFile').click(); break;
      case 'export-ics': exportIcs(); break;
      case 'clear-all':
        if (confirm('Delete all assignments, courses and logged time? This can’t be undone.')) {
          const settings = state.settings;
          state = defaultState(); state.settings = settings; save(); render(); toast('All data deleted.');
        }
        break;
    }
  });

  document.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'focusTask') { timer().taskId = t.value || null; save(); updateMiniTimer(); }
    if (t.id === 'importFile' && t.files[0]) importJson(t.files[0]);
    if (t.dataset.courseName) {
      const c = course(t.dataset.courseName);
      const name = t.value.trim();
      if (c && name) { c.name = name; save(); toast('Renamed to ' + name + '.'); } else if (c) t.value = c.name;
    }
    if (t.name === 'courseId' && t.value === '__new') {
      const name = (prompt('Name of the new course') || '').trim();
      if (name) {
        const c = { id: uid(), name: name.slice(0, 40), color: COLORS[state.courses.length % COLORS.length] };
        state.courses.push(c); save();
        const opt = document.createElement('option'); opt.value = c.id; opt.textContent = c.name;
        t.insertBefore(opt, t.lastElementChild); t.value = c.id;
      } else t.value = '';
    }
  });

  document.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.cap !== undefined) {
      const v = parseFloat(t.value);
      if (v >= 0 && v <= 16) { state.settings.capacity[+t.dataset.cap] = v; save(); t.removeAttribute('aria-invalid'); }
      else t.setAttribute('aria-invalid', 'true');
      const w = $('#weekTotal'); if (w) w.textContent = fmtH(state.settings.capacity.reduce((a, b) => a + Number(b || 0), 0));
    }
    if (t.dataset.setting) {
      const v = parseInt(t.value, 10);
      const min = +t.min, max = +t.max;
      if (v >= min && v <= max) {
        state.settings[t.dataset.setting] = v;
        const tm = timer();
        if (!tm.running && !tm.startedAt) tm.remainingMs = phaseMinutes(tm.phase) * 60000;
        save(); t.removeAttribute('aria-invalid');
      } else t.setAttribute('aria-invalid', 'true');
    }
  });

  document.addEventListener('submit', e => {
    if (e.target.id === 'assignmentForm') return submitAssignment(e);
    if (e.target.id === 'logForm') {
      e.preventDefault();
      const m = parseInt(e.target.elements.minutes.value, 10);
      if (!(m >= 5 && m <= 720)) { e.target.elements.minutes.setAttribute('aria-invalid', 'true'); return; }
      const a = assignment(logTarget);
      $('#logDialog').close();
      logMinutes(logTarget, m, 'manual');
      render();
      if (a && a.doneHours < a.estHours) toast('Logged ' + m + ' min on ' + a.title + '.');
      return;
    }
    if (e.target.dataset.form === 'course-add') {
      e.preventDefault();
      const name = e.target.elements.name.value.trim();
      if (!name) { e.target.elements.name.focus(); return; }
      state.courses.push({ id: uid(), name: name.slice(0, 40), color: COLORS[state.courses.length % COLORS.length] });
      save(); render();
      toast('Added ' + name + '.');
      const inp = document.querySelector('[data-form="course-add"] input'); if (inp) inp.focus();
    }
  });

  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  $('#logQuick').addEventListener('click', e => {
    const b = e.target.closest('[data-min]');
    if (b) $('#logForm').elements.minutes.value = b.dataset.min;
  });
  document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));
  $('#miniTimer').addEventListener('click', () => { location.hash = '#focus'; });

  let lastRoute = null;
  window.addEventListener('hashchange', () => {
    render();
    if (lastRoute !== null) { window.scrollTo(0, 0); $('#main').focus({ preventScroll: true }); }
    lastRoute = route();
  });
  window.addEventListener('storage', e => { if (e.key === STORAGE_KEY) { state = load(); render(); } });
  // Re-render periodically so countdowns and "today" stay correct if the tab is left open.
  setInterval(() => { if (!document.querySelector('dialog[open]') && route() !== 'focus' && !document.activeElement.matches('input,select,textarea')) render(); }, 60000);

  // Keyboard: "n" adds an assignment, space toggles the timer on the Focus page.
  document.addEventListener('keydown', e => {
    if (e.target.matches('input,select,textarea') || document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'n') { e.preventDefault(); openAssignmentDialog(); }
    if (e.key === ' ' && route() === 'focus' && !e.target.matches('button')) { e.preventDefault(); timer().running ? pauseTimer() : startTimer(); }
  });

  // If a focus phase ended while the tab was closed, complete it now.
  if (state.timer && state.timer.running && Date.now() >= state.timer.endsAt) completePhase();
  render();
  lastRoute = route();
})();
