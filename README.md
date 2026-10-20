# Portfolio Tracker PWA

A private, mobile-first dashboard for an investment portfolio valued in Malaysian Ringgit (MYR). The app is a static website. It stores no secrets in the repository: each device keeps its own Supabase details and a hashed PIN in the browser.

## Features

- Five tabs: Summary, Cash, Stocks, MMF and Crypto.
- Live MYR prices from CoinGecko, cached for 120 seconds, with fallback to the last known price and then to average cost.
- Buy and sell transactions with weighted-average cost and realised profit or loss.
- First-time setup wizard, PIN lock screen, CSV export and offline app shell.

## Project structure

```
index.html              Page structure, tabs, dialogs, library tags
manifest.json           Install details for the home screen
sw.js                   Service worker (offline app shell)
css/                    base (tokens), layout, components, animations
assets/icons/           App icons
js/
  main.js               Entry point: chooses the screen, connects the parts
  config.js             All settings and the asset catalogue
  state.js              The single store for app data
  logic/                Pure logic with no browser features (tested)
  services/             Supabase, prices, PIN and storage
  ui/                   Screens, tables, charts, tabs, dialogs
    views/              One file per tab
tests/                  Unit tests for the calculations
```

## Coding conventions

- Files and CSS classes use kebab-case. Functions and variables use camelCase. Constants use UPPER_SNAKE_CASE.
- Database columns use snake_case only inside `js/services/database.js`. The rest of the app uses camelCase.
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

Use any static server, because browsers block modules and service workers on `file://` pages.

```
npx serve .
```

Run the tests with `npm test`.

## Deploy with GitHub Pages

1. Push the files to the `main` branch.
2. Open the repository on GitHub, then **Settings > Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, select `main` and `/ (root)`, then save.
4. After about one minute, the site is live at `https://<username>.github.io/<repository>/`.

## Install on a phone

- **iPhone (Safari):** open the address, tap **Share**, then **Add to Home Screen**.
- **Android (Chrome):** open the address, tap the menu, then **Install app**.

## First launch

Enter the Supabase URL, the anon key and a 4-digit PIN. The app tests the connection before it saves anything. Repeat this once on each device.

## Making changes

- Change colours, assets, brokers or timings in `js/config.js`. To track a new asset, add one line to `ASSET_CATALOG`.
- Change styles in `css/`. Colours and sizes are variables at the top of `css/base.css`.
- After a release, raise `CACHE_VERSION` in `sw.js` so phones fetch the new files.
- To update a library, change the version in `index.html` and replace its `integrity` value. Compute the hash with:

```
openssl dgst -sha384 -binary <file> | openssl base64 -A
```

## Troubleshooting

| Problem | Action |
| --- | --- |
| "A required library did not load" | Check the internet connection and reload. Confirm the version in `index.html` exists on jsDelivr. |
| "Supabase blocked this request" | Run the policies in the Supabase section above. |
| "Supabase rejected the anon key" | Use **Reset credentials** on the lock screen and enter the key again. |
| A price shows as an estimate | CoinGecko has no price for that ID. The asset is valued at average cost. Check `coinId` in `js/config.js`. |
| The old version appears after a deploy | Raise `CACHE_VERSION` in `sw.js`, then reload twice. |
