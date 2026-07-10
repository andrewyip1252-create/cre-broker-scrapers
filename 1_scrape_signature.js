/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Signature Associates — Broker Scraper
 * ─────────────────────────────────────────────────────────────────────────────
 * Target:  https://www.signatureassociates.com/team/
 * Output:  output/signature_brokers.csv
 *
 * Actual DOM structure (confirmed via diagnostic):
 *   <div class="firm-member all-brokerage retail-brokerage southfield b">
 *     <img ... />
 *     <ul>
 *       <li>Bruce Baja</li>                         <- name (bare text)
 *       <li>Director...<br/>VP<br/>Principal</li>   <- title (may have <br/>)
 *       <li>Direct: (248) 799 3177</li>
 *       <li>Mobile: (313) 492 0957</li>
 *       <li><a href="mailto:email@...">email</a></li>
 *       <li class="profile"><a href="?team=...">Profile</a></li>
 *     </ul>
 *   </div>
 *
 * INSTALL:  (no dependencies - pure Node.js)
 * RUN:      node 1_scrape_signature.js
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const CONFIG = {
  teamUrl:    'https://www.signatureassociates.com/team/',
  company:    'Signature Associates',
  outputFile: path.resolve(__dirname, 'output', 'signature_brokers.csv'),
  errorDir:   path.resolve(__dirname, 'errors'),
  locationMap: {
    '248': 'Southfield, MI',
    '313': 'Detroit, MI',
    '616': 'Grand Rapids, MI',
    '269': 'Kalamazoo, MI',
    '419': 'Toledo, OH',
    '734': 'Southeast MI',
    '586': 'Macomb County, MI',
  },
};

// ── Title filter ────────────────────────────────────────────────────────────
const TITLE_INCLUDE = [
  'broker', 'agent', 'director', 'president', 'principal', 'advisor',
  'adviser', 'managing director', 'executive vice president', 'evp',
  'senior vice president', 'svp', 'vice president', 'brokerage',
  'capital markets', 'investment sales', 'investment division',
  'sale-leaseback', 'multifamily', 'multi-family',
  'tenant rep', 'landlord rep', 'leasing', 'partner',
  'associate broker', 'associate',
];

const TITLE_EXCLUDE = [
  'property manager', 'property management', 'asset manager',
  'facility', 'maintenance', 'engineer', 'building manager', 'building engineer',
  'marketing', 'communications', 'graphic', 'designer', 'social media',
  'research analyst', 'market research',
  'admin', 'assistant', 'coordinator', 'receptionist',
  'accounting', 'accountant', 'controller', 'payroll', 'human resources',
  'hr ', 'it ', 'intern', 'operations', 'office manager', 'office services',
  'transaction manager', 'valuation', 'client services',
  'creative director', 'creative marketing', 'digital designer',
  'project manager', 'cfo', 'chief financial', 'chief operating',
  'database coordinator', 'listing coordinator', 'accounts payable',
  'listing/database',
];

function titlePasses(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  for (const bad of TITLE_EXCLUDE) { if (t.includes(bad)) return false; }
  for (const good of TITLE_INCLUDE) { if (t.includes(good)) return true; }
  return false;
}

// ── Utilities ───────────────────────────────────────────────────────────────
function csvEscape(val) {
  const str = String(val ?? '').replace(/\r?\n/g, ' ').trim();
  return '"' + str.replace(/"/g, '""') + '"';
}

function stripTags(h) {
  return h
    .replace(/<br\s*\/?>/gi, ' | ')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(fetchUrl(res.headers.location)); return;
      }
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      let body = ''; res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function inferLocation(direct, mobile) {
  for (const phone of [direct, mobile]) {
    const m = phone.match(/\+1 (\d{3})/);
    if (m && CONFIG.locationMap[m[1]]) return CONFIG.locationMap[m[1]];
  }
  return 'Michigan/Ohio';
}

function formatPhone(raw) {
  // raw looks like "(248) 799 3177" or "248 799 3177" or "248-799-3177"
  const m = raw.match(/\(?(\d{3})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})/);
  return m ? '+1 ' + m[1] + '-' + m[2] + '-' + m[3] : raw.trim();
}

// ── Parser ──────────────────────────────────────────────────────────────────
// Splits HTML into firm-member card blocks, then parses each card's <ul> <li> items.
function parseBrokers(html) {
  const brokers = [];

  // Each card: <div class="firm-member ..."> ... </ul></div>
  // Use a simple split approach: find every occurrence of class="firm-member
  // and extract up to the closing </ul></div>
  const cardStartRx = /class="[^"]*firm-member[^"]*"/g;
  let startMatch;

  while ((startMatch = cardStartRx.exec(html)) !== null) {
    // Find the <ul> that follows this div's opening tag
    const ulStart = html.indexOf('<ul>', startMatch.index);
    if (ulStart === -1) continue;
    const ulEnd = html.indexOf('</ul>', ulStart);
    if (ulEnd === -1) continue;

    const ulHtml = html.substring(ulStart + 4, ulEnd); // content between <ul> and </ul>

    // Extract all <li>...</li> blocks from this ul
    // We'll split on <li to get each item
    const rawLiBlocks = ulHtml.split(/<li(?:\s[^>]*)?>/).slice(1);
    const liTexts = rawLiBlocks.map(block => {
      const end = block.indexOf('</li>');
      return end === -1 ? block : block.substring(0, end);
    });

    if (liTexts.length < 2) continue;

    // li[0] = name, li[1] = title, li[2+] = phones/email/profile
    const fullName = stripTags(liTexts[0]).trim();
    if (!fullName || fullName.length > 80) continue;

    const title = stripTags(liTexts[1]).replace(/\s*\|\s*/g, ' | ').trim();

    let direct = '', mobile = '', email = '', profileUrl = '';

    for (let i = 2; i < liTexts.length; i++) {
      const raw  = liTexts[i];
      const text = stripTags(raw).trim();

      if (/^Direct/i.test(text)) {
        direct = formatPhone(text.replace(/^Direct\s*:/i, '').trim());
        continue;
      }
      if (/^Mobile/i.test(text)) {
        mobile = formatPhone(text.replace(/^Mobile\s*:/i, '').trim());
        continue;
      }

      const emailM = raw.match(/href="mailto:([^"?]+)"/i);
      if (emailM) { email = emailM[1].trim(); continue; }

      const profM = raw.match(/href="(https?:\/\/[^"]*\?team=[^"]+)"/i);
      if (profM) { profileUrl = profM[1].trim(); }
    }

    if (!titlePasses(title)) {
      console.log('  [SKIP] ' + fullName + ' - "' + (title || 'no title') + '"');
      continue;
    }

    brokers.push({
      fullName, title, direct, mobile, email, profileUrl,
      location: inferLocation(direct, mobile),
    });
  }

  return brokers;
}

// ── CSV ─────────────────────────────────────────────────────────────────────
function initCsv() {
  fs.mkdirSync(path.dirname(CONFIG.outputFile), { recursive: true });
  const header = ['Email', 'Full Name', 'Direct/Office Phone', 'Mobile Phone', 'Company', 'State/City', 'Title', 'Profile URL'];
  fs.writeFileSync(CONFIG.outputFile, header.map(csvEscape).join(',') + '\n', 'utf8');
}

function appendCsv(r) {
  const row = [r.email, r.fullName, r.direct, r.mobile, CONFIG.company, r.location, r.title, r.profileUrl]
    .map(csvEscape).join(',') + '\n';
  fs.appendFileSync(CONFIG.outputFile, row, 'utf8');
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  fs.mkdirSync(CONFIG.errorDir, { recursive: true });
  initCsv();

  console.log('[INFO] Fetching Signature Associates team page...');
  let html;
  try {
    html = await fetchUrl(CONFIG.teamUrl);
  } catch (err) {
    console.error('[ERROR] ' + err.message); process.exit(1);
  }
  console.log('[INFO] Page fetched (' + (html.length / 1024).toFixed(0) + ' KB). Parsing broker cards...');

  const brokers = parseBrokers(html);
  console.log('[INFO] ' + brokers.length + ' brokers found after title filter.');

  for (const b of brokers) appendCsv(b);

  console.log('\n[DONE] ' + brokers.length + ' brokers written to:');
  console.log('       ' + CONFIG.outputFile);
})();
