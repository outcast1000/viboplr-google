# Changelog

## v1.0.0
- Initial release. Merges the former **google-lyrics** and **google-image-search** built-in plugins into one **Google** plugin.
- **Lyrics** information type: searches Google for a track's lyrics and scrapes the best matching page, with preferred/blocked domain lists, a search-suffix setting, per-domain success stats, and a step-by-step debugger.
- **Image providers** for artist, album, and tag: pulls artwork from Google Images, with per-entity search suffixes, a warm-up + consent auto-dismiss + serialized-search anti-captcha flow (surfacing the window only for a genuine reCAPTCHA), and a step-by-step debugger.
- One combined settings panel with **Lyrics** / **Images** tabs.
