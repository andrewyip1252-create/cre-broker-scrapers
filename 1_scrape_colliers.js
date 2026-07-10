/**
 * ─────────────────────────────────────────────────────────────
 * STEP 1 of 3 — Colliers Directory Scraper (PRIMARY SOURCE)
 * ─────────────────────────────────────────────────────────────
 * Target:  https://www.colliers.com/en/experts
 * Output:  output/1_colliers_brokers.csv
 *
 * Colliers uses a Coveo-powered JS search. This script loads the
 * experts directory, paginates through all results, and visits each
 * profile to collect identity data.
 *
 * Collects: Full Name, Title, City, State, Profile URL
 * (Company is always "Colliers International" — added automatically.)
 *
 * INSTALL:  npm install puppeteer
 * RUN:      node 1_scrape_colliers.js
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const CONFIG = {
  baseUrl:           'https://www.colliers.com/en/experts',
  company:           'Colliers International',  // fixed — every broker is Colliers
  outputFile:        path.resolve(__dirname, 'output', '1_colliers_brokers.csv'),
  progressFile:      path.resolve(__dirname, 'output', 'progress.txt'),
  proxyFile:         path.resolve(__dirname, 'proxies.txt'),
  errorDir:          path.resolve(__dirname, 'errors'),
  headless:          false,
  minDelay:          2000,
  maxDelay:          4500,
  navigationTimeout: 45_000,
  selectorTimeout:   15_000,
  // 0 = scrape all pages; set a number to cap for testing
  maxPages:          0,
  // Filter to US brokers only (matches state against US list)
  usOnly:            true,
  // Resume: if true, a re-run skips profiles already recorded in progressFile
  // and APPENDS to the existing CSV instead of overwriting it. Set to false
  // for a clean start (wipes progress + CSV).
  resume:            true,
};

// ─────────────────────────────────────────────
// SELECTORS  ← update via F12 if Colliers changes DOM
// ─────────────────────────────────────────────
const SELECTORS = {
  // Directory page
  expertCardLink:      'a[href*="/experts/"]',
  nextPageBtn:         'li.coveo-pager-next, .coveo-pager-next, [aria-label="Next"][class*="pager"]',
  nextPageDisabled:    'li.coveo-pager-next.coveo-pager-list-item-disabled, .coveo-pager-next[class*="disabled"]',
  cookieAccept:        '#onetrust-accept-btn-handler, button[aria-label*="Accept"]',

  // Profile page
  profileName:         'h1[class*="name"], h1[class*="expert"], .expert-name h1, h1',
  profileTitle:        '.expert__title, h3[class*="expert__title"], [class*="expert__title"], [class*="job-title"], [class*="position"]',
  profileLocation:     '.location-text, [class*="location-text"], [class*="location"], [class*="address"]',
  // Phone — Colliers stores the real number in a tel: link (class expert__phone-text)
  // even though it looks hidden behind a "Call my mobile/office" button.
  profilePhoneLink:    'a.expert__phone-text, a[class*="expert__phone"], a[href^="tel:"]',
  profilePhoneButton:  'button.js-show-phone, button[class*="show-phone"]',
  // Email — Colliers puts the real address in a mailto: link (class mail-link).
  // NOTE: the page also has a "share this page" mailto link, so the extraction
  // logic filters that out and the mail-link class is checked first.
  profileEmail:        'a.mail-link, a[href^="mailto:"]',
};

// US state abbreviations + names for the US-only filter
const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

// Map 2-letter codes → full state names (output uses full names, no abbreviations)
const STATE_NAMES = {
  AL:'Alabama', AK:'Alaska', AZ:'Arizona', AR:'Arkansas', CA:'California',
  CO:'Colorado', CT:'Connecticut', DE:'Delaware', FL:'Florida', GA:'Georgia',
  HI:'Hawaii', ID:'Idaho', IL:'Illinois', IN:'Indiana', IA:'Iowa', KS:'Kansas',
  KY:'Kentucky', LA:'Louisiana', ME:'Maine', MD:'Maryland', MA:'Massachusetts',
  MI:'Michigan', MN:'Minnesota', MS:'Mississippi', MO:'Missouri', MT:'Montana',
  NE:'Nebraska', NV:'Nevada', NH:'New Hampshire', NJ:'New Jersey', NM:'New Mexico',
  NY:'New York', NC:'North Carolina', ND:'North Dakota', OH:'Ohio', OK:'Oklahoma',
  OR:'Oregon', PA:'Pennsylvania', RI:'Rhode Island', SC:'South Carolina',
  SD:'South Dakota', TN:'Tennessee', TX:'Texas', UT:'Utah', VT:'Vermont',
  VA:'Virginia', WA:'Washington', WV:'West Virginia', WI:'Wisconsin',
  WY:'Wyoming', DC:'District of Columbia',
};

// Expand common abbreviations inside city names (e.g. "St. Louis" → "Saint Louis")
function expandCity(city) {
  if (!city) return '';
  return city
    .replace(/\bSt\.?\s/gi, 'Saint ')
    .replace(/\bFt\.?\s/gi, 'Fort ')
    .replace(/\bMt\.?\s/gi, 'Mount ')
    .replace(/\bN\.?\s/gi, 'North ')
    .replace(/\bS\.?\s/gi, 'South ')
    .replace(/\bE\.?\s/gi, 'East ')
    .replace(/\bW\.?\s/gi, 'West ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────
// TITLE FILTER  ← controls who gets kept vs dropped
// ─────────────────────────────────────────────
// A broker is KEPT only if their title contains one of these CRE
// dealmaking keywords. Edit these lists to fine-tune the filter.
const TITLE_INCLUDE = [
  'broker', 'agent', 'director', 'president', 'principal',
  'advisor', 'adviser', 'salesperson', 'sales associate',
  'managing director', 'executive vice president', 'evp',
  'senior vice president', 'svp', 'vice president of brokerage',
  'head of brokerage', 'brokerage', 'capital markets', 'investment sales',
  'tenant rep', 'landlord rep', 'leasing', 'partner',
  // Added per user: senior broker title at Colliers
  'vice chair', 'chairman', 'chair',
  // Added per user: keep all associate-level brokers
  'associate',
];

// A broker is DROPPED if their title contains any of these — even if it
// also matched an include word (exclude wins). This removes property
// managers, marketing, research, and admin/support staff.
const TITLE_EXCLUDE = [
  'property manager', 'property management', 'asset manager',
  'facilit', 'maintenance', 'engineer', 'building manager',
  'marketing', 'communications', 'graphic', 'designer', 'social media',
  'research', 'analyst', 'data', 'gis',
  'admin', 'assistant', 'coordinator', 'support', 'receptionist',
  'accounting', 'accountant', 'finance', 'payroll', 'human resources',
  'hr ', 'it ', 'intern', 'operations manager', 'office manager',
  // Added: transaction roles handle deal logistics, not brokerage (user: skip for now)
  'transaction manager', 'transaction specialist', 'transaction',
  // Added: other non-broker support/specialist roles seen in data
  'valuation', 'client services', 'people officer', 'preconstruction',
  'project manager', 'operations administrator', 'operations coordinator',
  'public finance', 'financial admin', 'qa ',
];

/**
 * Returns true if this title should be KEPT (a CRE dealmaking role).
 * Exclude list always wins over include list.
 */
function titlePasses(title) {
  if (!title) return false;            // no title → drop (can't confirm role)
  const t = title.toLowerCase();

  // Step 1: if it matches any exclude word, drop it immediately
  for (const bad of TITLE_EXCLUDE) {
    if (t.includes(bad)) return false;
  }
  // Step 2: keep only if it matches an include word
  for (const good of TITLE_INCLUDE) {
    if (t.includes(good)) return true;
  }
  return false;                        // matched nothing → drop
}

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────
function loadProxies() {
  if (!fs.existsSync(CONFIG.proxyFile)) return [];
  return fs.readFileSync(CONFIG.proxyFile, 'utf8')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map(line => {
      const a = line.match(/^(.+):(.+)@(.+):(\d+)$/);
      if (a) return { username: a[1], password: a[2], host: a[3], port: a[4] };
      const b = line.match(/^(.+):(\d+)$/);
      if (b) return { host: b[1], port: b[2] };
      return null;
    }).filter(Boolean);
}

function pickProxy(p) { return p.length ? p[Math.floor(Math.random() * p.length)] : null; }

function randomDelay() {
  const ms = CONFIG.minDelay + Math.random() * (CONFIG.maxDelay - CONFIG.minDelay);
  return new Promise(r => setTimeout(r, ms));
}

async function screenshotError(page, label) {
  try {
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(CONFIG.errorDir, `error_colliers_${label}_${ts}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.error(`[ERROR SCREENSHOT] ${file}`);
  } catch (_) {}
}

async function safeText(page, selector) {
  try { return await page.$eval(selector, el => el.innerText.trim()); }
  catch (_) { return ''; }
}

function csvEscape(val) {
  const str = String(val ?? '').replace(/\r?\n/g, ' ').trim();
  return `"${str.replace(/"/g, '""')}"`;
}

function initCsv() {
  fs.mkdirSync(path.dirname(CONFIG.outputFile), { recursive: true });
  // Email, Full Name, Office Phone, Mobile Phone, Company, City, State, Title, URL
  const header = ['Email', 'Full Name', 'Office Phone', 'Mobile Phone', 'Company', 'City', 'State', 'Title', 'Profile URL'];
  fs.writeFileSync(CONFIG.outputFile, header.map(csvEscape).join(',') + '\n', 'utf8');
}

// ── Resume support ──────────────────────────────
// Load the set of profile URLs already completed in a previous run.
function loadProgress() {
  if (!fs.existsSync(CONFIG.progressFile)) return new Set();
  const done = fs.readFileSync(CONFIG.progressFile, 'utf8')
    .split('\n').map(l => l.trim()).filter(Boolean);
  return new Set(done);
}

// Record one finished URL (append) so a crash never loses progress.
function markDone(url) {
  fs.appendFileSync(CONFIG.progressFile, url + '\n', 'utf8');
}

// Prepare output files based on resume setting.
function prepareOutputs() {
  fs.mkdirSync(path.dirname(CONFIG.outputFile), { recursive: true });
  const csvExists = fs.existsSync(CONFIG.outputFile);

  if (CONFIG.resume && csvExists) {
    const done = loadProgress();
    console.log(`[INFO] RESUME mode: ${done.size} profiles already done — will skip those and append.`);
    return done;
  }

  initCsv();
  fs.writeFileSync(CONFIG.progressFile, '', 'utf8');
  console.log('[INFO] Fresh start: new CSV created.');
  return new Set();
}

function appendCsv(r) {
  const fullState = STATE_NAMES[r.state] || r.state || '';
  const fullCity  = expandCity(r.city);
  const row = [
    r.email || '',
    r.fullName,
    r.officePhone || '',
    r.mobilePhone || '',
    CONFIG.company,
    fullCity,
    fullState,
    r.title,
    r.url,
  ].map(csvEscape).join(',') + '\n';
  fs.appendFileSync(CONFIG.outputFile, row, 'utf8');
}

// ─────────────────────────────────────────────
// STEALTH PATCH
// ─────────────────────────────────────────────
async function applyStealthPatch(page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
    const q = window.navigator.permissions.query;
    window.navigator.permissions.query = p =>
      p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission }) : q(p);
  });
}

// ─────────────────────────────────────────────
// PARSE LOCATION — extract city + 2-letter state
// ─────────────────────────────────────────────
// Colliers location text looks like:
//   "4350 La Jolla Village Drive, Suite 500 San Diego, CA 92122 United States"
// We want the "San Diego, CA" part — i.e. the City, ST that sits right
// before a ZIP code. We search for the LAST "Word(s), ST" that is followed
// by a 5-digit ZIP, which reliably skips the street address.
function parseLocation(locText) {
  if (!locText) return { city: '', state: '' };

  // Normalize whitespace (line breaks → single spaces)
  const text = locText.replace(/\s+/g, ' ').trim();

  // Preferred: "City, ST 12345" — city/state immediately before a ZIP
  const zipMatch = text.match(/([A-Za-z .'-]+),\s*([A-Z]{2})\s+\d{5}/);
  if (zipMatch) return { city: zipMatch[1].trim(), state: zipMatch[2].trim() };

  // Fallback: last "City, ST" anywhere in the string
  const all = [...text.matchAll(/([A-Za-z .'-]+),\s*([A-Z]{2})\b/g)];
  if (all.length) {
    const last = all[all.length - 1];
    return { city: last[1].trim(), state: last[2].trim() };
  }

  return { city: text, state: '' };
}

// ─────────────────────────────────────────────
// PROFILE SCRAPER
// ─────────────────────────────────────────────
async function scrapeProfile(page, url) {
  await randomDelay();
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.navigationTimeout });
  } catch (err) {
    console.error(`[ERROR] Nav failed: ${url} — ${err.message}`);
    await screenshotError(page, 'nav_fail');
    return null;
  }

  try {
    // Dismiss the cookie banner if it appears on this profile page —
    // otherwise its text can bleed into the title/location selectors.
    try {
      const cookieBtn = await page.$(SELECTORS.cookieAccept);
      if (cookieBtn) { await cookieBtn.click(); await new Promise(r => setTimeout(r, 500)); }
    } catch (_) {}

    const fullName = await safeText(page, SELECTORS.profileName);
    let   title    = await safeText(page, SELECTORS.profileTitle);
    const locText  = await safeText(page, SELECTORS.profileLocation);
    const { city, state } = parseLocation(locText);

    // Guard: if the title accidentally captured cookie/privacy banner text,
    // treat it as a failed read so the person isn't wrongly skipped.
    if (/cookie|privacy policy|stores cookies|don't ask me again/i.test(title)) {
      console.log(`[RETRY] Cookie text captured for ${fullName} — re-reading title.`);
      await new Promise(r => setTimeout(r, 800));
      title = await safeText(page, SELECTORS.profileTitle);
      // If still contaminated, null it out so it won't be mis-saved
      if (/cookie|privacy policy|stores cookies/i.test(title)) title = '';
    }

    // Title filter — drop property mgmt / marketing / research / admin roles
    if (!titlePasses(title)) {
      console.log(`[SKIP] Non-broker role: ${fullName} (${title || 'no title'})`);
      return null;
    }

    // US-only filter
    if (CONFIG.usOnly && state && !US_STATES.has(state)) {
      console.log(`[SKIP] Non-US broker: ${fullName} (${state})`);
      return null;
    }

    // Phones — Colliers hides the number behind a "Call my mobile/office"
    // button, but the real tel: number is already in the HTML. We read all
    // phone links and classify each by its button's aria-label.
    const { mobilePhone, officePhone } = await page.evaluate((linkSel, btnSel) => {
      const clean = s => (s || '').replace(/^tel:/, '').replace(/\s+/g, ' ').trim();
      let mobile = '', office = '';

      // Strategy 1: pair each button (which carries the label) with the
      // nearest tel: link inside the same container.
      const buttons = Array.from(document.querySelectorAll(btnSel));
      for (const btn of buttons) {
        const label = (btn.getAttribute('aria-label') || btn.innerText || '').toLowerCase();
        // Find the closest tel: link — check siblings then parent container
        let link = null;
        let container = btn.parentElement;
        for (let i = 0; i < 4 && container && !link; i++) {
          link = container.querySelector('a[href^="tel:"]');
          container = container.parentElement;
        }
        const num = link ? clean(link.getAttribute('href')) : '';
        if (!num) continue;
        if (label.includes('mobile') || label.includes('cell')) { if (!mobile) mobile = num; }
        else if (label.includes('office') || label.includes('direct') || label.includes('work')) { if (!office) office = num; }
      }

      // Strategy 2 (fallback): if buttons didn't resolve, just grab all
      // tel: links and assign by order (first = office, then mobile).
      if (!mobile && !office) {
        const links = Array.from(document.querySelectorAll(linkSel))
          .map(a => clean(a.getAttribute('href')))
          .filter(Boolean);
        if (links[0]) office = links[0];
        if (links[1]) mobile = links[1];
      }

      return { mobilePhone: mobile, officePhone: office };
    }, SELECTORS.profilePhoneLink, SELECTORS.profilePhoneButton);

    // Email — read the broker's real address from the mailto: link.
    // The page also has a "share this page" link (mailto:?subject=...), so we
    // skip any link that has no address before the '?' or contains 'subject='.
    let email = '';
    try {
      email = await page.evaluate((sel) => {
        const links = Array.from(document.querySelectorAll(sel));
        for (const a of links) {
          let href = (a.getAttribute('href') || '').replace(/^mailto:/i, '').trim();
          // Drop "share page" links: they look like "?subject=...&body=..."
          if (!href || href.startsWith('?') || /subject=/i.test(href)) continue;
          // Strip any trailing query string just in case (keep the address only)
          href = href.split('?')[0].trim();
          if (href.includes('@')) return href;
        }
        return '';
      }, SELECTORS.profileEmail);
    } catch (_) { email = ''; }

    return { fullName, title, city, state, url, mobilePhone, officePhone, email };
  } catch (err) {
    console.error(`[ERROR] Parse failed: ${url} — ${err.message}`);
    await screenshotError(page, 'parse_fail');
    return null;
  }
}

// ─────────────────────────────────────────────
// OFFICE LOCATIONS  ← full Colliers office list
// Coveo caps any single search at 1000 results, but the directory has
// 4500+ brokers. We work around the cap by filtering per office location
// (each well under 1000) and combining. Dedup handles any overlaps.
// ─────────────────────────────────────────────
const LOCATIONS = [
  "Akron",
  "Albuquerque",
  "Albuquerque - Valuation",
  "Allentown",
  "Anchorage",
  "Ann Arbor",
  "Atlanta",
  "Atlanta - Valuation",
  "Austin",
  "Austin - REMS",
  "Austin - Valuation",
  "Bakersfield",
  "Bellevue",
  "Birmingham_AL - Valuation",
  "Birmingham, AL",
  "Birmingham, MI",
  "Bloomington",
  "Boca Raton",
  "Boise",
  "Boston",
  "Boston - Valuation",
  "Charleston",
  "Charleston - Debt & Structured Finance",
  "Charleston - Valuation",
  "Charleston – Morrison",
  "Charleston – Truxtun",
  "Charlotte",
  "Charlotte - Debt & Structured Finance",
  "Charlotte - REMS Eastern Regional Accounting",
  "Charlotte - Valuation",
  "Charlottesville",
  "Chicago - Downtown",
  "Chicago - Rosemont",
  "Chicago - Rosemont - Debt & Structured Finance",
  "Chicago - Valuation",
  "Cincinnati",
  "Cincinnati - Valuation",
  "Cleveland",
  "Columbia",
  "Columbia MD",
  "Columbia MD - Valuation",
  "Columbus",
  "Columbus - Debt & Structured Finance",
  "Columbus - Valuation",
  "Conshohocken",
  "Conshohocken_PA - Debt & Structured Finance",
  "Dallas",
  "Dallas - Debt & Structured Finance",
  "Dallas - North",
  "Dallas - Valuation",
  "Dayton",
  "Denver",
  "Denver - Valuation",
  "Des Moines",
  "Destin - Valuation",
  "Detroit",
  "Detroit - Valuation",
  "El Paso",
  "Fairfield",
  "Fayetteville",
  "Fort Lauderdale",
  "Fort Mill_SC - Debt & Structured Finance",
  "Fort Myers",
  "Fort Myers - Debt & Structured Finance",
  "Fort Worth",
  "Fort Worth - Debt & Structured Finance",
  "Fox Valley",
  "Fredericksburg",
  "Fresno",
  "Fresno - Valuation",
  "Gilroy",
  "Grand Rapids",
  "Grand Rapids - Valuation",
  "Greenville",
  "Greenville - Debt & Structured Finance",
  "Hartford",
  "Hawaii - Big Island",
  "Hawaii - Honolulu",
  "Hawaii - Maui",
  "Holland",
  "Hot Springs",
  "Houston",
  "Houston - Debt & Structured Finance",
  "Houston - The Woodlands",
  "Houston - Valuation",
  "Huntsville",
  "Indianapolis",
  "Indianapolis - Valuation",
  "Jackson-Ridgeland - Debt & Structured Finance",
  "Jacksonville",
  "Jacksonville - Valuation",
  "Kansas City",
  "Kansas City - Valuation",
  "Lansing",
  "Las Cruces",
  "Las Vegas",
  "Las Vegas - Valuation",
  "Lawrence",
  "Lenox_MA - Debt & Structured Finance",
  "Little Rock",
  "Little Rock - Valuation",
  "Long Island",
  "Los Angeles - Brentwood",
  "Los Angeles - City of Industry",
  "Los Angeles - Downtown",
  "Los Angeles - Downtown - Debt & Structured Finance",
  "Los Angeles - Downtown - Valuation",
  "Los Angeles - El Segundo",
  "Los Angeles - Glendale",
  "Los Angeles - Inland Empire",
  "Los Angeles - Orange County",
  "Los Angeles - Orange County - Valuation",
  "Los Angeles - Woodland Hills",
  "Louisville",
  "Madison",
  "Madison - Project Management",
  "Maine",
  "Manchester, NH",
  "Memphis",
  "Memphis - Asset Services",
  "Memphis - Colliers Securities",
  "Memphis - Debt & Structured Finance",
  "Miami",
  "Miami - Valuation",
  "Milwaukee",
  "Minneapolis - Colliers Securities",
  "Minneapolis - Debt & Structured Finance",
  "Minneapolis - Downtown",
  "Minneapolis - Downtown - Valuation",
  "Minneapolis - St. Paul",
  "Mobile_AL - Debt & Structured Finance",
  "Mount Laurel",
  "Nampa",
  "Nashville",
  "Nashville - Valuation",
  "New Haven",
  "New Orleans",
  "New Orleans - Valuation",
  "New York",
  "New York - Debt & Structured Finance",
  "New York - Project Management",
  "New York - Valuation",
  "Newport News",
  "Norfolk - Main",
  "Oakland",
  "Oklahoma City",
  "Omaha",
  "Orlando",
  "Orlando - Valuation",
  "Parsippany",
  "Philadelphia",
  "Philadelphia - Valuation",
  "Phoenix",
  "Phoenix - Debt & Structured Finance",
  "Phoenix - REMS",
  "Phoenix - Valuation",
  "Pittsburgh",
  "Pittsburgh - Debt & Structured Finance",
  "Pleasant Grove",
  "Pleasanton",
  "Pocatello",
  "Portland",
  "Portland - Valuation",
  "Portsmouth",
  "Princeton",
  "Raleigh",
  "Raleigh - Debt & Structured Finance",
  "Reno",
  "Richmond - North",
  "Richmond - REMS",
  "Richmond - Valuation",
  "Rogers",
  "Sacramento",
  "Sacramento - Downtown",
  "Sacramento - Valuation",
  "Salt Lake City - Downtown",
  "Salt Lake City - Millrock",
  "Salt Lake City - Valuation",
  "San Diego - La Jolla",
  "San Diego - Valuation",
  "San Diego – Carlsbad",
  "San Francisco",
  "San Francisco - Debt & Structured Finance",
  "San Francisco - Valuation",
  "San Luis Obispo",
  "San Mateo",
  "Santa Barbara",
  "Santa Fe",
  "Sarasota",
  "Sarasota - Valuation",
  "Savannah",
  "Scottsdale",
  "Seattle",
  "Seattle - Debt & Structured Finance",
  "Seattle - Valuation",
  "Silicon Valley",
  "Silicon Valley - Valuation",
  "Spartanburg",
  "St. Louis - Clayton",
  "St. Louis - Clayton - Valuation",
  "St. Louis-Clayton - Debt & Structured Finance",
  "Stamford",
  "Stockton",
  "Syracuse - Valuation",
  "Tampa",
  "Tampa - Debt & Structured Finance",
  "Tampa - Valuation",
  "Traverse City",
  "Tulsa",
  "Twin Falls",
  "Tysons Corner",
  "Vancouver - Valuation",
  "Walnut Creek",
  "Washington, D.C. - Debt & Structured Finance",
  "Washington, DC",
  "Washington, DC - REMS",
  "West Palm Beach",
  "Wilmington",
  "Woodbridge"
];

// ─────────────────────────────────────────────
// DIRECTORY NAVIGATOR — loops through every office location
// ─────────────────────────────────────────────

// Scrape all profile URLs for ONE location's filtered view.
async function collectUrlsForLocation(page, location) {
  const urls = [];

  // Build the filtered URL: #sort=...&f:location=[Office Name]
  const sort = 'sort=%40firstz32xname%20ascending';
  const filter = `f:location=[${encodeURIComponent(location).replace(/%20/g, ' ')}]`;
  const url = `${CONFIG.baseUrl}#${sort}&${filter}`;

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.navigationTimeout });
  } catch (err) {
    console.error(`[WARN] Could not load location "${location}": ${err.message}`);
    return urls;
  }

  // Dismiss cookie banner if it appears (first location only, usually)
  try {
    const cookieBtn = await page.$(SELECTORS.cookieAccept);
    if (cookieBtn) { await cookieBtn.click(); await randomDelay(); }
  } catch (_) {}

  await randomDelay();

  let pageNum = 0;
  let lastFirstUrl = '';

  while (true) {
    pageNum++;
    if (CONFIG.maxPages > 0 && pageNum > CONFIG.maxPages) break;

    try {
      await page.waitForSelector(SELECTORS.expertCardLink, { timeout: CONFIG.selectorTimeout });
    } catch (_) {
      // No cards — empty location or filter mismatch
      break;
    }

    const pageUrls = await page.evaluate((sel) => {
      return [...new Set(
        Array.from(document.querySelectorAll(sel))
          .map(a => a.href)
          .filter(h => h && h.includes('/experts/') && !h.match(/\/experts\/?$/))
      )];
    }, SELECTORS.expertCardLink);

    urls.push(...pageUrls);

    const nextBtn = await page.$(SELECTORS.nextPageBtn);
    if (!nextBtn) break;
    const isDisabled = await page.$(SELECTORS.nextPageDisabled);
    if (isDisabled) break;

    lastFirstUrl = pageUrls[0] || '';

    try {
      await nextBtn.click();
    } catch (err) {
      break;
    }

    try {
      await page.waitForFunction(
        (sel, prevFirst) => {
          const cards = Array.from(document.querySelectorAll(sel))
            .map(a => a.href)
            .filter(h => h && h.includes('/experts/') && !h.match(/\/experts\/?$/));
          return cards.length > 0 && cards[0] !== prevFirst;
        },
        { timeout: CONFIG.navigationTimeout },
        SELECTORS.expertCardLink,
        lastFirstUrl
      );
    } catch (err) {
      break;
    }

    await randomDelay();
  }

  return [...new Set(urls)];
}

// Loop every location and combine all profile URLs (deduplicated).
async function collectProfileUrls(page) {
  const all = new Set();

  for (let i = 0; i < LOCATIONS.length; i++) {
    const loc = LOCATIONS[i];
    const urls = await collectUrlsForLocation(page, loc);
    urls.forEach(u => all.add(u));
    console.log(`[LOCATION ${i + 1}/${LOCATIONS.length}] "${loc}": ${urls.length} found (unique total: ${all.size})`);
    await randomDelay();
  }

  return [...all];
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
(async () => {
  fs.mkdirSync(CONFIG.errorDir, { recursive: true });

  const proxies = loadProxies();
  const proxy   = pickProxy(proxies);

  const args = [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars', '--window-size=1440,900',
  ];
  if (proxy) args.push(`--proxy-server=${proxy.host}:${proxy.port}`);

  const browser = await puppeteer.launch({
    headless: CONFIG.headless, args,
    // Use the Edge browser already installed on Windows (no Chrome download needed)
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    // Save the browser session (cookies, accepted banners) between runs.
    // Once you accept the cookie banner once, Edge remembers it permanently.
    userDataDir: path.resolve(__dirname, '.edge-session'),
    defaultViewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });

  const page = await browser.newPage();
  if (proxy?.username) await page.authenticate({ username: proxy.username, password: proxy.password });

  await applyStealthPatch(page);
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // Prepare CSV + load any prior progress (resume support)
  const alreadyDone = prepareOutputs();

  console.log('[INFO] Scanning Colliers experts directory...');
  const urls = await collectProfileUrls(page);
  console.log(`[INFO] ${urls.length} profiles found.`);

  // Filter out URLs already completed in a previous run
  const todo = urls.filter(u => !alreadyDone.has(u));
  const skippedResume = urls.length - todo.length;
  if (skippedResume > 0) {
    console.log(`[INFO] Skipping ${skippedResume} already-done profiles. ${todo.length} remaining.`);
  }
  console.log(`[INFO] Extracting ${todo.length} profiles...`);

  let success = 0, errors = 0;
  for (let i = 0; i < todo.length; i++) {
    const url = todo[i];
    const rec = await scrapeProfile(page, url);
    if (rec) { appendCsv(rec); success++; }
    else { errors++; }
    // Record this URL as done regardless of keep/skip, so a re-run won't
    // re-visit it. (Skipped non-brokers are "done" too — no need to recheck.)
    markDone(url);

    // Lightweight progress ping every 50 profiles
    if ((i + 1) % 50 === 0) {
      console.log(`[PROGRESS] ${i + 1}/${todo.length} processed | ${success} saved so far`);
    }
  }

  await browser.close();
  console.log(`\n[DONE] ${success} brokers saved this run. ${errors} errors/skips.`);
  console.log(`[OUTPUT] ${CONFIG.outputFile}`);
  console.log(`[INFO] If interrupted, just run again — it resumes automatically.`);
})();
