// Date suggestion engine – pure functions, no DOM, no network.
// All times are handled in the phone's local time zone.

export const WINDOW_PRESETS = [
  { id: 'weekday-evening', label: 'Weekday evenings', days: [1, 2, 3, 4], start: '18:00', end: '23:00' },
  { id: 'fri-sat-evening', label: 'Fri & Sat evenings', days: [5, 6], start: '18:00', end: '24:00' },
  { id: 'weekend-day',     label: 'Weekend daytime',  days: [6, 0], start: '10:00', end: '18:00' },
  { id: 'sunday-evening',  label: 'Sunday evening',   days: [0],    start: '17:00', end: '22:00' },
];

const MIN = 60 * 1000;

function parseHM(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + (m || 0);
}

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function dayKey(d) {
  const x = new Date(d);
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${x.getFullYear()}-${m}-${day}`;
}

/** Busy intervals per member, honouring each member's all-day preference. */
export function busyByMember(members, busy) {
  const map = new Map(members.map((m) => [m.id, []]));
  const blockAllDay = new Map(members.map((m) => [m.id, m.blockAllDay !== false]));
  for (const b of busy) {
    if (!map.has(b.user_id)) continue;
    if (b.all_day && !blockAllDay.get(b.user_id)) continue;
    map.get(b.user_id).push([new Date(b.starts_at).getTime(), new Date(b.ends_at).getTime()]);
  }
  return map;
}

export function isFree(intervals, start, end) {
  for (const [s, e] of intervals) if (s < end && e > start) return false;
  return true;
}

/** Candidate slots for one day, from the chosen time windows. */
export function slotsForDay(day, windows, durationMin, stepMin = 30) {
  const base = startOfDay(day).getTime();
  const weekday = new Date(base).getDay();
  const out = [];
  const seen = new Set();
  for (const w of windows) {
    if (!w.days.includes(weekday)) continue;
    const ws = parseHM(w.start);
    const we = parseHM(w.end);
    const lastStart = Math.max(ws, we - durationMin);
    for (let t = ws; t <= lastStart; t += stepMin) {
      // Use setHours rather than adding milliseconds so DST changes are handled.
      const s = new Date(base);
      s.setHours(0, t, 0, 0);
      const key = s.getTime();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ start: key, end: key + durationMin * MIN });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Rank possible dates.
 * @returns {{days: Map<string, DayInfo>, top: Slot[]}}
 *   days: per calendar day → best slot that day (for the heatmap)
 *   top:  best slot per day, ranked best first
 */
export function suggest({ members, busy, from, to, durationMin, windows, required = [], now = Date.now(), stepMin = 30 }) {
  const busyMap = busyByMember(members, busy);
  const total = members.length;
  const days = new Map();

  for (let d = startOfDay(from); d <= to; d = addDays(d, 1)) {
    let best = null;
    for (const slot of slotsForDay(d, windows, durationMin, stepMin)) {
      if (slot.start < now) continue;
      const free = [];
      const busyIds = [];
      const unknown = [];
      for (const m of members) {
        // Someone who has never shared a calendar can't be assumed free.
        if (m.unknown) { unknown.push(m.id); continue; }
        (isFree(busyMap.get(m.id), slot.start, slot.end) ? free : busyIds).push(m.id);
      }
      const requiredOk = required.every((id) => free.includes(id) || unknown.includes(id));
      const candidate = { ...slot, free, busy: busyIds, unknown, requiredOk, total };
      if (!best || better(candidate, best)) best = candidate;
    }
    days.set(dayKey(d), best ? { ...best, ratio: total ? best.free.length / total : 0 } : null);
  }

  const top = [...days.values()].filter(Boolean).sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));
  return { days, top };
}

// Prefer: all required people free → most people free → earliest.
function better(a, b) {
  if (a.requiredOk !== b.requiredOk) return a.requiredOk;
  if (a.free.length !== b.free.length) return a.free.length > b.free.length;
  return a.start < b.start;
}

/** What each member is expected to answer for an option: their vote, or their calendar's guess. */
export function memberStatus(member, option, votes, busyMap) {
  const v = votes.find((x) => x.option_id === option.id && x.user_id === member.id);
  if (v) return { answer: v.answer, implicit: false };
  if (member.unknown) return { answer: 'unknown', implicit: true };
  const start = new Date(option.starts_at).getTime();
  const end = new Date(option.ends_at).getTime();
  const free = isFree(busyMap.get(member.id) || [], start, end);
  return { answer: free ? 'yes' : 'no', implicit: true };
}

/** Score an option: explicit yes = 1, implicit yes = 0.75, maybe = 0.5. */
export function optionScore(members, option, votes, busyMap) {
  let score = 0;
  let yes = 0;
  for (const m of members) {
    const s = memberStatus(m, option, votes, busyMap);
    if (s.answer === 'yes') { score += s.implicit ? 0.75 : 1; yes++; }
    else if (s.answer === 'maybe') score += 0.5;
  }
  return { score, yes };
}
