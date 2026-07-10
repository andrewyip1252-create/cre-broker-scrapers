/**
 * JLL People -> CSV
 * -----------------
 * Pulls all people records from JLL's people-search API and writes them to a CSV.
 *
 * Requirements: Node.js v18 or newer (uses the built-in fetch — no `npm install` needed).
 *
 * Setup (one time):
 *   1. Copy the example env file:   cp .env.example .env   (Windows: copy .env.example .env)
 *   2. Open .env and paste your JLL subscription key after JLL_SUBSCRIPTION_KEY=
 *
 * How to run:
 *   1. Open a terminal in this folder.
 *   2. Run:  node jll_people_scraper.js
 *   3. When it finishes you'll have  jll_people.csv  in the same folder.
 *
 * Where to get the key:
 *   Open jll.com/en-us/people in Chrome, open DevTools (F12) -> Network tab,
 *   find the "template" request, and copy the value of its `subscription-key`
 *   header. Paste it into your .env file. If the key alone is rejected with a
 *   401/403, also paste your browser cookie into JLL_COOKIE in .env.
 */

const fs = require('fs');

// ---- Load .env (tiny built-in loader, no dependencies) --------------------
// Reads KEY=value lines from a .env file in this folder into process.env.
function loadEnv() {
  try {
    const text = fs.readFileSync('.env', 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      // Strip optional surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (_) {
    // No .env file — that's fine if the vars are already in the environment.
  }
}
loadEnv();

// ---- Config ---------------------------------------------------------------

const ENDPOINT = 'https://www.jll.com/api/search/template';
const SUBSCRIPTION_KEY = process.env.JLL_SUBSCRIPTION_KEY || '';
const COOKIE = process.env.JLL_COOKIE || ''; // optional — only if you hit 401/403 with the key alone
const OUTPUT_FILE = 'jll_people.csv';

// Fail early with a clear message if the key is missing.
if (!SUBSCRIPTION_KEY) {
  console.error('\n[ERROR] No subscription key found.');
  console.error('        Create a .env file (copy .env.example) and set JLL_SUBSCRIPTION_KEY.');
  console.error('        See the comments at the top of this file for where to get the key.\n');
  process.exit(1);
}

const PAGE_SIZE = 100;        // records per request (12 in the browser; 100 = fewer calls)
const DELAY_MS = 600;         // pause between requests, to be gentle on the server
const MAX_RECORDS = Infinity; // set to e.g. 200 to test on a small batch first

// Only keep US people whose role is a broker type.
// Edit this list if you want to widen/narrow what counts as a "broker".
const US_ONLY = true;
const BROKER_SERVICES = [
  'Leasing',
  'Capital markets',
  'Tenant representation',
];

function isBroker(src) {
  if (US_ONLY && src.country !== 'United States') return false;
  const services = (src.services || []).map((s) => String(s).toLowerCase());
  return BROKER_SERVICES.some((b) => services.includes(b.toLowerCase()));
}

// ---- CSV columns ----------------------------------------------------------

const COLUMNS = [
  'firstName', 'lastName', 'fullName', 'jobTitle',
  'email', 'phone', 'city', 'state', 'country',
  'services', 'industries', 'propertyTypes',
  'linkedIn', 'profileUrl', 'imageUrl',
];

// ---- Helpers ---------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function csvCell(value) {
  if (value == null) return '';
  const s = Array.isArray(value)
    ? [...new Set(value)].join('; ')   // dedupe arrays like ["Capital markets","Capital markets"]
    : String(value);
  // Quote if it contains a comma, quote, or newline; escape inner quotes.
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toRow(src) {
  const username = src.username || '';
  return {
    firstName: src.firstName,
    lastName: src.lastName,
    fullName: src.title || `${src.firstName || ''} ${src.lastName || ''}`.trim(),
    jobTitle: src.jobTitle,
    email: src.email,
    phone: src.telephoneNumber,
    city: src.addressCity,
    state: src.addressStateProvince,
    country: src.country,
    services: src.services,
    industries: src.industries,
    propertyTypes: src.propertyTypes,
    linkedIn: src.linkedIn,
    profileUrl: username ? `https://www.jll.com/en-us/people/bio-broker/${username}` : '',
    imageUrl: src.imageUrl,
  };
}

async function fetchPage(from, size) {
  const body = {
    id: 'jll_people_search_template_v2',
    params: {
      size,
      from,
      boostCountry: 'United States',
      sort_by_relevance: true,
      includeGlobalPeople: true,
      countries: ['United States'],
      language: 'en-US',
      query_string: '',
    },
  };

  const headers = {
    'accept': '*/*',
    'content-type': 'application/json',
    'origin': 'https://www.jll.com',
    'referer': 'https://www.jll.com/en-us/people?sort_by_relevance=relevance',
    'subscription-key': SUBSCRIPTION_KEY,
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  };
  if (COOKIE) headers['cookie'] = COOKIE;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} at from=${from}`);
  }
  return res.json();
}

// ---- Main ------------------------------------------------------------------

(async () => {
  // Start the CSV with a header row.
  fs.writeFileSync(OUTPUT_FILE, COLUMNS.join(',') + '\n');

  let from = 0;
  let total = null;
  let written = 0;   // brokers kept
  let scanned = 0;   // total people looked at

  while (true) {
    let data;
    try {
      data = await fetchPage(from, PAGE_SIZE);
    } catch (err) {
      console.error(`\nRequest failed: ${err.message}`);
      console.error('Stopping early — whatever was fetched so far is saved in the CSV.');
      break;
    }

    const hits = data?.hits?.hits || [];
    if (total === null) {
      total = data?.hits?.total?.value ?? 0;
      console.log(`Total records reported: ${total}`);
    }

    if (hits.length === 0) break; // no more results

    const matches = hits.map((h) => h._source || {}).filter(isBroker);
    if (matches.length) {
      const rows = matches.map(toRow);
      const lines = rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(','));
      fs.appendFileSync(OUTPUT_FILE, lines.join('\n') + '\n');
      written += rows.length;
    }

    scanned += hits.length;
    process.stdout.write(`\rScanned ${scanned}${total ? ` / ${total}` : ''} — kept ${written} brokers ...`);

    from += hits.length;
    if (written >= MAX_RECORDS) break;
    if (total && from >= total) break;

    await sleep(DELAY_MS);
  }

  console.log(`\nDone. Scanned ${scanned} people, wrote ${written} US brokers to ${OUTPUT_FILE}`);
})();
