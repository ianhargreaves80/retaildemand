/* retaildemand.org: Stage 1 behavioural collector
 * Mirrors the ianhargreaves.dev collector, adapted to this site's surfaces.
 * Privacy: random per-session id in sessionStorage only. No cookies, no
 * persistent identifiers, no personal data. Nothing is read back across sessions.
 * Tracks: (a) pageviews for session flow,
 *         (b) outbound clicks to ianhargreaves.dev / LinkedIn / Substack,
 *         (c) market selection on the data sheet ("market_select"; the ISO geo,
 *             capped per pageview so a click-through-every-market visit can't
 *             inflate the payload),
 *         (d) clicks through to the other pages on this site ("internal"),
 *         (e) downloads of the /performance/ prediction artefacts ("download").
 * Envelope is identical to ianhargreaves.dev (schema_v 1), so the two datasets
 * can be UNIONed for cross-site session work.
 *
 * !!! event_type values here MUST exist in the ingest function's EVENT_TYPES !!!
 * The function drops unknown types silently. Adding one here without
 * redeploying analytics-stage1/function is how ianhargreaves.dev lost two
 * months of tool_use events.
 */
(function () {
  "use strict";

  // ---- config -------------------------------------------------------------
  var ENDPOINT = "https://rd-analytics-ingest-5xw6y3xnja-oa.a.run.app";
  var SCHEMA_V = 1;

  // Outbound destinations, matched by hostname suffix (reads the real hrefs).
  // ianhargreaves.dev is the conversion KPI for this site: the data sheet is
  // the top of the funnel, the personal site is where the work is explained.
  var DESTINATIONS = [
    { key: "ianhargreaves", suffix: "ianhargreaves.dev" },
    { key: "linkedin",      suffix: "linkedin.com" },
    { key: "substack",      suffix: "ianhargreaves.substack.com" }
  ];

  // Internal pages worth counting click-throughs to (the whole published set).
  var CONTENT_PAGES = {
    "index": 1,
    "methods": 1,
    "factor-profile": 1
  };

  // Market selection is the core interaction on the data sheet. Unlike the
  // ianhargreaves tool_use event (first interaction only), the SEQUENCE of
  // markets is the interesting signal, so several are kept per pageview —
  // bounded so a visitor cycling all 35 markets can't bloat the beacon.
  var MARKET_EVENT_CAP = 20;
  var marketEvents = 0;

  // Prediction-registry artefacts: a download is the strongest engagement
  // signal this site has (someone taking the data away to use it).
  var DOWNLOAD_PATH = /^\/performance\/.+\.(csv|json)$/i;

  // ---- light bot filter ---------------------------------------------------
  if (navigator.webdriver === true) return;            // headless / automation: send nothing
  // local development / preview: send nothing (keeps test traffic out of the data)
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname)) return;
  if (!ENDPOINT || ENDPOINT.indexOf("http") !== 0) return;
  if (!("sendBeacon" in navigator)) return;            // flush mechanism unavailable

  // ---- session id (no persistence beyond the tab session) -----------------
  var SID_KEY = "rd_sid";
  var sessionId;
  function newId() {
    return (crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  }
  try {
    sessionId = sessionStorage.getItem(SID_KEY);
    if (!sessionId) {
      sessionId = newId();
      sessionStorage.setItem(SID_KEY, sessionId);
    }
  } catch (e) {
    // sessionStorage blocked (private mode / disabled): in-memory id, still no persistence
    sessionId = newId();
  }

  // ---- campaign tag -------------------------------------------------------
  // page_path deliberately excludes the query string (it would fragment the
  // page grouping), so a ?r= tag is lifted into event_data on the pageview.
  // Read via JSON_VALUE(event_data,'$.r') in BigQuery.
  function campaignTag() {
    try {
      var r = new URL(location.href).searchParams.get("r");
      if (!r) return null;
      r = String(r).slice(0, 40);
      return /^[A-Za-z0-9_.-]+$/.test(r) ? r : null;
    } catch (e) { return null; }
  }

  // ---- event envelope (LOCKED schema) -------------------------------------
  var buffer = [];
  function makeEvent(eventType, eventData) {
    return {
      schema_v: SCHEMA_V,
      session_id: sessionId,
      event_type: eventType,
      ts: new Date().toISOString(),
      page_path: location.pathname,
      referrer: document.referrer,
      viewport_w: window.innerWidth || 0,
      viewport_h: window.innerHeight || 0,
      user_agent: navigator.userAgent,
      event_data: eventData || {}
    };
  }

  // ---- flush via sendBeacon (survives unload) -----------------------------
  function flush() {
    if (!buffer.length) return;
    var payload = JSON.stringify(buffer);
    // text/plain keeps this a CORS "simple" request (no preflight); the
    // function parses the JSON body regardless of content-type.
    var blob = new Blob([payload], { type: "text/plain;charset=UTF-8" });
    var ok = navigator.sendBeacon(ENDPOINT, blob);
    if (ok) buffer = [];   // assume delivered; if it failed, keep for a later flush attempt
  }

  // ---- (a) pageview on load ----------------------------------------------
  var tag = campaignTag();
  buffer.push(makeEvent("pageview", tag ? { r: tag } : {}));

  // ---- (b/d/e) link clicks ------------------------------------------------
  function destinationFor(hostname) {
    hostname = (hostname || "").toLowerCase();
    for (var i = 0; i < DESTINATIONS.length; i++) {
      var s = DESTINATIONS[i].suffix;
      if (hostname === s || hostname.slice(-(s.length + 1)) === "." + s) {
        return DESTINATIONS[i].key;
      }
    }
    return null;
  }

  document.addEventListener("click", function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
    if (!a) return;
    var url;
    try { url = new URL(a.href, location.href); } catch (e) { return; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    // record only, do NOT preventDefault / delay navigation
    var dest = destinationFor(url.hostname);
    if (dest) {
      buffer.push(makeEvent("outbound", { destination: dest, link_url: a.href }));
      return;
    }
    if (url.origin !== location.origin) return;
    // ---- (e) prediction-registry downloads --------------------------------
    if (DOWNLOAD_PATH.test(url.pathname)) {
      buffer.push(makeEvent("download", { file: url.pathname }));
      flush();   // the click may navigate straight to the file; don't wait
      return;
    }
    // ---- (d) internal click-throughs --------------------------------------
    if (url.pathname !== location.pathname) {
      var base = url.pathname.replace(/\/$/, "/index").split("/").pop().replace(/\.html$/, "");
      if (CONTENT_PAGES[base] === 1) {
        // a.href keeps the fragment, so anchor-level targets (#method, #data)
        // remain distinguishable in BigQuery from the bare page
        buffer.push(makeEvent("internal", { destination: base, link_url: a.href }));
      }
    }
  }, true); // capture: fire before navigation begins

  // ---- (c) market selection on the data sheet -----------------------------
  // Two routes into the same state: the .ix market buttons (data-geo) and the
  // #countrySelect dropdown. Listened for at document level in the capture
  // phase, so the page's own handlers are untouched.
  function recordMarket(geo, control) {
    if (!geo || marketEvents >= MARKET_EVENT_CAP) return;
    if (!/^[A-Z0-9_]{2,10}$/.test(geo)) return;
    marketEvents++;
    buffer.push(makeEvent("market_select", { geo: geo, control: control }));
  }

  document.addEventListener("click", function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest("button.ix[data-geo]") : null;
    if (!b) return;
    recordMarket(b.getAttribute("data-geo"), "ix-button");
  }, true);

  document.addEventListener("change", function (ev) {
    var s = ev.target;
    if (!s || s.id !== "countrySelect") return;
    recordMarket(s.value, "country-select");
  }, true);

  // ---- flush triggers -----------------------------------------------------
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", flush);   // most reliable on mobile/bfcache
  window.addEventListener("beforeunload", flush);
})();
