# Portfolio Tracker PWA

A private, mobile-first dashboard for an investment portfolio valued in Malaysian Ringgit (MYR). The app is a static website. It stores no secrets in the repository: each device keeps its own Supabase details and a hashed PIN in the browser.

## Features

- Six tabs: Summary, Cash, Stocks, MMF, Crypto and Transactions.
- A switch in the header shows every amount in RM or in USD.
- Live MYR prices, cached for 120 seconds, with fallback to the last known price and then to average cost.
  - Crypto: CoinGecko.
  - Stocks (VOO, QQQM, SPYL): Yahoo Finance, with Finnhub as an optional backup, through a Cloudflare function.
- Brokers: Luno, Pionex, Moomoo, Webull, IBKR and Bank. Webull and IBKR hold the same stocks as Moomoo.
- Cash accounts for Bank, Luno, Pionex (USDT), Moomoo, Webull and IBKR (USD), plus the Moomoo MMF.
- One "Add entry" form for every kind of entry (see Entries below), with optional fees and a note.
- Weighted-average cost, realised profit or loss, and the cost per unit calculated from the amount paid.
- A Transactions page that lists every entry.
- First-time setup wizard, PIN lock screen, CSV export and offline app shell.

## Project structure

```
public/                 The website. Cloudflare serves this folder as static files.
  index.html            Page structure, tabs, dialogs, library tags
  manifest.json         Install details for the home screen
  sw.js                 Service worker (offline app shell)
  _headers              Cloudflare response headers
  css/                  base (tokens), layout, components, animations
  assets/icons/         App icons
  js/
    main.js             Entry point: chooses the screen, connects the parts
    config.js           All settings, the asset catalogue and the currency rules
    state.js            The single store for app data
    logic/              Pure logic with no browser features (tested)
    services/           Supabase, prices, PIN and storage
    ui/                 Screens, tables, charts, tabs, dialogs
      views/            One file per tab
src/worker.js           Cloudflare Worker entry point (routes /api/*)
src/stocks.js           Stock quotes and exchange rates (Yahoo Finance, Finnhub)
src/brokers/            Scheduled read-only sync of broker balances and trades (Luno, Pionex, IBKR)
src/ledger-sync.js      Records new broker trades in the ledger and sets Luno and Pionex cash
src/trade-import.js     Turns broker trades into ledger entries (pure logic)
src/supabase.js         Database client used by the Worker (service key, never in the browser)
sql/                    Database scripts to run in the Supabase SQL Editor
tests/                  Unit tests
wrangler.toml           Cloudflare settings
```

## Coding conventions

- Files and CSS classes use kebab-case. Functions and variables use camelCase. Constants use UPPER_SNAKE_CASE.
- Database columns use snake_case only inside `public/js/services/database.js`. The rest of the app uses camelCase.
- Spelling follows British English (`realised`), which matches the database column `realised_pl`.
- Each file has one job and starts with a comment that states it.

## Set up Supabase

1. Create a project at https://supabase.com.
2. Open **SQL Editor** and create the table if it does not exist yet:

```sql
create table if not exists portfolio (
  id bigint generated always as identity primary key,
  category text not null,
  broker text not null,
  asset text not null,
  qty numeric not null default 0,
  cost_myr numeric not null default 0,
  realised_pl numeric not null default 0
);
```

3. Turn on Row Level Security, so nobody can read the table until the owner-only policies exist (see Secure access):

```sql
alter table portfolio enable row level security;
```

4. Open **Project Settings > API**. Copy the **Project URL** and the **anon public** key. Never use the `service_role` key.

The anon key is public by design. The protection is the sign-in plus the policies in Secure access. The PIN only locks the screen on one device.

## Run locally

Use Cloudflare's local runtime, so the stock endpoint works too:

```
npx wrangler dev
```

Run the tests with `npm test`.

## Deploy with Cloudflare

The repository is a Cloudflare Worker with static assets. Cloudflare serves `public/` and runs `src/worker.js` for `/api/*`.

1. Open https://dash.cloudflare.com and choose **Workers & Pages > Create application > Import a repository**.
2. Select the `Portfolio-Tracker-PWA` repository.
3. Use these settings, then choose **Deploy**:
   - Build command: leave empty
   - Deploy command: `npx wrangler deploy`
   - The project name must match `name` in `wrangler.toml` (`portfolio-tracker-pwa`).
4. After about one minute, the site is live at `https://portfolio-tracker-pwa.<your-subdomain>.workers.dev`. Every push to `main` deploys again automatically.
5. Optional backup for stock prices: open the project, then **Settings > Variables and secrets**, add the secret `FINNHUB_API_KEY` (a free key from https://finnhub.io), and deploy again.

Deploy from the command line instead with `npx wrangler login`, then `npx wrangler deploy`.

GitHub Pages cannot run the stock endpoint. Use the Cloudflare address.

## Install on a phone

- **iPhone (Safari):** open the address, tap **Share**, then **Add to Home Screen**.
- **Android (Chrome):** open the address, tap the menu, then **Install app**.

## Transactions table

The Transactions page needs a second table. Run this once in the Supabase **SQL Editor**:

```sql
create table if not exists transactions (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  trade_date date not null,
  kind text not null,
  broker text not null default '',
  asset text not null default '',
  qty numeric not null default 0,
  price numeric not null default 0,
  currency text not null default 'MYR',
  fee numeric not null default 0,
  rate numeric not null default 1,
  total_myr numeric not null default 0,
  from_account text not null default '',
  to_account text not null default '',
  amount_from numeric not null default 0,
  amount_to numeric not null default 0,
  realised_pl numeric not null default 0,
  note text not null default ''
);

alter table transactions enable row level security;
```

Without this table, the dashboard still works, but the Transactions page stays empty and shows a reminder.

## Secure access

The database answers only you. Follow these steps in this order.

1. **Create your account.** In Supabase, open **Authentication > Users > Add user > Create new user**. Enter your email and a long, unique password, and tick **Auto Confirm User**. Copy the **User UID** shown in the list.
2. **Close the front door.** Open **Authentication > Sign In / Providers** and turn off **Allow new users to sign up**.
3. **Deploy this version of the app** and sign in once. The app asks for the email and password after the PIN screen.
4. **Switch the policies to owner-only.** Open the SQL Editor, replace `PASTE-YOUR-USER-ID-HERE` with your User UID, and run:

```sql
drop policy if exists "app can read"         on portfolio;
drop policy if exists "app can insert"       on portfolio;
drop policy if exists "app can update"       on portfolio;
drop policy if exists "app can read history" on transactions;
drop policy if exists "app can add history"  on transactions;
drop policy if exists "owner reads"          on portfolio;
drop policy if exists "owner inserts"        on portfolio;
drop policy if exists "owner updates"        on portfolio;
drop policy if exists "owner reads history"  on transactions;
drop policy if exists "owner adds history"   on transactions;

do $$
declare
  owner_id constant uuid := 'PASTE-YOUR-USER-ID-HERE';
begin
  execute format('create policy "owner reads"   on portfolio for select to authenticated using (auth.uid() = %L)', owner_id);
  execute format('create policy "owner inserts" on portfolio for insert to authenticated with check (auth.uid() = %L)', owner_id);
  execute format('create policy "owner updates" on portfolio for update to authenticated using (auth.uid() = %L) with check (auth.uid() = %L)', owner_id, owner_id);
  execute format('create policy "owner reads history" on transactions for select to authenticated using (auth.uid() = %L)', owner_id);
  execute format('create policy "owner adds history"  on transactions for insert to authenticated with check (auth.uid() = %L)', owner_id);
end $$;
```

After this, the public key alone reads and writes nothing. Another Supabase account would not work either, because the policies name your User UID.

5. **Protect the website with Cloudflare Access.** In the Cloudflare dashboard, open **Zero Trust** (choose the free plan the first time), then **Access > Applications > Add an application > Self-hosted**. Enter the address of your site, add a policy with the action **Allow** and the rule **Emails** set to your own email, and choose **One-time PIN** as the login method. Set the session length as long as allowed, so the phone app does not ask often. Menu names can differ slightly between versions.
6. **Protect the repository.** In GitHub, open **Settings > Code security** and turn on secret scanning and push protection. Turn on two-factor authentication for GitHub, Cloudflare and Supabase.

Keep in mind:
- Do not turn on Supabase multi-factor authentication yet. The app cannot answer that challenge.
- The sign-in session is stored in this browser. **Sign out** on the lock screen removes it and the saved copy of the data.
- Never put a secret in the repository, in `wrangler.toml` or in the browser. Future broker keys will live only as Cloudflare secrets.

## Broker sync (Luno, Pionex and IBKR)

A Cloudflare Worker reads your Luno and Pionex balances every 15 minutes, and your IBKR positions every 6 hours, and saves them in Supabase. The **Broker check** card on the Summary tab compares them with your ledger. The page never sees a broker key, and the sync only reads: it cannot trade or withdraw.

Do these steps in order.

1. **Create the tables.** Open `sql/broker-sync.sql`, replace `PASTE-YOUR-USER-ID-HERE` with your User UID, and run it in the Supabase SQL Editor.
2. **Create a Luno key.** In Luno, open **Settings > API Keys** and create a key with only **View balance** (`Perm_R_Balance`). Copy the key ID and the secret.
3. **Create a Pionex key.** In Pionex, open **API Management** and create a key with **Read** permission only. Do not enable trading or withdrawal. Pionex offers an IP allowlist, but a Worker has no fixed address, so leave it empty and rely on the read-only permission.
4. **Create the IBKR report and token.** IBKR has no live read-only key. It offers a saved report (a Flex Query) and a token that can only run that report.
   - In IBKR Client Portal, open **Performance & Reports > Flex Queries**. Create an **Activity Flex Query** with the sections **Open Positions** (tick **Summary** level, and fields Symbol, Quantity, Currency) and **Cash Report** (fields Currency, Ending Cash). Set the format to **XML** and save. Note the **Query ID**.
   - Open **Flex Queries > Flex Web Service Configuration**, enable the service, and generate a token. Choose the **longest expiry** offered, because the default is only 6 hours. Copy the token. Leave the IP restriction empty (a Worker has no fixed address).
   - The token expires. When the Broker check shows `1012` (token expired), generate a new one and update the secret.
5. **Get the Supabase secret key.** Open **Project Settings > API Keys**. Copy the **secret** key (or the legacy `service_role` key). This key skips the database rules, so it must live only in Cloudflare and nowhere else.
6. **Store the secrets in Cloudflare.** Open the Worker, then **Settings > Variables and secrets**, and add each of these as type **Secret**: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (the anon public key, so visitors need not type it), `SUPABASE_SERVICE_KEY`, `LUNO_KEY_ID`, `LUNO_KEY_SECRET`, `PIONEX_API_KEY`, `PIONEX_API_SECRET`, `IBKR_FLEX_TOKEN`, `IBKR_FLEX_QUERY_ID`. Then deploy again. Never type them into a file, the chat or GitHub.
7. **Wait up to 15 minutes**, then refresh the dashboard. The Broker check card shows each broker's last read time or its error. To test sooner, open the Worker in Cloudflare and use **Settings > Trigger Events > Cron Triggers**, or run `npx wrangler dev --test-scheduled` locally.

How to read the result:

- **Matches:** the ledger and the broker agree.
- **Differs:** the quantities disagree. Check for a missed entry, a fee, or a trade made outside the app.
- **Not in ledger / Not at broker:** one side holds the asset and the other does not.
- A broker whose last read failed is left out of the comparison, so old numbers never look current.

IBKR reports the last business day, so a trade made today shows as **Differs** until the next report. To read IBKR on every run while testing, add a plain (not secret) variable `SYNC_ALWAYS` with the value `true`, then delete it afterwards.

The comparison covers quantities only. Prices, costs and profit still come from the ledger. Pionex bot and earn balances are not read, which matches the app's rules.

If a broker shows `status 401` or `403`, the key or its permission is wrong. Create it again and update the secret.

## Automatic ledger from Luno and Pionex trades

You do not enter these trades by hand. Two Worker runs keep your ledger up to date:

1. Every 15 minutes (Pionex once an hour) the Worker reads your balances and your newest trades from Luno and Pionex (BTC, ETH, ADA, LINK, SUI and TON) and saves them in `broker_balances` and `broker_trades`.
2. Seven minutes later a second run records every new trade in your ledger as a Buy or Sell, with fees included in the cost and the broker's trade ID written on the line. It then sets **Luno Cash** and **Pionex Cash** to the balance the broker reports.

The Summary and Transactions tabs show the result at your next refresh. The Broker check card lists the status of each run, including a **Ledger** line.

**Pionex bots.** Pionex's own API leaves bot (strategy) trades out of both its fills and its balances, so bot money never enters the ledger.

Do these steps once:

1. Run `sql/broker-sync.sql` again in the Supabase SQL Editor (with your User UID). It adds the `broker_trades` table and a trade ID column on `transactions`. It is safe to run twice.
2. Deploy. Cloudflare registers both schedules from `wrangler.toml`.
3. To read your **full history** instead of only the newest 100 trades per coin, add the plain Cloudflare variable `TRADES_BACKFILL` with the value `true`. Deploy, wait for two cycles (about 30 minutes), then delete the variable and deploy again. The backfill reads up to 500 trades per coin.
4. Open the dashboard and press **Refresh**.

Rules the sync follows:

- A trade is recorded only once, even if two runs overlap. The database refuses a second line with the same trade ID.
- The whole change is worked out first. If a save fails, everything done in that run is undone.
- A sale of more coins than the ledger holds means the coins came from somewhere the history does not show (a deposit, staking, an older trade). The sync first adds the missing coins at the price they were sold for, so the sale shows no profit or loss on them, and notes this on the **Ledger** line ("... had no earlier purchase"). The Transactions tab shows these lines with the note "Opening balance". To give those coins a real cost, enter your own Buy for them.
- A trade that cannot be recorded (for example a missing exchange rate) holds back only the later trades of the same coin at the same broker. The **Ledger** line names it.
- Cash is set to the broker balance, so the Cash tab always matches Luno and Pionex. Money you move in or out needs no entry for these two accounts.

Limits you should know:

- Deposits, withdrawals and transfers between exchanges are not imported as separate lines. Their effect on cash is covered by the cash sync, but the coins you move between exchanges, or deposit from a wallet, have no cost in the ledger. Enter those with **Transfer** or **Buy** (with "Deduct from cash" off).
- A Pionex trade is converted from USDT to RM at the rate of the day of the sync, because the app keeps one rate. The cost of an old Pionex trade is therefore approximate.
- A Pionex fee paid in another coin (for example a platform token) is not counted.
- Coins outside the six above are not imported.
- If you add an entry by hand at the same moment a sync runs, the later save can overwrite the earlier one. Refresh before you add an entry.
- The Worker is limited in how many outside requests one run may make. The sync therefore saves each changed balance once and all history lines in one request, so a large first import fits in one run.

**Pionex rate limit.** Pionex allows 10 weight per second per account, and a trade request weighs 5. The Worker reads Pionex once an hour, pauses 0.7 seconds before each request, and identifies itself with a User-Agent. If Pionex still answers 429, the Worker stops at once (a retry would extend Pionex's 60-second ban) and tries again in the next hourly run. The Broker check line then shows what Pionex replied, for example the retry time. To test Pionex outside the hourly run, add the plain Cloudflare variable `SYNC_ALWAYS` with the value `true` (it also makes IBKR run every time), then delete it afterwards.

## Entries

Choose **Add entry** and pick a type. Every entry can carry a date and a note.

| Type | What it does |
| --- | --- |
| Buy | Adds the asset. Takes the amount paid, plus the fee, out of the broker's cash. |
| Sell | Removes the asset. Adds the amount received, minus the fee, to the broker's cash. |
| Transfer between accounts | Moves cash from one account to another. The received amount is filled in at today's rate and can be changed. |
| Deposit from outside | Adds money from outside the portfolio, such as income, to one account. |
| Cash out to outside | Takes money out of the portfolio, such as spending, from one account. |
| MMF gain | Adds a gain to the money market fund balance. The principal stays the same, so the gain shows as profit. |
| Adjust balance | Sets an account to the balance that the bank or broker shows. |

For a buy or a sell, enter either the price per unit or the total amount. With the total, the app works out the cost per unit. The option "Deduct from cash" can be switched off to record an old trade without touching cash.

## Currency rules

| Broker | Prices, fees and cash are entered in | Saved in |
| --- | --- | --- |
| IBKR (stocks and IBKR Cash) | USD | RM |
| Pionex (crypto and Pionex Cash) | USDT | RM |
| Luno, Moomoo, Webull and Bank | RM | RM |

The form shows the exchange rate used. The cost basis is fixed at the rate of the day of the entry. The USD rate comes from Yahoo Finance. The USDT rate comes from CoinGecko. If only one of them is available, it stands in for the other. USD and USDT cash balances are valued at the current rate, so their profit or loss includes the exchange-rate effect. This effect becomes realised when the cash is moved or spent.

The switch in the header only changes how amounts are shown. The database always holds RM costs.

## First launch

Each new device asks once for a 4-digit PIN, then for your email and password.

This works when the Worker has the secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY` (the **anon public** key). The Worker then gives these two public values to the page through `/api/config`, and nobody types them. The route returns only those two values, never the service key or a broker key. Without both secrets the route is absent, and the first screen asks for the URL and the anon key instead (this is also how local use and GitHub Pages work).

## Making changes

- Change colours, assets, brokers, currency rules or timings in `public/js/config.js`. To track a new asset, add one line to `ASSET_CATALOG`. Use `coinId` for crypto and `stockSymbol` (a Yahoo Finance symbol) for stocks.
- Change styles in `public/css/`. Colours and sizes are variables at the top of `base.css`.
- After a release, raise `CACHE_VERSION` in `public/sw.js` so phones fetch the new files.
- To update a library, change the version in `public/index.html` and replace its `integrity` value. Compute the hash with:

```
openssl dgst -sha384 -binary <file> | openssl base64 -A
```

## Troubleshooting

| Problem | Action |
| --- | --- |
| "A required library did not load" | Check the internet connection and reload. Confirm the version in `index.html` exists on jsDelivr. |
| "Supabase blocked this request" | Run the policies in the Supabase section above. |
| "Supabase rejected the anon key" | Use **Reset credentials** on the lock screen and enter the key again. |
| A price shows as an estimate | The price service has no price for that asset. It is valued at average cost. Check `coinId` or `stockSymbol` in `public/js/config.js`. |
| "Stock prices: status 404" | The site is not running on Cloudflare, or `src/worker.js` was not deployed. |
| "Stock prices: status 502" | Yahoo Finance refused the request. Add the `FINNHUB_API_KEY` secret as a backup, or try again later. |
| "The USD to RM rate is not available" | Press Refresh on the dashboard and try again. |
| SPYL has no price | `SPYL.L` is the London listing. If you hold a different listing, change `stockSymbol` for SPYL in `public/js/config.js`. |
| The old version appears after a deploy | Raise `CACHE_VERSION` in `public/sw.js`, then reload twice. |
| Deploy fails with "Missing entry-point" | `wrangler.toml` must contain `main` and an `[assets]` section, as in this repository. Do not add `pages_build_output_dir`. |

## Luno staking

- The Luno balance adds the normal wallet and the staking wallet of each coin (Luno marks staking accounts with `account_type: STAKING`; the key needs "View staking").
- Moving coins between the wallet and the staking wallet is not a trade. Both sides cancel out, so staked coins keep the buying price of the normal wallet.
- Every staking reward is recorded as a buy at RM 0.00 cost, so the average price falls and the coins carry full value.

## Luno balance check

After the history is applied, every Luno coin is set to the quantity Luno reports (normal plus staking wallet). A gap that the history cannot explain is never booked as a free reward. It is added or removed at the average cost and written as a ledger line "Balance corrected to the Luno balance". The Ledger status names the coin and the amount, so the gap can be traced to the missing movement.
RM 0.00 buys have one intended source: staking rewards read from the staking account history (note "Staking reward").
