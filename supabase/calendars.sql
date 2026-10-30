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
  n_saved int := 0;
  n_off int := 0;
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
  from unnest(keep) k
  -- Calendars switched off in the app are not stored at all.
  where coalesce((select included from public.user_calendars where user_id = uid and name = c[k]), true);
  get diagnostics n_saved = row_count;

  select count(*) into n_off from public.user_calendars
   where user_id = uid and not included and name = any(coalesce(names, '{}'));

  update public.profiles set last_synced_at = now() where id = uid;
  return format('Synced %s busy times from %s calendars to Friends%s',
                n_saved, coalesce(array_length(names, 1), 0) - n_off,
                case when n_off > 0 then format(' (%s switched off in Friends were skipped)', n_off) else '' end);
end $$;

revoke execute on function public.sync_busy_lists(text, text, text, text, text) from public;
grant  execute on function public.sync_busy_lists(text, text, text, text, text) to anon, authenticated;

-- Make the API see new/changed functions straight away.
notify pgrst, 'reload schema';
