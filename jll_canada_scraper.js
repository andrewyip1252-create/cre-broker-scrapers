/**
 * ─────────────────────────────────────────────────────────────
 * JLL Canada — Broker Scraper (Puppeteer / request interception)
 * ─────────────────────────────────────────────────────────────
 * Target:  https://www.jll.com/en-ca/people?sort_by_relevance=relevance
 * Output:  jll_canada_brokers.csv
 *
 * JLL's search API blocks all non-browser requests at the network level.
 * This script opens the real page in a headless Edge/Chrome browser,
 * intercepts every /api/search/template response as it fires, extracts
 * all broker records from the JSON, then triggers the next page by
 * clicking the "Next" button — repeating until all records are collected.
 *
 * No subscription key or .env file needed.
 * Total Canada records: ~304 (fast run, under 5 minutes).
 *
 * INSTALL:  npm install puppeteer
 * RUN:      node jll_canada_scraper.js
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

// ─────────────────────────────────────────────
// CONFIG  ← edit here if anything needs tuning
// ─────────────────────────────────────────────
const CONFIG = {
  startUrl:          'https://www.jll.com/en-ca/people?sort_by_relevance=relevance',
  apiPath:           '/api/search/template',          // path to intercept
  outputFile:        path.resolve(__dirname, 'jll_canada_brokers.csv'),
  errorDir:          path.resolve(__dirname, 'errors'),
  headless:          false,                           // set true to run hidden
  navigationTimeout: 60_000,
  pageLoadDelay:     3500,   // ms to wait after clicking Next for new results
  maxPages:          0,      // 0 = scrape all pages; set e.g. 3 to test first

  // Use the Edge browser already installed on Windows (no Chromium download needed).
  // If you have Chrome instead, change the path below, or remove executablePath
  // entirely to let Puppeteer use its own bundled Chromium.
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
};

// ─────────────────────────────────────────────
// SELECTORS  ← update via F12 if JLL changes DOM
// ─────────────────────────────────────────────
const SELECTORS = {
  // Cookie / consent banner
  cookieAccept:  '#onetrust-accept-btn-handler, button[id*="accept"], button[aria-label*="Accept"]',
  // Broker cards (confirms results have loaded)
  brokerCard:    '[class*="PeopleCard"], [class*="people-card"], [data-component*="people"], a[href*="/en-ca/people/"]',
  // Pagination next button
  nextBtn:       'button[aria-label="Next page"], [aria-label="Next"], .pagination-next, button:has(svg[data-icon="chevron-right"]), nav[aria-label*="pagination"] button:last-child',
  // "Load more" button (JLL sometimes uses this instead of numbered pages)
  loadMoreBtn:   'button[data-testid*="load-more"], button[class*="load-more"]',
};

// ─────────────────────────────────────────────
// BROKER ROLE FILTER
// ─────────────────────────────────────────────
// Keep only people whose services array matches, OR whose title matches
// as a fallback. All values from the actual Canada API aggregations bucket.
const BROKER_SERVICES = new Set([
  'leasing',
  'tenant representation',
  'capital markets',
  'investment sales and advisory',
  'agency leasing',
  'sale and leaseback',
  'debt advisory',
]);

const TITLE_INCLUDE = [
  'broker', 'agent', 'advisor', 'adviser', 'director', 'vice president',
  'managing director', 'executive director', 'principal', 'associate',
  'leasing', 'capital markets', 'investment', 'sales', 'partner',
  'chair', 'president', 'brokerage',
];

const TITLE_EXCLUDE = [
  'property manager', 'property management', 'facility', 'engineer',
  'maintenance', 'marketing', 'graphic', 'social media', 'research',
  'admin', 'assistant', 'coordinator', 'receptionist', 'accounting',
  'human resources', 'operations', 'intern', 'project manager',
  'transaction manager', 'valuation', 'client services',
  'project and development', 'strategy and design', 'facilities management',
];

function isBroker(src) {
  // Primary: services array
  const services = (src.services || []).map(s => s.toLowerCase());
  if (services.some(s => BROKER_SERVICES.has(s))) return true;

  // Fallback: job title keywords
  const title = (src.jobTitle || '').toLowerCase();
  if (!title) return false;
  for (const bad of TITLE_EXCLUDE) {
    if (title.includes(bad)) return false;
  }
  return TITLE_INCLUDE.some(good => title.includes(good));
}

// ─────────────────────────────────────────────
// CSV HELPERS
// ─────────────────────────────────────────────
// Column order: Email, Full Name, Direct/Office Phone, Mobile Phone,
//               Company, Province/City, Title, Profile URL
const CSV_HEADER = [
  'Email', 'Full Name', 'Direct/Office Phone', 'Mobile Phone',
  'Company', 'Province/City', 'Title', 'Profile URL',
];

function csvCell(v) {
  const s = Array.isArray(v)
    ? [...new Set(v)].join('; ')
    : String(v ?? '').replace(/\r?\n/g, ' ').trim();
  return `"${s.replace(/"/g, '""')}"`;
}

function initCsv() {
  fs.mkdirSync(path.dirname(CONFIG.outputFile), { recursive: true });
  fs.writeFileSync(CONFIG.outputFile, CSV_HEADER.map(csvCell).join(',') + '\n', 'utf8');
}

function appendRows(records) {
  if (!records.length) return;
  const lines = records.map(r =>
    [
      r.email,
      r.fullName,
      r.directPhone,
      r.mobilePhone,
      r.company,
      r.location,
      r.title,
      r.profileUrl,
    ].map(csvCell).join(',')
  );
  fs.appendFileSync(CONFIG.outputFile, lines.join('\n') + '\n', 'utf8');
}

// ─────────────────────────────────────────────
// DATA MAPPER
// ─────────────────────────────────────────────
function mapSource(src) {
  const username   = src.username || '';
  const profileUrl = username
    ? `https://www.jll.com/en-ca/people/bio-broker/${username}`
    : '';

  const province = src.addressStateProvince || src.addressRegion || '';
  const city     = src.addressCity || '';
  const location = [province, city].filter(Boolean).join('/');

  return {
    email:      src.email        || '',
    fullName:   src.title        || `${src.firstName || ''} ${src.lastName || ''}`.trim(),
    directPhone: src.telephoneNumber || '',
    mobilePhone: src.mobileNumber   || '',
    company:    'JLL Canada',
    location,
    title:      src.jobTitle     || '',
    profileUrl,
  };
}

// ─────────────────────────────────────────────
// STEALTH PATCH
// ─────────────────────────────────────────────
async function applyStealthPatch(page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-CA', 'en'] });
    window.chrome = { runtime: {} };
    const q = window.navigator.permissions.query;
    window.navigator.permissions.query = p =>
      p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : q(p);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function screenshotError(page, label) {
  try {
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(CONFIG.errorDir, `error_jll_ca_${label}_${ts}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.error(`[ERROR SCREENSHOT] ${file}`);
  } catch (_) {}
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
(async () => {
  fs.mkdirSync(CONFIG.errorDir, { recursive: true });
  initCsv();

  // ── Launch browser ────────────────────────────────────────────
  const browser = await puppeteer.launch({
    headless: CONFIG.headless,
    executablePath: CONFIG.executablePath,
    defaultViewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1440,900',
    ],
  });

  const page = await browser.newPage();
  await applyStealthPatch(page);
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-CA,en;q=0.9' });

  // ── Intercept API responses ───────────────────────────────────
  // Collect all broker _source objects from every /api/search/template response.
  const intercepted = [];

  page.on('response', async response => {
    const url = response.url();
    if (!url.includes(CONFIG.apiPath)) return;
    if (response.status() !== 200) return;

    try {
      const json = await response.json();
      const hits = json?.hits?.hits || [];
      if (hits.length) {
        intercepted.push(...hits.map(h => h._source).filter(Boolean));
        process.stdout.write(`\r[INFO]  Intercepted ${intercepted.length} raw records so far...`);
      }
    } catch (_) {
      // Non-JSON response on this path — ignore
    }
  });

  // ── Navigate to the people page ───────────────────────────────
  console.log('[INFO]  Loading JLL Canada people page...');
  try {
    await page.goto(CONFIG.startUrl, {
      waitUntil: 'networkidle2',
      timeout: CONFIG.navigationTimeout,
    });
  } catch (err) {
    console.error(`[ERROR] Initial navigation failed: ${err.message}`);
    await screenshotError(page, 'nav_fail');
    await browser.close();
    process.exit(1);
  }

  // Dismiss cookie banner if it appears
  try {
    const cookie = await page.$(SELECTORS.cookieAccept);
    if (cookie) {
      await cookie.click();
      await sleep(1000);
      console.log('[INFO]  Cookie banner dismissed.');
    }
  } catch (_) {}

  // ── Paginate through all results ─────────────────────────────
  let pageNum = 0;

  while (true) {
    pageNum++;
    if (CONFIG.maxPages > 0 && pageNum > CONFIG.maxPages) {
      console.log(`\n[INFO]  Reached maxPages cap (${CONFIG.maxPages}).`);
      break;
    }

    // Wait for the current page's results to fully load
    await sleep(CONFIG.pageLoadDelay);

    // Try to find and click the Next button
    let advanced = false;

    // Strategy 1: explicit Next button
    try {
      const nextBtn = await page.$(SELECTORS.nextBtn);
      if (nextBtn) {
        const disabled = await page.evaluate(
          el => el.disabled || el.getAttribute('aria-disabled') === 'true' ||
                el.classList.contains('disabled'),
          nextBtn
        );
        if (!disabled) {
          await nextBtn.click();
          advanced = true;
          console.log(`\n[INFO]  Page ${pageNum} done — clicking Next...`);
        }
      }
    } catch (_) {}

    // Strategy 2: Load More button (JLL sometimes uses this pattern)
    if (!advanced) {
      try {
        const loadMore = await page.$(SELECTORS.loadMoreBtn);
        if (loadMore) {
          const disabled = await page.evaluate(el => el.disabled, loadMore);
          if (!disabled) {
            await loadMore.click();
            advanced = true;
            console.log(`\n[INFO]  Page ${pageNum} done — clicking Load More...`);
          }
        }
      } catch (_) {}
    }

    // Strategy 3: No button found / disabled — we're on the last page
    if (!advanced) {
      console.log(`\n[INFO]  No more pages found after page ${pageNum}.`);
      break;
    }

    // Wait for the new batch to arrive (interceptor will capture it)
    await sleep(CONFIG.pageLoadDelay);
  }

  // ── Process all intercepted records ──────────────────────────
  console.log(`\n[INFO]  Total intercepted: ${intercepted.length} raw records.`);

  // Deduplicate by username (in case any pages overlapped)
  const seen    = new Set();
  const unique  = [];
  for (const src of intercepted) {
    const key = src.username || src.email || src.title;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    unique.push(src);
  }
  console.log(`[INFO]  After dedup: ${unique.length} unique records.`);

  // Filter to brokers only and write CSV
  const brokers = unique.filter(isBroker).map(mapSource);
  appendRows(brokers);

  const skipped = unique.length - brokers.length;
  console.log(`[INFO]  Filtered: ${brokers.length} brokers kept, ${skipped} non-broker roles skipped.`);

  await browser.close();

  console.log(`\n[DONE]  ${brokers.length} Canadian brokers written to CSV.`);
  console.log(`[OUTPUT] ${CONFIG.outputFile}`);
})();
