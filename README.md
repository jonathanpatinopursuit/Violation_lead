# Pest Violation Lead List

A lead-generation tool that helps pest control companies find new customers
in NYC. It turns the city's own public housing violation records into a
ranked list of buildings with active rodent or roach problems — each one
matched to the property's owner or managing agent, ready for postcards,
calls, or an in-person visit.

**Live:** [violationlead.vercel.app](https://violationlead.vercel.app)

## What it does

- **Ranks NYC buildings** by verified rodent and roach violations logged
  with HPD since January 2024 — pulled live on every request, not a static
  download.
- **Attaches a real contact** for each building: the registered owner or
  managing agent's name and mailing address, sourced from HPD's own
  registration filings.
- **Search any address or zip code** and get a straight answer — active
  violations, a clean record, or an honest "that's not a real NYC address."
- **Click into any building** for its full violation history, every contact
  on file, NYC Dept. of Buildings records, property deed history, and every
  other building registered to the same owner — so a landlord sitting on
  violations across a whole portfolio doesn't hide behind one address.
- **Filter by pest type, status, or recency** — buildings with a violation
  in the last 7 days are a very different lead than one from a year ago.
- **Export a CSV** or **print postcard labels** for every unique mailing
  address in your current results, ready to mail.

## Where the data comes from

Everything is sourced live from public New York City records — nothing is
scraped, guessed, or purchased:

- **HPD Housing Maintenance Code Violations** — the official record of
  every rodent/roach violation issued since 2024.
- **HPD Multiple Dwelling Registrations** and **Registration Contacts** —
  the legally required filing that names a building's owner or managing
  agent and their mailing address.
- **NYC Dept. of Buildings (DOB) Violations** — non-housing violations
  (construction, elevators, boilers) for additional building context.
- **ACRIS** (NYC Dept. of Finance) — recorded deed transfers, so you can see
  a building's ownership history.
- **NYC Planning GeoSearch** — resolves a typed address to a specific
  building for the address-search feature.

## A known limitation

City records give you a name and a mailing address — not a phone number or
an email. The tool attempts to fill that gap by finding a corporate owner's
own website (via Google Custom Search) and pulling published contact info
off it, but Google closed that search API to new developer accounts, so
this feature is currently dormant for any freshly created API key. In the
meantime, every contact has one-click "Search Google" and "Search LinkedIn"
links so you can track down a number or email yourself — no data-broker
scraping, no bulk people-search, just a fast starting point.

## Running locally

```bash
npm install
cp .env.example .env   # add your own NYC_OPEN_DATA_TOKEN
npm start               # http://localhost:3000
```

Get a free Socrata app token at
[data.cityofnewyork.us/profile/app_tokens](https://data.cityofnewyork.us/profile/app_tokens)
and set it as `NYC_OPEN_DATA_TOKEN` in `.env`. The app still runs without
it, just with tighter rate limits.

Optional: `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_CX` enable the corporate
website lookup described above, on Google accounts where it's still
available. Everything else works fine without them.

## API reference

| Endpoint | What it returns |
|---|---|
| `GET /api/pest-leads` | Ranked lead list. Filter with `pestType`, `status`, `zip`, `sortBy`, `recentDays`, `limit`. |
| `GET /api/pest-leads.csv` | Same filters, as a CSV for mail-merge. |
| `GET /api/buildings/:buildingid` | Full detail for one building — violations, contacts, DOB records, deed history, and other buildings under the same owner. |
| `GET /api/address-lookup?address=...` | Look up any address directly. |

## Technical notes

Socrata (NYC's data platform) has no index on violation descriptions, so a
full-text search across 2M+ rows takes up to a minute. The server caches
that aggregate query for 30 minutes so the leads list stays fast for
everyone — building-level detail (contacts, violation history, deed
records) is always fetched fresh.

## Deployment

Deployed on [Vercel](https://vercel.com) at
[violationlead.vercel.app](https://violationlead.vercel.app), auto-deploying
from `main` on push. `server.js` runs directly as the entrypoint.
