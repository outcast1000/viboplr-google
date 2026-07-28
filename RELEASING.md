# Releasing

The plugin is just `manifest.json` + `index.js`. A release publishes `google.zip`
(those two files, manifest at the zip root) plus `update.json` (the manifest the app
reads to check for updates).

## Steps

1. **Bump the version and stamp the changelog:**
   ```bash
   scripts/bump.sh patch      # or minor | major | X.Y.Z
   ```
   This rewrites `manifest.json` `version` and prepends a `## vX.Y.Z` section to
   `CHANGELOG.md`. Fill in the changelog TODO.

2. **Commit:**
   ```bash
   git add manifest.json CHANGELOG.md index.js
   git commit -m "Release vX.Y.Z"
   ```

3. **Tag and push** — CI (`.github/workflows/release.yml`) builds the artifacts and
   publishes the release:
   ```bash
   git push origin main
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

   Invariants enforced by CI: `manifest.json` `version` must equal the tag version,
   and `google.zip` must contain `manifest.json` at its root.

## Manual build (optional)

```bash
scripts/package.sh          # writes google.zip + update.json locally
```

The gallery (`outcast1000/viboplr-plugins`) resolves this plugin via its
`updateUrl` → `releases/latest/download/update.json`, so once a release is
published the app picks it up automatically; the gallery's reconcile bot keeps the
index entry's `version` / `minAppVersion` in sync.
