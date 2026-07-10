/**
 * ─────────────────────────────────────────────────────────────────────────────
 * KBC Advisors — Broker Scraper
 * ─────────────────────────────────────────────────────────────────────────────
 * Target:  https://www.kbcadvisors.com/team   (233 brokers, US only)
 * Output:  output/kbc_brokers.csv
 *
 * Both the directory and profile pages are Next.js SSR — all data is in the
 * initial HTML. No Puppeteer needed.
 *
 * DATA SOURCES (confirmed from raw HTML):
 *   1. Broker JSON object (escaped, embedded in the streaming payload):
 *      \"firstName\", \"lastName\", \"emailAddress\", \"phoneNumber\", \"linkedIn\"
 *      NOTE: phoneNumber is present even when isPhoneNumberVisible=false
 *            (KBC hides it on the page but the data is in the HTML source).
 *   2. Visible HTML right after the name <h1>:
 *      first  <h2 class="...text-rainier-grey...">  = Title  (e.g. "Brokerage Professional")
 *      second <h2 class="...text-rainier-grey...">  = Office (e.g. "Houston")
 *   3. Role label above the name (e.g. "Market Leader", "Platform") —
 *      matches the directory's role tag; used as a backup filter signal.
 *
 * Directory role tags (from image alt text): brokerage services, market leader,
 * capital markets, leadership, platform. "platform" = ops/support → skipped.
 *
 * INSTALL:  (no dependencies — pure Node.js)
 * RUN:      node 2_scrape_kbc.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const CONFIG = {
  directoryUrl: 'https://www.kbcadvisors.com/team',
  company:      'KBC Advisors',
  outputFile:   path.resolve(__dirname, 'output', 'kbc_brokers.csv'),
  progressFile: path.resolve(__dirname, 'output', 'kbc_progress.json'),
  errorDir:     path.resolve(__dirname, 'errors'),
  delayMs:      1000,   // ms between profile requests
  resume:       true,   // set false to force a clean restart
};

// ─────────────────────────────────────────────
// ROLE / TITLE FILTER
// ─────────────────────────────────────────────
const SKIP_ROLES = new Set(['platform']);  // ops/admin/support roles at KBC

const TITLE_INCLUDE = [
  'broker', 'agent', 'advisor', 'adviser', 'director', 'president',
  'principal', 'managing director', 'executive', 'vice president',
  'brokerage', 'capital markets', 'investment', 'leasing',
  'market leader', 'partner', 'associate',
];

const TITLE_EXCLUDE = [
  'property manager', 'property management', 'facility', 'engineer',
  'maintenance', 'marketing', 'graphic', 'designer', 'research analyst',
  'admin', 'assistant', 'coordinator', 'receptionist', 'accounting',
  'human resources', 'intern', 'operations', 'office manager',
  'transaction manager', 'valuation', 'client services', 'creative',
  'project manager', 'cfo', 'chief financial', 'data analyst',
  'data & products', 'data and products',
];

function titlePasses(title) {
  // Title filter is a SECONDARY check — the directory role tag already
  // qualified this person. If the profile title clearly marks a non-broker
  // role (e.g. "Data & Products"), drop them; otherwise keep.
  if (!title) return true;
  const t = title.toLowerCase();
  for (const bad of TITLE_EXCLUDE) { if (t.includes(bad)) return false; }
  return true;
}

// Known KBC office locations (for cleanup / validation)
const KNOWN_LOCATIONS = [
  'west texas', 'manhattan beach', 'newport beach', 'los angeles',
  'new jersey', 'new york', 'philadelphia', 'seattle', 'houston',
  'dallas', 'chicago', 'nashville', 'atlanta', 'phoenix', 'oakland',
  'columbus', 'austin',
];

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────
function csvEscape(val) {
  const str = String(val ?? '').replace(/\r?\n/g, ' ').trim();
  return '"' + str.replace(/"/g, '""') + '"';
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ');
}

function stripTags(h) {
  return decodeEntities(h.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toTitleCase(str) {
  return str.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
}

function slugToName(slug) {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function fetchUrl(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    https.get({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control':   'no-cache',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, urlStr).href;
        resolve(fetchUrl(loc));
        return;
      }
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      let body = ''; res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─────────────────────────────────────────────
// DIRECTORY PARSER
// ─────────────────────────────────────────────
// Each broker is a <a href="/team/slug"> with an <img alt="..."> whose alt
// text contains the role tag (e.g. "...market leader..."). We extract the
// slug and the role tag, skip "platform", and queue the rest.
function parseDirectory(html) {
  const entries = [];
  const linkRx = /<a[^>]+href="(\/team\/[a-z][a-z0-9\-]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRx.exec(html)) !== null) {
    const slug  = m[1].replace('/team/', '');
    const inner = m[2];

    const altMatch = inner.match(/alt="([^"]*)"/i);
    const alt = (altMatch ? altMatch[1] : '').toLowerCase();

    let roleTag = '';
    if (alt.includes('market leader'))           roleTag = 'market leader';
    else if (alt.includes('brokerage services')) roleTag = 'brokerage services';
    else if (alt.includes('capital markets'))    roleTag = 'capital markets';
    else if (alt.includes('leadership'))         roleTag = 'leadership';
    else if (alt.includes('platform'))           roleTag = 'platform';

    if (SKIP_ROLES.has(roleTag)) continue;

    entries.push({ slug, roleTag, fallbackName: slugToName(slug) });
  }

  // Deduplicate by slug
  const seen = new Set();
  return entries.filter(e => {
    if (seen.has(e.slug)) return false;
    seen.add(e.slug);
    return true;
  });
}

// ─────────────────────────────────────────────
// PROFILE PARSER
// ─────────────────────────────────────────────
// Pull from the escaped broker JSON object + the two text-rainier-grey h2s.
function parseProfile(html) {
  // ── Broker JSON fields (escaped: \"field\":\"value\") ──────────────
  // The HTML stores them as backslash-escaped JSON inside the Next.js payload.
  function grabJson(field) {
    const rx = new RegExp('\\\\"' + field + '\\\\":\\\\"((?:[^\\\\]|\\\\.)*?)\\\\"');
    const mm = html.match(rx);
    return mm ? mm[1].replace(/\\"/g, '"').trim() : '';
  }

  const firstName = grabJson('firstName');
  const lastName  = grabJson('lastName');
  const email     = grabJson('emailAddress').toLowerCase();
  const phoneRaw  = grabJson('phoneNumber');

  // linkedIn can be null (no quotes) — handle both
  let linkedin = '';
  const liMatch = html.match(/\\"linkedIn\\":(?:\\"((?:[^\\]|\\.)*?)\\"|null)/);
  if (liMatch && liMatch[1]) linkedin = liMatch[1].replace(/\\"/g, '"').trim();

  // Full name — prefer firstName+lastName (the bare \"name\" field is ambiguous
  // and can match other JSON objects in the payload).
  let fullName = (firstName + ' ' + lastName).trim();
  if (!fullName) fullName = grabJson('name');

  // ── Title + location from the two text-rainier-grey h2s ────────────
  const rainierRx = /<h2 class="[^"]*text-rainier-grey[^"]*">([\s\S]*?)<\/h2>/gi;
  const h2s = [];
  let h2m;
  while ((h2m = rainierRx.exec(html)) !== null) {
    h2s.push(stripTags(h2m[1]));
  }
  const title    = h2s[0] || '';
  const location = h2s[1] ? toTitleCase(h2s[1]) : '';

  // ── Phone normalization to +1 XXX-XXX-XXXX ─────────────────────────
  let phone = '';
  if (phoneRaw) {
    const digits = phoneRaw.replace(/\D/g, '').replace(/^1/, '');
    if (digits.length === 10) {
      phone = `+1 ${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6)}`;
    } else {
      phone = phoneRaw.trim();
    }
  }

  return { fullName, firstName, lastName, email, phone, linkedin, title, location };
}

// ─────────────────────────────────────────────
// PROGRESS / RESUME
// ─────────────────────────────────────────────
function loadProgress() {
  if (!CONFIG.resume) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG.progressFile, 'utf8')); }
  catch (_) { return {}; }
}
function saveProgress(done) {
  fs.writeFileSync(CONFIG.progressFile, JSON.stringify(done, null, 2), 'utf8');
}

// ─────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────
function initCsv(append) {
  fs.mkdirSync(path.dirname(CONFIG.outputFile), { recursive: true });
  if (!append || !fs.existsSync(CONFIG.outputFile)) {
    const header = [
      'Email', 'Full Name', 'Direct/Office Phone', 'Mobile Phone',
      'Company', 'State/City', 'Title', 'Profile URL', 'LinkedIn',
    ];
    fs.writeFileSync(CONFIG.outputFile, header.map(csvEscape).join(',') + '\n', 'utf8');
  }
}

function appendCsv(r) {
  const row = [
    r.email,
    r.fullName,
    r.phone,     // Direct/Office Phone (KBC has one phone field per broker)
    '',          // Mobile Phone — KBC stores a single number
    CONFIG.company,
    r.location,
    r.title,
    r.profileUrl,
    r.linkedin,
  ].map(csvEscape).join(',') + '\n';
  fs.appendFileSync(CONFIG.outputFile, row, 'utf8');
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
(async () => {
  fs.mkdirSync(CONFIG.errorDir, { recursive: true });

  console.log('[INFO] Fetching KBC Advisors team directory...');
  let dirHtml;
  try {
    dirHtml = await fetchUrl(CONFIG.directoryUrl);
  } catch (err) {
    console.error('[ERROR] Could not fetch directory: ' + err.message);
    process.exit(1);
  }

  const entries = parseDirectory(dirHtml);
  console.log(`[INFO] ${entries.length} broker entries after role filter (platform skipped).`);

  const done = loadProgress();
  const remaining = entries.filter(e => !done[e.slug]);
  const alreadyDone = entries.length - remaining.length;
  if (alreadyDone > 0) {
    console.log(`[INFO] RESUME: ${alreadyDone} already done, ${remaining.length} remaining.`);
  }

  initCsv(alreadyDone > 0 && CONFIG.resume);

  let kept = 0, skippedTitle = 0, noPhone = 0, errors = 0;

  for (let i = 0; i < remaining.length; i++) {
    const entry = remaining[i];
    const profileUrl = `https://www.kbcadvisors.com/team/${entry.slug}`;
    process.stdout.write(`[${i + 1}/${remaining.length}] ${entry.fallbackName} (${entry.roleTag})...`);

    let p;
    try {
      const html = await fetchUrl(profileUrl);
      p = parseProfile(html);
    } catch (err) {
      console.error(' ERROR: ' + err.message);
      errors++;
      done[entry.slug] = { error: err.message };
      saveProgress(done);
      await sleep(CONFIG.delayMs);
      continue;
    }

    if (!titlePasses(p.title)) {
      process.stdout.write(` SKIP (title: ${p.title})\n`);
      skippedTitle++;
      done[entry.slug] = { skipped: true };
      saveProgress(done);
      await sleep(CONFIG.delayMs);
      continue;
    }

    appendCsv({
      email:      p.email,
      fullName:   p.fullName || entry.fallbackName,
      phone:      p.phone,
      location:   p.location,
      title:      p.title,
      profileUrl,
      linkedin:   p.linkedin,
    });
    kept++;
    if (!p.phone) noPhone++;

    const tag = p.phone ? p.phone : '(no phone)';
    process.stdout.write(` OK — ${p.email || '(no email)'} | ${tag}\n`);

    done[entry.slug] = { kept: true };
    saveProgress(done);
    await sleep(CONFIG.delayMs);
  }

  console.log(`\n[DONE] ${kept} brokers written | ${skippedTitle} skipped (title) | ${errors} errors`);
  console.log(`[INFO] Of those kept, ${kept - noPhone} have a phone, ${noPhone} do not.`);
  console.log(`[OUTPUT] ${CONFIG.outputFile}`);
})();
