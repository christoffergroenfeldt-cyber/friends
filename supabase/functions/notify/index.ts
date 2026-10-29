// Sends push notifications to group members.
// Called by the app with the user's session:
//   { type: 'plan_created' | 'plan_locked' | 'nudge' | 'test', plan_id }
//
// Secrets (Supabase → Edge Functions → Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:you@example.com),
//   APP_URL (e.g. https://you.github.io/friends/), APP_TIMEZONE (default Europe/Copenhagen)
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const firstName = (n?: string | null) => (n || 'Someone').trim().split(/\s+/)[0];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: 'Not signed in' }, 401);

    const pub = Deno.env.get('VAPID_PUBLIC_KEY');
    const priv = Deno.env.get('VAPID_PRIVATE_KEY');
    if (!pub || !priv) return json({ error: 'VAPID keys are not set' }, 500);
    webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com', pub, priv);

    const appUrl = Deno.env.get('APP_URL') || '';
    const tz = Deno.env.get('APP_TIMEZONE') || 'Europe/Copenhagen';
    const { type, plan_id } = await req.json();

    let recipients: string[] = [];
    let payload: Record<string, string> = {};

    if (type === 'test') {
      recipients = [user.id];
      payload = { title: 'Friends', body: 'Notifications are working.', url: appUrl, tag: 'test' };
    } else {
      const { data: plan, error } = await admin
        .from('plans')
        .select('id,title,group_id,created_by,status,locked_option_id,plan_options(id,starts_at,ends_at)')
        .eq('id', plan_id)
        .single();
      if (error || !plan) return json({ error: 'Plan not found' }, 404);
      if (plan.created_by !== user.id) return json({ error: 'Only the person who made the plan can do this' }, 403);

      const { data: members } = await admin.from('group_members').select('user_id').eq('group_id', plan.group_id);
      const ids = (members ?? []).map((m) => m.user_id as string);
      const { data: me } = await admin.from('profiles').select('name').eq('id', user.id).single();
      const who = firstName(me?.name);
      const planUrl = `${appUrl}#/plan/${plan.id}`;
      const others = ids.filter((id) => id !== user.id);

      if (type === 'plan_created') {
        recipients = others;
        payload = { title: plan.title, body: `${who} wants to find a date. Tap to answer.`, url: planUrl, tag: plan.id };
      } else if (type === 'plan_locked') {
        const o = plan.plan_options.find((x: { id: string }) => x.id === plan.locked_option_id);
        if (!o) return json({ error: 'No date chosen' }, 400);
        const when = new Date(o.starts_at).toLocaleString('en-GB', {
          timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
        });
        recipients = others;
        payload = { title: plan.title, body: `It's on: ${when}. Tap to add it to your calendar.`, url: planUrl, tag: plan.id };
      } else if (type === 'nudge') {
        const optionIds = plan.plan_options.map((o: { id: string }) => o.id);
        const { data: votes } = await admin.from('votes').select('option_id,user_id').in('option_id', optionIds);
        recipients = others.filter((id) => !optionIds.every((oid: string) => (votes ?? []).some((v) => v.option_id === oid && v.user_id === id)));
        payload = { title: plan.title, body: `${who} is waiting for your answer.`, url: planUrl, tag: plan.id };
      } else {
        return json({ error: 'Unknown type' }, 400);
      }
    }

    if (!recipients.length) return json({ sent: 0 });
    const { data: subs } = await admin.from('push_subscriptions').select('*').in('user_id', recipients);

    const results = await Promise.allSettled(
      (subs ?? []).map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify(payload),
            { TTL: 60 * 60 * 24, urgency: 'high' },
          );
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) await admin.from('push_subscriptions').delete().eq('id', s.id);
          throw e;
        }
      }),
    );
    return json({ sent: results.filter((r) => r.status === 'fulfilled').length, failed: results.filter((r) => r.status === 'rejected').length });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
