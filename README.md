# Viboplr — Google plugin

Lyrics and artwork from Google for [Viboplr](https://viboplr.com). This plugin is
the successor to the former built-in `google-lyrics` and `google-image-search`
plugins, merged into a single **Google** extension.

It contributes:

- **Lyrics** — a `lyrics` information type. Searches Google for `<artist> <title> <suffix>`,
  scrapes the best-scoring page from the results, and caches the text. Configurable
  search suffix, preferred/blocked domain lists, per-domain success statistics, and a
  step-by-step debugger.
- **Images** — artist / album / tag image providers backed by Google Images. Per-entity
  search suffixes, and an anti-captcha flow (one-time session warm-up, silent GDPR
  consent dismissal, and serialized/jittered searches) that only surfaces a browse
  window when Google shows a genuine reCAPTCHA. Includes a step-by-step debugger.

Both halves share a single settings panel with **Lyrics** and **Images** tabs.

Because it scrapes Google, both features are best treated as **last-resort fallbacks** —
in the app's provider ordering they sit below the dedicated lyrics (LRCLIB, Lyrics.ovh,
Genius) and artwork (TheAudioDB, Deezer, iTunes, MusicBrainz) providers.

## Install

Install from the Viboplr plugin gallery (Extensions view), or from this repo's latest
release zip.

## Layout

- `manifest.json` — plugin metadata and contributions.
- `index.js` — the plugin code (ES5, executed via `new Function("api", code)`).
- `test/` — a Node test harness (not shipped).
- `scripts/` — `bump.sh` (version + changelog) and `package.sh` (build `google.zip` + `update.json`).

## Development

```bash
node --check index.js   # syntax
node --test             # tests
```

## Releasing

See [RELEASING.md](./RELEASING.md). In short: `scripts/bump.sh <patch|minor|major>`,
fill in the changelog, commit, then push a `vX.Y.Z` tag — CI builds `google.zip` +
`update.json` and publishes the GitHub release.
