// Unit tests for the planning engine. Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/planner.js');

// Monday 2 Nov 2026, 09:00 local
const NOW = new Date(2026, 10, 2, 9, 0);
const FLAT = { capacity: [3, 3, 3, 3, 3, 3, 3], mode: 'spread' };

function a(id, due, est, extra) {
  return Object.assign({ id, title: id, due, estHours: est, doneHours: 0, done: false }, extra);
}
function sumScheduled(plan, id) {
  return plan.days.reduce((s, d) => s + d.blocks.filter(b => b.id === id).reduce((x, b) => x + b.hours, 0), 0);
}

test('formatHours reads naturally', () => {
  assert.equal(P.formatHours(2.5), '2 h 30 min');
  assert.equal(P.formatHours(0.75), '45 min');
  assert.equal(P.formatHours(3), '3 h');
  assert.equal(P.formatHours(0), '0 min');
  assert.equal(P.formatHours(-1.5), '−1 h 30 min');
});

test('parseLocal treats input as local time and rejects junk', () => {
  const d = P.parseLocal('2026-11-05T23:55');
  assert.equal(d.getDate(), 5);
  assert.equal(d.getHours(), 23);
  assert.equal(P.parseLocal('nonsense'), null);
  assert.equal(P.parseLocal(''), null);
});

test('morning deadlines do not count their due day', () => {
  assert.equal(P.dayKey(P.lastWorkDay(new Date(2026, 10, 5, 9, 0), NOW)), '2026-11-04');
  assert.equal(P.dayKey(P.lastWorkDay(new Date(2026, 10, 5, 23, 55), NOW)), '2026-11-05');
});

test('every hour of a feasible assignment is scheduled before its deadline', () => {
  const plan = P.buildPlan([a('x', '2026-11-06T23:55', 7)], FLAT, NOW, 0);
  assert.equal(sumScheduled(plan, 'x'), 7);
  assert.equal(plan.info.x.status, 'comfortable');
  assert.ok(plan.days.filter(d => d.key > '2026-11-06').every(d => d.blocks.length === 0));
});

test('spread mode spreads work instead of front-loading', () => {
  const plan = P.buildPlan([a('x', '2026-11-08T23:55', 7)], FLAT, NOW, 0);
  const perDay = plan.days.slice(0, 7).map(d => d.used);
  assert.ok(Math.max(...perDay) <= 1.5, 'no day should carry more than 1.5 h: ' + perDay);
  assert.equal(plan.modeUsed, 'spread');
});

test('asap mode front-loads', () => {
  const plan = P.buildPlan([a('x', '2026-11-08T23:55', 7)], Object.assign({}, FLAT, { mode: 'asap' }), NOW, 0);
  assert.equal(plan.days[0].used, 3);
  assert.equal(plan.days[1].used, 3);
  assert.equal(plan.days[2].used, 1);
});

test('daily capacity is never exceeded', () => {
  const list = [a('a', '2026-11-04T23:55', 4), a('b', '2026-11-05T23:55', 5), a('c', '2026-11-10T23:55', 6)];
  const plan = P.buildPlan(list, FLAT, NOW, 0);
  plan.days.forEach(d => assert.ok(d.used <= d.capacity + 1e-9, d.key + ' over capacity'));
});

test('impossible workload is flagged with the exact shortfall', () => {
  // Due Tuesday evening: Mon + Tue = 6 h available, 10 h needed
  const plan = P.buildPlan([a('big', '2026-11-03T23:55', 10)], FLAT, NOW, 0);
  assert.equal(plan.info.big.status, 'at-risk');
  assert.equal(plan.info.big.shortfall, 4);
  assert.equal(plan.info.big.leeway, -4);
});

test('spread falls back to asap when spreading would miss a deadline', () => {
  // Later task with a high daily rate would steal capacity from the earlier one under naive spreading.
  const list = [a('early', '2026-11-04T23:55', 8), a('late', '2026-11-05T23:55', 4)];
  const plan = P.buildPlan(list, FLAT, NOW, 0);
  assert.equal(plan.totalShortfall, 0);
  assert.equal(sumScheduled(plan, 'early'), 8);
  assert.equal(sumScheduled(plan, 'late'), 4);
});

test('uneven capacity: plan never misses a deadline that asap could meet', () => {
  // Regression case found by a randomized search: Monday 0 h, big days later in the week.
  const settings = { capacity: [4, 0, 2, 4, 3, 3, 2], mode: 'spread' };
  const list = [a('a', '2026-11-04T23:55', 2.5), a('b', '2026-11-07T23:55', 5),
    a('c', '2026-11-03T23:55', 5), a('d', '2026-11-05T23:55', 6.5)];
  const spread = P.buildPlan(list, settings, NOW, 0);
  const asap = P.buildPlan(list, Object.assign({}, settings, { mode: 'asap' }), NOW, 0);
  assert.ok(spread.totalShortfall <= asap.totalShortfall);
});

test('leeway accounts for everything due earlier', () => {
  const list = [a('first', '2026-11-03T23:55', 4), a('second', '2026-11-04T23:55', 4)];
  const plan = P.buildPlan(list, FLAT, NOW, 0);
  assert.equal(plan.info.first.leeway, 2);   // 6 h available - 4
  assert.equal(plan.info.second.leeway, 1);  // 9 h available - 8
  assert.equal(plan.info.second.status, 'tight');
});

test('time already logged today reduces today\'s capacity', () => {
  const plan = P.buildPlan([a('x', '2026-11-03T23:55', 6)], FLAT, NOW, 2);
  assert.equal(plan.days[0].capacity, 1);
  assert.equal(plan.info.x.status, 'at-risk');
});

test('late in the evening, today only offers the time left before midnight', () => {
  const late = new Date(2026, 10, 2, 22, 30);
  const plan = P.buildPlan([a('x', '2026-11-04T23:55', 2)], FLAT, late, 0);
  assert.equal(plan.days[0].capacity, 1); // 1.5 h left minus 30 min buffer
});

test('done, overdue and progress are handled', () => {
  const list = [
    a('done', '2026-11-04T23:55', 3, { done: true }),
    a('late', '2026-11-01T12:00', 2),
    a('half', '2026-11-04T23:55', 4, { doneHours: 3 })
  ];
  const plan = P.buildPlan(list, FLAT, NOW, 0);
  assert.equal(plan.info.done.status, 'done');
  assert.equal(plan.info.late.status, 'overdue');
  assert.equal(sumScheduled(plan, 'half'), 1);
  assert.equal(sumScheduled(plan, 'done'), 0);
});

test('a zero-capacity weekend is skipped', () => {
  const settings = { capacity: [0, 3, 3, 3, 3, 3, 0], mode: 'asap' };
  const fri = new Date(2026, 10, 6, 9, 0);
  const plan = P.buildPlan([a('x', '2026-11-09T23:55', 5)], settings, fri, 0);
  assert.equal(plan.days[1].used, 0); // Saturday
  assert.equal(plan.days[2].used, 0); // Sunday
  assert.equal(sumScheduled(plan, 'x'), 5);
});

test('countdown wording', () => {
  assert.equal(P.countdown(new Date(2026, 10, 5, 13, 0), NOW), 'in 3 d 4 h');
  assert.equal(P.countdown(new Date(2026, 10, 2, 9, 45), NOW), 'in 45 min');
  assert.equal(P.countdown(new Date(2026, 10, 2, 7, 0), NOW), '2 h ago');
});

test('stress: 40 random assignments never break invariants', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const list = [];
  for (let i = 0; i < 40; i++) {
    const day = 2 + Math.floor(rnd() * 40);
    const d = new Date(2026, 10, day, Math.floor(rnd() * 24), 0);
    list.push(a('t' + i, P.dayKey(d) + 'T' + String(d.getHours()).padStart(2, '0') + ':00', Math.round(rnd() * 20) / 2));
  }
  const plan = P.buildPlan(list, FLAT, NOW, 0);
  plan.days.forEach(d => assert.ok(d.used <= d.capacity + 1e-9));
  list.forEach(t => {
    const info = plan.info[t.id];
    if (info.status === 'done' || info.status === 'overdue') return;
    const got = sumScheduled(plan, t.id) + info.shortfall;
    assert.ok(Math.abs(got - P.unitsToHours(P.hoursToUnits(t.estHours))) < 1e-9, t.id + ' hours lost');
    plan.days.forEach(d => d.blocks.forEach(b => { if (b.id === t.id) assert.ok(d.key <= info.lastDay); }));
  });
});
