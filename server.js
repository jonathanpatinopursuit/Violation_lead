import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

// Datasets used by this tool.
// HPD Housing Maintenance Code Violations — full 2010-present history (open + closed).
const VIOLATIONS_URL = 'https://data.cityofnewyork.us/resource/wvxf-dwi5.json';
// HPD Multiple Dwelling Registrations — one row per building registration, keyed by BuildingID.
const REGISTRATIONS_URL = 'https://data.cityofnewyork.us/resource/tesw-yqqr.json';
// HPD Registration Contacts — owner/agent names + mailing addresses, keyed by RegistrationID.
const CONTACTS_URL = 'https://data.cityofnewyork.us/resource/feu5-w2e2.json';
// NYC Dept. of Buildings violations (elevators, boilers, general construction — not HPD housing code), keyed by BIN.
const DOB_VIOLATIONS_URL = 'https://data.cityofnewyork.us/resource/3h2n-5cm9.json';
// ACRIS (Dept. of Finance property recording system): Legals maps a BBL (borough/block/lot) to document ids,
// Master has the doc type/date, Parties has the grantor/grantee (or borrower/lender) names — three-way join by document_id.
const ACRIS_LEGALS_URL = 'https://data.cityofnewyork.us/resource/8h5j-fqxa.json';
const ACRIS_MASTER_URL = 'https://data.cityofnewyork.us/resource/bnx9-e6tj.json';
const ACRIS_PARTIES_URL = 'https://data.cityofnewyork.us/resource/636b-3b5g.json';
// Deed-type ACRIS documents — i.e. an actual ownership transfer, not a mortgage/assignment/satisfaction.
const ACRIS_DEED_TYPES = ['DEED', 'DEEDO', 'CORR-D'];
// NYC Dept. of City Planning's free address geocoder (no API key) — resolves free-text
// addresses to a BIN via its PAD (Property Address Directory) match, used for address search.
const GEOSEARCH_URL = 'https://geosearch.planninglabs.nyc/v2/search';

const GOOGLE_CSE_URL = 'https://www.googleapis.com/customsearch/v1';

const { NYC_OPEN_DATA_TOKEN, GOOGLE_CSE_API_KEY, GOOGLE_CSE_CX } = process.env;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LEADS_DATE_WHERE = "novissueddate >= '2024-01-01T00:00:00'";
const RODENT_DESC_WHERE =
  "(upper(novdescription) like '%RODENT%' OR upper(novdescription) like '%RATS%' OR upper(novdescription) like '%MICE%')";
const ROACH_DESC_WHERE =
  "(upper(novdescription) like '%ROACH%' OR upper(novdescription) like '%COCKROACH%')";

// Preference order when a building's registration lists multiple contacts —
// the managing agent (who actually deals with day-to-day issues) beats a
// corporate owner, which beats a natural-person owner, etc.
const CONTACT_TYPE_PRIORITY = [
  'Agent',
  'CorporateOwner',
  'IndividualOwner',
  'JointOwner',
  'HeadOfficer',
  'Officer',
  'Lessee',
  'Shareholder',
  'SiteManager',
];

function sodaHeaders() {
  const headers = { Accept: 'application/json' };
  if (NYC_OPEN_DATA_TOKEN) {
    headers['X-App-Token'] = NYC_OPEN_DATA_TOKEN;
  }
  return headers;
}

async function sodaJson(url) {
  const response = await fetch(url, { headers: sodaHeaders() });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SODA request failed (${response.status}): ${text}`);
  }
  return response.json();
}

// Runs one grouped/aggregated query per pest type (rodent, roach), grouped by
// building + open/closed status, so we get counts + most-recent-date without
// ever pulling raw violation rows (there are 180k+ of those since 2024).
async function fetchPestCountsByBuilding(descWhere) {
  const url = new URL(VIOLATIONS_URL);
  url.searchParams.set(
    '$select',
    'buildingid, violationstatus, count(*) as cnt, max(novissueddate) as most_recent'
  );
  url.searchParams.set('$where', `${LEADS_DATE_WHERE} AND ${descWhere} AND buildingid IS NOT NULL`);
  url.searchParams.set('$group', 'buildingid, violationstatus');
  url.searchParams.set('$limit', '100000');
  return sodaJson(url);
}

// Fetches rows from `baseUrl` where `field` is one of `values`, batching the
// IN-list so we don't build unbounded URLs when there are thousands of ids.
async function fetchInBatches(baseUrl, field, values, { select, batchSize = 200, limitPerBatch = 2000 } = {}) {
  const ids = [...new Set(values)].filter((v) => /^\d+$/.test(String(v)));
  const batches = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    batches.push(ids.slice(i, i + batchSize));
  }

  const results = await Promise.all(
    batches.map(async (batch) => {
      const url = new URL(baseUrl);
      if (select) url.searchParams.set('$select', select);
      url.searchParams.set('$where', `${field} IN (${batch.join(',')})`);
      url.searchParams.set('$limit', String(limitPerBatch));
      return sodaJson(url);
    })
  );

  return results.flat();
}

// A contact row can carry both a corporationname AND a person's first/last
// name (e.g. an Agent contact naming both the management company and the
// individual who filed it) — this extracts just the person's name, ignoring
// corporationname, for cases (like LinkedIn search) that specifically want
// the human, not the company.
function formatPersonName(contact) {
  if (!contact) return null;
  const parts = [contact.firstname, contact.middleinitial ? `${contact.middleinitial}.` : null, contact.lastname]
    .filter(Boolean)
    .map((s) => s.trim());
  return parts.length ? parts.join(' ') : null;
}

function formatOwnerName(contact) {
  if (!contact) return null;
  if (contact.corporationname) return contact.corporationname.trim();
  return formatPersonName(contact) || contact.contactdescription || null;
}

function formatMailingAddress(contact) {
  if (!contact) return null;
  const line1 = [contact.businesshousenumber, contact.businessstreetname].filter(Boolean).join(' ').trim();
  const apt = contact.businessapartment ? `Apt ${contact.businessapartment}` : null;
  const streetLine = [line1, apt].filter(Boolean).join(', ');
  const cityLine = [contact.businesscity, contact.businessstate].filter(Boolean).join(', ');
  const cityZip = [cityLine, contact.businesszip].filter(Boolean).join(' ');
  return [streetLine, cityZip].filter(Boolean).join(', ') || null;
}

function pickBestContact(contacts) {
  for (const type of CONTACT_TYPE_PRIORITY) {
    const match = contacts.find((c) => c.type === type);
    if (match) return match;
  }
  return contacts[0] || null;
}

// A pre-filled LinkedIn people-search link for a contact — not an automated
// lookup (there's no legitimate API for that), just a one-click starting
// point so a human can verify the right match themselves.
// Best guess at "the company" for this building's registration, so a person
// contact's LinkedIn search can include it (e.g. "Joseph Cafiero CAM Property
// MGMT" instead of just "Joseph Cafiero") — much better odds of finding the
// right person when the name is common. Prefers the CorporateOwner's name,
// falling back to the Agent's, since those are the two contact types that
// reliably carry a corporationname.
function resolveCompanyName(contacts) {
  const owner = contacts.find((c) => c.type === 'CorporateOwner' && c.corporationname);
  if (owner) return owner.corporationname.trim();
  const agent = contacts.find((c) => c.type === 'Agent' && c.corporationname);
  if (agent) return agent.corporationname.trim();
  return null;
}

function linkedinSearchUrl(contact, buildingCompanyName) {
  // Prefer the actual person's name when this row has one (LinkedIn is for
  // people) — a contact can have both a corporationname and a person's name,
  // and formatOwnerName would otherwise return the company for this row.
  const personName = formatPersonName(contact);
  const baseName = personName || formatOwnerName(contact);
  if (!baseName) return null;

  // Prefer this contact's own company (most specific) over the building's
  // general owner name, so e.g. an agent searches with the agency they work
  // for, not the landlord's holding company.
  const company = (contact?.corporationname && contact.corporationname.trim()) || buildingCompanyName;
  const isCompanyItself = company && company.toUpperCase() === baseName.toUpperCase();
  const terms = company && !isCompanyItself ? `${baseName} ${company}` : baseName;
  return `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(terms)}`;
}

// Same idea, plain Google search — always present regardless of whether the
// automated website lookup below is configured or finds anything, so there's
// always at least one click-through option.
function googleSearchUrl(name) {
  if (!name) return null;
  return `https://www.google.com/search?q=${encodeURIComponent(name)}`;
}

// ---------------------------------------------------------------------------
// Corporate owner website lookup (Google Custom Search JSON API)
//
// Only run for CorporateOwner contacts — that's the one case where "does
// this have a real business website" is both answerable (a company website
// is meant to be publicly discoverable) and useful (a live site is often a
// better first outreach channel than a mailing address). Individual people
// (agent, officers, shareholders, site manager) get search links instead,
// above — no automated matching, since common names produce false positives
// and there's no reliable API for that anyway.
//
// Google's free tier is 100 queries/day and does NOT require billing to be
// enabled (unlike Brave, whose free tier now asks for a card) — see README
// for the two-step setup (API key + Programmable Search Engine id).
// ---------------------------------------------------------------------------

// Directory/social/aggregator domains that show up in company-name searches
// but are never the company's own site — filtered out so we don't "find" a
// Yelp listing and call it their website.
const NON_OFFICIAL_WEBSITE_DOMAINS = [
  'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
  'yelp.com', 'bbb.org', 'zillow.com', 'loopnet.com', 'yellowpages.com',
  'manta.com', 'bloomberg.com', 'opencorporates.com', 'dnb.com', 'glassdoor.com',
  'indeed.com', 'crunchbase.com', 'wikipedia.org', 'youtube.com', 'google.com',
  'maps.google.com', 'streeteasy.com', 'realtor.com', 'trulia.com', 'nydos.ny.gov',
  'appointments.nyc.gov', 'data.cityofnewyork.us', 'buildzoom.com', 'homes.com',
];

function isLikelyOfficialWebsite(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return !NON_OFFICIAL_WEBSITE_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

// Company website lookups are cached indefinitely-ish (24h) — websites don't
// change often, and it keeps us well within Google's 100/day free quota when
// the same owner/agent shows up across many buildings.
const WEBSITE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const websiteCache = new Map(); // normalizedName -> { website, fetchedAt }
const websiteCacheInFlight = new Map();

async function findCompanyWebsite(companyName) {
  if (!GOOGLE_CSE_API_KEY || !GOOGLE_CSE_CX || !companyName) return null;

  const key = companyName.trim().toUpperCase();
  const hit = websiteCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < WEBSITE_CACHE_TTL_MS) return hit.website;

  if (!websiteCacheInFlight.has(key)) {
    const promise = (async () => {
      const url = new URL(GOOGLE_CSE_URL);
      url.searchParams.set('key', GOOGLE_CSE_API_KEY);
      url.searchParams.set('cx', GOOGLE_CSE_CX);
      url.searchParams.set('q', `"${companyName}" New York property management OR real estate`);
      url.searchParams.set('num', '5');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      let website = null;
      try {
        const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
        if (response.ok) {
          const payload = await response.json();
          const items = payload.items || [];
          const match = items.find((item) => isLikelyOfficialWebsite(item.link));
          website = match ? match.link : null;
        }
      } catch {
        website = null; // search API hiccup shouldn't break the building detail response
      } finally {
        clearTimeout(timeout);
      }
      websiteCache.set(key, { website, fetchedAt: Date.now() });
      return website;
    })().finally(() => {
      websiteCacheInFlight.delete(key);
    });
    websiteCacheInFlight.set(key, promise);
  }
  return websiteCacheInFlight.get(key);
}

// ---------------------------------------------------------------------------
// Phone/email scraper — once a CorporateOwner's actual website is found
// (findCompanyWebsite, above), pull a phone number and email off it. This is
// the company's own publicly published contact info (usually a "Contact us"
// page), not a third-party people-search/data-broker lookup — the same kind
// of info a human would find by clicking the site themselves.
// ---------------------------------------------------------------------------

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/;
// Common placeholder/tracking addresses that show up in page markup but
// aren't a real contact — skip these rather than "finding" a fake lead.
const GENERIC_EMAIL_PREFIXES = ['noreply', 'no-reply', 'donotreply', 'webmaster', 'postmaster'];

function extractContactInfo(html) {
  const emailMatch = [...html.matchAll(new RegExp(EMAIL_RE, 'g'))]
    .map((m) => m[0])
    .find((email) => !GENERIC_EMAIL_PREFIXES.some((p) => email.toLowerCase().startsWith(p)));
  const phoneMatch = html.match(PHONE_RE);
  return {
    email: emailMatch || null,
    phone: phoneMatch ? phoneMatch[0] : null,
  };
}

async function fetchPageText(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; ViolationLeadBot/1.0)' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Finds a same-site link that looks like a contact page — checked before
// falling back to just the homepage, since phone/email usually live there.
function findContactPageUrl(homepageHtml, baseUrl) {
  const linkRe = /<a\s[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;
  for (const match of homepageHtml.matchAll(linkRe)) {
    const href = match[1];
    const text = match[2].replace(/<[^>]+>/g, '').trim().toLowerCase();
    if (/contact/i.test(href) || /contact/i.test(text)) {
      try {
        return new URL(href, baseUrl).toString();
      } catch {
        continue;
      }
    }
  }
  return null;
}

const CONTACT_INFO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const contactInfoCache = new Map(); // website -> { data, fetchedAt }
const contactInfoCacheInFlight = new Map();

async function findWebsiteContactInfo(website) {
  if (!website) return { email: null, phone: null };

  const hit = contactInfoCache.get(website);
  if (hit && Date.now() - hit.fetchedAt < CONTACT_INFO_CACHE_TTL_MS) return hit.data;

  if (!contactInfoCacheInFlight.has(website)) {
    const promise = (async () => {
      let data = { email: null, phone: null };
      const homepageHtml = await fetchPageText(website);
      if (homepageHtml) {
        data = extractContactInfo(homepageHtml);
        if (!data.email || !data.phone) {
          const contactUrl = findContactPageUrl(homepageHtml, website);
          const contactHtml = contactUrl ? await fetchPageText(contactUrl) : null;
          if (contactHtml) {
            const fromContactPage = extractContactInfo(contactHtml);
            data = { email: data.email || fromContactPage.email, phone: data.phone || fromContactPage.phone };
          }
        }
      }
      contactInfoCache.set(website, { data, fetchedAt: Date.now() });
      return data;
    })().finally(() => {
      contactInfoCacheInFlight.delete(website);
    });
    contactInfoCacheInFlight.set(website, promise);
  }
  return contactInfoCacheInFlight.get(website);
}

// Socrata has no index on novdescription, so `upper(novdescription) like
// '%ROACH%'` has to text-scan every 2024+ violation (2M+ rows) — about 40s
// per pest type, even though it's grouped/aggregated server-side. Building
// registration + contact lookups (by numeric id) are fast (indexed, <1s), so
// only the two big text-scan aggregates are cached here. This keeps the tool
// "live" (it re-scans Socrata every AGG_CACHE_TTL_MS) without making every
// page load pay a ~40s tax. On a cold Vercel instance the first request after
// the cache expires still eats that cost — see vercel.json's maxDuration.
const AGG_CACHE_TTL_MS = 30 * 60 * 1000;
let aggCache = null; // { rodentRows, roachRows, fetchedAt }
let aggCacheInFlight = null; // in-flight promise, so concurrent requests don't all trigger their own 40s scan

async function getCachedPestAggregates() {
  if (aggCache && Date.now() - aggCache.fetchedAt < AGG_CACHE_TTL_MS) {
    return aggCache;
  }
  if (!aggCacheInFlight) {
    aggCacheInFlight = Promise.all([
      fetchPestCountsByBuilding(RODENT_DESC_WHERE),
      fetchPestCountsByBuilding(ROACH_DESC_WHERE),
    ])
      .then(([rodentRows, roachRows]) => {
        aggCache = { rodentRows, roachRows, fetchedAt: Date.now() };
        return aggCache;
      })
      .finally(() => {
        aggCacheInFlight = null;
      });
  }
  return aggCacheInFlight;
}

// Pure reducer: turns the two cached grouped-count arrays into one row per
// building. Shared by the main leads list and the portfolio cross-reference
// in the building detail endpoint, so both use identical counting logic.
function aggregatePestRows(rodentRows, roachRows) {
  const byBuilding = new Map();
  const ensure = (buildingid) => {
    if (!byBuilding.has(buildingid)) {
      byBuilding.set(buildingid, {
        buildingid,
        rodent: { open: 0, closed: 0, mostRecent: null },
        roach: { open: 0, closed: 0, mostRecent: null },
      });
    }
    return byBuilding.get(buildingid);
  };

  const applyRows = (rows, key) => {
    for (const row of rows) {
      const building = ensure(row.buildingid);
      const count = parseInt(row.cnt, 10) || 0;
      const bucket = building[key];
      if (row.violationstatus === 'Open') bucket.open += count;
      else bucket.closed += count;
      if (row.most_recent && (!bucket.mostRecent || row.most_recent > bucket.mostRecent)) {
        bucket.mostRecent = row.most_recent;
      }
    }
  };
  applyRows(rodentRows, 'rodent');
  applyRows(roachRows, 'roach');

  return [...byBuilding.values()].map((b) => {
    const rodentTotal = b.rodent.open + b.rodent.closed;
    const roachTotal = b.roach.open + b.roach.closed;
    const mostRecent = [b.rodent.mostRecent, b.roach.mostRecent].filter(Boolean).sort().pop() || null;
    return {
      buildingid: b.buildingid,
      rodent_count: rodentTotal,
      roach_count: roachTotal,
      total_count: rodentTotal + roachTotal,
      open_count: b.rodent.open + b.roach.open,
      closed_count: b.rodent.closed + b.roach.closed,
      most_recent_violation_date: mostRecent ? mostRecent.slice(0, 10) : null,
    };
  });
}

function dedupeLatestRegistration(registrations) {
  const latestByBuilding = new Map();
  for (const reg of registrations) {
    const existing = latestByBuilding.get(reg.buildingid);
    if (!existing || (reg.lastregistrationdate || '') > (existing.lastregistrationdate || '')) {
      latestByBuilding.set(reg.buildingid, reg);
    }
  }
  return latestByBuilding;
}

const REGISTRATION_SELECT =
  'buildingid, registrationid, boro, housenumber, streetname, zip, bin, block, lot, boroid, lastregistrationdate';

// Registrations for every building in a zip code — used to both restrict the
// leads list to that zip and (since we're fetching it anyway) skip a second
// per-building registration lookup later.
async function fetchRegistrationsByZip(zip) {
  const url = new URL(REGISTRATIONS_URL);
  url.searchParams.set('$select', REGISTRATION_SELECT);
  url.searchParams.set('$where', `zip = '${zip}'`);
  url.searchParams.set('$limit', '5000');
  return sodaJson(url);
}

function formatAddress(reg) {
  if (!reg) return null;
  return [reg.housenumber, reg.streetname].filter(Boolean).join(' ') + `, ${reg.boro || ''} ${reg.zip || ''}`.trimEnd();
}

// Every sort is "biggest/most recent first" — that's what "best lead" means
// throughout this tool. Dates are ISO YYYY-MM-DD strings, so string compare
// sorts correctly; missing dates (empty string) naturally sort last.
const LEAD_SORTERS = {
  total: (a, b) => b.total_count - a.total_count,
  most_recent: (a, b) => (b.most_recent_violation_date || '').localeCompare(a.most_recent_violation_date || ''),
  rodent: (a, b) => b.rodent_count - a.rodent_count,
  roach: (a, b) => b.roach_count - a.roach_count,
  open: (a, b) => b.open_count - a.open_count,
};

// Builds the sorted, enriched lead list. `limit` caps how many buildings get
// the (expensive) registration + contact lookups — those only run for the
// top-N by the chosen sort, since that's what "best leads" means here.
async function getPestLeads({ limit = 100, pestType = 'all', status = 'all', zip = null, sortBy = 'total', recentDays = null } = {}) {
  const { rodentRows, roachRows, fetchedAt: pestDataAsOf } = await getCachedPestAggregates();
  let leads = aggregatePestRows(rodentRows, roachRows);

  // If a zip filter is given, resolve it to a set of building ids *before*
  // sorting/limiting — otherwise "top N citywide" could exclude buildings
  // that would have ranked highly within just this zip.
  let zipRegByBuilding = null;
  // Distinguishes "real zip, just no matching violations" from "not a real
  // zip" — if HPD has zero registered buildings at all for this zip (not
  // just zero pest-violation matches), that's a strong signal it's invalid,
  // not just an unlucky filter combination.
  let zipExists = null;
  if (zip) {
    zipRegByBuilding = dedupeLatestRegistration(await fetchRegistrationsByZip(zip));
    zipExists = zipRegByBuilding.size > 0;
    leads = leads.filter((l) => zipRegByBuilding.has(l.buildingid));
  }

  if (pestType === 'rodent') leads = leads.filter((l) => l.rodent_count > 0);
  else if (pestType === 'roach') leads = leads.filter((l) => l.roach_count > 0);

  if (status === 'open') leads = leads.filter((l) => l.open_count > 0);
  else if (status === 'closed') leads = leads.filter((l) => l.closed_count > 0);

  // "Recently active" — buildings whose most recent pest violation was issued
  // within the last N days. Property managers are far more receptive right
  // after an inspection than months later, so this surfaces fresh leads even
  // if the building's all-time total is modest.
  if (recentDays) {
    const cutoff = new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    leads = leads.filter((l) => l.most_recent_violation_date && l.most_recent_violation_date >= cutoff);
  }

  // Aggregate stats computed over the *full* filtered set, before slicing to
  // limit — these power the summary stat cards, which describe all matching
  // buildings, not just the page of leads actually returned.
  const totalMatchedBuildings = leads.length;
  const totalOpenCount = leads.reduce((sum, l) => sum + l.open_count, 0);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const activeLast7Days = leads.filter((l) => l.most_recent_violation_date && l.most_recent_violation_date >= sevenDaysAgo).length;

  leads.sort(LEAD_SORTERS[sortBy] || LEAD_SORTERS.total);
  leads = leads.slice(0, limit);

  if (leads.length === 0) {
    return { leads: [], totalMatchedBuildings, totalOpenCount, activeLast7Days, pestDataAsOf, zipExists };
  }

  const buildingIds = leads.map((l) => l.buildingid);
  const latestRegByBuilding = zip
    ? zipRegByBuilding
    : dedupeLatestRegistration(
        await fetchInBatches(REGISTRATIONS_URL, 'buildingid', buildingIds, { select: REGISTRATION_SELECT })
      );

  const registrationIds = buildingIds
    .map((id) => latestRegByBuilding.get(id))
    .filter(Boolean)
    .map((r) => r.registrationid);
  const contacts = await fetchInBatches(CONTACTS_URL, 'registrationid', registrationIds, {
    select:
      'registrationid, type, contactdescription, corporationname, firstname, middleinitial, lastname, businesshousenumber, businessstreetname, businessapartment, businesscity, businessstate, businesszip',
  });

  const contactsByReg = new Map();
  for (const contact of contacts) {
    if (!contactsByReg.has(contact.registrationid)) contactsByReg.set(contact.registrationid, []);
    contactsByReg.get(contact.registrationid).push(contact);
  }

  for (const lead of leads) {
    const reg = latestRegByBuilding.get(lead.buildingid);
    if (!reg) {
      lead.address = `Building ID ${lead.buildingid} (no active HPD registration found)`;
      lead.bin = null;
      lead.owner_name = null;
      lead.owner_type = null;
      lead.mailing_address = null;
      continue;
    }
    lead.address = formatAddress(reg);
    lead.bin = reg.bin || null;

    const bestContact = pickBestContact(contactsByReg.get(reg.registrationid) || []);
    lead.owner_name = formatOwnerName(bestContact);
    lead.owner_type = bestContact ? bestContact.type : null;
    lead.mailing_address = formatMailingAddress(bestContact);
  }

  return { leads, totalMatchedBuildings, totalOpenCount, activeLast7Days, pestDataAsOf, zipExists };
}

// ---------------------------------------------------------------------------
// Building detail (click-through from a lead)
//
// Pulls together everything about one building: every individual pest
// violation (not just the count), every contact on the HPD registration
// (not just the top-priority one), NYC Dept. of Buildings violations by BIN,
// ACRIS deed history by BBL (borough/block/lot), and a "portfolio" of other
// buildings registered under the same owner/agent name. Runs on demand per
// click, so — unlike the leads list — there's no need to cache it.
// ---------------------------------------------------------------------------

function soqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Like fetchInBatches, but for fields (e.g. ACRIS document_id) that aren't
// guaranteed to be purely numeric, so each value is quoted/escaped instead
// of validated as a plain integer.
async function fetchInBatchesQuoted(baseUrl, field, values, { select, extraWhere, batchSize = 200, limitPerBatch = 2000 } = {}) {
  const ids = [...new Set(values)].filter(Boolean);
  const batches = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    batches.push(ids.slice(i, i + batchSize));
  }

  const results = await Promise.all(
    batches.map(async (batch) => {
      const url = new URL(baseUrl);
      if (select) url.searchParams.set('$select', select);
      const inClause = `${field} in (${batch.map(soqlQuote).join(',')})`;
      url.searchParams.set('$where', extraWhere ? `${inClause} AND ${extraWhere}` : inClause);
      url.searchParams.set('$limit', String(limitPerBatch));
      return sodaJson(url);
    })
  );

  return results.flat();
}

function classifyPest(description) {
  const upper = (description || '').toUpperCase();
  const isRodent = upper.includes('RODENT') || upper.includes('RATS') || upper.includes('MICE');
  const isRoach = upper.includes('ROACH') || upper.includes('COCKROACH');
  if (isRodent && isRoach) return 'both';
  if (isRodent) return 'rodent';
  if (isRoach) return 'roach';
  return 'other';
}

// DOB dates come back as bare "YYYYMMDD" strings, unlike HPD's ISO timestamps.
function formatDobDate(value) {
  if (!value) return null;
  const s = String(value);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s.slice(0, 10);
}

async function fetchIndividualViolations(buildingid) {
  const url = new URL(VIOLATIONS_URL);
  url.searchParams.set(
    '$select',
    'violationid, novdescription, novissueddate, currentstatus, violationstatus, class, apartment'
  );
  url.searchParams.set(
    '$where',
    `buildingid = ${buildingid} AND ${LEADS_DATE_WHERE} AND (${RODENT_DESC_WHERE} OR ${ROACH_DESC_WHERE})`
  );
  url.searchParams.set('$order', 'novissueddate DESC');
  url.searchParams.set('$limit', '300');
  const rows = await sodaJson(url);
  return rows.map((v) => ({
    violationid: v.violationid,
    date: v.novissueddate ? v.novissueddate.slice(0, 10) : null,
    pest_type: classifyPest(v.novdescription),
    status: v.violationstatus,
    current_status: v.currentstatus,
    class: v.class,
    apartment: v.apartment || null,
    description: v.novdescription,
  }));
}

async function fetchDobViolations(bin) {
  if (!bin) return [];
  const url = new URL(DOB_VIOLATIONS_URL);
  url.searchParams.set(
    '$select',
    'issue_date, violation_type, violation_category, description, disposition_date, disposition_comments'
  );
  url.searchParams.set('$where', `bin = ${soqlQuote(bin)}`);
  url.searchParams.set('$order', 'issue_date DESC');
  url.searchParams.set('$limit', '25');
  const rows = await sodaJson(url);
  return rows.map((d) => ({
    issue_date: formatDobDate(d.issue_date),
    type: d.violation_type,
    category: d.violation_category,
    description: d.description,
    disposition_date: formatDobDate(d.disposition_date),
    disposition_comments: d.disposition_comments || null,
  }));
}

// Recorded deed transfers (not mortgages/assignments) for this lot, most
// recent first, with the buyer/seller names ACRIS has on file.
async function fetchAcrisDeedHistory(boroid, block, lot) {
  if (!boroid || !block || !lot) return [];

  const legalsUrl = new URL(ACRIS_LEGALS_URL);
  legalsUrl.searchParams.set('$select', 'document_id');
  legalsUrl.searchParams.set(
    '$where',
    `borough = ${soqlQuote(boroid)} AND block = ${soqlQuote(block)} AND lot = ${soqlQuote(lot)}`
  );
  legalsUrl.searchParams.set('$limit', '1000');
  const legalRows = await sodaJson(legalsUrl);
  const docIds = legalRows.map((r) => r.document_id);
  if (docIds.length === 0) return [];

  const deedTypeWhere = `doc_type in (${ACRIS_DEED_TYPES.map(soqlQuote).join(',')})`;
  const masterRows = await fetchInBatchesQuoted(ACRIS_MASTER_URL, 'document_id', docIds, {
    select: 'document_id, doc_type, document_date, document_amt',
    extraWhere: deedTypeWhere,
  });
  masterRows.sort((a, b) => (b.document_date || '').localeCompare(a.document_date || ''));
  const topDocs = masterRows.slice(0, 5);
  if (topDocs.length === 0) return [];

  const partyRows = await fetchInBatchesQuoted(
    ACRIS_PARTIES_URL,
    'document_id',
    topDocs.map((d) => d.document_id),
    { select: 'document_id, party_type, name' }
  );
  const partiesByDoc = new Map();
  for (const p of partyRows) {
    if (!partiesByDoc.has(p.document_id)) partiesByDoc.set(p.document_id, []);
    partiesByDoc.get(p.document_id).push(p);
  }

  return topDocs.map((doc) => {
    const parties = partiesByDoc.get(doc.document_id) || [];
    return {
      document_id: doc.document_id,
      doc_type: doc.doc_type,
      date: doc.document_date ? doc.document_date.slice(0, 10) : null,
      amount: doc.document_amt ? Number(doc.document_amt) : null,
      from: parties.filter((p) => p.party_type === '1').map((p) => p.name),
      to: parties.filter((p) => p.party_type === '2').map((p) => p.name),
    };
  });
}

// Other NYC buildings registered under the same owner/agent identity —
// exact (case-insensitive) name match on corporationname, or first+last name
// for individuals. This is a name-match heuristic against public HPD filings,
// not a verified identity match (won't catch "MGMT" vs "MANAGEMENT" etc).
async function getPortfolio(bestContact, excludeBuildingId) {
  if (!bestContact) return [];

  let where;
  if (bestContact.corporationname) {
    where = `upper(corporationname) = upper(${soqlQuote(bestContact.corporationname)})`;
  } else if (bestContact.firstname && bestContact.lastname) {
    where = `upper(firstname) = upper(${soqlQuote(bestContact.firstname)}) AND upper(lastname) = upper(${soqlQuote(bestContact.lastname)})`;
  } else {
    return [];
  }

  const contactsUrl = new URL(CONTACTS_URL);
  contactsUrl.searchParams.set('$select', 'registrationid');
  contactsUrl.searchParams.set('$where', where);
  contactsUrl.searchParams.set('$limit', '2000');
  const matches = await sodaJson(contactsUrl);
  const registrationIds = [...new Set(matches.map((m) => m.registrationid))];
  if (registrationIds.length === 0) return [];

  const regRows = await fetchInBatches(REGISTRATIONS_URL, 'registrationid', registrationIds, {
    select: 'buildingid, registrationid, boro, housenumber, streetname, zip',
  });

  const byBuilding = new Map();
  for (const r of regRows) {
    if (r.buildingid === String(excludeBuildingId)) continue;
    if (!byBuilding.has(r.buildingid)) byBuilding.set(r.buildingid, r);
  }
  if (byBuilding.size === 0) return [];

  const portfolioIds = new Set(byBuilding.keys());
  const { rodentRows, roachRows } = await getCachedPestAggregates();
  const stats = aggregatePestRows(
    rodentRows.filter((r) => portfolioIds.has(r.buildingid)),
    roachRows.filter((r) => portfolioIds.has(r.buildingid))
  );
  const statsByBuilding = new Map(stats.map((s) => [s.buildingid, s]));

  return [...byBuilding.entries()]
    .map(([buildingid, reg]) => {
      const stat = statsByBuilding.get(buildingid) || {
        rodent_count: 0,
        roach_count: 0,
        total_count: 0,
        open_count: 0,
        closed_count: 0,
        most_recent_violation_date: null,
      };
      return { buildingid, address: formatAddress(reg), ...stat };
    })
    .sort((a, b) => b.total_count - a.total_count)
    .slice(0, 25);
}

async function getBuildingDetail(buildingid) {
  if (!/^\d+$/.test(String(buildingid))) {
    const err = new Error('Invalid building id');
    err.status = 400;
    throw err;
  }

  const regUrl = new URL(REGISTRATIONS_URL);
  regUrl.searchParams.set('$select', REGISTRATION_SELECT);
  regUrl.searchParams.set('$where', `buildingid = ${buildingid}`);
  regUrl.searchParams.set('$order', 'lastregistrationdate DESC');
  regUrl.searchParams.set('$limit', '5');
  const registrations = await sodaJson(regUrl);
  const registration = registrations[0] || null;

  const fetchContacts = () => {
    const contactsUrl = new URL(CONTACTS_URL);
    contactsUrl.searchParams.set('$where', `registrationid = ${registration.registrationid}`);
    contactsUrl.searchParams.set('$limit', '100');
    return sodaJson(contactsUrl);
  };
  const contactsPromise = registration ? fetchContacts() : Promise.resolve([]);

  const [violations, contacts, dobViolations, deedHistory] = await Promise.all([
    fetchIndividualViolations(buildingid),
    contactsPromise,
    registration ? fetchDobViolations(registration.bin) : Promise.resolve([]),
    registration ? fetchAcrisDeedHistory(registration.boroid, registration.block, registration.lot) : Promise.resolve([]),
  ]);

  const bestContact = pickBestContact(contacts);
  const portfolioPromise = getPortfolio(bestContact, buildingid);
  const companyName = resolveCompanyName(contacts);

  // Website lookup only runs for CorporateOwner contacts (see findCompanyWebsite
  // for why) — everyone else just gets a LinkedIn search link, computed inline.
  const enrichedContactsPromise = Promise.all(
    contacts.map(async (c) => {
      const name = formatOwnerName(c);
      const website = c.type === 'CorporateOwner' ? await findCompanyWebsite(name) : null;
      const contactInfo = website ? await findWebsiteContactInfo(website) : { email: null, phone: null };
      return {
        type: c.type,
        name,
        mailing_address: formatMailingAddress(c),
        website,
        email: contactInfo.email,
        phone: contactInfo.phone,
        google_search_url: googleSearchUrl(name),
        linkedin_search_url: linkedinSearchUrl(c, companyName),
      };
    })
  );

  const [enrichedContacts, portfolio] = await Promise.all([enrichedContactsPromise, portfolioPromise]);

  return {
    buildingid: String(buildingid),
    address: formatAddress(registration),
    bin: registration ? registration.bin || null : null,
    block: registration ? registration.block || null : null,
    lot: registration ? registration.lot || null : null,
    last_registration_date: registration ? registration.lastregistrationdate : null,
    contacts: enrichedContacts,
    violations,
    dob_violations: dobViolations,
    deed_history: deedHistory,
    portfolio,
  };
}

// ---------------------------------------------------------------------------
// Address search
//
// Lets someone type any address and get a straight answer: this building has
// pest violations, this building has none, or that's not a real address.
// Geocoding (free text -> BIN) uses NYC Planning's public GeoSearch API, not
// an NYC Open Data/Socrata dataset — it's the standard free geocoder for NYC
// addresses and needs no API key. From the BIN, everything else reuses the
// same HPD/DOB/ACRIS pipeline as a building-detail click-through.
// ---------------------------------------------------------------------------

async function geocodeAddress(addressText) {
  const url = new URL(GEOSEARCH_URL);
  url.searchParams.set('text', addressText);
  url.searchParams.set('size', '1');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
  } catch (err) {
    throw new Error(
      err.name === 'AbortError' ? 'Address lookup service timed out' : `Address lookup service unreachable: ${err.message}`
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`Address lookup service failed (${response.status})`);
  }

  const payload = await response.json();
  const feature = payload.features && payload.features[0];
  if (!feature) return null;

  return {
    label: feature.properties.label,
    bin: feature.properties.addendum?.pad?.bin || null,
  };
}

async function lookupAddress(addressText) {
  // GeoSearch doesn't reliably flag low-confidence guesses — a vague query
  // like "Grand Concourse" (no house number) gets the *same* confidence
  // score as a precise one, just silently fuzzy-matched to some unrelated
  // building on that street. Since a house number is present on every real
  // address, requiring one here catches the ambiguous case before it ever
  // reaches the geocoder, instead of confidently returning the wrong building.
  if (!/^\d/.test(addressText.trim())) {
    return {
      status: 'too_vague',
      message:
        'That doesn’t look like a specific street address. Include the house number (e.g. "530 East 169th Street") and, if you have it, the zip code — otherwise the match can land on the wrong building.',
      query: addressText,
      resolved_address: null,
      detail: null,
    };
  }

  const geocoded = await geocodeAddress(addressText);
  if (!geocoded) {
    return {
      status: 'not_found',
      message: "That doesn't look like a real NYC address — double check the spelling, or add the borough/zip.",
      query: addressText,
      resolved_address: null,
      detail: null,
    };
  }

  if (!geocoded.bin) {
    return {
      status: 'no_building',
      message: 'That address was found, but it doesn’t resolve to a specific building (e.g. an intersection or open space).',
      query: addressText,
      resolved_address: geocoded.label,
      detail: null,
    };
  }

  const regUrl = new URL(REGISTRATIONS_URL);
  regUrl.searchParams.set('$select', REGISTRATION_SELECT);
  regUrl.searchParams.set('$where', `bin = ${soqlQuote(geocoded.bin)}`);
  regUrl.searchParams.set('$order', 'lastregistrationdate DESC');
  regUrl.searchParams.set('$limit', '1');
  const registrations = await sodaJson(regUrl);
  const registration = registrations[0] || null;

  if (!registration) {
    return {
      status: 'no_registration',
      message:
        'That’s a real building, but it has no HPD multiple-dwelling registration on file — common for owner-occupied 1-2 family homes or non-residential buildings — so there’s no violation history to check.',
      query: addressText,
      resolved_address: geocoded.label,
      detail: null,
    };
  }

  const detail = await getBuildingDetail(registration.buildingid);
  return {
    status: detail.violations.length > 0 ? 'found' : 'no_violations',
    message: detail.violations.length > 0 ? null : 'No rodent or roach violations found for this address since 2024-01-01.',
    query: addressText,
    resolved_address: geocoded.label,
    detail,
  };
}

function parseLeadsQuery(query) {
  const parsedLimit = parseInt(query.limit, 10);
  const limit = Math.min(500, Math.max(1, Number.isNaN(parsedLimit) ? 100 : parsedLimit));
  const pestType = ['rodent', 'roach'].includes(query.pestType) ? query.pestType : 'all';
  const status = ['open', 'closed'].includes(query.status) ? query.status : 'all';
  const zip = /^\d{5}$/.test(query.zip || '') ? query.zip : null;
  const sortBy = Object.keys(LEAD_SORTERS).includes(query.sortBy) ? query.sortBy : 'total';
  const parsedRecentDays = parseInt(query.recentDays, 10);
  const recentDays = Number.isFinite(parsedRecentDays) && parsedRecentDays > 0 ? parsedRecentDays : null;
  return { limit, pestType, status, zip, sortBy, recentDays };
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function leadsToCsv(leads) {
  const headers = [
    'Building Address',
    'BIN',
    'Owner/Agent Name',
    'Owner/Agent Type',
    'Mailing Address',
    'Total Violations',
    'Rodent Violations',
    'Roach Violations',
    'Open Violations',
    'Closed Violations',
    'Most Recent Violation Date',
  ];
  const rows = leads.map((l) =>
    [
      l.address,
      l.bin,
      l.owner_name,
      l.owner_type,
      l.mailing_address,
      l.total_count,
      l.rodent_count,
      l.roach_count,
      l.open_count,
      l.closed_count,
      l.most_recent_violation_date,
    ]
      .map(csvEscape)
      .join(',')
  );
  return [headers.join(','), ...rows].join('\n');
}

const app = express();

// Exterminator lead-gen tool: NYC buildings with rodent and/or roach HPD
// violations since 2024-01-01, ranked by violation count (or date, or pest
// type — see sortBy), with the current registered owner/agent name +
// mailing address attached for outreach.
app.get('/api/pest-leads', async (req, res) => {
  try {
    const { limit, pestType, status, zip, sortBy, recentDays } = parseLeadsQuery(req.query);
    const { leads, totalMatchedBuildings, totalOpenCount, activeLast7Days, pestDataAsOf, zipExists } = await getPestLeads({
      limit,
      pestType,
      status,
      zip,
      sortBy,
      recentDays,
    });
    res.json({
      source:
        'NYC Open Data — HPD Housing Maintenance Code Violations (wvxf-dwi5), Multiple Dwelling Registrations (tesw-yqqr), Registration Contacts (feu5-w2e2)',
      timeframe: '2024-01-01 to present',
      fetched_at: new Date().toISOString(),
      pest_counts_last_refreshed: pestDataAsOf ? new Date(pestDataAsOf).toISOString() : null,
      filters: { pestType, status, limit, zip, sortBy, recentDays },
      total_matched_buildings: totalMatchedBuildings,
      total_open_count: totalOpenCount,
      active_last_7_days: activeLast7Days,
      zip_exists: zipExists,
      count: leads.length,
      data: leads,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pest-leads.csv', async (req, res) => {
  try {
    const { limit, pestType, status, zip, sortBy, recentDays } = parseLeadsQuery(req.query);
    const { leads } = await getPestLeads({ limit, pestType, status, zip, sortBy, recentDays });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="pest-leads.csv"');
    res.send(leadsToCsv(leads));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Building detail: every individual pest violation, every registration
// contact, DOB violations, ACRIS deed history, and other buildings under the
// same owner/agent — everything for the "click a lead" panel. Fetched fresh
// on every request (no caching — this only runs when someone clicks a lead).
app.get('/api/buildings/:buildingid', async (req, res) => {
  try {
    const detail = await getBuildingDetail(req.params.buildingid);
    res.json({
      source:
        'NYC Open Data — HPD Violations (wvxf-dwi5), Registrations (tesw-yqqr), Registration Contacts (feu5-w2e2), DOB Violations (3h2n-5cm9), ACRIS Real Property Master/Parties/Legals (bnx9-e6tj, 636b-3b5g, 8h5j-fqxa)',
      fetched_at: new Date().toISOString(),
      ...detail,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Address search: type any NYC address, get back whether it has pest
// violations, has none, or isn't a real address at all. See lookupAddress().
app.get('/api/address-lookup', async (req, res) => {
  const address = (req.query.address || '').trim();
  if (!address) {
    return res.status(400).json({ error: 'Missing "address" query param' });
  }
  try {
    const result = await lookupAddress(address);
    res.json({
      source: 'NYC Planning GeoSearch (geocoding) + NYC Open Data (HPD/DOB/ACRIS, same as /api/buildings)',
      fetched_at: new Date().toISOString(),
      ...result,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
