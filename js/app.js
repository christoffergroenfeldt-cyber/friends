import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { CONFIG } from './config.js';
import * as S from './suggest.js';

// ===================================================================
// Setup
// ===================================================================
const configured = !CONFIG.SUPABASE_URL.includes('YOUR-PROJECT') && !CONFIG.SUPABASE_ANON_KEY.startsWith('YOUR-');
const sb = configured
  ? createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    })
  : null;

const $app = document.getElementById('app');
const $top = document.getElementById('topbar');
const $toast = document.getElementById('toast');

const state = { session: null, me: null, tokens: null, refreshable: false };
const LS_PENDING_INVITE = 'friends.pendingInvite';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ===================================================================
// Small helpers
// ===================================================================
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = $app) => root.querySelector(sel);
const $$ = (sel, root = $app) => [...root.querySelectorAll(sel)];
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

const LOCALE = 'en-GB';
const fmtDay = (d) => new Date(d).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDayLong = (d) => new Date(d).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
const fmtTime = (d) => new Date(d).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
const fmtRange = (s, e) => `${fmtTime(s)}–${fmtTime(e)}`;
const fmtWhen = (d) => `${fmtDay(d)} at ${fmtTime(d)}`;
const initials = (name) => (name || '?').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
const firstName = (name) => (name || 'Someone').trim().split(/\s+/)[0];
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function ago(ts) {
  if (!ts) return null;
  const min = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (min < 2) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
const isStale = (ts) => !ts || Date.now() - new Date(ts).getTime() > 3 * 24 * 3600 * 1000;
function syncLabel(p) {
  if (!p.last_synced_at) return '<span class="sync-state stale">Calendar not connected</span>';
  const cls = isStale(p.last_synced_at) ? 'sync-state stale' : 'sync-state';
  return `<span class="${cls}">Calendar synced ${ago(p.last_synced_at)}</span>`;
}

let toastTimer;
function toast(msg, ms = 2800) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.hidden = true; }, ms);
}

function render(html, { refreshable = false } = {}) {
  state.refreshable = refreshable;
  $app.innerHTML = html;
  window.scrollTo(0, 0);
}

function topbar(title = '', { back = null, right = '' } = {}) {
  if (!title && !back && !right) { $top.innerHTML = ''; return; }
  $top.innerHTML = `
    <div class="side">${back ? `<a class="btn link" href="${back}">Back</a>` : ''}</div>
    <div class="title">${esc(title)}</div>
    <div class="side right">${right}</div>`;
}

function errText(err) {
  return err?.message || err?.error_description || String(err || 'Something went wrong. Try again.');
}
function fail(err) {
  console.error(err);
  toast(errText(err), 7000);
}

async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

async function copy(text, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(what); }
  catch { prompt('Copy this:', text); }
}

async function notify(type, planId) {
  try { await sb.functions.invoke('notify', { body: { type, plan_id: planId } }); }
  catch (e) { console.warn('notify failed', e); }
}

const icsUrl = (planId) => `${CONFIG.SUPABASE_URL}/functions/v1/ics?plan=${planId}`;
const feedUrl = (token) => `${CONFIG.SUPABASE_URL.replace(/^https:/, 'webcal:')}/functions/v1/ics?feed=${token}`;
const inviteUrl = (code) => `${location.origin}${location.pathname}#/join/${code}`;

// ===================================================================
// Data
// ===================================================================
async function loadMe() {
  const uid = state.session.user.id;
  const [me, tokens] = await Promise.all([
    q(sb.from('profiles').select('*').eq('id', uid).maybeSingle()),
    q(sb.from('user_tokens').select('*').eq('user_id', uid).maybeSingle()),
  ]);
  state.me = me || { id: uid, name: '', block_all_day: true };
  state.tokens = tokens;
}

async function loadGroupPeople(groupId) {
  const rows = await q(sb.from('group_members').select('user_id').eq('group_id', groupId));
  const ids = rows.map((r) => r.user_id);
  const profiles = ids.length ? await q(sb.from('profiles').select('*').in('id', ids)) : [];
  return profiles
    .map((p) => ({ ...p, blockAllDay: p.block_all_day, unknown: !p.last_synced_at }))
    .sort((a, b) => (a.id === state.me.id ? -1 : b.id === state.me.id ? 1 : a.name.localeCompare(b.name)));
}

async function loadBusy(userIds, from, to) {
  if (!userIds.length) return [];
  return q(
    sb.from('busy_blocks')
      .select('user_id,starts_at,ends_at,all_day')
      .in('user_id', userIds)
      .lt('starts_at', new Date(to).toISOString())
      .gt('ends_at', new Date(from).toISOString())
  );
}

// ===================================================================
// Router
// ===================================================================
const routes = [
  [/^\/$/, viewHome],
  [/^\/group\/([\w-]+)$/, viewGroup],
  [/^\/group\/([\w-]+)\/new$/, viewNewPlan],
  [/^\/plan\/([\w-]+)$/, viewPlan],
  [/^\/settings$/, viewSettings],
  [/^\/welcome$/, viewWelcome],
  [/^\/sync$/, viewSyncSetup],
];

async function route() {
  try {
    if (!configured) return viewNotConfigured();
    const path = location.hash.slice(1) || '/';

    const join = path.match(/^\/join\/(\w+)$/);
    if (join) {
      localStorage.setItem(LS_PENDING_INVITE, join[1].toLowerCase());
      if (!isStandalone() && !sessionStorage.getItem('friends.continueInBrowser')) return viewInstall(join[1]);
      history.replaceState(null, '', '#/');
    }

    if (!state.session) return viewLogin();
    if (!state.me) await loadMe();
    ensurePush();

    const pending = localStorage.getItem(LS_PENDING_INVITE);
    if (pending) {
      localStorage.removeItem(LS_PENDING_INVITE);
      try {
        const gid = await q(sb.rpc('join_group', { p_code: pending }));
        toast('You joined the group');
        if (!state.me.name) return go('#/welcome');
        return go(`#/group/${gid}`);
      } catch (e) { fail(e); }
    }

    if (!state.me.name && path !== '/welcome') return go('#/welcome');

    for (const [re, view] of routes) {
      const m = path.match(re);
      if (m) return await view(...m.slice(1));
    }
    go('#/');
  } catch (e) {
    console.error(e);
    topbar();
    render(`
      <h1>Something went wrong</h1>
      <div class="notice">${esc(errText(e))}</div>
      <p class="small muted">If this keeps happening, take a screenshot of this message.</p>
      <button class="block" id="retry">Try again</button>
      <button class="block link" id="out">Sign out</button>`);
    $('#retry').onclick = () => route();
    $('#out').onclick = async () => { await sb.auth.signOut(); state.session = null; state.me = null; route(); };
  }
}

window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.refreshable && state.session) route();
});

// ===================================================================
// Views: not configured / install / login / welcome
// ===================================================================
function viewNotConfigured() {
  topbar();
  render(`
    <h1>Almost there</h1>
    <p class="lede">This copy of Friends isn't connected to a database yet.</p>
    <div class="card"><p>Open <b>js/config.js</b> and fill in your Supabase project URL and anon key. The README in the repository explains each step.</p></div>`);
}

function viewInstall(code) {
  topbar();
  render(`
    <h1>You're invited</h1>
    <p class="lede">Friends finds the dates when everyone is free. Install it on your Home Screen first, so you get a ping when there's something to answer.</p>
    <div class="card">
      <ol class="steps">
        <li>Tap the Share button in Safari.</li>
        <li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li>
        <li>Open Friends from your Home Screen and sign in.</li>
        <li>Enter this invite code when asked:</li>
      </ol>
      <p class="token center" style="font-size:24px">${esc(code)}</p>
    </div>
    <a class="btn block guide" href="guide.html"><svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor" opacity=".22"/><path d="M10 8l6 4-6 4z" fill="currentColor"/></svg>Watch the setup guide (1½ min)</a>
    <p class="center"><button class="link" id="browser">Use it in Safari instead</button></p>`);
  $('#browser').onclick = () => {
    sessionStorage.setItem('friends.continueInBrowser', '1');
    route();
  };
}

function viewLogin() {
  topbar();
  const pendingInvite = localStorage.getItem(LS_PENDING_INVITE);
  render(`
    <h1>Friends</h1>
    <p class="lede">Find a date that works for everyone, straight from your calendars.</p>
    <form id="email-form" class="stack">
      <label class="field"><span>Your email</span>
        <input type="email" name="email" autocomplete="email" inputmode="email" required placeholder="you@example.com"></label>
      <button class="block" type="submit">Send me a sign-in code</button>
    </form>
    <form id="code-form" class="stack hidden">
      <p>We've emailed you a sign-in code. It can take a minute to arrive. Use the code from the newest email.</p>
      <label class="field"><span>Code</span>
        <input class="code" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required></label>
      <div class="notice hidden" id="login-error"></div>
      <button class="block" type="submit">Sign in</button>
      <button class="link block" type="button" id="restart">Use a different email</button>
    </form>
    ${isStandalone() ? `
    <h2>Got an invite code?</h2>
    <label class="field"><span>Invite code</span>
      <input type="text" id="invite" value="${esc(pendingInvite || '')}" autocapitalize="off" placeholder="e.g. 3fa9c21b0d"></label>
    <p class="small muted">You'll join the group as soon as you're signed in.</p>` : ''}`);

  let email = '';
  $('#email-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = ev.submitter; btn.disabled = true;
    email = ev.target.email.value.trim().toLowerCase();
    try {
      await q(sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } }));
      $('#email-form').classList.add('hidden');
      $('#code-form').classList.remove('hidden');
      $('#code-form').code.focus();
    } catch (e) { fail(e); }
    btn.disabled = false;
  };
  $('#code-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = ev.submitter; btn.disabled = true;
    const invite = $('#invite')?.value.trim();
    if (invite) localStorage.setItem(LS_PENDING_INVITE, invite.toLowerCase());
    try {
      const data = await q(sb.auth.verifyOtp({ email, token: ev.target.code.value.replace(/\s/g, ''), type: 'email' }));
      state.session = data.session;
      state.me = null;
      route();
    } catch (e) {
      console.error(e);
      const box = $('#login-error');
      box.textContent = /expired|invalid/i.test(errText(e))
        ? 'That code is wrong or has expired. Request a new one with "Use a different email" and use the code from the newest email.'
        : errText(e);
      box.classList.remove('hidden');
      btn.disabled = false;
    }
  };
  $('#restart').onclick = () => {
    $('#code-form').classList.add('hidden');
    $('#email-form').classList.remove('hidden');
  };
}

function viewWelcome() {
  topbar();
  render(`
    <h1>Welcome</h1>
    <p class="lede">What should your friends see you as?</p>
    <form id="f">
      <label class="field"><span>Your name</span>
        <input type="text" name="name" required autocomplete="given-name" value="${esc(state.me.name)}"></label>
      <button class="block" type="submit">Continue</button>
    </form>`);
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    const name = ev.target.name.value.trim();
    try {
      await q(sb.from('profiles').update({ name }).eq('id', state.me.id));
      state.me.name = name;
      go('#/sync');
    } catch (e) { fail(e); }
  };
}

// ===================================================================
// Calendar sync (shared by setup screen and settings)
// ===================================================================
function syncSection() {
  const t = state.tokens?.sync_token || '';
  const hasShortcut = !!CONFIG.SHORTCUT_URL;
  return `
    <div class="card stack">
      <div class="row between"><h3>Calendar sync</h3>${syncLabel(state.me)}</div>
      <p class="small muted">A Shortcut on your iPhone reads when you're busy and sends only the start and end times. Event names, places and notes never leave your phone.</p>
      <a class="btn block guide" href="guide.html"><svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor" opacity=".22"/><path d="M10 8l6 4-6 4z" fill="currentColor"/></svg>Watch how to set it up (1½ min)</a>
      <ol class="steps">
        <li>${hasShortcut
          ? `<a class="btn quiet" href="${esc(CONFIG.SHORTCUT_URL)}" target="_blank" rel="noopener">Get the Friends Sync shortcut</a>`
          : 'Get the <b>Friends Sync</b> shortcut from whoever set up the app.'}</li>
        <li>Tap <b>Add Shortcut</b>. When it asks for your sync code, paste this:
          <div class="token" id="sync-token">${esc(t)}</div>
          <button class="link" data-copy="${esc(t)}">Copy sync code</button></li>
        <li>In the iPhone <b>Settings</b> app, go to <b>Apps → Shortcuts → Advanced</b> and switch on <b>Allow Sharing Large Amounts of Data</b>.</li>
        <li>Run it once and choose <b>Allow</b> when it asks for your calendar and to send data.</li>
        <li>In Shortcuts, open <b>Automation</b> → <b>New Automation</b> → <b>Time of Day</b>, pick a morning time, Daily, choose <b>Run Immediately</b>, then select Friends Sync.</li>
      </ol>
      <button class="block quiet" id="sync-now">Sync now</button>
    </div>`;
}

function wireSyncSection() {
  $$('[data-copy]').forEach((b) => { b.onclick = () => copy(b.dataset.copy, 'Sync code copied'); });
  const btn = $('#sync-now');
  if (btn) btn.onclick = () => {
    location.href = `shortcuts://run-shortcut?name=${encodeURIComponent(CONFIG.SHORTCUT_NAME)}`;
  };
}

async function viewSyncSetup() {
  const cals = await loadCalendars();
  topbar('Connect your calendar');
  render(`
    <p class="lede" style="margin-top:12px">So Friends can suggest dates when you're free.</p>
    ${syncSection()}
    ${calendarsSection(cals)}
    ${pushCard()}
    <p style="margin-top:20px"><a class="btn block" href="#/">${state.me.last_synced_at ? 'Done' : 'I\'ll do it later'}</a></p>`, { refreshable: true });
  wireSyncSection();
  wireCalendars();
  wirePushCard();
}


// ===================================================================
// Which calendars count (names are private to the owner)
// ===================================================================
async function loadCalendars() {
  try { return await q(sb.from('user_calendars').select('id,name,included').eq('user_id', state.me.id).order('name')); }
  catch { return []; }
}
function calendarsSection(cals) {
  if (!state.me.last_synced_at) return '';
  return `
    <div class="card stack" style="margin-top:12px" id="cals">
      <h3>Calendars that make you busy</h3>
      <p class="small muted">Only you can see these names. Friends only see when you're busy.</p>
      ${cals.length ? cals.map((c) => `
        <label class="switch"><span>${esc(c.name)}</span>
          <input type="checkbox" data-cal="${c.id}" ${c.included ? 'checked' : ''}></label>`).join('')
      : '<p class="small">Your shortcut doesn\'t send calendar names yet. Get the latest Friends Sync shortcut above, then run it once, and your calendars will show up here.</p>'}
    </div>`;
}
function wireCalendars() {
  $$('[data-cal]').forEach((box) => {
    box.onchange = async () => {
      try {
        await q(sb.from('user_calendars').update({ included: box.checked }).eq('id', box.dataset.cal));
        toast(box.checked ? 'Calendar included' : 'Calendar ignored');
      } catch (e) { box.checked = !box.checked; fail(e); }
    };
  });
}

// ===================================================================
// Home
// ===================================================================
async function viewHome() {
  topbar('', { right: '<a class="btn link" href="#/settings">Settings</a>' });
  const uid = state.me.id;
  const [groups, plans, myVotes] = await Promise.all([
    q(sb.from('groups').select('id,name').order('created_at')),
    q(sb.from('plans').select('id,title,group_id,status,deadline,created_by,locked_option_id,plan_options!plan_options_plan_id_fkey(id,starts_at,ends_at)').in('status', ['open', 'locked']).order('created_at', { ascending: false })),
    q(sb.from('votes').select('option_id').eq('user_id', uid)),
  ]);
  const voted = new Set(myVotes.map((v) => v.option_id));
  const groupName = Object.fromEntries(groups.map((g) => [g.id, g.name]));

  const waiting = plans.filter((p) => p.status === 'open' && p.plan_options.some((o) => !voted.has(o.id)));
  const open = plans.filter((p) => p.status === 'open' && !waiting.includes(p));
  const upcoming = plans
    .filter((p) => p.status === 'locked')
    .map((p) => ({ ...p, slot: p.plan_options.find((o) => o.id === p.locked_option_id) }))
    .filter((p) => p.slot && new Date(p.slot.ends_at) > Date.now())
    .sort((a, b) => new Date(a.slot.starts_at) - new Date(b.slot.starts_at));

  const planRow = (p, sub) => `
    <a href="#/plan/${p.id}" class="chev"><div class="grow"><h3>${esc(p.title)}</h3><div class="small muted">${esc(sub)}</div></div></a>`;

  render(`
    <h1>Hi ${esc(firstName(state.me.name))}</h1>
    ${isStale(state.me.last_synced_at) ? `
      <div class="notice"><b>${state.me.last_synced_at ? 'Your calendar is out of date.' : 'Your calendar isn\'t connected.'}</b>
      Friends can't see when you're busy. <a href="#/sync">Connect it</a></div>` : ''}
    ${!isStandalone() ? `<div class="notice small">Add Friends to your Home Screen (Share → Add to Home Screen) to get notifications.</div>` : ''}
    ${pushCard()}

    ${waiting.length ? `<h2>Waiting for your answer</h2>
      <div class="list">${waiting.map((p) => planRow(p, `${groupName[p.group_id] || ''}${p.deadline ? ` · answer by ${fmtWhen(p.deadline)}` : ''}`)).join('')}</div>` : ''}

    ${upcoming.length ? `<h2>Coming up</h2>
      <div class="list">${upcoming.map((p) => planRow(p, `${fmtDay(p.slot.starts_at)}, ${fmtRange(p.slot.starts_at, p.slot.ends_at)}`)).join('')}</div>` : ''}

    ${open.length ? `<h2>Still deciding</h2>
      <div class="list">${open.map((p) => planRow(p, `${groupName[p.group_id] || ''} · you've answered`)).join('')}</div>` : ''}

    <h2>Your groups</h2>
    <div class="list">
      ${groups.length ? groups.map((g) => `<a href="#/group/${g.id}" class="chev"><div class="avatar">${esc(initials(g.name))}</div><div class="grow">${esc(g.name)}</div></a>`).join('')
        : '<div class="empty">Create a group for your friends, or join one with an invite code.</div>'}
    </div>

    <form id="new-group" class="row" style="margin-top:14px">
      <input type="text" name="name" placeholder="New group name" required class="grow">
      <button type="submit">Create</button>
    </form>
    <form id="join" class="row" style="margin-top:10px">
      <input type="text" name="code" placeholder="Invite code" autocapitalize="off" required class="grow">
      <button type="submit" class="quiet">Join</button>
    </form>`, { refreshable: true });

  wirePushCard();
  $('#new-group').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const gid = await q(sb.rpc('create_group', { p_name: ev.target.name.value }));
      go(`#/group/${gid}`);
    } catch (e) { fail(e); }
  };
  $('#join').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const gid = await q(sb.rpc('join_group', { p_code: ev.target.code.value }));
      toast('You joined the group');
      go(`#/group/${gid}`);
    } catch (e) { fail(e); }
  };
}

// ===================================================================
// Group
// ===================================================================
async function viewGroup(gid) {
  const [group, people, plans] = await Promise.all([
    q(sb.from('groups').select('*').eq('id', gid).single()),
    loadGroupPeople(gid),
    q(sb.from('plans').select('id,title,status,locked_option_id,plan_options!plan_options_plan_id_fkey(id,starts_at,ends_at)').eq('group_id', gid).order('created_at', { ascending: false }).limit(20)),
  ]);
  topbar(group.name, { back: '#/' });

  const planSub = (p) => {
    if (p.status === 'cancelled') return 'Cancelled';
    if (p.status === 'locked') {
      const o = p.plan_options.find((x) => x.id === p.locked_option_id);
      return o ? `${fmtDay(o.starts_at)}, ${fmtRange(o.starts_at, o.ends_at)}` : 'Date chosen';
    }
    return `${p.plan_options.length} dates to vote on`;
  };

  render(`
    <a class="btn block" href="#/group/${gid}/new" style="margin-top:12px">Plan something</a>

    <h2>Plans</h2>
    <div class="list">
      ${plans.length ? plans.map((p) => `<a href="#/plan/${p.id}" class="chev"><div class="grow"><h3>${esc(p.title)}</h3><div class="small muted">${esc(planSub(p))}</div></div></a>`).join('')
        : '<div class="empty">No plans yet. Tap Plan something to find a date.</div>'}
    </div>

    <h2>People</h2>
    <div class="list">
      ${people.map((p) => `<div><div class="avatar">${esc(initials(p.name))}</div><div class="grow">${esc(p.name)}${p.id === state.me.id ? ' <span class="muted">(you)</span>' : ''}<br>${syncLabel(p)}</div></div>`).join('')}
    </div>

    <h2>Invite friends</h2>
    <div class="card stack">
      <p class="small muted">Send this link. On their iPhone it explains how to install Friends and join this group.</p>
      <div class="token">${esc(inviteUrl(group.invite_code))}</div>
      <button class="block quiet" id="share">Share invite</button>
    </div>

    <p class="center" style="margin-top:28px"><button class="danger" id="leave">Leave group</button></p>`, { refreshable: true });

  $('#share').onclick = async () => {
    const url = inviteUrl(group.invite_code);
    const guide = `${location.origin}${location.pathname}guide.html`;
    const text = `Join "${group.name}" on Friends so we can find dates that work for everyone. Invite code: ${group.invite_code}\n\nSetup guide (1½ min): ${guide}`;
    if (navigator.share) { try { await navigator.share({ title: 'Friends', text, url }); } catch {} }
    else copy(url, 'Invite link copied');
  };
  $('#leave').onclick = async () => {
    if (!confirm(`Leave ${group.name}? You'll need a new invite to come back.`)) return;
    try {
      await q(sb.from('group_members').delete().eq('group_id', gid).eq('user_id', state.me.id));
      go('#/');
    } catch (e) { fail(e); }
  };
}

// ===================================================================
// New plan: constraints → suggestions → send
// ===================================================================
async function viewNewPlan(gid) {
  const [group, people] = await Promise.all([
    q(sb.from('groups').select('id,name').eq('id', gid).single()),
    loadGroupPeople(gid),
  ]);
  topbar('Plan something', { back: `#/group/${gid}` });

  const defaults = { windows: ['fri-sat-evening'], required: new Set() };
  render(`
    <form id="f" style="margin-top:12px">
      <label class="field"><span>What's the plan?</span>
        <input type="text" name="title" required placeholder="Poker night, dinner, a trip…"></label>
      <label class="field"><span>Details (optional)</span>
        <textarea name="note" placeholder="Where, what to bring…"></textarea></label>

      <div class="field"><span class="small muted">When could it be?</span>
        <div class="chips" id="windows" style="margin-top:6px">
          ${S.WINDOW_PRESETS.map((w) => `<button type="button" class="chip" data-w="${w.id}" aria-pressed="${defaults.windows.includes(w.id)}">${esc(w.label)}</button>`).join('')}
        </div>
      </div>

      <div class="row" style="margin-top:16px">
        <label class="field grow"><span>How long</span>
          <select name="duration">
            <option value="120">2 hours</option><option value="180" selected>3 hours</option>
            <option value="240">4 hours</option><option value="360">6 hours</option><option value="600">All day</option>
          </select></label>
        <label class="field grow"><span>Look ahead</span>
          <select name="weeks">
            <option value="2">2 weeks</option><option value="4" selected>4 weeks</option>
            <option value="8">8 weeks</option><option value="12">3 months</option>
          </select></label>
      </div>

      <div class="field"><span class="small muted">Who must be there? (optional)</span>
        <div class="chips" id="required" style="margin-top:6px">
          ${people.map((p) => `<button type="button" class="chip" data-u="${p.id}" aria-pressed="false">${esc(firstName(p.name))}</button>`).join('')}
        </div>
      </div>

      <label class="field" style="margin-top:16px"><span>Answer by</span>
        <select name="deadline">
          <option value="24">Tomorrow</option><option value="48" selected>In 2 days</option>
          <option value="72">In 3 days</option><option value="168">In a week</option><option value="">No deadline</option>
        </select></label>

      <button class="block" type="submit">Find dates</button>
    </form>
    <div id="results"></div>`);

  const toggle = (btn) => btn.setAttribute('aria-pressed', btn.getAttribute('aria-pressed') !== 'true');
  $$('#windows .chip, #required .chip').forEach((b) => { b.onclick = () => toggle(b); });

  $('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const windows = S.WINDOW_PRESETS.filter((w) => $(`#windows [data-w="${w.id}"]`).getAttribute('aria-pressed') === 'true');
    if (!windows.length) return toast('Pick at least one time of week');
    const required = $$('#required .chip[aria-pressed="true"]').map((b) => b.dataset.u);
    const durationMin = Number(f.duration.value);
    const from = S.startOfDay(new Date());
    const to = S.addDays(from, Number(f.weeks.value) * 7);
    const busy = await loadBusy(people.map((p) => p.id), from, S.addDays(to, 1));
    const result = S.suggest({ members: people, busy, from, to, durationMin, windows, required });
    showSuggestions({ gid, group, people, f, result, from, to, durationMin });
  };
}

function showSuggestions({ gid, people, f, result, from, to, durationMin }) {
  const total = people.length;
  const notSynced = people.filter((p) => isStale(p.last_synced_at));
  const selected = new Map(); // dayKey → {start, end}
  result.top.filter((s) => s.free.length > 0).slice(0, 3).forEach((s) => selected.set(S.dayKey(s.start), { start: s.start, end: s.end }));

  const $res = $('#results');

  const draw = () => {
    // ---- heat map, Monday-first weeks ----
    const first = S.startOfDay(from);
    const gridStart = S.addDays(first, -((first.getDay() + 6) % 7));
    let html = '';
    const monthName = (d) => d.toLocaleDateString(LOCALE, { month: 'long' });
    for (let wk = gridStart; wk <= to; wk = S.addDays(wk, 7)) {
      const newMonth = [...Array(7)].map((_, i) => S.addDays(wk, i)).find((d) => d.getDate() === 1 && d > first && d <= to);
      if (wk.getTime() === gridStart.getTime()) {
        html += `<div class="heat-month">${monthName(first)}${newMonth ? ` / ${monthName(newMonth)}` : ''}</div>`;
      } else if (newMonth) {
        html += `<div class="heat-month">${monthName(newMonth)}</div>`;
      }
      html += '<div class="heat-week">';
      for (let i = 0; i < 7; i++) {
        const d = S.addDays(wk, i);
        const key = S.dayKey(d);
        const info = d >= first && d <= to ? result.days.get(key) : undefined;
        if (!info) { html += `<span class="heat-day off">${d.getDate()}</span>`; continue; }
        const n = info.free.length;
        const lvl = n > 0 && n + info.unknown.length === total ? 'all' : info.ratio >= 0.5 ? 'most' : 'few';
        html += `<button type="button" class="heat-day has ${lvl}" style="--pct:${Math.round(info.ratio * 100)}" data-day="${key}"
          aria-pressed="${selected.has(key)}" aria-label="${fmtDay(d)}: ${n} of ${total} free"><b>${d.getDate()}</b><small>${n}/${total}</small></button>`;
      }
      html += '</div>';
    }

    // ---- ranked list: best suggestions + anything picked on the map ----
    const rows = result.top.slice(0, 6).map((s) => S.dayKey(s.start));
    for (const k of selected.keys()) if (!rows.includes(k)) rows.push(k);

    $res.innerHTML = `
      <h2>When people are free</h2>
      ${notSynced.length ? `<div class="notice small">${notSynced.map((p) => esc(firstName(p.name))).join(', ')} ${notSynced.length === 1 ? 'hasn\'t' : 'haven\'t'} synced lately, so their calendar might be missing.</div>` : ''}
      <div class="heat">
        <div class="heat-head">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x) => `<span>${x}</span>`).join('')}</div>
        ${html}
        <div class="heat-legend">
          <span><i style="background:var(--free)"></i>Everyone</span>
          <span><i style="background:var(--some)"></i>Most</span>
          <span><i style="background:var(--busy)"></i>Few</span>
        </div>
      </div>
      <p class="small muted" style="margin-top:8px">Tap a day to add or remove it.</p>

      <h2>Dates to vote on</h2>
      <div class="list">
        ${rows.length ? rows.map((k) => {
          const info = result.days.get(k);
          const sel = selected.get(k);
          const start = sel ? sel.start : info.start;
          const freeNames = info.free.map((id) => firstName(people.find((p) => p.id === id)?.name)).join(', ');
          return `<label class="pick">
            <input type="checkbox" data-pick="${k}" ${sel ? 'checked' : ''}>
            <div class="grow"><b>${fmtDay(info.start)}</b><br>
              <span class="small muted">${info.free.length} of ${total} free${info.free.length && info.free.length < total ? `: ${esc(freeNames)}` : ''}</span></div>
            <input type="time" data-time="${k}" value="${fmtTime(start)}" step="900">
          </label>`;
        }).join('') : '<div class="empty">No times fit. Try more times of week or look further ahead.</div>'}
      </div>
      <button class="block" id="send" style="margin-top:16px" ${selected.size ? '' : 'disabled'}>Send ${selected.size || ''} ${selected.size === 1 ? 'date' : 'dates'} to the group</button>`;

    $$('[data-day]', $res).forEach((b) => { b.onclick = () => { togglePick(b.dataset.day); draw(); }; });
    $$('[data-pick]', $res).forEach((c) => { c.onchange = () => { togglePick(c.dataset.pick); draw(); }; });
    $$('[data-time]', $res).forEach((t) => {
      t.onchange = () => {
        const k = t.dataset.time;
        const [h, m] = t.value.split(':').map(Number);
        const s = new Date(`${k}T00:00:00`); s.setHours(h, m, 0, 0);
        selected.set(k, { start: s.getTime(), end: s.getTime() + durationMin * 60000 });
        draw();
      };
    });
    $('#send', $res).onclick = send;
  };

  const togglePick = (k) => {
    if (selected.has(k)) selected.delete(k);
    else { const i = result.days.get(k); selected.set(k, { start: i.start, end: i.end }); }
  };

  const send = async () => {
    const btn = $('#send', $res); btn.disabled = true;
    try {
      const hours = f.deadline.value;
      const plan = await q(sb.from('plans').insert({
        group_id: gid,
        created_by: state.me.id,
        title: f.title.value.trim(),
        note: f.note.value.trim(),
        duration_minutes: durationMin,
        deadline: hours ? new Date(Date.now() + Number(hours) * 3600000).toISOString() : null,
      }).select().single());
      const options = [...selected.values()].sort((a, b) => a.start - b.start).map((s) => ({
        plan_id: plan.id, starts_at: new Date(s.start).toISOString(), ends_at: new Date(s.end).toISOString(),
      }));
      await q(sb.from('plan_options').insert(options));
      notify('plan_created', plan.id);
      go(`#/plan/${plan.id}`);
    } catch (e) { fail(e); btn.disabled = false; }
  };

  draw();
  $res.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ===================================================================
// Plan: vote, lock, add to calendar
// ===================================================================
async function viewPlan(pid) {
  const plan = await q(sb.from('plans').select('*, plan_options!plan_options_plan_id_fkey(*)').eq('id', pid).single());
  const options = plan.plan_options.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  const [group, people, votes] = await Promise.all([
    q(sb.from('groups').select('id,name').eq('id', plan.group_id).single()),
    loadGroupPeople(plan.group_id),
    options.length ? q(sb.from('votes').select('*').in('option_id', options.map((o) => o.id))) : [],
  ]);
  const minStart = Math.min(...options.map((o) => new Date(o.starts_at)));
  const maxEnd = Math.max(...options.map((o) => new Date(o.ends_at)));
  const busy = options.length ? await loadBusy(people.map((p) => p.id), minStart, maxEnd) : [];
  const busyMap = S.busyByMember(people, busy);

  topbar(group.name, { back: `#/group/${group.id}` });
  const me = state.me.id;
  const isOwner = plan.created_by === me;
  const owner = people.find((p) => p.id === plan.created_by);
  const total = people.length;

  const scored = options.map((o) => ({ o, ...S.optionScore(people, o, votes, busyMap) }));
  const best = [...scored].sort((a, b) => b.score - a.score || new Date(a.o.starts_at) - new Date(b.o.starts_at))[0];
  const answered = (p) => options.every((o) => votes.some((v) => v.option_id === o.id && v.user_id === p.id));
  const waitingFor = people.filter((p) => !answered(p));
  const deadlinePassed = plan.deadline && new Date(plan.deadline) < Date.now();

  const personChip = (p, o) => {
    const s = S.memberStatus(p, o, votes, busyMap);
    const title = !s.implicit ? s.answer
      : s.answer === 'unknown' ? 'Calendar not connected, hasn\'t answered'
      : s.answer === 'yes' ? 'Free in calendar, hasn\'t answered' : 'Busy in calendar, hasn\'t answered';
    return `<span class="person ${s.answer}${s.implicit ? ' implicit' : ''}" title="${title}"><span class="dot">${s.answer === 'unknown' ? '?' : esc(initials(p.name)[0])}</span>${esc(firstName(p.name))}</span>`;
  };

  const myAnswer = (o) => votes.find((v) => v.option_id === o.id && v.user_id === me)?.answer;

  let head = '';
  if (plan.status === 'locked') {
    const o = options.find((x) => x.id === plan.locked_option_id);
    const coming = o ? people.filter((p) => S.memberStatus(p, o, votes, busyMap).answer === 'yes') : [];
    head = o ? `
      <div class="locked">
        <div class="big">${fmtDayLong(o.starts_at)}</div>
        <div>${fmtRange(o.starts_at, o.ends_at)}</div>
        <p style="margin:12px 0 0">${coming.length} coming: ${coming.map((p) => esc(firstName(p.name))).join(', ')}</p>
        <a class="btn block" href="${icsUrl(plan.id)}" target="_blank" rel="noopener">Add to my calendar</a>
      </div>` : '<div class="notice">A date was chosen, but it has since been removed.</div>';
  } else if (plan.status === 'cancelled') {
    head = '<div class="notice">This plan was cancelled.</div>';
  } else {
    head = `
      <p class="muted small">${plan.deadline ? (deadlinePassed ? 'The answer deadline has passed.' : `Answer by ${fmtWhen(plan.deadline)}.`) : ''}
        ${waitingFor.length ? `Waiting for ${waitingFor.map((p) => (p.id === me ? 'you' : esc(firstName(p.name)))).join(', ')}.` : 'Everyone has answered.'}</p>
      ${isOwner && best && (deadlinePassed || !waitingFor.length) ? `
        <div class="notice good"><b>Best date: ${fmtDay(best.o.starts_at)}</b>, ${best.yes} of ${total} can come.
          <button class="block" style="margin-top:10px" data-lock="${best.o.id}">Choose ${fmtDay(best.o.starts_at)}</button></div>` : ''}
      ${options.some((o) => !myAnswer(o)) ? `<button class="block quiet" id="auto">Answer from my calendar</button>` : ''}`;
  }

  render(`
    <h1>${esc(plan.title)}</h1>
    <p class="muted">Suggested by ${esc(owner ? firstName(owner.name) : 'someone')}</p>
    ${plan.note ? `<p>${esc(plan.note)}</p>` : ''}
    ${head}

    <h2>${plan.status === 'open' ? 'Which dates work for you?' : 'All dates'}</h2>
    <p class="small muted">Solid: answered. Dashed: not answered yet, guessed from their calendar. Grey with ?: no calendar connected.</p>
    ${scored.map(({ o, yes }) => `
      <div class="option ${plan.locked_option_id === o.id ? 'winner' : ''}">
        <div class="row between">
          <div><div class="when">${fmtDay(o.starts_at)}</div><div class="time">${fmtRange(o.starts_at, o.ends_at)}</div></div>
          <div class="small muted">${yes} of ${total}</div>
        </div>
        <div class="bar"><i style="width:${total ? Math.round((yes / total) * 100) : 0}%"></i></div>
        <div class="people">${people.map((p) => personChip(p, o)).join('')}</div>
        ${plan.status === 'open' ? `
          <div class="segmented" role="group" aria-label="Your answer for ${fmtDay(o.starts_at)}">
            ${['yes', 'maybe', 'no'].map((a) => `<button type="button" class="${a}" data-vote="${o.id}" data-a="${a}" aria-pressed="${myAnswer(o) === a}">${{ yes: 'Yes', maybe: 'Maybe', no: 'No' }[a]}</button>`).join('')}
          </div>
          ${isOwner ? `<button class="link" data-lock="${o.id}">Choose this date</button>` : ''}` : ''}
      </div>`).join('')}

    ${isOwner && plan.status === 'open' ? `
      <div class="stack" style="margin-top:24px">
        ${waitingFor.filter((p) => p.id !== me).length ? `<button class="block quiet" id="nudge">Remind ${waitingFor.filter((p) => p.id !== me).map((p) => esc(firstName(p.name))).join(', ')}</button>` : ''}
        <p class="center"><button class="danger" id="cancel">Cancel plan</button></p>
      </div>` : ''}`, { refreshable: true });

  // ---- actions ----
  const vote = async (optionId, answer) => {
    await q(sb.from('votes').upsert({ option_id: optionId, user_id: me, answer, updated_at: new Date().toISOString() }, { onConflict: 'option_id,user_id' }));
  };
  $$('[data-vote]').forEach((b) => {
    b.onclick = async () => {
      try { await vote(b.dataset.vote, b.dataset.a); route(); } catch (e) { fail(e); }
    };
  });
  const auto = $('#auto');
  if (auto) auto.onclick = async () => {
    try {
      const myBusy = S.busyByMember([state.me], busy).get(me) || [];
      for (const o of options) {
        if (myAnswer(o)) continue;
        const free = S.isFree(myBusy, new Date(o.starts_at).getTime(), new Date(o.ends_at).getTime());
        await vote(o.id, free ? 'yes' : 'no');
      }
      toast('Answered from your calendar. Change any you like.');
      route();
    } catch (e) { fail(e); }
  };
  $$('[data-lock]').forEach((b) => {
    b.onclick = async () => {
      const o = options.find((x) => x.id === b.dataset.lock);
      if (!confirm(`Choose ${fmtDayLong(o.starts_at)} for everyone?`)) return;
      try {
        await q(sb.from('plans').update({ status: 'locked', locked_option_id: o.id }).eq('id', plan.id));
        notify('plan_locked', plan.id);
        toast('Date chosen. Everyone gets a notification.');
        route();
      } catch (e) { fail(e); }
    };
  });
  const nudge = $('#nudge');
  if (nudge) nudge.onclick = async () => {
    nudge.disabled = true;
    await notify('nudge', plan.id);
    toast('Reminder sent');
  };
  const cancel = $('#cancel');
  if (cancel) cancel.onclick = async () => {
    if (!confirm('Cancel this plan?')) return;
    try {
      await q(sb.from('plans').update({ status: 'cancelled' }).eq('id', plan.id));
      route();
    } catch (e) { fail(e); }
  };
}

// ===================================================================
// Settings
// ===================================================================
async function viewSettings() {
  topbar('Settings', { back: '#/' });
  const cals = await loadCalendars();
  const manual = await q(sb.from('busy_blocks').select('*').eq('user_id', state.me.id).eq('source', 'manual').gte('ends_at', new Date().toISOString()).order('starts_at'));
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && !!CONFIG.VAPID_PUBLIC_KEY;
  let pushOn = false;
  if (pushSupported) {
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    pushOn = !!(reg && await reg.pushManager.getSubscription()) && Notification.permission === 'granted';
  }

  render(`
    <form id="name-form" style="margin-top:12px">
      <label class="field"><span>Your name</span>
        <div class="row"><input type="text" name="name" value="${esc(state.me.name)}" required class="grow"><button type="submit" class="quiet">Save</button></div></label>
    </form>

    ${syncSection()}
    ${calendarsSection(cals)}

    <div class="card stack" style="margin-top:12px">
      <label class="switch"><span>All-day events make me busy</span>
        <input type="checkbox" id="allday" ${state.me.block_all_day ? 'checked' : ''}></label>
      <p class="small muted">Turn this off if your all-day events are mostly birthdays and reminders.</p>
    </div>

    <h2>Notifications</h2>
    <div class="card stack">
      ${!CONFIG.VAPID_PUBLIC_KEY ? '<p class="small muted">Notifications aren\'t set up for this app yet.</p>'
        : !isStandalone() ? '<p class="small muted">Add Friends to your Home Screen first (Share → Add to Home Screen), then open it from there.</p>'
        : pushOn ? '<p>Notifications are on for this iPhone.</p><button class="block quiet" id="push-test">Send me a test</button>'
        : '<p class="small muted">Get a notification when there\'s a new plan to answer or a date is chosen.</p><button class="block" id="push">Turn on notifications</button>'}
    </div>

    <h2>Extra busy times</h2>
    <div class="card stack">
      <p class="small muted">For things that aren't in your calendar.</p>
      ${manual.map((b) => `<div class="row between"><span>${b.all_day ? `${fmtDay(b.starts_at)}, all day` : `${fmtDay(b.starts_at)}, ${fmtRange(b.starts_at, b.ends_at)}`}</span><button class="danger" data-del="${b.id}">Remove</button></div>`).join('')}
      <form id="manual">
        <label class="field"><span>Day</span><input type="date" name="day" required></label>
        <div class="row">
          <label class="field grow"><span>From</span><input type="time" name="from" value="18:00"></label>
          <label class="field grow"><span>To</span><input type="time" name="to" value="23:00"></label>
        </div>
        <label class="switch field"><span>All day</span><input type="checkbox" name="allday"></label>
        <button class="block quiet" type="submit">Add busy time</button>
      </form>
    </div>

    <h2>See plans in your calendar</h2>
    <div class="card stack">
      <p class="small muted">Subscribe once and every chosen date appears in your iPhone calendar automatically.</p>
      <a class="btn block quiet" href="${esc(feedUrl(state.tokens?.feed_token || ''))}">Subscribe in Calendar</a>
    </div>

    <h2>Account</h2>
    <div class="card stack">
      <p class="small muted">Signed in as ${esc(state.session.user.email)}</p>
      <button class="block quiet" id="regen">Make new sync codes</button>
      <p class="small muted">Only needed if you shared your sync code by mistake. You'll have to paste the new code into the shortcut.</p>
      <button class="block quiet" id="signout">Sign out</button>
    </div>`, { refreshable: false });

  wireSyncSection();
  wireCalendars();

  $('#name-form').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const name = ev.target.name.value.trim();
      await q(sb.from('profiles').update({ name }).eq('id', state.me.id));
      state.me.name = name; toast('Name saved');
    } catch (e) { fail(e); }
  };
  $('#allday').onchange = async (ev) => {
    try {
      await q(sb.from('profiles').update({ block_all_day: ev.target.checked }).eq('id', state.me.id));
      state.me.block_all_day = ev.target.checked; toast('Saved');
    } catch (e) { fail(e); }
  };
  $('#manual').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const day = f.day.value;
    let s; let e;
    if (f.allday.checked) {
      s = new Date(`${day}T00:00:00`); e = S.addDays(s, 1);
    } else {
      s = new Date(`${day}T${f.from.value}:00`); e = new Date(`${day}T${f.to.value}:00`);
      if (e <= s) e = S.addDays(e, 1);
    }
    try {
      await q(sb.from('busy_blocks').insert({ user_id: state.me.id, starts_at: s.toISOString(), ends_at: e.toISOString(), all_day: f.allday.checked, source: 'manual' }));
      toast('Busy time added'); route();
    } catch (err) { fail(err); }
  };
  $$('[data-del]').forEach((b) => {
    b.onclick = async () => {
      try { await q(sb.from('busy_blocks').delete().eq('id', b.dataset.del)); route(); } catch (e) { fail(e); }
    };
  });
  const pushBtn = $('#push');
  if (pushBtn) pushBtn.onclick = () => enablePush().then(() => route()).catch(fail);
  const testBtn = $('#push-test');
  if (testBtn) testBtn.onclick = async () => { await notify('test', null); toast('Test sent'); };
  $('#regen').onclick = async () => {
    if (!confirm('Make new sync codes? The old ones stop working.')) return;
    try { await q(sb.rpc('regenerate_tokens')); await loadMe(); route(); } catch (e) { fail(e); }
  };
  $('#signout').onclick = async () => {
    await sb.auth.signOut();
    state.session = null; state.me = null;
    go('#/');
  };
}

function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

const pushPossible = () => !!CONFIG.VAPID_PUBLIC_KEY && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && isStandalone();
const pushAskable = () => pushPossible() && Notification.permission === 'default';

// Already allowed on this phone? Then (re)connect silently – no tap needed.
let pushChecked = false;
async function ensurePush() {
  if (pushChecked || !pushPossible() || Notification.permission !== 'granted') return;
  pushChecked = true;
  try { await subscribePush(); } catch (e) { console.warn('push resubscribe failed', e); }
}

async function subscribePush() {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(CONFIG.VAPID_PUBLIC_KEY) });
  const j = sub.toJSON();
  await q(sb.from('push_subscriptions').upsert({ user_id: state.me.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: 'endpoint' }));
}

function pushCard() {
  if (!pushAskable()) return '';
  return `<div class="notice good" id="push-card"><b>Turn on notifications</b><br>
    Get a ping when there's a new plan to answer or a date is chosen.
    <button class="block" id="push-now" style="margin-top:10px">Turn on notifications</button></div>`;
}
function wirePushCard() {
  const b = $('#push-now');
  if (b) b.onclick = () => enablePush().then(() => { $('#push-card')?.remove(); }).catch(fail);
}

async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them in iPhone Settings → Notifications → Friends.');
  await subscribePush();
  pushChecked = true;
  toast('Notifications are on');
}

// ===================================================================
// Start
// ===================================================================
(async function start() {
  if (configured) {
    const { data } = await sb.auth.getSession();
    state.session = data.session;
    sb.auth.onAuthStateChange((_event, session) => { state.session = session; });
  }
  route();
})();
