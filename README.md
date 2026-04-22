# Tag Tester

Chrome (MV3) DevTools extension that audits live page traffic for:

1. **Consent** — CMP framework, Consent Mode v2 signals (`gcs` / `gcd` / `ad_user_data` / `ad_personalization`), EU gating, session replay gating
2. **Ad platforms** — Google Ads, Floodlight, Meta, TikTok, LinkedIn, Bing, Pinterest, Snap, X, Reddit; Conversion Linker; click-ID capture; UTM persistence
3. **Analytics** — GA4 loader presence, measurement ID count, duplicate configs, `debug_mode` in prod
4. **GA4 events** — `purchase` / `value` / `currency` / `items[]`, numeric value, manual vs auto `page_view`, UA-vs-GA4 ecommerce shape
5. **Cookies** — default 2-year Google cookie expiry in EU, session-only tracker cookies

Includes one-click **Clear tracking cookies** (`_ga*`, `_gcl_*`, `_fbp`, `_fbc`, `_uetsid`, `_uetvid`, `_ttp`, `li_fat_id`, consent cookies) and **Clear all + reload** for zero-cookie retesting.

## Install (unpacked)

1. `chrome://extensions`
2. Developer mode → **Load unpacked** → select `C:\Tag Tester`
3. Add 16/48/128 px icons if needed (optional — not referenced as required by this manifest)
4. Open DevTools → **Tag Tester** panel

Reload the page once after installing so the content script injects at `document_start`.

## Files

```
manifest.json
background/service-worker.js   # webRequest capture, cookie clearing
content/inject.js              # content-script bridge
content/page.js                # main-world reader (dataLayer, CMP, click-IDs, UTMs)
devtools/                      # panel UI
rules/{consent,ads,analytics,events,cookies}.js
utils/parsers.js               # provider matcher + GA4/Ads/Floodlight/Meta/... decoders
```

## Adding rules

Each rule returns `{ id, severity, status: "pass"|"fail"|"warn"|"info"|"skip", title, evidence }`. Append to the appropriate `rules/*.js`, no wiring needed — the panel calls `TTRules.<category>.run(input)` where `input = { annotated, pageState, cookies, region, origin, host }`.

## Out of scope (v1)

Container-level checks (naming conventions, paused tags) require GTM API access and are not implemented. PII detection is also out of scope.
