// Calendar files. Deploy with "Verify JWT" turned OFF – links are opened straight from Safari/Calendar.
//   GET ?plan=<plan id>      → one event, for "Add to my calendar"
//   GET ?feed=<feed token>   → every chosen date in your groups, for a Calendar subscription
import { createClient } from 'npm:@supabase/supabase-js@2';

type Option = { id: string; starts_at: string; ends_at: string };
type Plan = { id: string; title: string; note: string; status: string; locked_option_id: string | null; plan_options: Option[]; groups?: { name: string } | null };

const stamp = (d: string | Date) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const escText = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);

// RFC 5545: lines longer than 75 octets must be folded.
function fold(line: string) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (new TextEncoder().encode(cur + ch).length > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function vevent(p: Plan): string[] {
  const o = p.plan_options.find((x) => x.id === p.locked_option_id);
  if (!o) return [];
  const desc = [p.groups?.name ? `With ${p.groups.name}` : '', p.note].filter(Boolean).join('\n\n');
  return [
    'BEGIN:VEVENT',
    `UID:${p.id}@friends-planner`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(o.starts_at)}`,
    `DTEND:${stamp(o.ends_at)}`,
    `SUMMARY:${escText(p.title)}`,
    ...(desc ? [`DESCRIPTION:${escText(desc)}`] : []),
    'END:VEVENT',
  ];
}

function calendar(name: string, plans: Plan[]) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Friends planner//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escText(name)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...plans.flatMap(vevent),
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

const SELECT = 'id,title,note,status,locked_option_id,plan_options(id,starts_at,ends_at),groups(name)';

Deno.serve(async (req) => {
  const params = new URL(req.url).searchParams;
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const headers = { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache' };

  const planId = params.get('plan');
  const feed = params.get('feed');

  if (planId && /^[0-9a-f-]{36}$/i.test(planId)) {
    const { data: plan } = await admin.from('plans').select(SELECT).eq('id', planId).eq('status', 'locked').maybeSingle();
    if (!plan) return new Response('No chosen date for this plan yet.', { status: 404 });
    return new Response(calendar((plan as unknown as Plan).title, [plan as unknown as Plan]), {
      headers: { ...headers, 'Content-Disposition': 'inline; filename="friends.ics"' },
    });
  }

  if (feed && /^[0-9a-f]{20,64}$/i.test(feed)) {
    const { data: tok } = await admin.from('user_tokens').select('user_id').eq('feed_token', feed).maybeSingle();
    if (!tok) return new Response('Unknown calendar link.', { status: 404 });
    const { data: groups } = await admin.from('group_members').select('group_id').eq('user_id', tok.user_id);
    const groupIds = (groups ?? []).map((g) => g.group_id);
    const { data: plans } = groupIds.length
      ? await admin.from('plans').select(SELECT).in('group_id', groupIds).eq('status', 'locked')
      : { data: [] };
    return new Response(calendar('Friends', (plans ?? []) as unknown as Plan[]), { headers });
  }

  return new Response('Missing plan or feed.', { status: 400 });
});
