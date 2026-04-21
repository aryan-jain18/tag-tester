// Tag / pixel / analytics provider patterns (Omnibug-inspired).
// Each provider: name, category, match(url), parse(url, postBody) -> fields object.

const PROVIDERS = [
  {
    key: "gtm", name: "Google Tag Manager", category: "Tag Management",
    match: (u) => /googletagmanager\.com\/gtm\.js/.test(u) || /googletagmanager\.com\/gtag\/js/.test(u),
    parse: (u) => {
      const url = new URL(u);
      return { "Container ID": url.searchParams.get("id") || "" };
    }
  },
  {
    key: "ga4", name: "Google Analytics 4", category: "Analytics",
    match: (u) => /google-analytics\.com\/g\/collect/.test(u) || /analytics\.google\.com\/g\/collect/.test(u),
    parse: (u, body) => {
      const url = new URL(u);
      const params = new URLSearchParams(url.search);
      if (body) { try { new URLSearchParams(body).forEach((v, k) => params.set(k, v)); } catch {} }
      return {
        "Measurement ID": params.get("tid") || "",
        "Event Name": params.get("en") || "",
        "Client ID": params.get("cid") || "",
        "Session ID": params.get("sid") || "",
        "Page Location": params.get("dl") || "",
        "Page Title": params.get("dt") || ""
      };
    }
  },
  {
    key: "ua", name: "Universal Analytics (legacy)", category: "Analytics",
    match: (u) => /google-analytics\.com\/(collect|r\/collect|j\/collect)/.test(u),
    parse: (u) => {
      const url = new URL(u);
      return {
        "Property ID": url.searchParams.get("tid") || "",
        "Hit Type": url.searchParams.get("t") || "",
        "Event Category": url.searchParams.get("ec") || "",
        "Event Action": url.searchParams.get("ea") || "",
        "Event Label": url.searchParams.get("el") || ""
      };
    }
  },
  {
    key: "fb", name: "Meta / Facebook Pixel", category: "Advertising",
    match: (u) => /facebook\.com\/tr\//.test(u) || /connect\.facebook\.net\/.*\/fbevents\.js/.test(u),
    parse: (u) => {
      const url = new URL(u);
      return {
        "Pixel ID": url.searchParams.get("id") || "",
        "Event": url.searchParams.get("ev") || "",
        "Event ID": url.searchParams.get("eid") || ""
      };
    }
  },
  {
    key: "tiktok", name: "TikTok Pixel", category: "Advertising",
    match: (u) => /analytics\.tiktok\.com\/(api|i18n)\/pixel/.test(u) || /analytics\.tiktok\.com\/i18n\/pixel\/events\.js/.test(u),
    parse: (u) => {
      const url = new URL(u);
      return { "Pixel Code": url.searchParams.get("sdkid") || url.searchParams.get("pixel_code") || "" };
    }
  },
  {
    key: "linkedin", name: "LinkedIn Insight", category: "Advertising",
    match: (u) => /px\.ads\.linkedin\.com|snap\.licdn\.com\/li\.lms-analytics/.test(u),
    parse: (u) => {
      const url = new URL(u);
      return {
        "Partner ID": url.searchParams.get("pid") || "",
        "Conversion ID": url.searchParams.get("conversionId") || ""
      };
    }
  },
  {
    key: "reddit", name: "Reddit Pixel", category: "Advertising",
    match: (u) => /alb\.reddit\.com|events\.redditmedia\.com|www\.redditstatic\.com\/ads\/pixel\.js/.test(u),
    parse: (u) => ({ "URL": u })
  },
  {
    key: "bing", name: "Microsoft / Bing UET", category: "Advertising",
    match: (u) => /bat\.bing\.com|bat\.r\.msn\.com|uet\.js/.test(u),
    parse: (u) => {
      const url = new URL(u);
      return { "Tag ID": url.searchParams.get("ti") || "", "Event Action": url.searchParams.get("ea") || "" };
    }
  },
  {
    key: "pinterest", name: "Pinterest Tag", category: "Advertising",
    match: (u) => /ct\.pinterest\.com|s\.pinimg\.com\/ct\/core\.js/.test(u),
    parse: (u) => {
      const url = new URL(u);
      return { "Tag ID": url.searchParams.get("tid") || "", "Event": url.searchParams.get("event") || "" };
    }
  },
  {
    key: "snap", name: "Snap Pixel", category: "Advertising",
    match: (u) => /tr\.snapchat\.com|sc-static\.net\/scevent\.min\.js/.test(u),
    parse: () => ({})
  },
  {
    key: "twitter", name: "X / Twitter Pixel", category: "Advertising",
    match: (u) => /analytics\.twitter\.com|static\.ads-twitter\.com\/uwt\.js|t\.co\/i\/adsct/.test(u),
    parse: (u) => { try { const url = new URL(u); return { "Tag ID": url.searchParams.get("txn_id") || url.searchParams.get("p_id") || "" }; } catch { return {}; } }
  },
  {
    key: "hubspot", name: "HubSpot", category: "CDP/CRM",
    match: (u) => /js\.hs-scripts\.com|js\.hs-analytics\.net|track\.hubspot\.com|forms\.hsforms\.com/.test(u),
    parse: () => ({})
  },
  {
    key: "segment", name: "Segment", category: "CDP",
    match: (u) => /cdn\.segment\.com|api\.segment\.io/.test(u),
    parse: () => ({})
  },
  {
    key: "mixpanel", name: "Mixpanel", category: "Analytics",
    match: (u) => /cdn\.mxpnl\.com|api\.mixpanel\.com/.test(u),
    parse: () => ({})
  },
  {
    key: "amplitude", name: "Amplitude", category: "Analytics",
    match: (u) => /cdn\.amplitude\.com|api\.amplitude\.com|api2\.amplitude\.com/.test(u),
    parse: () => ({})
  },
  {
    key: "hotjar", name: "Hotjar", category: "UX Analytics",
    match: (u) => /static\.hotjar\.com|script\.hotjar\.com/.test(u),
    parse: () => ({})
  },
  {
    key: "clarity", name: "Microsoft Clarity", category: "UX Analytics",
    match: (u) => /clarity\.ms/.test(u),
    parse: () => ({})
  },
  {
    key: "adobe", name: "Adobe Analytics", category: "Analytics",
    match: (u) => /\/b\/ss\/|2o7\.net|omtrdc\.net/.test(u),
    parse: () => ({})
  },
  {
    key: "dv360", name: "DoubleClick / Google Ads", category: "Advertising",
    match: (u) => /doubleclick\.net|googleadservices\.com\/pagead\/conversion|googlesyndication\.com/.test(u),
    parse: () => ({})
  },
  {
    key: "klaviyo", name: "Klaviyo", category: "CRM/Email",
    match: (u) => /static\.klaviyo\.com|a\.klaviyo\.com/.test(u),
    parse: () => ({})
  }
];

const CONSENT_COOKIE_HINTS = [
  "OptanonConsent","OptanonAlertBoxClosed","CookieConsent","cookieyes-consent",
  "__cmpconsent","euconsent-v2","didomi_token","OneTrust","borlabs-cookie",
  "cookie_consent","usercentrics"
];

const FUNCTIONAL_COOKIE_HINTS = ["session","csrf","xsrf","auth","token","sid","lang","locale","cart"];

function classifyDomain(reqDomain, pageDomain) {
  if (!reqDomain || !pageDomain) return "unknown";
  const r = reqDomain.replace(/^www\./, "");
  const p = pageDomain.replace(/^www\./, "");
  if (r === p) return "first-party";
  const rootR = r.split(".").slice(-2).join(".");
  const rootP = p.split(".").slice(-2).join(".");
  return rootR === rootP ? "first-party" : "third-party";
}

function matchProvider(url) {
  for (const p of PROVIDERS) {
    try { if (p.match(url)) return p; } catch {}
  }
  return null;
}

if (typeof module !== "undefined") module.exports = { PROVIDERS, CONSENT_COOKIE_HINTS, FUNCTIONAL_COOKIE_HINTS, classifyDomain, matchProvider };
if (typeof self !== "undefined") { self.PROVIDERS = PROVIDERS; self.CONSENT_COOKIE_HINTS = CONSENT_COOKIE_HINTS; self.FUNCTIONAL_COOKIE_HINTS = FUNCTIONAL_COOKIE_HINTS; self.classifyDomain = classifyDomain; self.matchProvider = matchProvider; }
