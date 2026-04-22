// Provider matcher + URL/body param decoders for GA4, Google Ads, Floodlight,
// Meta, Bing, TikTok, LinkedIn, etc.

(function (root) {
  const PROVIDERS = [
    {
      key: "gtm_loader", name: "GTM / gtag.js loader", category: "loader",
      match: (u) => /googletagmanager\.com\/(gtm|gtag)\/js/.test(u),
      parse: (u) => ({ id: qp(u, "id") })
    },
    {
      key: "ga4", name: "Google Analytics 4", category: "analytics",
      match: (u) => /google-analytics\.com\/(g|debug\/g)\/collect/.test(u) || /analytics\.google\.com\/g\/collect/.test(u),
      parse: (u, body) => {
        const p = allParams(u, body);
        const events = parseGa4Batch(p);
        return {
          tid: p.tid || "",
          cid: p.cid || "",
          en: p.en || (events[0] && events[0].en) || "",
          dl: p.dl || "",
          dt: p.dt || "",
          gcs: p.gcs || "",
          gcd: p.gcd || "",
          npa: p.npa || "",
          dma: p.dma || "",
          _dbg: p._dbg || p.debug_mode || "",
          events
        };
      }
    },
    {
      key: "google_ads_conv", name: "Google Ads Conversion", category: "ads",
      match: (u) => /googleadservices\.com\/pagead\/conversion/.test(u) || /googleads\.g\.doubleclick\.net\/pagead\/viewthroughconversion/.test(u),
      parse: (u) => {
        const p = allParams(u);
        return { awId: extractAwId(u), label: p.label || "", value: p.value || "", currency: p.currency_code || p.currency || "", gclid: p.gclid || "" };
      }
    },
    {
      key: "floodlight", name: "Floodlight (DCM)", category: "ads",
      match: (u) => /fls\.doubleclick\.net\/activityi/.test(u) || /ad\.doubleclick\.net\/activity/.test(u),
      parse: (u) => {
        const m = u.match(/src=(\d+)[;&].*?type=([^;&]+).*?cat=([^;&]+)/);
        const ord = (u.match(/[;&?]ord=([^;&]+)/) || [])[1] || "";
        return { src: m ? m[1] : "", type: m ? m[2] : "", cat: m ? m[3] : "", ord };
      }
    },
    {
      key: "meta", name: "Meta (Facebook) Pixel", category: "ads",
      match: (u) => /facebook\.com\/tr/.test(u) || /connect\.facebook\.net\/.*\/fbevents\.js/.test(u),
      parse: (u) => ({ id: qp(u, "id"), ev: qp(u, "ev"), eid: qp(u, "eid") })
    },
    {
      key: "tiktok", name: "TikTok Pixel", category: "ads",
      match: (u) => /analytics\.tiktok\.com\/(api|i18n)\/pixel/.test(u) || /analytics\.tiktok\.com\/i18n\/pixel\/events\.js/.test(u),
      parse: (u) => ({ id: qp(u, "sdkid") || qp(u, "pixel_code") })
    },
    {
      key: "linkedin", name: "LinkedIn Insight", category: "ads",
      match: (u) => /px\.ads\.linkedin\.com|snap\.licdn\.com\/li\.lms-analytics/.test(u),
      parse: (u) => ({ pid: qp(u, "pid"), conversionId: qp(u, "conversionId") })
    },
    {
      key: "bing", name: "Microsoft / Bing UET", category: "ads",
      match: (u) => /bat\.bing\.com|bat\.r\.msn\.com/.test(u),
      parse: (u) => ({ ti: qp(u, "ti"), ea: qp(u, "ea"), el: qp(u, "el") })
    },
    {
      key: "pinterest", name: "Pinterest Tag", category: "ads",
      match: (u) => /ct\.pinterest\.com|s\.pinimg\.com\/ct/.test(u),
      parse: (u) => ({ tid: qp(u, "tid"), event: qp(u, "event") })
    },
    {
      key: "snap", name: "Snap Pixel", category: "ads",
      match: (u) => /tr\.snapchat\.com|sc-static\.net\/scevent/.test(u),
      parse: () => ({})
    },
    {
      key: "twitter", name: "X / Twitter", category: "ads",
      match: (u) => /analytics\.twitter\.com|static\.ads-twitter\.com\/uwt\.js|t\.co\/i\/adsct/.test(u),
      parse: (u) => ({ txn_id: qp(u, "txn_id"), p_id: qp(u, "p_id") })
    },
    {
      key: "reddit", name: "Reddit Pixel", category: "ads",
      match: (u) => /alb\.reddit\.com|events\.redditmedia\.com|redditstatic\.com\/ads\/pixel/.test(u),
      parse: () => ({})
    },
    {
      key: "conversion_linker", name: "Conversion Linker (gtag)", category: "ads",
      match: (u) => /googletagmanager\.com\/gtag\/destination/.test(u) || /googleadservices\.com\/pagead\/landing/.test(u),
      parse: (u) => ({ id: qp(u, "id") })
    },
    {
      key: "hotjar", name: "Hotjar", category: "replay",
      match: (u) => /static\.hotjar\.com|script\.hotjar\.com/.test(u),
      parse: () => ({})
    },
    {
      key: "clarity", name: "Microsoft Clarity", category: "replay",
      match: (u) => /clarity\.ms/.test(u),
      parse: () => ({})
    },
    {
      key: "fullstory", name: "FullStory", category: "replay",
      match: (u) => /fullstory\.com|fs\.js/.test(u),
      parse: () => ({})
    }
  ];

  function qp(u, k) { try { return new URL(u).searchParams.get(k) || ""; } catch { return ""; } }

  function allParams(u, body) {
    const out = {};
    try { new URL(u).searchParams.forEach((v, k) => { out[k] = v; }); } catch {}
    if (body) {
      try { new URLSearchParams(body).forEach((v, k) => { out[k] = v; }); } catch {}
    }
    return out;
  }

  function parseGa4Batch(p) {
    // GA4 `ep.*` params are event-scoped; `en` is event name. A single request can
    // carry multiple events when batched (enumerated en, en2, en3...).
    const events = [];
    const keys = Object.keys(p);
    const enKeys = keys.filter((k) => /^en(\d*)$/.test(k)).sort();
    for (const enKey of enKeys) {
      const idx = enKey.replace(/^en/, "") || "";
      const suffix = idx ? idx : "";
      const ev = { en: p[enKey] };
      for (const k of keys) {
        if (k === enKey) continue;
        if (suffix && k.endsWith(suffix)) {
          const base = k.slice(0, -suffix.length);
          if (/^ep\./.test(base) || /^epn\./.test(base) || ["cu", "tr", "ti"].includes(base)) ev[base] = p[k];
        } else if (!suffix && !/\d+$/.test(k)) {
          if (/^ep\./.test(k) || /^epn\./.test(k) || ["cu", "tr", "ti"].includes(k)) ev[k] = p[k];
        }
      }
      if (ev.en === "purchase") {
        if (p["epn.value"]) ev.value = p["epn.value"];
        if (p["ep.currency"]) ev.currency = p["ep.currency"];
        if (p["pr1"]) ev.items_raw = Object.keys(p).filter((k) => /^pr\d+$/.test(k)).map((k) => p[k]);
      }
      events.push(ev);
    }
    if (!events.length && p.en) events.push({ en: p.en });
    return events;
  }

  function extractAwId(u) {
    const m = u.match(/[?&]id=AW-([0-9]+)/) || u.match(/\/(AW-[0-9]+)\//) || u.match(/\/([0-9]+)\//);
    return m ? (m[1].startsWith("AW-") ? m[1] : `AW-${m[1]}`) : "";
  }

  function matchProvider(url) {
    for (const p of PROVIDERS) { try { if (p.match(url)) return p; } catch {} }
    return null;
  }

  function annotate(requests) {
    return requests.map((r) => {
      const prov = matchProvider(r.url);
      if (!prov) return { ...r, provider: null };
      let fields = {};
      try { fields = prov.parse(r.url, r.postBody) || {}; } catch {}
      return { ...r, provider: { key: prov.key, name: prov.name, category: prov.category }, fields };
    });
  }

  const api = { PROVIDERS, matchProvider, annotate, qp, allParams };
  if (typeof module !== "undefined") module.exports = api;
  root.TTParsers = api;
})(typeof window !== "undefined" ? window : self);
