# Housing Ranker

A single-page web app that scores rental apartments against weighted personal
criteria instead of eyeballing a spreadsheet. Pure static — vanilla
HTML/CSS/JS, no build step, no framework. Works from `file://` and from
GitHub Pages.

## Features

- **Onboarding** — first run collects your locations (an **Office** and a
  **Home** slot by default; add more if you like), number of cars, and a
  starting weight preset. Type an address and it geocodes automatically via
  OpenStreetMap — no button to press — or enter coordinates manually. Only
  the label and coordinates are stored; the address text itself is never
  saved (see Privacy).
- **Weighted scoring engine** — 7 categories (Rent, Commute, Living Space,
  Walkability, Building Condition, Appliances, Personal Preference), integer
  weights summing to 100. Candidates are ranked at the **floor-plan level**
  (apartment × floor plan), with per-category 0–100 sub-scores via min-max
  normalization across the current candidate set.
- **True monthly cost** — rent + HOA + property tax/12 + extra-parking cost for
  cars beyond the included spots.
- **Named weight presets** — create, edit, rename, delete, switch; re-ranks
  instantly.
- **Ranked leaderboard** with per-category score breakdowns and key facts,
  plus a **side-by-side comparison table**.
- **Persistence** — everything lives in `localStorage` as two JSON blobs
  (`hr_settings`, `hr_apartments`), with JSON export/import for backup.
- **Share snapshot** — "Share link" copies a URL whose `#s=` hash carries a
  compressed copy of the current shortlist. Friends opening it get a banner
  offering to load the snapshot into their own copy. This is a **snapshot**,
  not live collaboration: their edits stay local.
- **Seeding** — "Seed apartments" (Apartments tab, or the empty state) builds
  a starter list around one of your locations two ways: a free in-page AI
  chat, or a copy/paste loop through your own Muse. See
  [Seeding apartments](#seeding-apartments).

Not included by design: map views, Walk Score auto-fetch, Google review
auto-fetch.

## Seeding apartments

"Seed apartments" gives you two ways to build a starter shortlist around
one of your saved locations (it needs a location with coordinates first):

- **Free AI chat** — a chat box right in the app, powered by
  [Pollinations](https://text.pollinations.ai) (keyless, no account). It
  suggests apartment complexes near your anchor and offers an "Add N
  apartments" button under any reply that contains usable data. Be aware:
  a free model can sound confident while inventing details, so imported
  entries are stamped **"Seeded via free AI chat — UNVERIFIED, verify all
  details"** in their notes. Treat them as leads, not facts.
- **Use my Muse** — the accurate route. The app generates a ready-made
  prompt from your criteria (anchor, radius, max rent, bedrooms,
  must-haves, count) in a copy box; you copy it, open
  [muse.ai](https://muse.ai), paste it there, and Muse researches real,
  currently-listed properties on the web and answers with a JSON block.
  Paste that answer back into the app and the apartments are imported,
  stamped "Seeded via Muse" in their notes.

Either way, seeded apartments arrive with blank 1–10 ratings (scores stay
honest until you rate them yourself), an estimated commute when coordinates
are available, and names that already exist in your list are skipped rather
than overwritten.

## Run locally

Just open `index.html` in a browser, or serve the folder:

```sh
cd housing-ranker
python3 -m http.server 8080
# open http://localhost:8080
```

Geocoding uses the public OpenStreetMap Nominatim API (no key needed); the
app throttles to at most 1 request/second per its usage policy. Commute
"estimates" are straight-line distance at an assumed 40 km/h and are always
labeled as estimates — type the real number to override.

## Enable GitHub Pages

1. Push this folder's contents to a GitHub repo (repo root = this folder).
2. In the repo: **Settings → Pages → Build and deployment → GitHub Actions**.
3. Push to `main` — the included workflow (`.github/workflows/pages.yml`)
   deploys automatically. Your app will be at
   `https://<user>.github.io/<repo>/`.

## Data model

`localStorage["hr_settings"]`:

```json
{
  "work_addresses": [
    { "name": "Office", "lat": 37.33, "lng": -122.01 },
    { "name": "Home", "lat": null, "lng": null }
  ],
  "primary_work_address": 0,
  "num_cars": 1,
  "weight_presets": [{ "id": "balanced", "name": "Balanced",
    "weights": { "rent": 20, "commute": 15, "space": 15, "walkability": 15,
                 "condition": 15, "appliances": 10, "preference": 10 } }],
  "active_preset_id": "balanced",
  "onboarded": true
}
```

`localStorage["hr_apartments"]`: object keyed by apartment name; each value
holds address/website/year built/walk score/coordinates/commute minutes (+ an
`commute_estimated` flag)/Google review/notes/`created_at`, four 1–10 ratings
(`neighborhood_vibe`, `condition_score`, `appliances_score`, `gut_feeling`),
parking and home details, and `floor_plans: [{name, price, sqft, hoa,
property_tax}]`.

Locations (`work_addresses`) always include an `Office` and a `Home` entry;
an unset location has `lat`/`lng` of `null`. Each location is stored as a
label plus coordinates only — the address you type to find it is used for
the geocoding lookup and then discarded. `primary_work_address` picks the
commute anchor; if it has no coordinates yet, the first location that does
is used.

## Privacy

Your address is never sent to or stored on a server. It stays in your
browser, on your device (`localStorage`). Only the coordinates are kept,
so the app can score commutes — the address text itself is not saved.
Geocoding sends what you type to OpenStreetMap once to find the
coordinates. If you create a share link, the coordinates travel with it —
only when you choose to share.

## Sharing notes

- The share link is self-contained: no server ever sees your data.
- Loading a snapshot **replaces** the loader's current data (with a confirm
  step). Export a backup first if it matters.
- Scores are relative to the candidate set in the snapshot (min-max
  normalization), so a shared ranking reflects the sharer's shortlist.
