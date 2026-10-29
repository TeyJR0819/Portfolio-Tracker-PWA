-- Broker sync tables. Run once in the Supabase SQL Editor, after the owner-only policies in the README.
-- Replace PASTE-YOUR-USER-ID-HERE with your User UID (the same one used for the other policies).
--
-- Only the Cloudflare Worker writes these tables, with the service key, which skips Row Level Security.
-- No write policy exists, so the app, the anon key and your own sign-in cannot change them.

create table if not exists broker_balances (
  broker    text        not null,
  asset     text        not null,
  qty       numeric     not null,
  synced_at timestamptz not null,
  primary key (broker, asset)
);

create table if not exists broker_sync_status (
  broker    text        primary key,
  ok        boolean     not null,
  message   text        not null default '',
  synced_at timestamptz not null
);

alter table broker_balances    enable row level security;
alter table broker_sync_status enable row level security;

drop policy if exists "owner reads balances" on broker_balances;
drop policy if exists "owner reads sync"     on broker_sync_status;

do $$
declare
  owner_id constant uuid := 'PASTE-YOUR-USER-ID-HERE';
begin
  execute format('create policy "owner reads balances" on broker_balances for select to authenticated using (auth.uid() = %L)', owner_id);
  execute format('create policy "owner reads sync" on broker_sync_status for select to authenticated using (auth.uid() = %L)', owner_id);
end $$;
