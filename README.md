# Portfolio Tracker PWA

A private, mobile-first dashboard for an investment portfolio valued in Malaysian Ringgit (MYR). The app is a static website. It stores no secrets in the repository: each device keeps its own Supabase details and a hashed PIN in the browser.

## Features

- Five tabs: Summary, Cash, Stocks, MMF and Crypto.
- Live MYR prices, cached for 120 seconds, with fallback to the last known price and then to average cost.
  - Crypto: CoinGecko.
  - Stocks (VOO, QQQM, SPYL): Yahoo Finance, with Finnhub as an optional backup, through a Cloudflare function.
- Brokers: Luno, Pionex, Moomoo, IBKR and Bank. IBKR holds the same stocks as Moomoo.
- Prices for IBKR stocks are entered in USD, and prices for Pionex crypto in USDT. The app converts them to RM when it saves.
- Buy and sell transactions with weighted-average cost and realised profit or loss.
- First-time setup wizard, PIN lock screen, CSV export and offline app shell.

## Project structure

```
public/                 The website. Cloudflare publishes this folder.
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
functions/api/stocks.js Cloudflare function: stock quotes and exchange rates
tests/                  Unit tests
wrangler.toml           Cloudflare Pages settings
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

3. Allow the app to read and write the table:

```sql
alter table portfolio enable row level security;
create policy "app can read"   on portfolio for select to anon using (true);
create policy "app can insert" on portfolio for insert to anon with check (true);
create policy "app can update" on portfolio for update to anon using (true) with check (true);
```

4. Open **Project Settings > API**. Copy the **Project URL** and the **anon public** key. Never use the `service_role` key.

The PIN only locks the screen on one device. Real protection comes from keeping the project URL and anon key private.

## Run locally

Use Cloudflare's local runtime, so the stock function works too:

```
npx wrangler pages dev public
```

Run the tests with `npm test`.

## Deploy with Cloudflare Pages

1. Open https://dash.cloudflare.com and choose **Workers & Pages > Create > Pages > Connect to Git**.
2. Select the `Portfolio-Tracker-PWA` repository.
3. Use these build settings, then choose **Save and Deploy**:
   - Framework preset: `None`
   - Build command: leave empty
   - Build output directory: `public`
4. After about one minute, the site is live at `https://<project-name>.pages.dev`. Every push to `main` deploys again automatically.
5. Optional backup for stock prices: open the project, then **Settings > Variables and Secrets**, add the secret `FINNHUB_API_KEY` (a free key from https://finnhub.io), and deploy again.

Deploy from the command line instead with:

```
npx wrangler login
npx wrangler pages deploy public --project-name portfolio-tracker-pwa
```

GitHub Pages cannot run the stock function. Use the Cloudflare address.

## Install on a phone

- **iPhone (Safari):** open the address, tap **Share**, then **Add to Home Screen**.
- **Android (Chrome):** open the address, tap the menu, then **Install app**.

## Currency rules

| Broker | Asset type | Price is entered in | Saved in |
| --- | --- | --- | --- |
| IBKR | Stocks | USD | RM |
| Pionex | Crypto | USDT | RM |
| Every other case | Any | RM | RM |

The drawer shows the total in USD or USDT, the exchange rate used, and the total in RM. The cost basis is fixed at the rate of the day of the transaction. The USD rate comes from Yahoo Finance. The USDT rate comes from CoinGecko. If only one of them is available, it stands in for the other.

## First launch

Enter the Supabase URL, the anon key and a 4-digit PIN. The app tests the connection before it saves anything. Repeat this once on each device.

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
| "Stock prices: status 404" | The site is not running on Cloudflare Pages, or the `functions` folder was not deployed. |
| "Stock prices: status 502" | Yahoo Finance refused the request. Add the `FINNHUB_API_KEY` secret as a backup, or try again later. |
| "The USD to RM rate is not available" | Press Refresh on the dashboard and try again. |
| SPYL has no price | `SPYL.L` is the London listing. If you hold a different listing, change `stockSymbol` for SPYL in `public/js/config.js`. |
| The old version appears after a deploy | Raise `CACHE_VERSION` in `public/sw.js`, then reload twice. |
