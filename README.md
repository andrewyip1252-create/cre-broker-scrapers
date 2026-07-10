# CRE Broker Scrapers

Scripts that pull commercial real estate broker contact info (name, title, email, phone, company, location) from brokerage firm websites and write it to CSV.

## Scripts

| Script | Target | Output | Dependencies |
|---|---|---|---|
| `1_scrape_colliers.js` | Colliers experts directory | `output/1_colliers_brokers.csv` | Puppeteer + local Edge/Chrome |
| `1_scrape_signature.js` | Signature Associates team page | `output/signature_brokers.csv` | none (built-in `https`) |
| `2_scrape_kbc.js` | KBC Advisors team directory | `output/kbc_brokers.csv` | none (built-in `https`) |
| `jll_canada_scraper.js` | JLL Canada people search | `jll_canada_brokers.csv` | Puppeteer + local Edge/Chrome |
| `jll_people_scraper.js` | JLL US people search API | `jll_people.csv` | none (Node 18+ built-in `fetch`) |
| `nai_brokers.js` | NAI Global broker directory | `output/nai_brokers.csv` | none (built-in `https`/`http`) |

All scripts filter results down to broker/agent-type titles (excluding property management, accounting, marketing, admin, etc. roles) and normalize phone numbers to `+1 XXX-XXX-XXXX`.

## Install

```
npm install
```

This only pulls in Puppeteer, which is required for `jll_canada_scraper.js`. The other four scripts have no dependencies.

## Setup for jll_people_scraper.js

This one needs a JLL API subscription key, since it calls their people-search API directly:

```
cp .env.example .env
```

Then open `.env` and fill in `JLL_SUBSCRIPTION_KEY` (and `JLL_COOKIE` if you get a 401/403). Instructions for finding the key are in the comment block at the top of the script.

## Run

```
node 1_scrape_colliers.js
node 1_scrape_signature.js
node 2_scrape_kbc.js
node jll_canada_scraper.js
node jll_people_scraper.js
node nai_brokers.js
```

Or via npm scripts: `npm run colliers`, `npm run signature`, `npm run kbc`, `npm run jll-canada`, `npm run jll-people`, `npm run nai`.

Scripts that write to `output/` create the folder automatically. `2_scrape_kbc.js` and `nai_brokers.js` save resumable progress (`*_progress.json`) — if interrupted, just re-run and they'll pick up where they left off.

## Notes

- CSV outputs and progress files are git-ignored — they're local run artifacts, not source.
- `jll_canada_scraper.js` launches a visible (non-headless) browser by default; set `headless: true` in its `CONFIG` object to run it hidden.
- Selectors and title-filter keyword lists are defined near the top of each file — update them there if a site changes its markup or you want to adjust which roles count as "brokers."
