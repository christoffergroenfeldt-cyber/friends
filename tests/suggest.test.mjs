// Run: TZ=Europe/Copenhagen node --test tests/suggest.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggest, slotsForDay, WINDOW_PRESETS, memberStatus, busyByMember, dayKey } from '../js/suggest.js';

const members = [
  { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C', blockAllDay: false },
];
const now = new Date('2026-11-02T08:00:00+01:00').getTime();   // Monday morning

test('slots respect windows and duration', () => {
  const fri = new Date('2026-11-06T12:00:00+01:00');
  const s = slotsForDay(fri, [WINDOW_PRESETS[1]], 240, 60);
  assert.equal(s.length, 3);                                  // 18,19,20 start → end by 24
  assert.equal(new Date(s[0].start).getHours(), 18);
  assert.equal(new Date(s.at(-1).end).getHours(), 0);
});

test('long duration in short window gives one slot at window start', () => {
  const s = slotsForDay(new Date('2026-11-02T12:00'), [WINDOW_PRESETS[0]], 600, 30);
  assert.equal(s.length, 1);
});

test('DST day still starts slots at local 18:00', () => {
  const s = slotsForDay(new Date('2027-03-28T12:00:00'), [{ days: [0], start: '18:00', end: '22:00' }], 120, 60);
  assert.equal(new Date(s[0].start).getHours(), 18);
});

test('ranking prefers days where everyone is free', () => {
  const busy = [
    { user_id: 'a', starts_at: '2026-11-06T17:00:00+01:00', ends_at: '2026-11-06T23:00:00+01:00' }, // A busy Fri evening
    { user_id: 'b', starts_at: '2026-11-07T00:00:00+01:00', ends_at: '2026-11-08T00:00:00+01:00', all_day: true }, // B all-day Sat
    { user_id: 'c', starts_at: '2026-11-13T00:00:00+01:00', ends_at: '2026-11-14T00:00:00+01:00', all_day: true }, // C all-day, ignored
  ];
  const r = suggest({
    members, busy, now, durationMin: 180, windows: [WINDOW_PRESETS[1]],
    from: new Date('2026-11-02T00:00'), to: new Date('2026-11-15T00:00'),
  });
  assert.equal(r.days.get('2026-11-06').free.length, 2);
  assert.equal(r.days.get('2026-11-07').free.length, 2);
  assert.equal(r.days.get('2026-11-04'), null);              // Wednesday: no window
  assert.equal(dayKey(r.top[0].start), '2026-11-13');        // C's all-day event doesn't count
  assert.equal(r.top[0].free.length, 3);
  assert.equal(r.top[1].free.length, 3);                     // Sat 14th
});

test('required people come first', () => {
  const busy = [{ user_id: 'a', starts_at: '2026-11-06T00:00:00+01:00', ends_at: '2026-11-07T00:00:00+01:00' }];
  const r = suggest({
    members, busy, now, durationMin: 180, windows: [{ days: [5, 6], start: '18:00', end: '23:00' }],
    from: new Date('2026-11-06T00:00'), to: new Date('2026-11-07T00:00'), required: ['a'],
  });
  assert.equal(dayKey(r.top[0].start), '2026-11-07');
  assert.equal(r.top[1].requiredOk, false);
});

test('past slots are skipped', () => {
  const r = suggest({
    members, busy: [], now: new Date('2026-11-06T19:30:00+01:00').getTime(), durationMin: 120,
    windows: [WINDOW_PRESETS[1]], from: new Date('2026-11-06T00:00'), to: new Date('2026-11-06T00:00'), stepMin: 60,
  });
  assert.equal(new Date(r.top[0].start).getHours(), 20);
});

test('implicit answers come from the calendar', () => {
  const busy = [{ user_id: 'b', starts_at: '2026-11-06T19:00:00+01:00', ends_at: '2026-11-06T20:00:00+01:00' }];
  const map = busyByMember(members, busy);
  const opt = { id: 'o1', starts_at: '2026-11-06T18:00:00+01:00', ends_at: '2026-11-06T22:00:00+01:00' };
  const votes = [{ option_id: 'o1', user_id: 'a', answer: 'maybe' }];
  assert.deepEqual(memberStatus(members[0], opt, votes, map), { answer: 'maybe', implicit: false });
  assert.deepEqual(memberStatus(members[1], opt, votes, map), { answer: 'no', implicit: true });
  assert.deepEqual(memberStatus(members[2], opt, votes, map), { answer: 'yes', implicit: true });
});

test('people without a connected calendar are unknown, not free', () => {
  const ms = [{ id: 'a' }, { id: 'b', unknown: true }];
  const r = suggest({ members: ms, busy: [], now, durationMin: 120, windows: [{ days: [5], start: '18:00', end: '22:00' }],
    from: new Date('2026-11-06T00:00'), to: new Date('2026-11-06T00:00'), required: ['b'] });
  assert.deepEqual(r.top[0].free, ['a']);
  assert.deepEqual(r.top[0].unknown, ['b']);
  assert.equal(r.top[0].requiredOk, true);
  const opt = { id: 'o', starts_at: '2026-11-06T18:00:00+01:00', ends_at: '2026-11-06T20:00:00+01:00' };
  assert.equal(memberStatus(ms[1], opt, [], busyByMember(ms, [])).answer, 'unknown');
});
