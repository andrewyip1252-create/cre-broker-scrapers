/**
 * ─────────────────────────────────────────────────────────────
 * NAI Global — Broker Scraper  (full-directory pagination)
 * ─────────────────────────────────────────────────────────────
 * Target:  https://www.naiglobal.com/brokers/
 * Output:  output/nai_brokers.csv
 *
 * Paginates through the ENTIRE broker directory in one pass —
 * no company-by-company search, no repeated POST rate-limits.
 *
 * Pipeline
 * ────────
 * Page 1  → POST /brokers  (no search text = all brokers)
 * Page 2+ → GET  /brokers?page=N  (AJAX headers)
 * Phones  → fetch each broker's profile page, read tel: links
 *
 * INSTALL:  No npm packages — pure Node.js built-ins.
 * RUN:      node nai_brokers.js
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const PLUGIN_KEY = '4fc4c741a2b49384c474ebc81ede3d108d02ca1c';
const BUILDOUT   = `https://buildout.com/plugins/${PLUGIN_KEY}`;

const CONFIG = {
  outputFile:   path.resolve(__dirname, 'output', 'nai_brokers.csv'),
  progressFile: path.resolve(__dirname, 'output', 'nai_progress.json'),
  errorDir:     path.resolve(__dirname, 'errors'),

  // true  → fetch each broker's profile page for office + cell phones (~2-4 hrs)
  // false → names/emails/titles only (~20 min)
  fetchPhones:      true,

  northAmericaOnly: true,
  delayMs:          6000,  // ms between page requests (raised to avoid WAF block)
  phoneDelayMs:     1500,  // ms between profile-page requests (raised after 403)
  resume:           true,  // restart picks up from last completed page
};

// ─────────────────────────────────────────────
// US STATES + CANADIAN PROVINCES
// ─────────────────────────────────────────────
const NORTH_AMERICA = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
  'AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT',
]);

// ─────────────────────────────────────────────
// TITLE FILTER
// ─────────────────────────────────────────────
const TITLE_INCLUDE = [
  'broker', 'agent', 'advisor', 'adviser',
  'director', 'president', 'principal', 'partner',
  'vice president', 'vp ',
  'evp', 'svp',
  'managing director', 'executive vice president',
  'senior vice president', 'managing partner',
  'brokerage',
  'investment sales', 'investment advisor', 'investment advisory', 'investment',
  'tenant rep', 'landlord rep', 'leasing', 'sales',
  'associate', 'chair', 'ceo', 'founder', 'owner',
  'commercial advisor', 'commercial broker',
  'commercial agent', 'commercial realtor',
  'realtor', 'salesperson',
];

const TITLE_EXCLUDE = [
  'capital markets',
  'tax',
  'acquisition',                 // user: principal-side, not brokers
  'property manager', 'property management',
  'asset manager', 'asset management',
  'portfolio manager', 'portfolio management',
  'director of property', 'vp of property', 'vice president of property',
  'regional property', 'senior property manager',
  'on site property', 'onsite property',
  'accountant', 'accounting',
  'bookkeeper', 'controller',
  'payroll', 'accounts payable', 'accounts receivable',
  'cfo', 'chief financial', 'chief investment officer',
  'fund accountant', 'property accountant',
  'financial analyst', 'finance director', 'director of finance',
  'vice president, finance', 'vice president of finance', 'vp finance',
  'vp, finance', 'svp, finance', 'senior vice president, finance',
  'corporate finance',
  'admin', 'receptionist', 'front desk',
  'office manager', 'office administrator',
  'executive assistant', 'personal assistant', 'pa to',
  'coordinator',
  'support specialist', 'client services coordinator',
  'listing coordinator', 'transaction coordinator', 'brokerage coordinator',
  'project manager', 'project management',
  'project coordinator', 'project engineer',
  'construction manager', 'superintendent', 'director of construction',
  'operations manager', 'operations coordinator',
  'director of operations', 'operations director',
  'marketing', 'communications', 'graphic', 'designer',
  'social media', 'web ', 'it ', 'database', 'technology',
  'research analyst', 'gis', 'data analyst', 'research coordinator',
  'human resources', 'hr ', 'content writer',
  'facility', 'maintenance', 'engineer', 'building manager', 'groundskeeper',
  'appraiser', 'appraisal', 'valuation', 'valuer', 'surveyor',
  'paralegal', 'counsel', 'attorney', 'general counsel',
  'intern', 'chief information', 'chief marketing',
  'director of marketing', 'director of accounting',
];

function titlePasses(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  for (const bad of TITLE_EXCLUDE) { if (t.includes(bad)) return false; }
  for (const good of TITLE_INCLUDE) { if (t.includes(good)) return true; }
  return false;
}

// ─────────────────────────────────────────────
// HTTP HELPERS
// ─────────────────────────────────────────────
const BASE_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
};

// Headers that make requests look like they come from the naiglobal.com iframe.
// Used for the search/pagination endpoints (AJAX fragments).
const AJAX_HEADERS = {
  ...BASE_HEADERS,
  'Accept':           'text/html, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
  'Origin':           'https://www.naiglobal.com',
  'Referer':          'https://www.naiglobal.com/brokers/',
  'Sec-Fetch-Site':   'cross-site',
  'Sec-Fetch-Mode':   'cors',
  'Sec-Fetch-Dest':   'empty',
};

// Plain full-page browser headers (NO XHR). The brokerId profile URL returns
// the search-results page when requested with XHR headers, but the real
// profile page (with tel: links) when requested as a normal document.
const PLAIN_HEADERS = {
  ...BASE_HEADERS,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function httpGet(url, headers = AJAX_HEADERS, hops = 8, attempt = 1) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    let req;
    try {
      req = lib.get(url, { headers }, res => {
        if ([301,302,303,307,308].includes(res.statusCode)) {
          const loc = res.headers.location;
          if (!loc || hops <= 0) { res.resume(); return reject(new Error(`Redirect loop: ${url}`)); }
          res.resume();
          return resolve(httpGet(loc.startsWith('http') ? loc : new URL(loc, url).href, headers, hops - 1, attempt));
        }
        // 403 = WAF rate-limit — wait and retry up to 4 times (60s,120s,180s,240s)
        if (res.statusCode === 403 && attempt <= 4) {
          res.resume();
          const wait = attempt * 60_000;
          console.log(`\n  [RATE LIMIT] 403 — waiting ${wait/1000}s (attempt ${attempt}/4)...`);
          return setTimeout(() => resolve(httpGet(url, headers, hops, attempt + 1)), wait);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      });
    } catch (e) { return reject(e); }
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

// POST with retry on 403 (rate-limit back-off: 20s, 40s, 60s)
function httpPost(url, formBody, attempt = 1) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const bodyBuf = Buffer.from(formBody, 'utf8');
    let req;
    try {
      req = https.request({
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname,
        method: 'POST',
        headers: { ...AJAX_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': bodyBuf.length },
      }, res => {
        if (res.statusCode === 403 && attempt <= 3) {
          res.resume();
          const wait = attempt * 20_000;
          console.log(`  [RATE LIMIT] 403 — waiting ${wait/1000}s (attempt ${attempt}/3)...`);
          return setTimeout(() => resolve(httpPost(url, formBody, attempt + 1)), wait);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for POST ${url}`));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      });
    } catch (e) { return reject(e); }
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('Timeout POST')); });
    req.write(bodyBuf);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────
// PHONE FORMATTER  →  +1 XXX-XXX-XXXX
// ─────────────────────────────────────────────
function formatPhone(raw) {
  if (!raw) return '';
  const d = raw.replace(/\D/g, '');
  if (d.length === 10)                 return `+1 ${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === '1') return `+1 ${d.slice(1,4)}-${d.slice(4,7)}-${d.slice(7)}`;
  return raw.trim();
}

function decodeHtml(s) {
  return (s||'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
                .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').trim();
}

// ─────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────
const CSV_HEADER = ['Email','Full Name','Direct/Office Phone','Mobile Phone','Company','State/City','Title','Profile URL'];

function cell(v) { const s = String(v??'').replace(/\r?\n/g,' ').trim(); return `"${s.replace(/"/g,'""')}"`; }

function initCsv() {
  fs.mkdirSync(path.dirname(CONFIG.outputFile), { recursive: true });
  fs.writeFileSync(CONFIG.outputFile, CSV_HEADER.map(cell).join(',') + '\n', 'utf8');
}

function appendCsv(r) {
  const sc = [r.state, r.city].filter(Boolean).join('/');
  const pu = `https://www.naiglobal.com/brokers/?brokerId=${encodeURIComponent(r.email)}`;
  fs.appendFileSync(CONFIG.outputFile, [r.email,r.fullName,r.directPhone||'',r.mobilePhone||'',r.company,sc,r.title,pu].map(cell).join(',') + '\n', 'utf8');
}

// ─────────────────────────────────────────────
// PROFILE PAGE — phones + company from tel: links and <title>
// ─────────────────────────────────────────────
// Phone links look like:
//   <a class="text-dark" href="tel:+1(859)2214000">Cell: 859.221.4000</a>
//   <a class="text-dark" href="tel:+18594224400">Office: 859.422.4400</a>
//
// Company comes from the page <title>, which is formatted as:
//   <title>Al Isaac | President | NAI Isaac</title>
// We take the last segment after the final "|" as the firm name.
function parseProfile(html) {
  let directPhone = '', mobilePhone = '', company = '';

  // ── Phones ──────────────────────────────────────────────────────────────
  const linkRe = /<a[^>]*href="tel:([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const num   = formatPhone(m[1]);
    const label = decodeHtml(m[2]).toLowerCase();
    if (!num) continue;

    if (label.includes('cell') || label.includes('mobile')) {
      if (!mobilePhone) mobilePhone = num;
    } else if (label.includes('office') || label.includes('direct') || label.includes('work') || label.includes('tel')) {
      if (!directPhone) directPhone = num;
    } else {
      const before = html.slice(Math.max(0, m.index - 300), m.index);
      if (/data-icon="mobile"/i.test(before)) { if (!mobilePhone) mobilePhone = num; }
      else                                     { if (!directPhone) directPhone = num; }
    }
  }

  // ── Company from <title> ────────────────────────────────────────────────
  // Title format: "Full Name | Job Title | Firm Name"
  const titleM = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (titleM) {
    const parts = decodeHtml(titleM[1]).split('|').map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) company = parts[parts.length - 1]; // last segment = firm
  }

  return { directPhone, mobilePhone, company };
}

// Fetch one broker's profile page and pull phones from it.
//
// The profile lives at BuildOut's IFRAME url, which has a very different
// shape from the search endpoint:
//   /plugins/{KEY}/www.naiglobal.com/brokers/{EMAIL}?iframe=true&embedded=true&brokerId={EMAIL}
//
// The plain /brokers?brokerId= URL returns the search-results page instead,
// which is why earlier attempts found no phone numbers.
async function fetchProfile(email) {
  const enc = encodeURIComponent(email);
  const url = `${BUILDOUT}/www.naiglobal.com/brokers/${email}` +
              `?pluginId=0&iframe=true&embedded=true&brokerId=${enc}&cacheSearch=true`;
  try {
    const html = await httpGet(url, PLAIN_HEADERS);
    return parseProfile(html);
  } catch (_) { return {}; }
}

// ─────────────────────────────────────────────
// COMPANY NAME from email domain (fallback)
// ─────────────────────────────────────────────
// Used only when the profile <title> doesn't yield a firm name.
// e.g. "jsmith@naiisaac.com" → "NAI Isaac"; "x@bergman-group.com" → "Bergman Group"
function companyFromEmail(email) {
  const at = (email || '').split('@')[1];
  if (!at) return 'NAI Global';
  let domain = at.split('.')[0]; // strip TLD and subdomains
  if (!domain) return 'NAI Global';

  // hyphens/underscores → spaces
  domain = domain.replace(/[-_]+/g, ' ').trim();

  // If it starts with "nai" run together with the shop name (e.g. "naiisaac",
  // "naihiffman"), split that prefix off so it reads "NAI Isaac", "NAI Hiffman".
  let m = domain.match(/^nai([a-z].*)$/i);
  if (m && !domain.includes(' ')) domain = 'nai ' + m[1];

  const words = domain.split(/\s+/).map(w =>
    w.toLowerCase() === 'nai' ? 'NAI' : w.charAt(0).toUpperCase() + w.slice(1)
  );
  return words.join(' ') || 'NAI Global';
}

// ─────────────────────────────────────────────
// PARSE BROKER CARDS from HTML fragment
// ─────────────────────────────────────────────
function parseBrokerCards(html) {
  const brokers = [];
  const parts   = html.split('class="col-auto js-result-row"');
  parts.shift();

  for (const part of parts) {
    try {
      const idM   = part.match(/brokerId=([^"&\s]+)/);
      if (!idM) continue;
      const email = decodeURIComponent(idM[1]);
      if (!email.includes('@')) continue;

      const nameM   = part.match(/class="mb-1 js-broker-link"[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/);
      const fullName = nameM ? decodeHtml(nameM[1]) : '';
      if (!fullName) continue;

      const info   = [...part.matchAll(/<div class="small title-secondary-color">([\s\S]*?)<\/div>/g)];
      const title  = info[0] ? decodeHtml(info[0][1]) : '';
      const locStr = info[1] ? decodeHtml(info[1][1]) : '';

      const locM = locStr.match(/^(.+),\s*([A-Z]{2})$/);
      const city  = locM ? locM[1].trim() : locStr;
      const state = locM ? locM[2].trim() : '';

      const hasContact = /vcard=true/i.test(part);

      brokers.push({ email, fullName, title, city, state, hasContact, company: 'NAI Global', directPhone: '', mobilePhone: '' });
    } catch (_) {}
  }
  return brokers;
}

// rel="next" is the most reliable next-page indicator
function hasNextPage(html) {
  return html.includes('rel="next"');
}

// ─────────────────────────────────────────────
// EMPTY QUERY PARAMS (no search text = all brokers)
// ─────────────────────────────────────────────
const EMPTY_PARAMS = 'q%5Bsearch_text_cont%5D=' +
  '&q%5Bbroker_certifications_cont_any%5D%5B%5D=' +
  '&q%5Bbroker_specifications_cont_any%5D%5B%5D=' +
  '&q%5Bjob_title_eq_any%5D%5B%5D=';

// ─────────────────────────────────────────────
// RESUME / PROGRESS  (tracks last completed page)
// ─────────────────────────────────────────────
function loadProgress() {
  if (!CONFIG.resume) return 0;
  try { return JSON.parse(fs.readFileSync(CONFIG.progressFile, 'utf8')).lastPage || 0; }
  catch (_) { return 0; }
}

function saveProgress(page) {
  fs.writeFileSync(CONFIG.progressFile, JSON.stringify({ lastPage: page }), 'utf8');
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
(async () => {
  fs.mkdirSync(CONFIG.errorDir, { recursive: true });
  fs.mkdirSync(path.dirname(CONFIG.outputFile), { recursive: true });

  const startPage = loadProgress();
  if (startPage > 0) {
    console.log(`[INFO] RESUME — continuing from page ${startPage + 1}`);
  } else {
    initCsv();
    console.log('[INFO] Fresh start — CSV created.');
  }

  const seenEmails = new Set();
  let totalKept = 0, totalSkipped = 0, totalProfiles = 0, totalWithPhone = 0;
  let page = startPage;

  while (true) {
    page++;
    let html = '';

    if (page === 1) {
      // ── Page 1: single POST, no search filter ──────────────────────────
      process.stdout.write(`[Page   1] Fetching (POST)... `);
      try {
        html = await httpPost(`${BUILDOUT}/brokers`, EMPTY_PARAMS);
      } catch (err) {
        console.error(`FAILED: ${err.message}`);
        break;
      }
    } else {
      // ── Page 2+: GET ───────────────────────────────────────────────────
      process.stdout.write(`[Page ${String(page).padStart(3)}] Fetching (GET)... `);
      const url = `${BUILDOUT}/brokers?page=${page}&${EMPTY_PARAMS}`;
      try {
        html = await httpGet(url);
      } catch (err) {
        console.error(`FAILED: ${err.message}`);
        break;
      }
    }

    if (!html.includes('js-result-row')) {
      // Empty page — we're done (or hit a shell response)
      console.log('no broker cards — done.');
      break;
    }

    const brokers = parseBrokerCards(html);
    let kept = 0;

    for (const broker of brokers) {
      if (seenEmails.has(broker.email)) continue;
      seenEmails.add(broker.email);

      if (CONFIG.northAmericaOnly && broker.state && !NORTH_AMERICA.has(broker.state)) continue;
      if (!titlePasses(broker.title)) { totalSkipped++; continue; }

      // Fetch phones + company from the broker's profile page
      if (CONFIG.fetchPhones && broker.hasContact) {
        totalProfiles++;
        const prof = await fetchProfile(broker.email);
        if (prof.directPhone) broker.directPhone = prof.directPhone;
        if (prof.mobilePhone) broker.mobilePhone = prof.mobilePhone;
        if (prof.company)     broker.company     = prof.company;
        if (prof.directPhone || prof.mobilePhone) totalWithPhone++;
        await sleep(CONFIG.phoneDelayMs);
      }

      // If the profile didn't give a firm name (or phones were skipped),
      // derive the company from the broker's email domain.
      if (!broker.company || broker.company === 'NAI Global') {
        broker.company = companyFromEmail(broker.email);
      }

      appendCsv(broker);
      kept++;
      totalKept++;
    }

    process.stdout.write(`${brokers.length} cards, ${kept} kept (total: ${totalKept})\n`);
    saveProgress(page);

    if (!hasNextPage(html)) {
      console.log('[INFO] No next-page link found — all pages complete.');
      break;
    }

    await sleep(CONFIG.delayMs);
  }

  console.log(`\n[DONE]`);
  console.log(`  Brokers saved            : ${totalKept}`);
  console.log(`  Non-broker roles skipped : ${totalSkipped}`);
  console.log(`  Profile pages fetched    : ${totalProfiles}`);
  console.log(`  Brokers with a phone     : ${totalWithPhone}`);
  console.log(`  Output                   : ${CONFIG.outputFile}`);
  console.log(`\n  Interrupted? Run again — it resumes from the last completed page.`);
})();
