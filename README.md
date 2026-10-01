# Housing Ranker

A single-page web app that scores rental apartments against weighted personal
criteria instead of eyeballing a spreadsheet. Pure static — vanilla
HTML/CSS/JS, no build step, no framework. Works from `file://` and from
GitHub Pages.

## Features

- **Onboarding** — first run collects work address(es) (with OpenStreetMap
  geocoding or manual coordinates), number of cars, and a starting weight
  preset.
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

Not included by design: map views, Walk Score auto-fetch, Google review
auto-fetch.

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
  "work_addresses": [{ "name": "Office", "lat": 37.33, "lng": -122.01 }],
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

## Sharing notes

- The share link is self-contained: no server ever sees your data.
- Loading a snapshot **replaces** the loader's current data (with a confirm
  step). Export a backup first if it matters.
- Scores are relative to the candidate set in the snapshot (min-max
  normalization), so a shared ranking reflects the sharer's shortlist.
