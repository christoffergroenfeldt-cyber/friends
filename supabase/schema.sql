-- =====================================================================
-- Friends planner – database schema
-- Run this whole file once in Supabase → SQL Editor → New query → Run.
-- It is safe to re-run: it drops and recreates functions/policies.
-- =====================================================================

-- Random tokens come from gen_random_uuid(), which is built into Postgres,
-- so no extension is needed.
create or replace function public.random_hex(n int)
returns text language sql volatile set search_path = public as $$
  select substr(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 1, n);
$$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

-- Public profile, visible to people you share a group with.
create table if not exists public.profiles (
  id             uuid primary key references auth.users on delete cascade,
  name           text not null default '',
  block_all_day  boolean not null default true,   -- do all-day events count as busy?
  last_synced_at timestamptz,
  created_at     timestamptz not null default now()
);

-- Private tokens, only readable by the owner.
--   sync_token: used by the iOS Shortcut to upload busy times
--   feed_token: used by the calendar subscription feed
create table if not exists public.user_tokens (
  user_id    uuid primary key references auth.users on delete cascade,
  sync_token text not null unique default public.random_hex(48),
  feed_token text not null unique default public.random_hex(48)
);

create table if not exists public.groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  invite_code text not null unique default public.random_hex(10),
  created_by  uuid not null references auth.users on delete cascade,
  created_at  timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id  uuid not null references public.groups on delete cascade,
  user_id   uuid not null references auth.users on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists group_members_user_idx on public.group_members (user_id);

-- Busy times only. Event titles/locations are never stored.
create table if not exists public.busy_blocks (
  id        bigserial primary key,
  user_id   uuid not null references auth.users on delete cascade,
  starts_at timestamptz not null,
  ends_at   timestamptz not null,
  all_day   boolean not null default false,
  source    text not null default 'calendar' check (source in ('calendar', 'manual')),
  check (ends_at > starts_at)
);
create index if not exists busy_blocks_user_time_idx on public.busy_blocks (user_id, starts_at);

create table if not exists public.plans (
  id               uuid primary key default gen_random_uuid(),
  group_id         uuid not null references public.groups on delete cascade,
  created_by       uuid not null references auth.users on delete cascade,
  title            text not null,
  note             text not null default '',
  duration_minutes int  not null default 180 check (duration_minutes between 15 and 1440),
  deadline         timestamptz,
  status           text not null default 'open' check (status in ('open', 'locked', 'cancelled')),
  locked_option_id uuid,
  created_at       timestamptz not null default now()
);
create index if not exists plans_group_idx on public.plans (group_id, created_at desc);

create table if not exists public.plan_options (
  id        uuid primary key default gen_random_uuid(),
  plan_id   uuid not null references public.plans on delete cascade,
  starts_at timestamptz not null,
  ends_at   timestamptz not null,
  check (ends_at > starts_at)
);
create index if not exists plan_options_plan_idx on public.plan_options (plan_id);

do $$ begin
  alter table public.plans
    add constraint plans_locked_option_fk
    foreign key (locked_option_id) references public.plan_options (id) on delete set null;
exception when duplicate_object then null; end $$;

create table if not exists public.votes (
  option_id  uuid not null references public.plan_options on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  answer     text not null check (answer in ('yes', 'maybe', 'no')),
  updated_at timestamptz not null default now(),
  primary key (option_id, user_id)
);

create table if not exists public.push_subscriptions (
  id         bigserial primary key,
  user_id    uuid not null references auth.users on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

alter table public.user_tokens alter column sync_token  set default public.random_hex(48);
alter table public.user_tokens alter column feed_token  set default public.random_hex(48);
alter table public.groups      alter column invite_code set default public.random_hex(10);

-- ---------------------------------------------------------------------
-- New user → profile + tokens
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  insert into public.user_tokens (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- Membership helpers (security definer avoids RLS recursion)
-- ---------------------------------------------------------------------
create or replace function public.is_member(gid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.group_members where group_id = gid and user_id = auth.uid()
  );
$$;

create or replace function public.shares_group(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select uid = auth.uid() or exists (
    select 1
    from public.group_members a
    join public.group_members b on a.group_id = b.group_id
    where a.user_id = auth.uid() and b.user_id = uid
  );
$$;

create or replace function public.plan_member(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.plans p
    join public.group_members m on m.group_id = p.group_id
    where p.id = pid and m.user_id = auth.uid()
  );
$$;

create or replace function public.option_member(oid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.plan_options o
    join public.plans p on p.id = o.plan_id
    join public.group_members m on m.group_id = p.group_id
    where o.id = oid and m.user_id = auth.uid() and p.status = 'open'
  );
$$;

-- ---------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------
alter table public.profiles           enable row level security;
alter table public.user_tokens        enable row level security;
alter table public.groups             enable row level security;
alter table public.group_members      enable row level security;
alter table public.busy_blocks        enable row level security;
alter table public.plans              enable row level security;
alter table public.plan_options       enable row level security;
alter table public.votes              enable row level security;
alter table public.push_subscriptions enable row level security;

drop policy if exists "profiles read"   on public.profiles;
drop policy if exists "profiles update" on public.profiles;
create policy "profiles read"   on public.profiles for select using (public.shares_group(id));
create policy "profiles update" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "tokens read own" on public.user_tokens;
create policy "tokens read own" on public.user_tokens for select using (user_id = auth.uid());

drop policy if exists "groups read"   on public.groups;
drop policy if exists "groups update" on public.groups;
create policy "groups read"   on public.groups for select using (public.is_member(id));
create policy "groups update" on public.groups for update using (public.is_member(id));

drop policy if exists "members read"  on public.group_members;
drop policy if exists "members leave" on public.group_members;
create policy "members read"  on public.group_members for select using (public.is_member(group_id));
create policy "members leave" on public.group_members for delete using (user_id = auth.uid());

drop policy if exists "busy read"          on public.busy_blocks;
drop policy if exists "busy insert manual" on public.busy_blocks;
drop policy if exists "busy delete manual" on public.busy_blocks;
create policy "busy read"          on public.busy_blocks for select using (public.shares_group(user_id));
create policy "busy insert manual" on public.busy_blocks for insert with check (user_id = auth.uid() and source = 'manual');
create policy "busy delete manual" on public.busy_blocks for delete using (user_id = auth.uid() and source = 'manual');

drop policy if exists "plans read"   on public.plans;
drop policy if exists "plans insert" on public.plans;
drop policy if exists "plans update" on public.plans;
create policy "plans read"   on public.plans for select using (public.is_member(group_id));
create policy "plans insert" on public.plans for insert with check (created_by = auth.uid() and public.is_member(group_id));
create policy "plans update" on public.plans for update using (created_by = auth.uid()) with check (created_by = auth.uid());

drop policy if exists "options read"   on public.plan_options;
drop policy if exists "options insert" on public.plan_options;
create policy "options read"   on public.plan_options for select using (public.plan_member(plan_id));
create policy "options insert" on public.plan_options for insert with check (
  exists (select 1 from public.plans p where p.id = plan_id and p.created_by = auth.uid())
);

drop policy if exists "votes read"   on public.votes;
drop policy if exists "votes insert" on public.votes;
drop policy if exists "votes update" on public.votes;
drop policy if exists "votes delete" on public.votes;
create policy "votes read" on public.votes for select using (
  exists (select 1 from public.plan_options o where o.id = option_id and public.plan_member(o.plan_id))
);
create policy "votes insert" on public.votes for insert with check (user_id = auth.uid() and public.option_member(option_id));
create policy "votes update" on public.votes for update using (user_id = auth.uid()) with check (user_id = auth.uid() and public.option_member(option_id));
create policy "votes delete" on public.votes for delete using (user_id = auth.uid());

drop policy if exists "push own" on public.push_subscriptions;
create policy "push own" on public.push_subscriptions for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- RPCs used by the app
-- ---------------------------------------------------------------------
create or replace function public.create_group(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare gid uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into public.groups (name, created_by) values (trim(p_name), auth.uid()) returning id into gid;
  insert into public.group_members (group_id, user_id) values (gid, auth.uid());
  return gid;
end $$;

create or replace function public.join_group(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare gid uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select id into gid from public.groups where invite_code = lower(trim(p_code));
  if gid is null then raise exception 'Invite code not found'; end if;
  insert into public.group_members (group_id, user_id) values (gid, auth.uid()) on conflict do nothing;
  return gid;
end $$;

create or replace function public.regenerate_tokens()
returns void language sql security definer set search_path = public as $$
  update public.user_tokens
     set sync_token = public.random_hex(48),
         feed_token = public.random_hex(48)
   where user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------
-- Called by the iOS Shortcut (no login – authenticated by sync token).
--
-- p_events: one event per line, exactly three fields separated by "|":
--   START|END|ALLDAY
--   2026-11-06T18:00:00+01:00|2026-11-06T22:00:00+01:00|No
-- START/END must be ISO 8601 date-times with a time zone.
-- ALLDAY must be yes/no, true/false, 1/0 or ja/nej.
--
-- Strict on purpose: only busy times may ever reach the database.
-- If ANY line contains anything else (an event title, a place, a 4th
-- field…), the whole upload is rejected and nothing is saved. The error
-- names the line number only, never its content.
-- ---------------------------------------------------------------------
create or replace function public.sync_busy(p_token text, p_events text)
returns text language plpgsql security definer set search_path = public as $$
declare
  iso_re  constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)$';
  flag_re constant text := '^(yes|no|true|false|1|0|ja|nej)$';
  uid     uuid;
  lines   text[];
  parts   text[];
  i       int;
  s       timestamptz;
  e       timestamptz;
  starts  timestamptz[] := '{}';
  ends    timestamptz[] := '{}';
  flags   boolean[]     := '{}';
  n_ok    int := 0;
begin
  select user_id into uid from public.user_tokens where sync_token = trim(coalesce(p_token, ''));
  if uid is null then
    raise exception 'Unknown sync code. Copy it again from the Friends app (Settings → Calendar sync).';
  end if;

  if length(coalesce(p_events, '')) > 500000 then
    raise exception 'Upload too large. Nothing was saved.';
  end if;

  lines := regexp_split_to_array(coalesce(p_events, ''), E'\\r?\\n');

  -- 1) Validate every line before touching anything.
  for i in 1 .. coalesce(array_length(lines, 1), 0) loop
    continue when trim(lines[i]) = '';
    parts := string_to_array(trim(lines[i]), '|');
    if array_length(parts, 1) <> 3
       or trim(parts[1]) !~ iso_re
       or trim(parts[2]) !~ iso_re
       or lower(trim(parts[3])) !~ flag_re then
      raise exception 'Rejected: line % is not START|END|ALLDAY. Only busy times may be sent, so nothing was saved. Check the Friends Sync shortcut.', i;
    end if;
    begin
      s := trim(parts[1])::timestamptz;
      e := trim(parts[2])::timestamptz;
    exception when others then
      raise exception 'Rejected: line % has an invalid date. Nothing was saved.', i;
    end;
    if e <= s then e := s + interval '1 minute'; end if;
    continue when e < now() - interval '1 day';          -- ignore the past
    continue when s > now() + interval '400 days';
    starts := starts || s;
    ends   := ends   || e;
    flags  := flags  || (lower(trim(parts[3])) in ('yes', 'true', '1', 'ja'));
  end loop;

  -- 2) All lines are clean: replace this person's synced busy times.
  delete from public.busy_blocks where user_id = uid and source = 'calendar';
  for i in 1 .. coalesce(array_length(starts, 1), 0) loop
    insert into public.busy_blocks (user_id, starts_at, ends_at, all_day, source)
    values (uid, starts[i], ends[i], flags[i], 'calendar');
    n_ok := n_ok + 1;
  end loop;

  update public.profiles set last_synced_at = now() where id = uid;
  return format('Synced %s busy times to Friends', n_ok);
end $$;

-- ---------------------------------------------------------------------
-- Faster variant for the Shortcut: no Repeat loop needed.
-- The Shortcut sends three lists (one item per line, same order):
--   p_starts: start times, p_ends: end times, p_allday: Yes/No per event
-- They are paired up line by line and checked by sync_busy above,
-- so the same strict rules apply.
-- ---------------------------------------------------------------------
create or replace function public.sync_busy_lists(p_token text, p_starts text, p_ends text, p_allday text)
returns text language plpgsql security definer set search_path = public as $$
declare
  s text[] := array_remove(regexp_split_to_array(trim(coalesce(p_starts, '')), E'\\s*\\r?\\n\\s*'), '');
  e text[] := array_remove(regexp_split_to_array(trim(coalesce(p_ends,   '')), E'\\s*\\r?\\n\\s*'), '');
  a text[] := array_remove(regexp_split_to_array(trim(coalesce(p_allday, '')), E'\\s*\\r?\\n\\s*'), '');
  ns int := coalesce(array_length(s, 1), 0);
  ne int := coalesce(array_length(e, 1), 0);
  na int := coalesce(array_length(a, 1), 0);
  lines text[] := '{}';
  i int;
begin
  if ns <> ne or ns <> na then
    raise exception 'Rejected: got % start times, % end times and % all-day values. They must match. Nothing was saved.', ns, ne, na;
  end if;
  for i in 1 .. ns loop
    lines := lines || (s[i] || '|' || e[i] || '|' || a[i]);
  end loop;
  return public.sync_busy(p_token, array_to_string(lines, E'\n'));
end $$;

-- ---------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------
revoke execute on function public.sync_busy(text, text) from public;
grant  execute on function public.sync_busy(text, text) to anon, authenticated;
revoke execute on function public.sync_busy_lists(text, text, text, text) from public;
grant  execute on function public.sync_busy_lists(text, text, text, text) to anon, authenticated;

revoke execute on function public.create_group(text)    from public, anon;
revoke execute on function public.join_group(text)      from public, anon;
revoke execute on function public.regenerate_tokens()   from public, anon;
grant  execute on function public.create_group(text)    to authenticated;
grant  execute on function public.join_group(text)      to authenticated;
grant  execute on function public.regenerate_tokens()   to authenticated;

-- Helper functions used inside the privacy rules. Newer Supabase projects
-- don't let signed-in users run functions unless this is granted.
grant  execute on function public.is_member(uuid)       to authenticated;
grant  execute on function public.shares_group(uuid)    to authenticated;
grant  execute on function public.plan_member(uuid)     to authenticated;
grant  execute on function public.option_member(uuid)   to authenticated;
grant  execute on function public.random_hex(int)       to authenticated, service_role;
grant  usage on schema public                            to anon, authenticated;

grant select, update                 on public.profiles           to authenticated;
grant select                         on public.user_tokens        to authenticated;
grant select, update                 on public.groups             to authenticated;
grant select, delete                 on public.group_members      to authenticated;
grant select, insert, delete         on public.busy_blocks        to authenticated;
grant usage on sequence public.busy_blocks_id_seq                 to authenticated;
grant select, insert, update         on public.plans              to authenticated;
grant select, insert                 on public.plan_options       to authenticated;
grant select, insert, update, delete on public.votes              to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant usage on sequence public.push_subscriptions_id_seq          to authenticated;


-- =====================================================================
-- Calendar choice: lets each person pick, inside the app, which of their
-- phone's calendars count as busy. Safe to re-run.
-- (Also included at the end of schema.sql.)
-- =====================================================================

-- Each person's calendar names. Only the owner can ever see these.
create table if not exists public.user_calendars (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  name         text not null,
  included     boolean not null default true,
  last_seen_at timestamptz not null default now(),
  unique (user_id, name)
);
alter table public.user_calendars enable row level security;
drop policy if exists "calendars own read"   on public.user_calendars;
drop policy if exists "calendars own update" on public.user_calendars;
create policy "calendars own read"   on public.user_calendars for select using (user_id = auth.uid());
create policy "calendars own update" on public.user_calendars for update using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, update (included) on public.user_calendars to authenticated;

-- Busy blocks point to an (opaque) calendar id, never its name.
alter table public.busy_blocks add column if not exists calendar_id uuid references public.user_calendars on delete cascade;

-- Is this block's calendar switched on? Runs with owner rights so friends
-- can apply the rule without being able to read calendar names.
create or replace function public.calendar_included(cid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select cid is null or coalesce((select included from public.user_calendars where id = cid), true);
$$;
grant execute on function public.calendar_included(uuid) to authenticated;

drop policy if exists "busy read" on public.busy_blocks;
create policy "busy read" on public.busy_blocks for select
  using (public.shares_group(user_id) and public.calendar_included(calendar_id));

-- ---------------------------------------------------------------------
-- Shortcut upload with calendar names: five lists, one item per line,
-- same order. Same strict rules as before, plus:
--   * calendar names: 1–100 characters, no control characters
--   * at most 40 different calendar names (stops event titles being
--     smuggled in as "calendar names")
-- Anything off → whole upload rejected, nothing saved.
-- ---------------------------------------------------------------------
create or replace function public.sync_busy_lists(p_token text, p_starts text, p_ends text, p_allday text, p_calendars text)
returns text language plpgsql security definer set search_path = public as $$
declare
  iso_re  constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)$';
  flag_re constant text := '^(yes|no|true|false|1|0|ja|nej)$';
  uid uuid;
  s text[] := array_remove(regexp_split_to_array(trim(coalesce(p_starts, '')),    E'\\s*\\r?\\n\\s*'), '');
  e text[] := array_remove(regexp_split_to_array(trim(coalesce(p_ends, '')),      E'\\s*\\r?\\n\\s*'), '');
  a text[] := array_remove(regexp_split_to_array(trim(coalesce(p_allday, '')),    E'\\s*\\r?\\n\\s*'), '');
  c text[] := array_remove(regexp_split_to_array(trim(coalesce(p_calendars, '')), E'\\s*\\r?\\n\\s*'), '');
  n int; i int;
  st timestamptz; en timestamptz;
  keep int[] := '{}';
  names text[];
begin
  select user_id into uid from public.user_tokens where sync_token = trim(coalesce(p_token, ''));
  if uid is null then
    raise exception 'Unknown sync code. Copy it again from the Friends app (Settings → Calendar sync).';
  end if;
  if length(coalesce(p_starts,'')) + length(coalesce(p_ends,'')) + length(coalesce(p_calendars,'')) > 800000 then
    raise exception 'Upload too large. Nothing was saved.';
  end if;

  n := coalesce(array_length(s, 1), 0);
  if n <> coalesce(array_length(e, 1), 0) or n <> coalesce(array_length(a, 1), 0) or n <> coalesce(array_length(c, 1), 0) then
    raise exception 'Rejected: got % start times, % end times, % all-day values and % calendars. They must match. Nothing was saved.',
      n, coalesce(array_length(e, 1), 0), coalesce(array_length(a, 1), 0), coalesce(array_length(c, 1), 0);
  end if;

  -- 1) Check everything before saving anything.
  for i in 1 .. n loop
    if s[i] !~ iso_re or e[i] !~ iso_re or lower(a[i]) !~ flag_re then
      raise exception 'Rejected: event % is not a start time, end time and Yes/No. Only busy times may be sent, so nothing was saved.', i;
    end if;
    if length(c[i]) > 100 or c[i] ~ '[[:cntrl:]]' then
      raise exception 'Rejected: calendar name % is not valid. Nothing was saved.', i;
    end if;
    begin
      st := s[i]::timestamptz; en := e[i]::timestamptz;
    exception when others then
      raise exception 'Rejected: event % has an invalid date. Nothing was saved.', i;
    end;
    continue when en < now() - interval '1 day' or st > now() + interval '400 days';
    keep := keep || i;
  end loop;

  select array_agg(distinct x) into names from unnest(c) x;
  if coalesce(array_length(names, 1), 0) > 40 then
    raise exception 'Rejected: more than 40 different calendar names. Check that the shortcut sends the Calendar, not the event title. Nothing was saved.';
  end if;

  -- 2) Remember calendar names (owner-only), then replace busy times.
  insert into public.user_calendars (user_id, name)
  select uid, x from unnest(coalesce(names, '{}')) x
  on conflict (user_id, name) do update set last_seen_at = now();

  delete from public.busy_blocks where user_id = uid and source = 'calendar';
  insert into public.busy_blocks (user_id, starts_at, ends_at, all_day, source, calendar_id)
  select uid,
         s[k]::timestamptz,
         greatest(e[k]::timestamptz, s[k]::timestamptz + interval '1 minute'),
         lower(a[k]) in ('yes', 'true', '1', 'ja'),
         'calendar',
         (select id from public.user_calendars where user_id = uid and name = c[k])
  from unnest(keep) k;

  update public.profiles set last_synced_at = now() where id = uid;
  return format('Synced %s busy times from %s calendars to Friends', coalesce(array_length(keep, 1), 0), coalesce(array_length(names, 1), 0));
end $$;

revoke execute on function public.sync_busy_lists(text, text, text, text, text) from public;
grant  execute on function public.sync_busy_lists(text, text, text, text, text) to anon, authenticated;
