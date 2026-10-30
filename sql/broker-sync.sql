-- Broker sync tables. Run in the Supabase SQL Editor, after the owner-only policies in the README. Safe to run again.
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

-- Trades read from the brokers. The app lists the ones that are not in your ledger yet.
create table if not exists broker_trades (
  external_id    text        primary key,        -- for example luno:XBTMYR:12345
  broker         text        not null,
  asset          text        not null,
  side           text        not null,           -- buy or sell
  qty            numeric     not null,           -- units that arrived (buy) or left (sell)
  cash_amount    numeric     not null,           -- money that left (buy) or arrived (sell), fee included
  fee_quote      numeric     not null default 0,
  quote_currency text        not null,
  traded_at      timestamptz not null
);

-- Marks a ledger line as created from a broker trade. The unique index stops the same trade being imported twice.
alter table transactions add column if not exists external_id text;
create unique index if not exists transactions_external_id_key on transactions (external_id) where external_id is not null;

alter table broker_balances    enable row level security;
alter table broker_trades      enable row level security;
alter table broker_sync_status enable row level security;

drop policy if exists "owner reads balances" on broker_balances;
drop policy if exists "owner reads sync"     on broker_sync_status;
drop policy if exists "owner reads trades"   on broker_trades;

do $$
declare
  owner_id constant uuid := 'PASTE-YOUR-USER-ID-HERE';
begin
  execute format('create policy "owner reads balances" on broker_balances for select to authenticated using (auth.uid() = %L)', owner_id);
  execute format('create policy "owner reads sync" on broker_sync_status for select to authenticated using (auth.uid() = %L)', owner_id);
  execute format('create policy "owner reads trades" on broker_trades for select to authenticated using (auth.uid() = %L)', owner_id);
end $$;
