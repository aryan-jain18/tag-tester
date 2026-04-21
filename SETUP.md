# GTM Audit Extension — Setup & Usage

A Chrome (Manifest V3) extension that audits any website against **21 checks** (Performance, Privacy, Compliance, Security, SEO, Debugging) and includes **Omnibug-style** tag/pixel detection plus **Data Slayer-style** `dataLayer` inspection.

## 1. Folder layout

```
C:\GTM Audit Extension\
├── Audit.xlsx                (source spec)
├── SETUP.md                  (this file)
└── extension\                (load THIS folder in Chrome)
    ├── manifest.json
    ├── background.js
    ├── content.js
    ├── injected.js
    ├── audit-config.json
    ├── lib\providers.js
    ├── devtools\devtools.html / devtools.js
    ├── panel\panel.html / panel.css / panel.js / audits.js
    ├── popup\popup.html / popup.js
    └── icons\icon16.png / icon48.png / icon128.png
```

## 2. Load the extension in Chrome / Edge / Brave

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Toggle **Developer mode** ON (top right).
3. Click **Load unpacked**.
4. Select the folder: `C:\GTM Audit Extension\extension`.
5. The extension "GTM Audit" appears. Pin it to the toolbar.

Reload the extension from `chrome://extensions` whenever you edit a file.

## 3. Run an audit on any website

1. Navigate to the site. **Reload once after installing** so the content script injects cleanly.
2. Open DevTools (F12).
3. Click the **GTM Audit** panel.
4. Click **Run Audit**.
5. Summary tab shows all 21 checks with pass/warn/fail and expandable details.

Other tabs: **Tags/Pixels** (Omnibug-style grouped detections), **dataLayer** (Data Slayer-style live pushes), **Network**, **Cookies**, **Storage**, **Console**. **Export JSON** saves everything.

## 4. Consent-denied validation (AUD-004, AUD-005)

1. Tick **Simulate consent denied** in the panel.
2. Reject marketing cookies in the site's CMP (or ignore the banner).
3. Reload → Run Audit. AUD-004/005 fail if CDP/CRM/ad pixels still fire.

## 5. Zero-cookie load test (AUD-006)

1. Click the extension icon → **Clear cookies** and **Clear storage**.
2. Reload without interacting with the consent banner.
3. Run Audit. AUD-006 lists any cookie set pre-consent.

## 6. Audit coverage

| ID | Category | Check |
|----|----------|-------|
| AUD-001 | Performance | 3rd-party library load + DNS/TCP/TTFB/duration |
| AUD-002 | Debugging | console.error + uncaught/unhandled rejections |
| AUD-003 | Privacy | Cookie classification (consent/functional/1p/3p-tracking) |
| AUD-004 | Compliance | HubSpot/Segment/Klaviyo under denied consent |
| AUD-005 | Privacy | Meta/TikTok/LinkedIn/Reddit/Bing/Pinterest/Snap/X/DV360 under denied consent |
| AUD-006 | Privacy | Non-essential cookies set before user interaction |
| AUD-007 | Privacy | localStorage/sessionStorage/IndexedDB identifiers |
| AUD-008 | Privacy | Third-party domain tally |
| AUD-009 | Performance | LCP / CLS / INP / FCP / TTFB |
| AUD-010 | Performance | Uncompressed text assets, >1MB images |
| AUD-011 | Performance | Render-blocking head scripts/stylesheets |
| AUD-012 | Security | HTTP assets on HTTPS page |
| AUD-013 | SEO | Missing viewport/canonical/description/OG/Twitter tags |
| AUD-014 | Privacy | PII (email/phone/SSN/MD5/SHA256) in cookies and payloads |
| AUD-015 | Privacy | Third-party iframes |
| AUD-016 | Debugging | GA4/Meta/Bing/TikTok/LinkedIn schema |
| AUD-017 | Debugging | Duplicate events within 1s |
| AUD-018 | Performance | 4xx/5xx resources |
| AUD-019 | Performance | Third-party sync scripts |
| AUD-020 | Security | Stripe/Google/AWS/Slack/JWT/HubSpot keys exposed |
| AUD-021 | Debugging | console.warn deprecations |

## 7. Troubleshooting

- No dataLayer pushes → reload the page after opening DevTools.
- No requests → the page loaded before the extension was installed; reload.
- Panel tab missing → close/reopen DevTools after installing.
- Everything stays local; the extension makes no outbound calls.

## 8. Extending

- New provider: edit `extension/lib/providers.js`, push a `{ key, name, category, match, parse }` entry.
- New audit: edit `extension/panel/audits.js`, push into `AUDIT_DEFS`. `ctx` exposes `requests, cookies, dom, console, cwv, storage, resourceTiming, origin, host, consentDenied`.

## 9. Packaging

Zip the contents of `extension/` for Chrome Web Store upload, or share the folder for Developer-mode loads.
