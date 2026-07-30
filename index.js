// Google plugin for Viboplr — a merge of the former google-lyrics and
// google-image-search plugins. Contributes:
//   • the `lyrics` information type (scraped from Google search results)
//   • artist / album / tag image providers (Google Images)
// Both sub-features share one settings panel with Lyrics / Images tabs.
//
// The two halves are kept verbatim as activateLyrics()/activateImages(). Each is
// handed a wrapped `api` whose ui.setViewData is intercepted so its layout
// becomes one tab's body instead of overwriting the whole panel — everything
// else (onAction, storage, network, providers) passes straight through.

function activate(api) {
  var activeTab = "lyrics";
  var nodes = { lyrics: null, images: null };

  function tabsNode() {
    return {
      type: "tabs",
      activeTab: activeTab,
      action: "google-switch-tab",
      tabs: [
        { id: "lyrics", label: "Lyrics" },
        { id: "images", label: "Images" },
      ],
    };
  }

  function pushRender() {
    var body = nodes[activeTab] || { type: "text", content: "Loading…" };
    api.ui.setViewData("google-settings", {
      type: "layout",
      direction: "vertical",
      children: [tabsNode(), { type: "spacer" }, body],
    });
  }

  // A sub-scoped api: setViewData is captured as this tab's body (and triggers a
  // recompose); every other member is inherited from the real api unchanged.
  function subApi(tabId) {
    var wrapped = Object.create(api);
    wrapped.ui = Object.create(api.ui);
    wrapped.ui.setViewData = function (_viewId, data) {
      nodes[tabId] = data;
      pushRender();
    };
    return wrapped;
  }

  api.ui.onAction("google-switch-tab", function (data) {
    if (data && data.tabId) {
      activeTab = data.tabId;
      pushRender();
    }
  });

  activateLyrics(subApi("lyrics"));
  activateImages(subApi("images"));
  pushRender();
}

function deactivate() {
  suffixes = { artist: "musician", album: "album cover", tag: "music genre" };
}

// ============================================================================
// Image search (formerly the google-image-search plugin)
// ============================================================================
var SEARCH_TIMEOUT = 15000;
var CAPTCHA_TIMEOUT = 180000; // 3 minutes once user is solving
var SETTLE_DELAY = 3000;
var POLL_INTERVAL = 500;
// Anti-captcha tuning. Google throws its "unusual traffic" wall when a fresh
// cookie jar hits a search deep-link, or when searches arrive in a burst. We
// (1) warm up a real browsing session once per app run, (2) auto-dismiss the
// GDPR consent wall so it never reaches the user, and (3) serialize searches
// with a small gap so a library scan doesn't read like a bot.
var WARMUP_URL = "https://www.google.com/ncr"; // ncr = no country redirect
var WARMUP_SETTLE = 2500;
var WARMUP_TIMEOUT = 12000;
var CONSENT_EXTEND = 10000; // give the page time to redirect after auto-consent
var MIN_GAP = 700;          // floor between consecutive Google page loads (ms)
var GAP_JITTER = 900;       // + random 0..GAP_JITTER, so the cadence isn't robotic
var suffixes = { artist: "musician", album: "album cover", tag: "music genre" };

// Probes the page for a consent wall, a captcha, or a usable image result.
// Sends one message per poll: "consent", "captcha", "image-result", or "none".
// Consent (GDPR) and captcha (reCAPTCHA) are distinct: consent is dismissible
// in JS without a human; only a real captcha gets surfaced to the user.
var PROBE_SCRIPT =
  '(function() {' +
  '  try {' +
  '    var url = location.href || "";' +
  '    var body = (document.body && document.body.innerText) || "";' +
  '    var isConsent = url.indexOf("consent.google.com") !== -1' +
  '      || !!document.getElementById("L2AGLb") || !!document.getElementById("W0wltc")' +
  '      || /before you continue/i.test(body);' +
  '    if (isConsent) { window.__viboplr.send("consent", { url: url }); return; }' +
  '    var isCaptcha = url.indexOf("/sorry/") !== -1' +
  '      || !!document.querySelector("form#captcha-form, iframe[src*=\\"recaptcha\\"], iframe[src*=\\"/sorry/\\"], #recaptcha")' +
  '      || /unusual traffic|automated queries/i.test(body);' +
  '    if (isCaptcha) { window.__viboplr.send("captcha", { url: url }); return; }' +
  '    var imgs = document.querySelectorAll("img");' +
  '    for (var i = 0; i < imgs.length; i++) {' +
  '      var src = imgs[i].src || "";' +
  '      if (src.indexOf("data:image") !== 0) continue;' +
  '      var w = imgs[i].naturalWidth || imgs[i].width || 0;' +
  '      var h = imgs[i].naturalHeight || imgs[i].height || 0;' +
  '      if (w < 150 || h < 150) continue;' +
  '      window.__viboplr.send("image-result", { src: src, w: w, h: h });' +
  '      return;' +
  '    }' +
  '    window.__viboplr.send("none", null);' +
  '  } catch (e) {' +
  '    window.__viboplr.send("none", null);' +
  '  }' +
  '})();';

// Injects a top banner explaining why the window appeared and what to do.
// Idempotent: re-running it just updates the existing banner.
var BANNER_SCRIPT =
  '(function() {' +
  '  var ID = "__viboplr_captcha_banner";' +
  '  var existing = document.getElementById(ID);' +
  '  if (existing) return;' +
  '  var bar = document.createElement("div");' +
  '  bar.id = ID;' +
  '  bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
  '    background:#1a73e8;color:#fff;font-family:-apple-system,system-ui,sans-serif;' +
  '    padding:12px 16px;font-size:14px;line-height:1.4;box-shadow:0 2px 6px rgba(0,0,0,.25);";' +
  '  bar.innerHTML = "<b>Viboplr — Google asked us to verify you\'re human.</b>' +
  '    <br/>Please complete the check below. This window will close automatically' +
  '    once Google lets the search through. You usually only need to do this once.";' +
  '  document.documentElement.appendChild(bar);' +
  '  document.body && (document.body.style.paddingTop = (bar.offsetHeight + 8) + "px");' +
  '})();';

// Finds the first <img> with a data:image src that meets minimum size
var EXTRACT_SCRIPT =
  '(function() {' +
  '  var imgs = document.querySelectorAll("img");' +
  '  for (var i = 0; i < imgs.length; i++) {' +
  '    var src = imgs[i].src || "";' +
  '    if (src.indexOf("data:image") !== 0) continue;' +
  '    var w = imgs[i].naturalWidth || imgs[i].width || 0;' +
  '    var h = imgs[i].naturalHeight || imgs[i].height || 0;' +
  '    if (w < 150 || h < 150) continue;' +
  '    window.__viboplr.send("image-result", { src: src, w: w, h: h });' +
  '    return;' +
  '  }' +
  '  window.__viboplr.send("image-result", null);' +
  '})();';

// Collects all qualifying images for the test/debug view
var EXTRACT_ALL_SCRIPT =
  '(function() {' +
  '  var results = [];' +
  '  var imgs = document.querySelectorAll("img");' +
  '  for (var i = 0; i < imgs.length; i++) {' +
  '    var src = imgs[i].src || "";' +
  '    if (src.indexOf("data:image") !== 0) continue;' +
  '    var w = imgs[i].naturalWidth || imgs[i].width || 0;' +
  '    var h = imgs[i].naturalHeight || imgs[i].height || 0;' +
  '    if (w < 150 || h < 150) continue;' +
  '    results.push({ src: src, w: w, h: h });' +
  '  }' +
  '  window.__viboplr.send("image-results", results);' +
  '})();';

function buildSearchUrl(name, entity) {
  var suffix = (suffixes[entity] || "").trim();
  var q = suffix ? name + " " + suffix : name;
  return "https://www.google.com/search?udm=2&q=" + encodeURIComponent(q);
}

function stripDataUriPrefix(dataUri) {
  var idx = dataUri.indexOf(",");
  if (idx === -1) return dataUri;
  return dataUri.substring(idx + 1);
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Clicks past Google's GDPR consent interstitial. Reject-all is preferred
// (privacy) but either button sets the SOCS cookie and lets the search through.
var CONSENT_DISMISS_SCRIPT =
  '(function() {' +
  '  try {' +
  '    var ids = ["W0wltc", "L2AGLb"];' + // Reject all, then Accept all
  '    for (var i = 0; i < ids.length; i++) {' +
  '      var b = document.getElementById(ids[i]);' +
  '      if (b) { b.click(); window.__viboplr.send("consent-clicked", { id: ids[i] }); return; }' +
  '    }' +
  '    var re = /^(reject all|accept all|i agree|agree|accept the use of cookies)$/i;' +
  '    var btns = document.querySelectorAll("button, input[type=submit], [role=button]");' +
  '    for (var j = 0; j < btns.length; j++) {' +
  '      var t = ((btns[j].innerText || btns[j].value || "") + "").trim();' +
  '      if (re.test(t)) { btns[j].click(); window.__viboplr.send("consent-clicked", { text: t }); return; }' +
  '    }' +
  '    window.__viboplr.send("consent-none", null);' +
  '  } catch (e) { window.__viboplr.send("consent-none", null); }' +
  '})();';

// Warm up a real Google session ONCE per app run: load the homepage (not a
// search), accept/reject the consent wall, and let cookies (NID/SOCS/CONSENT)
// settle into the shared WKWebView store. Later search windows inherit them, so
// the first *search* no longer looks like a cold, cookie-less bot hit — which
// is what triggers the "verify you're human" wall in the first place.
var warmupPromise = null;
function ensureWarmedUp(api) {
  if (warmupPromise) return warmupPromise;
  warmupPromise = new Promise(function (resolve) {
    api.log("info", "warming up Google session (once per app run)", "google-images");
    api.network
      .openBrowseWindow(WARMUP_URL, {
        visible: false,
        title: "Viboplr — Google verification",
        width: 1024,
        height: 768,
      })
      .then(function (handle) {
        var done = false;
        var settleTimer = null;
        var deadline = null;
        function finish() {
          if (done) return;
          done = true;
          if (settleTimer) clearTimeout(settleTimer);
          if (deadline) clearTimeout(deadline);
          api.log("info", "Google session warm-up complete", "google-images");
          handle.close().catch(console.error);
          resolve();
        }
        handle.onMessage(function (msg) {
          // Consent handled — give the redirect a moment, then we're warm.
          if (msg.type === "consent-clicked") setTimeout(finish, 1200);
        });
        settleTimer = setTimeout(function () {
          // Whether or not a consent wall is present, cookies are seeded by now.
          handle.eval(CONSENT_DISMISS_SCRIPT).catch(console.error);
          setTimeout(finish, 2000);
        }, WARMUP_SETTLE);
        deadline = setTimeout(finish, WARMUP_TIMEOUT);
      })
      .catch(function (e) {
        api.log("warn", "Google warm-up failed: " + e);
        resolve(); // Never block searches on a warm-up failure.
      });
  });
  return warmupPromise;
}

// Serialize every Google search and space them out. Bursts of concurrent
// searches are the fastest way to trip the abuse wall; one-at-a-time with a
// jittered gap reads as human. (Google is the last-resort image provider, so
// serial resolution is an acceptable trade for not getting captcha-walled.) A
// search showing a captcha holds the chain until the user clears it, so no
// other window pops in the meantime.
var searchChain = Promise.resolve();
var lastLoadAt = 0;
// Diagnostics: monotonic per-session counters. Every Google image search and
// every captcha wall is logged (section "google-images") so the trigger rate is
// visible — watch the captcha/search ratio to tune MIN_GAP or provider order.
var imgSearchSeq = 0;
var imgCaptchaSeq = 0;
function noop() {}

function searchGoogleImages(api, name, entity) {
  var run = searchChain.then(function () {
    return ensureWarmedUp(api).then(function () {
      var now = Date.now();
      var sinceLast = lastLoadAt ? now - lastLoadAt : -1;
      var wait = Math.max(0, lastLoadAt + MIN_GAP + Math.random() * GAP_JITTER - now);
      return delay(wait).then(function () {
        lastLoadAt = Date.now();
        var seq = ++imgSearchSeq;
        api.log("info",
          "image search #" + seq + " q=\"" + name + "\" (" + entity + ")"
            + (sinceLast >= 0 ? " · " + sinceLast + "ms since last load" : "")
            + (wait > 0 ? " · throttled " + Math.round(wait) + "ms" : ""),
          "google-images");
        return runOneSearch(api, name, entity, seq);
      });
    });
  });
  // Keep the chain alive even if this search rejects.
  searchChain = run.then(noop, noop);
  return run;
}

function runOneSearch(api, name, entity, seq) {
  var searchUrl = buildSearchUrl(name, entity);
  var startedAt = Date.now();
  return api.network
    .openBrowseWindow(searchUrl, {
      visible: false,
      title: "Viboplr — Google verification",
      width: 1024,
      height: 768,
    })
    .then(function (handle) {
      return new Promise(function (resolve) {
        var settled = false;
        var pollTimer = null;
        var deadline = null;
        var captchaShown = false;
        var consentClicked = false;

        function finish(result) {
          if (settled) return;
          settled = true;
          if (pollTimer) clearInterval(pollTimer);
          if (deadline) clearTimeout(deadline);
          api.log("info",
            "image search #" + seq + " → " + (result && result.src ? "found image" : "no image")
              + " in " + (Date.now() - startedAt) + "ms"
              + (captchaShown ? " (after captcha)" : ""),
            "google-images");
          handle.close().catch(console.error);
          resolve(result);
        }

        function extendDeadline(ms) {
          if (deadline) clearTimeout(deadline);
          deadline = setTimeout(function () { finish(null); }, ms);
        }

        handle.onMessage(function (msg) {
          if (msg.type === "image-result") {
            finish(msg.data);
          } else if (msg.type === "consent" && !consentClicked) {
            // GDPR wall — dismiss it silently and keep polling. Never surfaced.
            consentClicked = true;
            api.log("info", "image search #" + seq + " · GDPR consent wall auto-dismissed", "google-images");
            handle.eval(CONSENT_DISMISS_SCRIPT).catch(console.error);
            extendDeadline(CONSENT_EXTEND);
          } else if (msg.type === "captcha" && !captchaShown) {
            // Genuine reCAPTCHA — only a human can clear it. Surface the window.
            captchaShown = true;
            var cseq = ++imgCaptchaSeq;
            api.log("warn",
              "CAPTCHA shown — image search #" + seq + " q=\"" + name + "\" · captcha #" + cseq
                + " of " + imgSearchSeq + " image searches this session; surfacing browse window",
              "google-images");
            handle.eval(BANNER_SCRIPT).catch(console.error);
            handle.show().catch(console.error);
            extendDeadline(CAPTCHA_TIMEOUT);
          }
        });

        // Wait for page to settle before polling
        setTimeout(function () {
          pollTimer = setInterval(function () {
            handle.eval(PROBE_SCRIPT).catch(function () {
              finish(null);
            });
          }, POLL_INTERVAL);
        }, SETTLE_DELAY);

        deadline = setTimeout(function () {
          finish(null);
        }, SEARCH_TIMEOUT);
      });
    });
}

function handleImageFetch(api, entity) {
  return function (name, artistName) {
    var searchName = name;
    if (entity === "album" && artistName) {
      searchName = artistName + " " + name;
    }
    return searchGoogleImages(api, searchName, entity)
      .then(function (result) {
        if (!result || !result.src) {
          return { status: "not_found" };
        }
        return { status: "ok", data: stripDataUriPrefix(result.src) };
      })
      .catch(function (e) {
        api.log("warn", "Google image search failed for " + entity + ": " + e);
        return { status: "error", message: String(e) };
      });
  };
}

function activateImages(api) {
  // Step-by-step debugger state
  var dbgTest = {
    status: "idle", // idle | searching | done
    handle: null,
    query: "",
    entity: "artist",
    images: [],
  };

  api.storage.get("suffixes").then(function (val) {
    if (val != null && typeof val === "object") {
      if (val.artist !== undefined) suffixes.artist = String(val.artist);
      if (val.album !== undefined) suffixes.album = String(val.album);
      if (val.tag !== undefined) suffixes.tag = String(val.tag);
    }
    renderSettings();
  }).catch(console.error);

  api.imageProviders.onFetch("artist", handleImageFetch(api, "artist"));
  api.imageProviders.onFetch("album", handleImageFetch(api, "album"));
  api.imageProviders.onFetch("tag", handleImageFetch(api, "tag"));

  // --- Settings actions ---

  api.ui.onAction("gis-suffix-artist", function (data) {
    if (data && data.value !== undefined) {
      suffixes.artist = data.value;
      api.storage.set("suffixes", suffixes).catch(console.error);
    }
  });

  api.ui.onAction("gis-suffix-album", function (data) {
    if (data && data.value !== undefined) {
      suffixes.album = data.value;
      api.storage.set("suffixes", suffixes).catch(console.error);
    }
  });

  api.ui.onAction("gis-suffix-tag", function (data) {
    if (data && data.value !== undefined) {
      suffixes.tag = data.value;
      api.storage.set("suffixes", suffixes).catch(console.error);
    }
  });

  // --- Step-by-step debugger ---

  api.ui.onAction("gis-dbg-query", function (data) {
    if (data && data.value !== undefined) dbgTest.query = data.value;
  });

  api.ui.onAction("gis-dbg-entity", function (data) {
    if (data && data.value !== undefined) {
      dbgTest.entity = data.value;
      renderSettings();
    }
  });

  api.ui.onAction("gis-dbg-start", function () {
    dbgStart();
  });

  api.ui.onAction("gis-dbg-stop", function () {
    dbgStop();
  });

  api.ui.onAction("gis-dbg-devtools", function () {
    if (dbgTest.handle && dbgTest.handle.devtools) {
      dbgTest.handle.devtools().catch(console.error);
    }
  });

  function dbgStart() {
    var query = dbgTest.query.trim();
    if (!query) return;

    var searchUrl = buildSearchUrl(query, dbgTest.entity);
    dbgTest.status = "searching";
    dbgTest.images = [];
    renderSettings();

    api.network.openBrowseWindow(searchUrl, {
      visible: true,
      title: "Google Images Debug",
      width: 1024,
      height: 768,
    }).then(function (handle) {
      dbgTest.handle = handle;
      renderSettings();

      var settled = false;
      var pollTimer = null;
      var deadline = null;

      function finish(results) {
        if (settled) return;
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        if (deadline) clearTimeout(deadline);
        dbgTest.images = results || [];
        dbgTest.status = "done";
        renderSettings();
      }

      handle.onMessage(function (msg) {
        if (msg.type === "image-results") {
          finish(msg.data || []);
        }
      });

      setTimeout(function () {
        pollTimer = setInterval(function () {
          handle.eval(EXTRACT_ALL_SCRIPT).catch(function () {});
        }, POLL_INTERVAL);
      }, SETTLE_DELAY);

      deadline = setTimeout(function () { finish([]); }, SEARCH_TIMEOUT);
    }).catch(function (e) {
      console.error("Debugger failed:", e);
      dbgTest.status = "idle";
      renderSettings();
    });
  }

  function dbgStop() {
    if (dbgTest.handle) {
      dbgTest.handle.close().catch(console.error);
      dbgTest.handle = null;
    }
    dbgTest.status = "idle";
    dbgTest.images = [];
    renderSettings();
  }

  // --- Render ---

  function renderSettings() {
    var idle = dbgTest.status === "idle";
    var searching = dbgTest.status === "searching";
    var done = dbgTest.status === "done";
    var hasHandle = !!dbgTest.handle;

    // Debugger section
    var dbgChildren = [];

    var buttons = [];
    if (idle || done) {
      buttons.push({ type: "button", label: "Start", action: "gis-dbg-start", variant: "accent", style: { padding: "3px 14px" } });
    }
    if (!idle) {
      buttons.push({ type: "button", label: "Reset", action: "gis-dbg-stop", variant: "secondary", style: { padding: "3px 10px" } });
    }
    if (hasHandle) {
      buttons.push({ type: "button", label: "DevTools", action: "gis-dbg-devtools", variant: "secondary", style: { padding: "3px 10px" } });
    }

    dbgChildren.push({
      type: "layout", direction: "horizontal", style: { gap: "8px", "align-items": "center" },
      children: [
        { type: "text-input", placeholder: "Search query (e.g. Radiohead)", action: "gis-dbg-query", value: dbgTest.query, style: { flex: "1" }, disabled: searching },
        { type: "select", options: [
          { value: "artist", label: "Artist" },
          { value: "album", label: "Album" },
          { value: "tag", label: "Tag" },
        ], value: dbgTest.entity, action: "gis-dbg-entity" },
      ].concat(buttons),
    });

    if (searching) {
      dbgChildren.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs)\">Searching Google Images (visible window)...</p>" });
    }

    if (done) {
      if (dbgTest.images.length === 0) {
        dbgChildren.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs);color:var(--error)\">No images found — page may not have loaded or no data:image imgs >= 150px matched.</p>" });
      } else {
        dbgChildren.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs);color:var(--success)\"><b>Found " + dbgTest.images.length + " image(s)</b></p>" });
        var gallery = dbgTest.images.map(function (img) {
          return "<div style=\"display:inline-block;margin:4px;text-align:center\">" +
            "<img src=\"" + img.src + "\" style=\"max-width:160px;max-height:160px;border-radius:var(--ds-radius-card);border:1px solid var(--border)\" />" +
            "<div style=\"font-size:var(--fs-2xs);color:var(--text-secondary);margin-top:2px\">" + img.w + "×" + img.h + "</div>" +
            "</div>";
        }).join("");
        dbgChildren.push({ type: "text", content: "<div style=\"margin-top:8px;display:flex;flex-wrap:wrap;gap:4px\">" + gallery + "</div>" });
      }
    }

    api.ui.setViewData("google-image-search-settings", {
      type: "layout",
      direction: "vertical",
      children: [
        {
          type: "section",
          title: "Step-by-Step Debugger",
          children: dbgChildren,
        },
        {
          type: "section",
          title: "Search Suffixes",
          children: [
            {
              type: "settings-row",
              label: "Artist suffix",
              description: "Appended to artist name (e.g. \"Radiohead musician\")",
              control: { type: "text-input", placeholder: "musician", action: "gis-suffix-artist", value: suffixes.artist }
            },
            {
              type: "settings-row",
              label: "Album suffix",
              description: "Appended to album title (e.g. \"OK Computer album cover\")",
              control: { type: "text-input", placeholder: "album cover", action: "gis-suffix-album", value: suffixes.album }
            },
            {
              type: "settings-row",
              label: "Tag suffix",
              description: "Appended to tag name (e.g. \"rock music genre\")",
              control: { type: "text-input", placeholder: "music genre", action: "gis-suffix-tag", value: suffixes.tag }
            }
          ]
        }
      ]
    });
  }
}

// ============================================================================
// Lyrics (formerly the google-lyrics plugin)
// ============================================================================
function activateLyrics(api) {
  var SEARCH_TIMEOUT = 10000;
  var POLL_INTERVAL = 500;

  var blacklist = ["chatzi.org"];
  var preferred = ["stixoi.info", "genius.com"];
  var searchSuffix = "lyrics";
  var domainStats = {};
  var testArtist = "Τρύπες";
  var testTitle = "Παράξενη Πόλη";
  var testState = { status: "idle", steps: [] };

  // Diagnostics: monotonic per-session counters. Every automated lyrics search
  // and every captcha wall it hits is logged (section "google-lyrics"). The
  // lyrics search runs hidden and can't be solved, so a captcha is logged and
  // returned as no-results — but it still trains Google's abuse wall, which is
  // usually what makes the (visible) image-search captchas keep appearing.
  var lyrSearchSeq = 0;
  var lyrCaptchaSeq = 0;

  // Step-by-step debugger state
  var dbgTest = {
    status: "idle", // idle | searching | results | scraping | done
    handle: null,
    results: [],
    selectedUrl: "",
    scrapeResult: null,
  };

  var MIN_WORD_COUNT = 20;

  // --- Domain statistics ---

  function loadStats() {
    return api.storage.get("domain_stats").then(function (saved) {
      domainStats = saved || {};
    });
  }

  function saveStats() {
    return api.storage.set("domain_stats", domainStats);
  }

  function recordStat(domain, success) {
    if (!domainStats[domain]) {
      domainStats[domain] = { ok: 0, fail: 0, lastOk: null, lastFail: null };
    }
    if (success) {
      domainStats[domain].ok++;
      domainStats[domain].lastOk = new Date().toISOString();
    } else {
      domainStats[domain].fail++;
      domainStats[domain].lastFail = new Date().toISOString();
    }
    saveStats().catch(console.error);
  }

  function formatStatsTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    var now = Date.now();
    var diff = now - d.getTime();
    if (diff < 60000) return "just now";
    if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
    if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
    return Math.floor(diff / 86400000) + "d ago";
  }

  // --- Settings ---

  function loadSettings() {
    return api.storage.get("blacklist").then(function (saved) {
      if (Array.isArray(saved)) blacklist = saved;
    }).then(function () {
      return api.storage.get("preferred").then(function (saved) {
        if (Array.isArray(saved)) preferred = saved;
      });
    }).then(function () {
      return api.storage.get("search_suffix").then(function (val) {
        if (typeof val === "string") searchSuffix = val;
      });
    }).then(loadStats);
  }

  function saveSettings() {
    return api.storage.set("blacklist", blacklist).then(function () {
      return api.storage.set("preferred", preferred);
    }).then(function () {
      return api.storage.set("search_suffix", searchSuffix);
    });
  }

  function isBlacklisted(url) {
    var lower = url.toLowerCase();
    for (var i = 0; i < blacklist.length; i++) {
      if (blacklist[i] && lower.indexOf(blacklist[i].toLowerCase()) !== -1) return true;
    }
    return false;
  }

  function domainFromUrl(url) {
    var m = url.match(/^https?:\/\/(?:www\.)?([^\/]+)/);
    return m ? m[1] : url;
  }

  function renderSettings() {
    var busy = testState.status === "searching" || testState.status === "fetching";
    var testRows = [
      {
        type: "layout", direction: "horizontal", style: { gap: "8px", "align-items": "center" },
        children: [
          { type: "text-input", placeholder: "Artist", action: "test-artist", value: testArtist, style: { flex: "1" } },
          { type: "text-input", placeholder: "Title", action: "test-title", value: testTitle, style: { flex: "1" } },
          { type: "button", label: busy ? "Searching..." : "Test", action: "test-search", disabled: busy, variant: "accent", style: { padding: "3px 14px" } },
        ],
      },
    ];
    if (testState.steps.length > 0) {
      var log = testState.steps.map(function (s) { return "<p style=\"margin:2px 0;font-size:var(--fs-xs)\">" + s + "</p>"; }).join("");
      testRows.push({ type: "text", content: log });
    }

    var searchChildren = [
      { type: "text", content: "<span style=\"font-size:var(--fs-xs);color:var(--text-secondary)\">Extra keywords appended to every Google search (e.g. \"lyrics\", \"στίχοι\", \"lyrics στίχοι\").</span>" },
      { type: "text-input", placeholder: "lyrics", action: "update-suffix", value: searchSuffix },
    ];

    var preferredChildren = [
      { type: "text", content: "<span style=\"font-size:var(--fs-xs);color:var(--text-secondary)\">One domain per line. Results matching these domains are tried first.</span>" },
      { type: "text-input", placeholder: "genius.com", action: "update-preferred", value: preferred.join("\n"), multiline: true, rows: 3 },
    ];

    var blacklistChildren = [
      { type: "text", content: "<span style=\"font-size:var(--fs-xs);color:var(--text-secondary)\">One domain per line. Search results matching these domains will be skipped.</span>" },
      { type: "text-input", placeholder: "example.com", action: "update-blacklist", value: blacklist.join("\n"), multiline: true, rows: 4 },
    ];

    var statsRows = [];
    var hasSomeStats = false;
    var allStatDomains = Object.keys(domainStats);
    for (var s = 0; s < allStatDomains.length; s++) {
      var sd = allStatDomains[s];
      var st = domainStats[sd];
      if (st && (st.ok > 0 || st.fail > 0)) {
        hasSomeStats = true;
        var rate = st.ok + st.fail > 0 ? Math.round(st.ok / (st.ok + st.fail) * 100) : 0;
        statsRows.push({
          type: "text",
          content: "<div style=\"font-size:var(--fs-xs);padding:2px 0\">"
            + "<b>" + sd + "</b> — "
            + "<span style=\"color:var(--success)\">" + st.ok + " ok</span> / "
            + "<span style=\"color:var(--error)\">" + st.fail + " fail</span>"
            + " (" + rate + "%)"
            + (st.lastOk ? " · last ok " + formatStatsTime(st.lastOk) : "")
            + (st.lastFail ? " · last fail " + formatStatsTime(st.lastFail) : "")
            + "</div>",
        });
      }
    }
    if (!hasSomeStats) {
      statsRows.push({ type: "text", content: "<span style=\"font-size:var(--fs-xs);color:var(--text-secondary)\">No data yet</span>" });
    } else {
      statsRows.push({ type: "button", label: "Reset Statistics", action: "reset-stats", variant: "secondary", style: { padding: "3px 14px", "margin-top": "4px" } });
    }

    api.ui.setViewData("google-lyrics-settings", {
      type: "layout",
      direction: "vertical",
      children: [
        buildDebugTestSection(),
        {
          type: "section",
          title: "Test (auto)",
          children: testRows,
        },
        {
          type: "section",
          title: "Search Keywords",
          children: searchChildren,
        },
        {
          type: "section",
          title: "Preferred Sites",
          children: preferredChildren,
        },
        {
          type: "section",
          title: "Blocked Domains",
          children: blacklistChildren,
        },
        {
          type: "section",
          title: "Statistics",
          children: statsRows,
        },
      ],
    });
  }

  api.ui.onAction("update-suffix", function (data) {
    if (data && data.value !== undefined) {
      searchSuffix = data.value;
      saveSettings();
    }
  });

  api.ui.onAction("update-preferred", function (data) {
    if (data && data.value !== undefined) {
      preferred = data.value.split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
      saveSettings();
    }
  });

  api.ui.onAction("update-blacklist", function (data) {
    if (data && data.value !== undefined) {
      blacklist = data.value.split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
      saveSettings();
    }
  });

  api.ui.onAction("reset-stats", function () {
    domainStats = {};
    saveStats().then(renderSettings);
  });

  api.ui.onAction("test-artist", function (data) {
    if (data && data.value !== undefined) testArtist = data.value;
  });
  api.ui.onAction("test-title", function (data) {
    if (data && data.value !== undefined) testTitle = data.value;
  });

  function buildQuery(artist, title) {
    var q = "";
    if (artist) q += artist + " ";
    if (title) q += title + " ";
    if (searchSuffix) q += searchSuffix;
    return q.trim();
  }

  function runTestSearch() {
    var artist = testArtist.trim();
    var title = testTitle.trim();
    if (!artist && !title) {
      testState = { status: "done", steps: ["Enter an artist and/or title."] };
      renderSettings();
      return;
    }

    var query = buildQuery(artist, title);
    var steps = ["Query: <b>" + query + "</b>", "Searching..."];
    testState = { status: "searching", steps: steps };
    renderSettings();

    searchGoogle(query).then(function (results) {
      if (results.length === 0) {
        steps.push("Google returned 0 URLs (timeout or page did not load).");
        testState = { status: "done", steps: steps };
        renderSettings();
        return;
      }

      steps.push("Google returned " + results.length + " URL(s).");
      if (blacklist.length > 0) steps.push("Blacklist: " + blacklist.join(", "));

      var candidates = filterResults(results);
      if (candidates.length === 0) {
        steps.push("All results were blacklisted or no results found.");
        closeScrapeWindow();
        testState = { status: "done", steps: steps };
        renderSettings();
        return;
      }
      steps.push(candidates.length + " candidate(s) after filtering.");

      function tryCandidate(idx) {
        if (idx >= candidates.length) {
          steps.push("All " + candidates.length + " candidate(s) failed.");
          closeScrapeWindow();
          testState = { status: "done", steps: steps };
          renderSettings();
          return;
        }

        var found = candidates[idx];
        steps.push((idx > 0 ? "Fallback " + (idx + 1) + ": " : "") + "Scraping <b>" + found.domain + "</b>: " + found.url);
        testState = { status: "fetching", steps: steps };
        renderSettings();

        return scrapeLyrics(found.url).then(function (result) {
          if (!result || !result.text) {
            steps.push("No lyrics found (score: " + (result ? result.score : 0) + ", need " + MIN_WORD_COUNT + "+ words).");
            if (idx < candidates.length - 1) {
              steps.push("Trying next candidate...");
              renderSettings();
              return tryCandidate(idx + 1);
            }
          } else {
            var preview = result.text.length > 200 ? result.text.substring(0, 200) + "..." : result.text;
            steps.push("Found " + result.text.length + " chars (" + result.words + " words, score: " + Math.round(result.score) + ").");
            steps.push("<i>" + preview.replace(/\n/g, " / ") + "</i>");
            closeScrapeWindow();
            testState = { status: "done", steps: steps };
            renderSettings();
            return;
          }
          closeScrapeWindow();
          testState = { status: "done", steps: steps };
          renderSettings();
        }).catch(function (e) {
          console.error("Scrape failed for " + found.domain + ":", e);
          steps.push("Error scraping " + found.domain + ": " + e + ", trying next...");
          renderSettings();
          return tryCandidate(idx + 1);
        });
      }

      return tryCandidate(0);
    }).catch(function (e) {
      console.error("Test search failed:", e);
      steps.push("Error: " + e);
      testState = { status: "done", steps: steps };
      renderSettings();
    });
  }

  api.ui.onAction("test-search", runTestSearch);

  // --- Step-by-step debugger ---

  function dbgStart() {
    var artist = testArtist.trim();
    var title = testTitle.trim();
    if (!artist && !title) return;

    var query = buildQuery(artist, title);
    var searchUrl = "https://www.google.com/search?q=" + encodeURIComponent(query);

    dbgTest.status = "searching";
    dbgTest.results = [];
    dbgTest.selectedUrl = "";
    dbgTest.scrapeResult = null;
    renderSettings();

    api.network.openBrowseWindow(searchUrl, {
      visible: true,
      title: "Google Lyrics Debug",
      width: 900,
      height: 700,
    }).then(function (handle) {
      dbgTest.handle = handle;
      renderSettings();

      var settled = false;
      var pollTimer = null;
      var deadline = null;

      function finish(urls) {
        if (settled) return;
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        if (deadline) clearTimeout(deadline);
        dbgTest.results = filterResults(urls || []);
        dbgTest.status = "results";
        if (dbgTest.results.length > 0) dbgTest.selectedUrl = dbgTest.results[0].url;
        renderSettings();
      }

      handle.onMessage(function (msg) {
        if (msg.type === "search-results" && Array.isArray(msg.data)) {
          finish(msg.data);
        }
        if (msg.type === "lyrics-result" && dbgTest.status === "scraping") {
          dbgTest.scrapeResult = msg.data;
          dbgTest.status = "done";
          renderSettings();
        }
      });

      pollTimer = setInterval(function () {
        handle.eval(GOOGLE_EXTRACT_SCRIPT).catch(function () {});
      }, POLL_INTERVAL);

      deadline = setTimeout(function () { finish([]); }, SEARCH_TIMEOUT);
    }).catch(function (e) {
      console.error("Debugger failed to open window:", e);
      dbgTest.status = "idle";
      renderSettings();
    });
  }

  function dbgScrapeUrl(url) {
    if (!dbgTest.handle || !url) return;
    dbgTest.status = "scraping";
    dbgTest.scrapeResult = null;
    renderSettings();

    var escaped = url.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    dbgTest.handle.eval("window.location.href = '" + escaped + "'").catch(function () {
      dbgTest.status = "done";
      dbgTest.scrapeResult = { text: null };
      renderSettings();
    });

    setTimeout(function () {
      if (dbgTest.status !== "scraping") return;
      var pollTimer = setInterval(function () {
        if (dbgTest.status !== "scraping") { clearInterval(pollTimer); return; }
        dbgTest.handle.eval(LYRICS_EXTRACT_SCRIPT).catch(function () {});
      }, POLL_INTERVAL);
      setTimeout(function () {
        clearInterval(pollTimer);
        if (dbgTest.status === "scraping") {
          dbgTest.status = "done";
          dbgTest.scrapeResult = { text: null, timeout: true };
          renderSettings();
        }
      }, SCRAPE_TIMEOUT);
    }, SCRAPE_NAV_DELAY);
  }

  function dbgStop() {
    if (dbgTest.handle) {
      dbgTest.handle.close().catch(console.error);
      dbgTest.handle = null;
    }
    dbgTest.status = "idle";
    dbgTest.results = [];
    dbgTest.scrapeResult = null;
    renderSettings();
  }

  function buildDebugTestSection() {
    var children = [];
    var idle = dbgTest.status === "idle";
    var searching = dbgTest.status === "searching";
    var hasHandle = !!dbgTest.handle;

    // Input + Start/Stop + DevTools
    var buttons = [];
    if (idle || dbgTest.status === "done") {
      buttons.push({ type: "button", label: "Start", action: "dbg-start", variant: "accent", style: { padding: "3px 14px" } });
    }
    if (!idle) {
      buttons.push({ type: "button", label: "Reset", action: "dbg-stop", variant: "secondary", style: { padding: "3px 10px" } });
    }
    if (hasHandle) {
      buttons.push({ type: "button", label: "DevTools", action: "dbg-devtools", variant: "secondary", style: { padding: "3px 10px" } });
    }

    children.push({
      type: "layout", direction: "horizontal", style: { gap: "8px", "align-items": "center" },
      children: [
        { type: "text-input", placeholder: "Artist", action: "test-artist", value: testArtist, style: { flex: "1" }, disabled: !idle },
        { type: "text-input", placeholder: "Title", action: "test-title", value: testTitle, style: { flex: "1" }, disabled: !idle },
      ].concat(buttons),
    });

    // Status
    if (searching) {
      children.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs)\">Searching Google (visible window)...</p>" });
    }

    // Step 2: Show results as clickable links
    if (dbgTest.status === "results" || dbgTest.status === "scraping" || dbgTest.status === "done") {
      if (dbgTest.results.length === 0) {
        children.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs);color:var(--error)\">No results found from Google.</p>" });
      } else {
        children.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs)\"><b>Search results (" + dbgTest.results.length + "):</b></p>" });
        var resultOptions = dbgTest.results.map(function (r) { return { value: r.url, label: r.domain + " — " + r.url.substring(0, 60) }; });
        children.push({
          type: "select", options: resultOptions, value: dbgTest.selectedUrl, action: "dbg-select-url",
        });
        if (dbgTest.status === "results") {
          children.push({
            type: "button", label: "Scrape Lyrics", action: "dbg-scrape", variant: "accent", style: { padding: "3px 14px", "margin-top": "4px" },
          });
        }
      }
    }

    // Step 3: Scrape status
    if (dbgTest.status === "scraping") {
      children.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs)\">Navigating and extracting lyrics...</p>" });
    }

    // Step 4: Result
    if (dbgTest.status === "done" && dbgTest.scrapeResult) {
      var res = dbgTest.scrapeResult;
      if (res.text) {
        children.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs);color:var(--success)\"><b>Lyrics found!</b> " + res.words + " words, score: " + Math.round(res.score) + "</p>" });
        children.push({ type: "text", content: "<pre style=\"font-size:var(--fs-2xs);max-height:400px;overflow:auto;white-space:pre-wrap;padding:8px;background:var(--bg-tertiary);border-radius:var(--ds-radius)\">" + res.text.replace(/</g, "&lt;") + "</pre>" });
      } else if (res.timeout) {
        children.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs);color:var(--error)\">Timeout — no lyrics extracted within " + (SCRAPE_TIMEOUT / 1000) + "s.</p>" });
      } else {
        children.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs);color:var(--error)\">No lyrics found on this page (below " + MIN_WORD_COUNT + " word threshold).</p>" });
      }
      // Allow trying another URL + domain actions
      var currentDomain = dbgTest.selectedUrl ? domainFromUrl(dbgTest.selectedUrl) : "";
      if (dbgTest.results.length > 0) {
        children.push({
          type: "layout", direction: "horizontal", style: { gap: "8px", "align-items": "center", "margin-top": "4px" },
          children: [
            { type: "button", label: "Try Another URL", action: "dbg-retry", variant: "secondary", style: { padding: "3px 14px" } },
            { type: "button", label: "Add \"" + currentDomain + "\" to Preferred", action: "dbg-add-preferred", variant: "secondary", style: { padding: "3px 10px", "font-size": "var(--fs-2xs)" } },
            { type: "button", label: "Add \"" + currentDomain + "\" to Blocked", action: "dbg-add-blacklist", variant: "secondary", style: { padding: "3px 10px", "font-size": "var(--fs-2xs)" } },
          ],
        });
      }
    }

    // Also show domain action buttons when viewing results (before scraping)
    if (dbgTest.status === "results" && dbgTest.selectedUrl) {
      var selDomain = domainFromUrl(dbgTest.selectedUrl);
      children.push({
        type: "layout", direction: "horizontal", style: { gap: "8px", "align-items": "center", "margin-top": "4px" },
        children: [
          { type: "button", label: "Add \"" + selDomain + "\" to Preferred", action: "dbg-add-preferred", variant: "secondary", style: { padding: "3px 10px", "font-size": "var(--fs-2xs)" } },
          { type: "button", label: "Add \"" + selDomain + "\" to Blocked", action: "dbg-add-blacklist", variant: "secondary", style: { padding: "3px 10px", "font-size": "var(--fs-2xs)" } },
        ],
      });
    }

    return { type: "section", title: "Step-by-Step Debugger", children: children };
  }

  api.ui.onAction("dbg-start", dbgStart);
  api.ui.onAction("dbg-stop", dbgStop);

  api.ui.onAction("dbg-devtools", function () {
    if (dbgTest.handle && dbgTest.handle.devtools) {
      dbgTest.handle.devtools().catch(console.error);
    }
  });

  api.ui.onAction("dbg-select-url", function (data) {
    if (data && data.value !== undefined) {
      dbgTest.selectedUrl = data.value;
      renderSettings();
    }
  });

  api.ui.onAction("dbg-scrape", function () {
    dbgScrapeUrl(dbgTest.selectedUrl);
  });

  api.ui.onAction("dbg-retry", function () {
    dbgTest.status = "results";
    dbgTest.scrapeResult = null;
    renderSettings();
  });

  api.ui.onAction("dbg-add-preferred", function () {
    if (!dbgTest.selectedUrl) return;
    var domain = domainFromUrl(dbgTest.selectedUrl);
    if (!domain) return;
    for (var i = 0; i < preferred.length; i++) {
      if (preferred[i].toLowerCase() === domain.toLowerCase()) {
        api.log("info", "Domain already in preferred: " + domain, "google-lyrics");
        return;
      }
    }
    preferred.push(domain);
    api.log("info", "Added to preferred: " + domain, "google-lyrics");
    saveSettings().then(renderSettings);
  });

  api.ui.onAction("dbg-add-blacklist", function () {
    if (!dbgTest.selectedUrl) return;
    var domain = domainFromUrl(dbgTest.selectedUrl);
    if (!domain) return;
    for (var i = 0; i < blacklist.length; i++) {
      if (blacklist[i].toLowerCase() === domain.toLowerCase()) {
        api.log("info", "Domain already in blacklist: " + domain, "google-lyrics");
        return;
      }
    }
    blacklist.push(domain);
    api.log("info", "Added to blacklist: " + domain, "google-lyrics");
    saveSettings().then(renderSettings);
  });

  loadSettings().then(renderSettings);

  // --- Browse window scraping ---

  var SCRAPE_TIMEOUT = 15000;
  var SCRAPE_NAV_DELAY = 1000;

  var GOOGLE_EXTRACT_SCRIPT =
    '(function() {' +
    '  var __u = location.href || "";' +
    '  var __b = (document.body && document.body.innerText) || "";' +
    '  if (__u.indexOf("/sorry/") !== -1 || /unusual traffic|automated queries/i.test(__b)) { window.__viboplr.send("search-captcha", { url: __u }); return; }' +
    '  var container = document.getElementById("search") || document.getElementById("rso");' +
    '  if (!container) return;' +
    '  var links = container.querySelectorAll("a[href]");' +
    '  var seen = {};' +
    '  var urls = [];' +
    '  var skip = /google\\.|gstatic\\.|googleapis\\.|youtube\\.|schema\\.org/;' +
    '  for (var i = 0; i < links.length; i++) {' +
    '    var href = links[i].href;' +
    '    if (!href) continue;' +
    '    if (href.indexOf("/url?") !== -1) {' +
    '      var m = href.match(/[?&]q=([^&]+)/);' +
    '      if (m) { try { href = decodeURIComponent(m[1]); } catch(e) { continue; } }' +
    '      else { continue; }' +
    '    }' +
    '    if (href.indexOf("http") !== 0) continue;' +
    '    if (skip.test(href)) continue;' +
    '    if (seen[href]) continue;' +
    '    seen[href] = true;' +
    '    urls.push(href);' +
    '  }' +
    '  if (urls.length > 0) window.__viboplr.send("search-results", urls);' +
    '})();';

  var LYRICS_EXTRACT_SCRIPT =
    '(function() {' +
    '  if (document.readyState !== "complete") return;' +
    '  var MIN = ' + MIN_WORD_COUNT + ';' +
    '  var MAX_LINE = 150;' +
    '  var skip = {SCRIPT:1,STYLE:1,NOSCRIPT:1,IFRAME:1,SVG:1,IMG:1,INPUT:1,BUTTON:1,SELECT:1,TEXTAREA:1,VIDEO:1,AUDIO:1,CANVAS:1,OBJECT:1,EMBED:1};' +
    '  var inline = {A:1,B:1,I:1,EM:1,STRONG:1,SPAN:1,U:1,SMALL:1,SUP:1,SUB:1,FONT:1,RUBY:1,RT:1,RP:1,WBR:1,MARK:1,S:1,ABBR:1,CITE:1,BR:1};' +
    '  var best = null;' +
    '  var bestScore = 0;' +
    '  function score(text) {' +
    '    text = text.replace(/^[ \\t]+$/gm, "").replace(/\\n{3,}/g, "\\n\\n").trim();' +
    '    if (!text) return;' +
    '    var lines = text.split(/\\n/);' +
    '    var nonEmpty = lines.filter(function(l){return l.trim().length>0;});' +
    '    if (nonEmpty.length < 3) return;' +
    '    var allShort = true;' +
    '    for (var k = 0; k < nonEmpty.length; k++) {' +
    '      if (nonEmpty[k].trim().length > MAX_LINE) { allShort = false; break; }' +
    '    }' +
    '    if (!allShort) return;' +
    '    var words = text.split(/\\s+/).filter(function(w){return w.length>0;});' +
    '    if (words.length < MIN) return;' +
    '    var s = words.length + nonEmpty.length;' +
    '    if (s > bestScore) { bestScore = s; best = text; }' +
    '  }' +
    '  var els = document.body.querySelectorAll("*");' +
    '  for (var i = 0; i < els.length; i++) {' +
    '    var el = els[i];' +
    '    if (skip[el.tagName]) continue;' +
    '    var st = window.getComputedStyle(el);' +
    '    if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") continue;' +
    '    var children = el.childNodes;' +
    '    var hasBr = false;' +
    '    var hasBlock = false;' +
    '    for (var c = 0; c < children.length; c++) {' +
    '      var ch = children[c];' +
    '      if (ch.nodeType === 1) {' +
    '        if (ch.tagName === "BR") { hasBr = true; }' +
    '        else if (!inline[ch.tagName]) { hasBlock = true; }' +
    '      }' +
    '    }' +
    '    if (!hasBr) continue;' +
    '    if (!hasBlock) {' +
    '      score(el.innerText);' +
    '    } else {' +
    '      var buf = "";' +
    '      for (var c2 = 0; c2 < children.length; c2++) {' +
    '        var n = children[c2];' +
    '        if (n.nodeType === 3) { buf += n.textContent; }' +
    '        else if (n.nodeType === 1 && n.tagName === "BR") { buf += "\\n"; }' +
    '        else if (n.nodeType === 1 && inline[n.tagName]) { buf += n.innerText || ""; }' +
    '        else {' +
    '          score(buf); buf = "";' +
    '        }' +
    '      }' +
    '      score(buf);' +
    '    }' +
    '  }' +
    '  var html = document.documentElement.outerHTML;' +
    '  window.__viboplr.send("lyrics-result", best ? {text: best, score: bestScore, words: best.split(/\\s+/).length, html: html} : {text: null, html: html});' +
    '})();';

  var scrapeHandle = null;

  function searchGoogle(query) {
    var searchUrl = "https://www.google.com/search?q=" + encodeURIComponent(query);
    var seq = ++lyrSearchSeq;
    var startedAt = Date.now();
    api.log("info", "lyrics search #" + seq + " q=\"" + query + "\"", "google-lyrics");

    if (scrapeHandle) {
      scrapeHandle.close().catch(console.error);
      scrapeHandle = null;
    }

    return api.network.openBrowseWindow(searchUrl, {
      visible: false,
      width: 800,
      height: 600,
    }).then(function (handle) {
      scrapeHandle = handle;

      return new Promise(function (resolve) {
        var settled = false;
        var pollTimer = null;
        var deadline = null;
        var sawCaptcha = false;

        function finish(urls) {
          if (settled) return;
          settled = true;
          if (pollTimer) clearInterval(pollTimer);
          if (deadline) clearTimeout(deadline);
          if (!sawCaptcha) {
            api.log("info",
              "lyrics search #" + seq + " → " + urls.length + " url(s) in " + (Date.now() - startedAt) + "ms",
              "google-lyrics");
          }
          resolve(urls);
        }

        handle.onMessage(function (msg) {
          if (msg.type === "search-results" && Array.isArray(msg.data)) {
            finish(msg.data);
          } else if (msg.type === "search-captcha" && !sawCaptcha) {
            sawCaptcha = true;
            var cseq = ++lyrCaptchaSeq;
            api.log("warn",
              "CAPTCHA on lyrics search #" + seq + " q=\"" + query + "\" · captcha #" + cseq
                + " of " + lyrSearchSeq + " lyrics searches this session (hidden — returned as no-results)",
              "google-lyrics");
            finish([]);
          }
        });

        pollTimer = setInterval(function () {
          handle.eval(GOOGLE_EXTRACT_SCRIPT).catch(function () {
            finish([]);
          });
        }, POLL_INTERVAL);

        deadline = setTimeout(function () {
          finish([]);
        }, SEARCH_TIMEOUT);
      });
    });
  }

  function scrapeLyrics(url) {
    if (!scrapeHandle) return Promise.resolve(null);

    return new Promise(function (resolve) {
      var settled = false;
      var pollTimer = null;
      var deadline = null;
      var unsub = null;

      function finish(result) {
        if (settled) return;
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        if (deadline) clearTimeout(deadline);
        if (unsub) unsub();
        resolve(result);
      }

      unsub = scrapeHandle.onMessage(function (msg) {
        if (msg.type === "lyrics-result") {
          finish(msg.data);
        }
      });

      var escaped = url.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      scrapeHandle.eval("window.location.href = '" + escaped + "'").catch(function () {
        finish(null);
      });

      setTimeout(function () {
        if (settled) return;
        pollTimer = setInterval(function () {
          if (settled) return;
          scrapeHandle.eval(LYRICS_EXTRACT_SCRIPT).catch(function () {});
        }, POLL_INTERVAL);
      }, SCRAPE_NAV_DELAY);

      deadline = setTimeout(function () {
        finish(null);
      }, SCRAPE_TIMEOUT);
    });
  }

  function closeScrapeWindow() {
    if (!scrapeHandle) return;
    scrapeHandle.close().catch(console.error);
    scrapeHandle = null;
  }

  function isPreferred(url) {
    var lower = url.toLowerCase();
    for (var i = 0; i < preferred.length; i++) {
      if (preferred[i] && lower.indexOf(preferred[i].toLowerCase()) !== -1) return true;
    }
    return false;
  }

  function filterResults(results) {
    var preferredList = [];
    var otherList = [];
    var seen = {};
    for (var i = 0; i < results.length; i++) {
      var url = results[i].split("#")[0];
      if (!url || seen[url] || isBlacklisted(url)) continue;
      seen[url] = true;
      var entry = { url: url, domain: domainFromUrl(url) };
      if (isPreferred(url)) {
        preferredList.push(entry);
      } else {
        otherList.push(entry);
      }
    }
    return preferredList.concat(otherList);
  }

  // --- Scrape & extract ---

  function fetchAndExtract(url, domain) {
    return scrapeLyrics(url).then(function (result) {
      if (!result || !result.text) {
        recordStat(domain, false);
        return null;
      }
      recordStat(domain, true);
      return result.text;
    }).catch(function (e) {
      recordStat(domain, false);
      throw e;
    });
  }

  // --- onFetch handler ---

  api.informationTypes.onFetch("lyrics", function (entity) {
    if (!entity.name || !entity.artistName) {
      return Promise.resolve({ status: "not_found" });
    }

    var query = buildQuery(entity.artistName, entity.name);

    return searchGoogle(query).then(function (results) {
      var candidates = filterResults(results);
      if (candidates.length === 0) {
        closeScrapeWindow();
        return { status: "not_found" };
      }

      function tryNext(index) {
        if (index >= candidates.length) {
          closeScrapeWindow();
          return { status: "not_found" };
        }
        var c = candidates[index];
        return fetchAndExtract(c.url, c.domain).then(function (text) {
          if (text) {
            closeScrapeWindow();
            return { status: "ok", value: { text: text, kind: "plain" } };
          }
          return tryNext(index + 1);
        }).catch(function (e) {
          console.error("Failed to scrape " + c.domain + ":", e);
          return tryNext(index + 1);
        });
      }

      return tryNext(0);
    }).catch(function (e) {
      console.error("Failed to search lyrics:", e);
      closeScrapeWindow();
      return { status: "error" };
    });
  });
}

return { activate: activate, deactivate: deactivate };
