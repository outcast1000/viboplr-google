# Changelog

## v1.0.2
- **Diagnostics logging** for the captcha problem (behavior unchanged). Every Google search is now logged with a per-session counter, and every captcha wall is logged at `warn`:
  - Images (section `google-images`): session warm-up, each search (with the gap since the last load and any anti-burst throttle), GDPR consent auto-dismissals, captchas (`captcha #C of N searches`), and each search's outcome/timing.
  - Lyrics (section `google-lyrics`): each search and its result count/timing. Lyrics searches now also **detect** Google's `/sorry/` captcha wall (previously invisible — it looked like "no results") and log it, so you can see that the un-throttled lyrics half is what trains Google's abuse wall and drives the visible image-search captchas.


## v1.0.1
- Marked **experimental**: both features scrape Google, so they can break when Google changes its markup or shows a captcha. Treat them as last-resort fallbacks below the dedicated lyrics/artwork providers.

## v1.0.0
- Initial release. Merges the former **google-lyrics** and **google-image-search** built-in plugins into one **Google** plugin.
- **Lyrics** information type: searches Google for a track's lyrics and scrapes the best matching page, with preferred/blocked domain lists, a search-suffix setting, per-domain success stats, and a step-by-step debugger.
- **Image providers** for artist, album, and tag: pulls artwork from Google Images, with per-entity search suffixes, a warm-up + consent auto-dismiss + serialized-search anti-captcha flow (surfacing the window only for a genuine reCAPTCHA), and a step-by-step debugger.
- One combined settings panel with **Lyrics** / **Images** tabs.
