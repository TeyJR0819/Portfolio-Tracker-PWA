-- Chart tab storage. Run in the Supabase SQL Editor, after the owner-only policies in the README. Safe to run again.
-- Replace PASTE-YOUR-USER-ID-HERE with your User UID (the same one used for the other policies).
--
-- One row per saved item. The key says what it is:
--   drawings:<asset>:<currency>   the support, resistance and trend lines drawn on one asset in USD or MYR
--   watchlist                     the assets added to the watchlist
-- The value is JSON written by the app.

create table if not exists chart_state (
  key        text        primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now()
);

alter table chart_state enable row level security;

drop policy if exists "owner reads chart state"   on chart_state;
drop policy if exists "owner writes chart state"  on chart_state;
drop policy if exists "owner updates chart state" on chart_state;
drop policy if exists "owner deletes chart state" on chart_state;

do $$
declare
  owner_id constant uuid := 'PASTE-YOUR-USER-ID-HERE';
begin
  execute format('create policy "owner reads chart state" on chart_state for select to authenticated using (auth.uid() = %L)', owner_id);
  execute format('create policy "owner writes chart state" on chart_state for insert to authenticated with check (auth.uid() = %L)', owner_id);
  execute format('create policy "owner updates chart state" on chart_state for update to authenticated using (auth.uid() = %L) with check (auth.uid() = %L)', owner_id, owner_id);
  execute format('create policy "owner deletes chart state" on chart_state for delete to authenticated using (auth.uid() = %L)', owner_id);
end $$;
