# Bookcast — Project Guide for Claude

A truly serverless audiobook publisher. The user drops MP3s into a Google Drive
folder; a Google Apps Script project notices, generates an RSS podcast feed per
book, and exposes a subscription index page. Subscribers (the user + a few
trusted people) bookmark one URL and tap "Subscribe" per book.

**Status (2026-05-16): scaffolded, no logic written yet.** The Apps Script
project structure exists with stubbed JS files in `src/`. Each file has a
docstring + a comment pointing at the relevant DESIGN.md section. The next
session should write the actual logic, deploy the web app, and verify a feed
plays in Overcast.

Sister project (parked): `/home/will/source/shelfsync/` — the original
"build a custom audiobook player" design. Kept for reference.

## Read these first
- [DESIGN.md](./DESIGN.md) — architecture, Drive layout, state, web app routing, security

## Stack
- **Google Apps Script** (V8 runtime, JavaScript) — single platform for code execution, scheduling, Drive access, and HTTP serving. No B2, no GitHub Actions, no other vendors involved at runtime.
- **`clasp`** (Command Line Apps Script) — the local→Apps-Script sync tool. Install with `npm install -g @google/clasp`. Authenticate once with `clasp login`. Then `clasp push` / `clasp pull` / `clasp open`.
- **PropertiesService** for state. No database, no Drive-stored state file.
- **`XmlService`** for RSS XML generation. No external deps (Apps Script has no `npm install`).
- **No `package.json`, no node_modules at runtime.** If we ever add a build step (TypeScript, bundling) we can do it locally before `clasp push`, but v1 doesn't need it.

## Project conventions
- **Google account:** the Drive folder, the Apps Script project, the OAuth client (if you needed one), and the deployment all live under the same single Google account. Don't mix accounts — `clasp login`, the Drive folder owner, and the deploying user must all be the same identity, or you'll spend an afternoon debugging 403s. Personal accounts are usually a better choice than corporate Workspace accounts because the script runs with the deployer's full Drive scope.
- **Drive root folder ID:** intentionally not committed to this repo. Set it once at runtime via the Apps Script editor (see "Order of operations" step 7 in [README.md](./README.md#7-configure-the-root-folder-id)). It lives in Apps Script `PropertiesService` under key `ROOT_FOLDER_ID`. Treat it like any other URL secret — don't paste it into PR descriptions, issues, or chat.
- **The Drive folder is the source of truth, at every moment.** Top-level is the user's audiobook root. Subfolders = books. Audio files in a book folder = chapters, ordered by filename. Optional `metadata.json` per book folder; the cover is auto-detected (see below). See [DESIGN.md §3](./DESIGN.md).
- **Cover image discovery: largest image file wins.** The script picks the largest file in a book folder with MIME `image/jpeg` (then `image/png` as fallback) and treats it as the cover. No fixed filename is required — audiobook archives ship covers named after the book, and renaming every cover to `cover.jpg` is busywork the user shouldn't have to do.
- **Metadata auto-lookup via Open Library.** If a book folder has no `metadata.json`, the first cache miss triggers a lookup against `openlibrary.org/search.json` based on the cleaned folder name, fetches the work description, and writes the result back as `metadata.json` in the book folder. Subsequent scans then read the file directly. If the lookup fails, the script falls back to defaults and does NOT write a file (so the next scan retries). See [DESIGN.md §3a](./DESIGN.md).
- **Generation is lazy.** No triggers, no scheduled scans. A request to `/exec` reads Drive, renders the response, and caches it briefly via `CacheService`. A request to `/exec?feed=<book-id>` scans just that book's folder. See [DESIGN.md §5, §8](./DESIGN.md).
- **There is no persistent state about books or chapters.** `PropertiesService` holds exactly one value: `ROOT_FOLDER_ID`. Everything else is read from Drive on cache miss.
- **`CacheService` for rendered output**, ~10 minute TTL. Cache key `index` for the HTML page; cache key `feed:<book-id>` for each RSS feed. A `flushCache()` function lets the user force a re-scan after adding new content.
- **MP3 URLs in feeds are direct Drive URLs** of the form `https://drive.usercontent.google.com/download?id=<file-id>&export=download`. We do NOT proxy audio bytes through Apps Script (would blow `UrlFetch` quotas and is unnecessary).
- **Image URLs use `https://lh3.googleusercontent.com/d/<file-id>=s<size>`** for inline rendering (the `download` URL serves images with `Content-Disposition: attachment` and would force-download).
- **Sharing is "anyone with link" per file, never per folder.** When the script discovers an MP3 or cover during a scan, it calls `setSharing(ANYONE_WITH_LINK, VIEW)` on that file. It NEVER calls `setSharing` on a folder. See "Hard rules" below for why this distinction is load-bearing.
- **One Apps Script web app deployment URL is "the URL."** It serves the HTML index at `/exec` and an RSS feed at `/exec?feed=<book-folder-id>`. There is only ever one URL the user needs to remember; bookmark it once per phone.
- **Chapter identity = Drive file ID.** If the user deletes and re-uploads a chapter, the file ID changes and subscribers will see a new episode. This is acceptable; do not invent a separate UUID layer to "stabilise" this.

## Hard rules
- **Never apply `setSharing` to a folder.** Only to leaf files (MP3s and cover images). Why this matters: Drive treats "anyone with link" on a folder as "anyone with that URL can browse and download every file inside, recursively." A leaked folder URL would expose the entire library. A leaked file URL exposes one file. Keep all `setSharing` calls in `Drive.js` so this rule is auditable in one place.
- **The root folder stays private. There is no `gcloud`/`gws drive share` step in setup.** The Apps Script reads Drive under the deploying user's own credentials. It does not require — and must not be given — public access to the folder. If you find yourself reaching for a "share this folder" command during setup, stop: you've misunderstood the architecture.
- **The script's only writes to Drive are: (a) `setSharing` on leaf MP3/image files, and (b) creating `metadata.json` inside a book folder.** It never modifies an existing file, never deletes anything, and never touches anything outside the audiobook root. Code that does anything else in user Drive should not be merged.
- **Never log file IDs in `Logger`/Stackdriver output** — they are part of the URL secret. Log file *names* instead when debugging.
- **The repository must be private.** The source code reveals the architecture, and any inadvertent commit (deployment URL, folder ID, `.clasp.json`) would defeat obscurity. GitHub Free supports unlimited private repos.
- **Chapter detection keys off the file extension, not Drive's MIME type.** `AUDIO_EXT_MIME` in `Drive.js` is the single source of truth for both "is this a chapter" and "what `<enclosure type>` do we emit". Drive reports `.m4b` inconsistently (`audio/x-m4b`, `audio/mp4`, `video/mp4`, or `application/octet-stream` depending on upload path), so MIME-based detection silently drops files and the feed renders with zero episodes.
- **A whole-book `.m4b` should be split before upload, not accommodated in the feed.** `tools/split_m4b.py` explodes it into per-chapter files using the embedded chapter markers. One file per episode is the model; don't add chapter-marker parsing to the Apps Script (no ffmpeg, no binary parsing budget, and `UrlFetch` quotas rule out streaming the container).
- **Audio files must stay under ~100MB each.** Above that, Drive serves a virus-scan HTML interstitial instead of the file, which breaks podcast clients. Chapters bigger than this should be split before upload.
- **The cover image must be square JPG/PNG, ≥1400×1400.** Apple Podcasts requirement. Refuse to render a book card without one — easier to fix once than have broken art in subscribers' apps.

## Build & run
```
# One-time setup
npm install -g @google/clasp        # install clasp globally
clasp login                          # opens browser, authorises clasp
clasp create --type webapp --rootDir ./src --title bookcast   # creates the Apps Script project

# Develop
clasp push                           # uploads src/ to Apps Script
clasp open                           # opens the Apps Script web IDE

# Deploy (the "make the web app live" step)
clasp deploy --description "v0.1"    # prints the deployment URL — bookmark this
clasp deployments                    # list deployments

# Ship a CODE CHANGE to the live URL. `clasp push` alone is NOT enough: a web
# app deployment serves the code version it was pinned to at creation, so /exec
# keeps running old code while the editor (HEAD) runs the new code. Redeploy
# over the SAME deployment id to keep the URL stable; a bare `clasp deploy`
# makes a second deployment on a new URL and leaves the stale one live.
clasp push && clasp deploy -i <deploymentId> --description "v0.2"
```

The deployment URL is the index URL. It looks like
`https://script.google.com/macros/s/AKfycb<long-id>/exec`.

## Where things live
- `src/` — all JS + the `appsscript.json` manifest (clasp's `rootDir`)
- `src/Code.js` — `doGet()` web app entry + `refreshFromDrive()` trigger
- `src/Drive.js` — Drive folder walking + sharing + URL helpers + cover discovery
- `src/State.js` — PropertiesService wrappers
- `src/Metadata.js` — folder-name → title heuristics + Open Library lookup + `metadata.json` write-back
- `src/Feed.js` — RSS XML rendering
- `src/Index.js` — HTML index rendering
- `src/appsscript.json` — Apps Script manifest (scopes, runtime, webapp config)
- `.clasp.json` — local-only, gitignored, links this repo to a specific Apps Script project ID

## Order of operations on Day 1
1. Create a Drive folder for audiobooks (e.g. `Audiobooks/`) in your chosen Google account, and keep it private — do NOT link-share it (see Hard rules). Drop 1–2 short test books in it with the layout from DESIGN.md §3. A LibriVox public-domain audiobook is the easy test case. Note the folder's Drive ID (the long string in the URL when you open the folder in Drive) but do not commit it to this repo — pass it to the `setRootFolderId(...)` call in step 3 only. Cover image filename does not matter; the script picks the largest image in the folder. `metadata.json` is optional; if absent, the script will auto-populate it from Open Library on first scan.
2. Install clasp and create the Apps Script project (sign in with the right Google account when the browser opens):
   ```
   npm install -g @google/clasp
   clasp login                                                # opens browser — choose the right account
   clasp create --type webapp --rootDir ./src --title bookcast
   clasp push                                                 # uploads stubs to Apps Script
   ```
   Also enable the Apps Script API at https://script.google.com/home/usersettings for that account before `clasp create`, or it'll fail with an unhelpful error.
3. Fill in `src/State.js`: `getRootFolderId()` + `setRootFolderId()` via PropertiesService, plus the `CacheService` wrappers. Then in the Apps Script editor, run `setRootFolderId('<paste-folder-id-here>')` once to configure. (The actual folder ID is in Claude's project memory; never type it into a file that gets committed.)
4. Fill in `src/Drive.js`: folder listing, `ensureAnyoneWithLink`, largest-image-wins cover discovery, and the URL builders for audio + image. Smoke-test by calling `listBooks(getRootFolderId())` from the editor and inspecting the output.
5. Fill in `src/Metadata.js`: folder-name → title cleanup, Open Library search + work-record fetch, fallback handling, and the `metadata.json` write-back. Smoke-test on a book folder that has no `metadata.json` and confirm the file appears in Drive afterwards.
6. Fill in `src/Feed.js`: render one book's RSS XML using `XmlService`. Test by calling it on a real book; paste into [castfeedvalidator.com](https://castfeedvalidator.com/).
7. Fill in `src/Code.js#doGet`: route `?feed=<id>` to feed render, no params to index render. Wrap both with the cache lookup.
8. Fill in `src/Index.js`: HTML cards + the page's own QR code as inline SVG.
9. `clasp deploy --description "v0.1"` — prints the deployment URL. **This is the URL.** Open it on a desktop browser. Tap "Subscribe" on a book — confirm it opens in your default podcast app and plays.
10. Scan the page's QR code with your phone, tap the URL preview, bookmark, "Add to Home Screen" in Safari.
11. Push the source to a **private** GitHub repo.

## Decision log
- **2026-05-16** — Pivoted from B2 + GitHub Actions to Drive + Apps Script. Reason: chapters are nearly always <100MB so Drive's interstitial-on-big-files issue rarely bites for audiobooks, and a single-platform Google-native architecture is dramatically simpler than three vendors stitched together. Trade-off: Drive URL behaviour is what Google says it is — if they change it, the system breaks. Mitigation: if it ever does break, swap the audio URLs for a tiny Cloudflare Worker proxy in front of Drive; the rest of the codebase is unchanged.
- **2026-05-16** — State lives in `PropertiesService`, not git. Reason: in the Drive model, state is a derivable cache (rebuild from the Drive folder anytime). The "git as backup" benefit doesn't apply because there's nothing important to back up.
- **2026-05-16** — No separate per-chapter UUID layer. Reason: Drive file IDs are stable across renames/moves, so the UUID layer the B2 design needed is redundant here. If a user re-uploads a chapter (new file ID), they intend a new episode; that's correct behaviour.
- **2026-05-16** — Repository will be a **private** GitHub repo, not public. Reason: even without UUIDs in committed files, casual commits of `.clasp.json` / deployment URLs / folder IDs would defeat obscurity. No benefit to public; zero cost to private.
- **2026-05-16** — Index HTML page is v1, not post-v1. Reason: an unguessable URL is useless if no one will ever type it. The index page (bookmark once → one-tap subscribe per book) is what makes the project actually usable.
- **2026-05-16** — Fully lazy generation, no triggers. Reason: there's nothing useful to do in the background — every interesting moment is a request from a podcast client or the user. Generating only on request (with a brief `CacheService` cache) removes a whole class of complexity: no scheduled job to install, no persistent state to keep in sync with Drive, no stale-entry tracking, no "what if state and Drive disagree" edge cases. Drive is the source of truth at every moment.
- **2026-05-16** — Runs under a personal Google account, not a Workspace/corporate one. Reason: the script has the deploying user's full Drive scope at runtime; isolating it to a personal account avoids any accidental interaction with work data and keeps the blast radius small.
- **2026-05-16** — Cover discovery is "largest image file in the folder," not a fixed `cover.jpg` filename. Reason: audiobook archives (LibriVox, Audible rips, etc.) ship cover art named after the book; forcing every cover to be renamed to `cover.jpg` is gratuitous user friction with no architectural benefit. The "largest image" heuristic correctly picks the cover in every realistic case (MP3 folders don't contain other JPEGs).
- **2026-05-16** — Book metadata is auto-fetched from Open Library when `metadata.json` is absent, and the result is written back to the book folder. Reason: typing out metadata for every book is tedious, and Open Library has good coverage and free API access. Writing the result back as `metadata.json` means lookup runs at most once per book and the user can hand-edit any errors. Failure mode (no hits / network error) is non-destructive: no file is written, defaults are used for this render, the next scan retries.
- **2026-07-25** — Chapter detection moved from Drive MIME type to file extension, and the supported set widened beyond MP3 to m4a/m4b/mp4/aac/ogg/opus. Reason: a real `.m4b` upload was silently skipped (Drive typed it as something outside the MIME allowlist), producing a book card on the index page with an empty feed behind it and a "no episodes" error in the podcast app. Extension is what the user actually controls and what Drive can't get wrong. The same table drives the `<enclosure type>` attribute, which was previously hardcoded to `audio/mpeg`.
- **2026-07-25** — Whole-book `.m4b` files are handled by a local pre-upload split (`tools/split_m4b.py`), not by the Apps Script. Reason: Apps Script can't parse MP4 chapter atoms in any sane way, and even if it could, one 300MB enclosure trips Drive's virus-scan interstitial and gives subscribers no chapter navigation. Splitting on the container's own chapter markers is a 30-second local ffmpeg stream-copy and produces exactly the folder shape Bookcast already expects. Bonus: the same pass harvests the embedded cover art and tags into `metadata.json`, so the Open Library lookup never has to run.
- **2026-05-16** — Considered and rejected: making the Drive root folder publicly accessible. Reason: doing so would let anyone with the folder URL enumerate the whole library, which contradicts the entire security model (URL obscurity at the file level, never the folder level). The Apps Script reads Drive under the deploying user's own credentials and does not need the folder to be public.
