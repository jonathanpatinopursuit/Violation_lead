# Violation Lead

A lead-generation tool for pest control outreach: NYC buildings ranked by
rodent + roach HPD housing violations since 2024-01-01, cross-referenced with
HPD's building registration data to attach the current owner/agent's name and
mailing address — for postcards or in-person visits (no phone/email
collected). Click into any building for its full violation history, every
registration contact on file, NYC Dept. of Buildings violations, ACRIS deed
history, and other buildings registered under the same owner/agent.

**Everything is fetched live** from [NYC Open Data](https://opendata.cityofnewyork.us/)
on each request — nothing is a static download.

## Where the data comes from

- **[HPD Housing Maintenance Code Violations](https://data.cityofnewyork.us/City-Government/Housing-Maintenance-Code-Violations/wvxf-dwi5)**
  (`wvxf-dwi5`) — full violation history (open + closed), filtered for
  rodent/rat/mice and roach/cockroach infestation language in
  `novdescription`, grouped by `buildingid`.
- **[Multiple Dwelling Registrations](https://data.cityofnewyork.us/Housing-Development/Multiple-Dwelling-Registrations/tesw-yqqr)**
  (`tesw-yqqr`) — maps `buildingid` to the building's current `registrationid`
  (most recent by `lastregistrationdate`).
- **[Registration Contacts](https://data.cityofnewyork.us/Housing-Development/Registration-Contacts/feu5-w2e2)**
  (`feu5-w2e2`) — the owner/agent's name + business mailing address for that
  registration. Preference order when a building has multiple contacts on
  file: Agent > CorporateOwner > IndividualOwner > JointOwner > HeadOfficer >
  Officer > Lessee > Shareholder > SiteManager.
- **[DOB Violations](https://data.cityofnewyork.us/Housing-Development/DOB-Violations/3h2n-5cm9)**
  (`3h2n-5cm9`) — NYC Dept. of Buildings violations (elevators, boilers,
  construction — not HPD housing code), keyed by BIN, shown in the building
  detail panel.
- **ACRIS** (Dept. of Finance property recording system) — deed transfer
  history by borough/block/lot, joined across three datasets: **Real Property
  Legals** (`8h5j-fqxa`, maps a BBL to document ids), **Real Property Master**
  (`bnx9-e6tj`, doc type/date), and **Real Property Parties** (`636b-3b5g`,
  grantor/grantee names). Shown in the building detail panel.
- **[NYC Planning GeoSearch](https://geosearch.planninglabs.nyc/)** — free,
  no-key geocoder used by `/api/address-lookup` to resolve a typed address to
  a BIN, which then feeds the same HPD/DOB/ACRIS pipeline as a lead click.
- **[Google Custom Search JSON API](https://developers.google.com/custom-search/v1/overview)**
  — used to find a CorporateOwner contact's actual business website (see
  below). Chosen over Brave Search specifically because its 100 queries/day
  free tier doesn't require adding a payment method.

## Contact enrichment: websites and LinkedIn

- **CorporateOwner contacts** get an automated website lookup via Google
  Custom Search, filtered to exclude directory/social sites (LinkedIn, Yelp,
  Zillow, BBB, etc.) so it's the company's own site or nothing. Requires
  `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_CX` (see below) — without them, `website`
  is always `null` and nothing else breaks. Results are cached 24h per
  company name to stay well within the free daily quota.
- **Every contact** (agent, head officer, shareholders, site manager,
  individual/joint owners, and the corporate owner too) also gets a
  `linkedin_search_url` and a `google_search_url` — pre-filled search links,
  not automated matches. There's no legitimate API for bulk LinkedIn
  people-search, and matching common names automatically would produce false
  positives, so this puts a human in the loop to verify. These links work
  with zero setup, regardless of whether the Google CSE keys are configured.

## API

- `GET /api/pest-leads` — the ranked lead list. Query params: `pestType`
  (`all` | `rodent` | `roach`), `status` (`all` | `open` | `closed`), `zip`
  (5-digit), `sortBy` (`total` | `most_recent` | `open` | `rodent` | `roach`),
  `limit` (default 100, max 500 — caps how many buildings get the
  registration/contact lookup, since that's the expensive part).
- `GET /api/pest-leads.csv` — same filters, CSV export for mail-merge.
- `GET /api/buildings/:buildingid` — full detail for one building: every
  individual pest violation, every registration contact (with website/LinkedIn
  enrichment, see above), DOB violations, ACRIS deed history, and other
  buildings under the same owner/agent ("portfolio" — an exact
  case-insensitive name match against HPD's own filings, not a verified
  identity match).
- `GET /api/address-lookup?address=...` — type any address, get back whether
  it has pest violations (`found`), has none (`no_violations`), is a real
  building with no HPD registration (`no_registration`), or isn't a
  recognized NYC address (`not_found`).

## Why some things are cached

Socrata has no index on `novdescription`, so a `LIKE '%ROACH%'` text scan
over 2024+ violations (2M+ rows) takes ~40 seconds per pest type even
aggregated server-side. `server.js` caches those two aggregate queries in
memory for 30 minutes so the leads list stays fast — violation *counts*
refresh on that cadence, but owner/agent lookups (and everything in the
building detail panel) are always fetched live. `vercel.json` sets
`maxDuration: 60` so a cold cache miss doesn't time out.

## Running locally

```bash
npm install
cp .env.example .env   # add your own NYC_OPEN_DATA_TOKEN
npm start               # http://localhost:3000
```

Get a free Socrata app token at
[data.cityofnewyork.us/profile/app_tokens](https://data.cityofnewyork.us/profile/app_tokens)
and put it in `.env` as `NYC_OPEN_DATA_TOKEN`. Without it, requests still
work but are rate-limited more aggressively.

For corporate-owner website lookups, set up a free Google Custom Search
key (100 queries/day, no credit card required):

1. [Google Cloud Console](https://console.cloud.google.com/apis/library/customsearch.googleapis.com) —
   create/select a project, enable the "Custom Search API," then create an
   API key under **APIs & Services > Credentials**. Put it in `.env` as
   `GOOGLE_CSE_API_KEY`.
2. [Programmable Search Engine](https://programmablesearchengine.google.com/) —
   create a new search engine, turn on "Search the entire web," and copy its
   Search Engine ID. Put it in `.env` as `GOOGLE_CSE_CX`.

Without both, everything else still works — `website` just stays `null` on
every contact, and the search-link fallbacks (`google_search_url`,
`linkedin_search_url`) work regardless.

## Deployment

Not yet deployed. To put this on Vercel: `vercel link` a new project, set
`NYC_OPEN_DATA_TOKEN` as an environment variable (Production + Preview), and
deploy — `server.js` runs directly as the entrypoint, same as this repo's
sibling project (`nyc`).
