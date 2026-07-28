"use strict";
// Runtime smoke test for the merged Google plugin. Loads index.js exactly the
// way the host does (new Function("api", code)) against a mock api, then checks
// that both halves register and that the single settings panel composes the two
// tabbed sub-panels correctly.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function loadPlugin() {
  const code = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  // eslint-disable-next-line no-new-func
  const factory = new Function("api", code);
  return factory;
}

function makeMockApi() {
  const actions = {};
  const imageFetch = {};
  const infoFetch = {};
  const store = {};
  let lastView = null;
  const api = {
    appVersion: "1.0.4",
    log() {},
    ui: {
      setViewData(viewId, data) { lastView = { viewId, data }; },
      onAction(id, handler) { actions[id] = handler; },
      showNotification() {},
      navigateToView() {},
    },
    storage: {
      get(key) { return Promise.resolve(store[key]); },
      set(key, value) { store[key] = value; return Promise.resolve(); },
      delete(key) { delete store[key]; return Promise.resolve(); },
    },
    imageProviders: { onFetch(entity, handler) { imageFetch[entity] = handler; } },
    informationTypes: { onFetch(id, handler) { infoFetch[id] = handler; } },
    network: {
      openBrowseWindow() { return Promise.resolve({ onMessage() { return function () {}; }, eval() { return Promise.resolve(); }, close() { return Promise.resolve(); }, show() { return Promise.resolve(); } }); },
    },
  };
  return { api, actions, imageFetch, infoFetch, get lastView() { return lastView; } };
}

const flush = () => new Promise((r) => setTimeout(r, 30));

test("exports activate + deactivate", () => {
  const plugin = loadPlugin()(makeMockApi().api);
  assert.strictEqual(typeof plugin.activate, "function");
  assert.strictEqual(typeof plugin.deactivate, "function");
});

test("registers both halves' providers + the tab switcher", async () => {
  const m = makeMockApi();
  loadPlugin()(m.api).activate(m.api);
  await flush();

  // Image providers for all three entities.
  assert.ok(m.imageFetch.artist && m.imageFetch.album && m.imageFetch.tag, "image providers registered");
  // Lyrics information type.
  assert.ok(m.infoFetch.lyrics, "lyrics info type registered");
  // Combined settings panel + tab switcher.
  assert.ok(m.actions["google-switch-tab"], "tab switcher registered");
  assert.strictEqual(m.lastView.viewId, "google-settings", "renders into the single merged panel");
});

test("panel composes tabs and swaps body on tab switch", async () => {
  const m = makeMockApi();
  loadPlugin()(m.api).activate(m.api);
  await flush();

  const first = m.lastView.data;
  assert.strictEqual(first.type, "layout");
  const tabs = first.children[0];
  assert.strictEqual(tabs.type, "tabs");
  assert.deepStrictEqual(tabs.tabs.map((t) => t.id), ["lyrics", "images"]);
  assert.strictEqual(tabs.activeTab, "lyrics");

  // Body under the "lyrics" tab must be the lyrics sub-panel (has the debugger /
  // "Search Keywords" sections), not the images one.
  const lyricsBody = JSON.stringify(first.children[first.children.length - 1]);
  assert.ok(/Search Keywords|Step-by-Step Debugger/.test(lyricsBody), "lyrics body present");

  // Switch to Images.
  m.actions["google-switch-tab"]({ tabId: "images" });
  await flush();
  const second = m.lastView.data;
  assert.strictEqual(second.children[0].activeTab, "images");
  const imagesBody = JSON.stringify(second.children[second.children.length - 1]);
  assert.ok(/Search Suffixes/.test(imagesBody), "images body present after switch");
});

test("manifest is valid and declares the merged contributions", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  assert.strictEqual(manifest.id, "google");
  assert.ok(manifest.contributes.informationTypes.some((t) => t.id === "lyrics"), "lyrics info type");
  const entities = manifest.contributes.imageProviders.map((p) => p.entity).sort();
  assert.deepStrictEqual(entities, ["album", "artist", "tag"]);
  assert.strictEqual(manifest.contributes.settingsPanel.id, "google-settings");
});
