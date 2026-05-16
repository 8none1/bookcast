# Bookcast — Design

## 1. Goal

Listen to audiobooks I own, on any device I choose, in the podcast app I already
use, without writing or maintaining a custom player and without running
infrastructure of my own.

The whole system lives inside Google: Drive holds the MP3s, Apps Script
generates the feeds and serves them, both subscribers and triggers run on
Google's infrastructure. There is no GitHub Actions runner, no B2 account, no
VPS. The only piece outside Google is (optionally) a Cloudflare redirect to
give the index URL a memorable hostname.

## 2. Non-goals

- Not a public podcast platform. Feeds are at unguessable URLs.
- Not a multi-user system in the auth sense. Whoever has the URL can listen.
  Sharing scope is controlled socially.
- Not transcoding. The MP3s the user uploads are the MP3s subscribers get.
- Not real-time. A time-based trigger runs hourly; new books appear within an
  hour. (A Drive change trigger can shrink this to seconds later; v1 is cron.)
- Not authenticating subscribers. URL obscurity is the security model.

## 3. The Drive folder

The user maintains a single root folder. Anything under it is fair game.

```
Audiobooks/                            ← root_folder_id (configured once)
├── The Hitchhiker's Guide to the Galaxy/
│   ├── metadata.json                  ← optional, see below
│   ├── The Hitchhiker's Guide to the Galaxy.jpg   ← any image file; largest one wins
│   ├── 01 - Chapter One.mp3
│   ├── 02 - Chapter Two.mp3
│   └── ...
├── Wind in the Willows/
│   ├── wind-in-the-willows-cover.jpg
│   └── 01.mp3, 02.mp3, ...
```

- Top-level subfolders are books.
- MP3 files inside a book folder are chapters, ordered by filename (prefix with `01`, `02`, ...).
- **Cover image:** the largest image file (MIME `image/jpeg`, falling back to `image/png`) in the book folder is treated as the cover. No fixed filename — audiobook archives typically ship covers named after the book. If multiple images exist, the largest by file size wins. If none exists, the book renders with a placeholder and a warning is logged. Cover should still be ≥1400×1400 square for Apple Podcasts compliance, but the script does not enforce dimensions; it'll happily serve whatever is largest.
- **`metadata.json`** is optional. If absent on first scan, the script attempts an Open Library lookup (see §3a) and writes the result back as `metadata.json` in the book folder. If present (whether hand-written or auto-generated), it overrides all defaults and the lookup is skipped.

The root folder ID is stored in `PropertiesService` as `ROOT_FOLDER_ID`. It's set once via a tiny setup function or by hand in the Apps Script Properties UI.

`metadata.json` schema:
```json
{
  "title": "The Hitchhiker's Guide to the Galaxy",
  "author": "Douglas Adams",
  "narrator": "Stephen Fry",
  "year": 1979,
  "description": "Long-form description for the podcast listing.",
  "language": "en"
}
```

Fallbacks (only used if Open Library lookup also fails): title = folder name, author = "Unknown", description = "".

## 3a. Metadata auto-lookup (Open Library)

When a book folder has no `metadata.json`, the script attempts a one-shot lookup
against the Open Library Search API and writes the result back to the folder so
subsequent scans skip the lookup entirely.

Flow on cache miss for a book with no `metadata.json`:

1. Derive a probable title from the folder name: lowercase, strip parenthetical
   tags like `(Unabridged)`, `[Audiobook]`, trailing four-digit years, and
   collapse separator characters (`_`, `-`, multiple spaces). Optionally, if
   the name contains ` - `, treat the right side as a probable author hint.
2. `GET https://openlibrary.org/search.json?title=<title>[&author=<author>]&limit=1`
3. From the top hit (`docs[0]`), record `title`, `author_name[0]`,
   `first_publish_year`, `language[0]`, and the work key (`key`, e.g. `/works/OL12345W`).
4. `GET https://openlibrary.org/works/<work-key>.json` and extract `description`
   (which may be a string or `{value: "..."}`; handle both).
5. Build the `metadata.json` object and write it as a new file in the book
   folder. Do NOT overwrite an existing `metadata.json`.
6. Use the in-memory object for the current request; the file is there for next
   time.

On failure (network error, no hits, or a hit with no usable fields):

- Use the bare-bones fallbacks for the current render.
- Do NOT write `metadata.json` — leaving it absent means the next scan retries.
  This is deliberate: a one-shot failure shouldn't be cached as truth.

Quota and rate: Open Library is generous (no auth, no hard published rate
limit) and the lookups are tiny JSON responses, so the `UrlFetchApp` daily
quota (100 MB) and per-request budget are non-issues. The Apps Script
manifest must allowlist `openlibrary.org` under `urlFetchWhitelist`, or run
without a whitelist (Apps Script will warn but permit) — to be decided when
we wire it up.

The lookup adds ~500ms–1.5s to the first cache miss for a new book. Cached
output absorbs that for everyone after the first request.

This is the only path by which the script writes to the user's Drive aside
from `setSharing`. The script never modifies an existing file; it only
creates new `metadata.json` files inside book folders. See "Hard rules" in
CLAUDE.md.

## 4. Apps Script project structure

```
src/
├── appsscript.json    Apps Script manifest (scopes, runtime, web app config)
├── Code.js            doGet() entry + refreshFromDrive() trigger handler
├── Drive.js           Folder traversal, sharing, URL builders
├── State.js           PropertiesService wrappers
├── Metadata.js        Open Library lookup, folder-name → title heuristics
├── Feed.js            RSS XML rendering (uses XmlService)
└── Index.js           HTML index rendering + inline SVG QR code
```

Apps Script doesn't import files — every function in every `.js` file is in the
same global namespace at runtime. Keep names unambiguous (`Drive_listBooks`
rather than `listBooks`) if collisions appear; for v1 the surface is small
enough that plain names are fine.

## 5. State and caching

There is no persistent state about books or chapters. **Drive is the source of
truth at every moment.** The script reads from Drive when asked and caches the
*rendered output* (HTML or XML) for a few minutes so podcast-client polling
doesn't hammer Drive.

Two storage services in play:

**`PropertiesService.getScriptProperties()`** — persistent, used only for
configuration:
- `ROOT_FOLDER_ID` — the Drive folder ID the user designated as the audiobook
  root. Set once during setup.

**`CacheService.getScriptCache()`** — short-TTL cache of rendered responses:
- `index` → the HTML index page (TTL ~10 minutes)
- `feed:<book-folder-id>` → an RSS feed XML (TTL ~10 minutes)

Cache miss flow:
1. List the relevant Drive folders (root, or one book folder).
2. Apply `ANYONE_WITH_LINK` sharing to any leaf file that needs it (idempotent;
   no-op if already shared).
3. Render HTML or XML.
4. `cache.put(key, output, ttl)`.

A new book or chapter appears at most `ttl` seconds after upload — usually
sooner because podcast clients don't poll faster than this. Manual cache flush
is exposed as `flushCache()` in the Apps Script editor for when you want the
next request to re-scan immediately.

No "last seen" tracking. No reconciliation between state and Drive. No stale
entries. If a chapter is deleted from Drive, the next cache miss won't include
it; existing subscribers' podcast apps remove the old episode on next feed
refresh. This is correct behaviour.

## 6. Sharing model

Files in the audiobook folder are NOT shared by default — Drive's default is
private. The script makes leaf files (MP3s and cover images) "anyone with link"
on the first refresh that discovers them. The script never link-shares
folders. This is critical: a link-shared folder allows anyone with the URL to
enumerate its contents; a link-shared file does not.

Apps Script code: `DriveApp.getFileById(id).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW)`.

Idempotent: calling it on an already-shared file is a no-op. The script calls
it unconditionally on every refresh; cheaper than checking first.

## 7. The web app

One Apps Script web app deployment. URL pattern:
`https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`

`doGet(e)` routes by query string:

- No params → HTML index of all books.
- `?feed=<book-folder-id>` → RSS XML for one book.

Both responses are generated fresh from state on each request (state itself is
refreshed on the hourly trigger, not on every request, so this is cheap).

### Index HTML

- A QR code at the top encoding the page's own URL (for bootstrapping a new device — point any phone camera at it).
- One card per book:
  - Cover image (`<img src="https://lh3.googleusercontent.com/d/<cover-id>=s400">`)
  - Title, author
  - **Subscribe** button → `<a href="podcast://script.google.com/macros/s/<dep>/exec?feed=<book-id>">`. The `podcast://` scheme is registered by every major podcast app on iOS/Android.
  - **Copy URL** button (JS clipboard) for Apple Podcasts users — Apple has no one-tap subscribe scheme; users paste into "Follow a Show by URL".
- All CSS inline. No external HTTP requests except for the cover images. No
  JavaScript except the clipboard buttons; the page must work with JS disabled
  everywhere else.

### RSS XML

One `<channel>` per book. Each chapter is one `<item>` with an `<enclosure>`.
Required tags:

```xml
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>...</title>
    <description>...</description>
    <language>en</language>
    <itunes:author>...</itunes:author>
    <itunes:type>serial</itunes:type>                <!-- play in order -->
    <itunes:explicit>false</itunes:explicit>
    <itunes:image href="https://lh3.googleusercontent.com/d/<cover-id>=s1400"/>

    <item>
      <title>Chapter One</title>
      <enclosure url="https://drive.usercontent.google.com/download?id=<file-id>&amp;export=download"
                 length="..." type="audio/mpeg"/>
      <guid isPermaLink="false"><file-id></guid>
      <pubDate>...</pubDate>                          <!-- ch1 oldest -->
      <itunes:episode>1</itunes:episode>
      <itunes:episodeType>full</itunes:episodeType>
    </item>
  </channel>
</rss>
```

`pubDate` is a fixed base date (e.g. `2020-01-01T00:00:00Z`) + `ordinal × 60
seconds`, so chapter 1 is always the oldest by RSS rules. We don't track when
a book was first seen because state isn't persisted; using a hardcoded base is
fine because podcast apps care about *relative* ordering within a feed, not
absolute dates.

Use `XmlService.createElement(...)` to build the XML — never string-concatenate
attribute values into XML. The escaping bugs aren't worth the perceived
simplicity.

`<itunes:duration>` is omitted in v1 because reading MP3 duration in Apps
Script is painful (no native lib, ID3 tags don't always include duration).
Podcast apps compute duration on first play; it's not a regression.

## 8. Request flow

There is no background work. Every action happens inside a `doGet()` invocation.

**Index request** (`/exec`):
```
1. cached = CacheService.get('index')
2. if cached: return cached
3. folders = list subfolders of ROOT_FOLDER_ID
4. for each folder:
     - find the largest image file (image/jpeg, then image/png),
       ensureAnyoneWithLink(cover)
     - if metadata.json is present, parse it
       else attempt Open Library lookup; on success, write metadata.json back
       to the folder; on failure, use defaults
     - record book id, title, author, cover-url
5. html = renderIndex(books)
6. CacheService.put('index', html, 600)
7. return html
```

**Feed request** (`/exec?feed=<book-id>`):
```
1. cached = CacheService.get('feed:' + bookId)
2. if cached: return cached
3. chapters = list MP3 children of <book-id> folder, sorted by filename
4. for each chapter:
     - ensureAnyoneWithLink(chapter)
     - record file id, name, size
5. cover, metadata = read from the same folder as above
   (same lookup-and-persist logic as the index request)
6. xml = renderFeed(book, chapters)
7. CacheService.put('feed:' + bookId, xml, 600)
8. return xml
```

That's the entire system. No trigger, no scheduled scan, no state to keep in
sync. The first request to a feed after a cache miss does ~10 Drive API calls
and takes 1–3 seconds; subsequent cache hits are ~100ms.

For manual control: a `flushCache()` function (run from the Apps Script editor)
clears all cache entries so the next request re-scans Drive. Useful immediately
after adding a new book.

## 9. URLs

- **Index URL** (one URL the user needs to remember):
  `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`
- **Per-book feed URL** (rarely shared directly; the index handles linking):
  `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec?feed=<book-folder-id>`
- **MP3 URL** (appears in the RSS feed, fetched by podcast clients):
  `https://drive.usercontent.google.com/download?id=<chapter-file-id>&export=download`
- **Cover image URL** (appears in RSS + HTML index):
  `https://lh3.googleusercontent.com/d/<cover-file-id>=s<size>`

### Optional: vanity redirect

Point a memorable hostname at the index URL via Cloudflare Rules (free):

`bookcast.yourdomain.com` → 301 → `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`

The Cloudflare rule has no logic, no caching of the contents — it's a
redirect. The destination URL is still cryptic; the rule just adds a friendly
front door. Cost: free if you already have a domain on Cloudflare.

## 10. Security model

- URL obscurity. The `DEPLOYMENT_ID` is the index secret. Drive file IDs are
  the per-file secret. Both are unguessable.
- Sharing is per-file, not per-folder. A leaked MP3 URL leaks one chapter; the
  rest of the library is unaffected (URLs share no prefix structure beyond the
  domain).
- The Drive root folder is never link-shared. Only leaf files. The Apps Script
  reads the folder under the deploying user's own Drive access — it does not
  require the folder to be public, and the folder MUST remain private.
- Apps Script web app deployment access: `ANYONE_ANONYMOUS`. This is required
  for podcast clients to fetch the feed without auth. The deployment URL's
  unguessability provides the access control.
- The script runs as `USER_DEPLOYING` (the user's Google account). Drive
  reads/writes happen with the user's full Drive access — keep this in mind
  if you ever add code that does anything outside the audiobook folder.

Threat model in plain English: we protect against random discovery and casual
crawling. We do NOT protect against a determined attacker who already has a
URL. If you wouldn't share a particular audiobook with the people you'd share
the index URL with, host it elsewhere.

Rotation: if the index URL leaks, redeploy the script (gives a new
`DEPLOYMENT_ID`). The old URL stops working. Existing subscribers need the new
URL; existing per-chapter MP3 URLs in their downloaded queue continue to work
until they re-fetch the feed.

## 11. Apps Script quotas

The relevant ones for personal use:

| Quota | Limit (consumer) | Our usage |
|---|---|---|
| Web app execution time per request | 30 s | Cache hit ~100ms; cache miss 1–3 s |
| Web app simultaneous executions | 30 | Trivially fine |
| Drive API reads / day | ~unmetered for normal use | A handful per cache miss; cached most of the time |
| `UrlFetchApp` data / day | 100 MB | Tiny JSON requests to Open Library on first scan per book, then never again |
| PropertiesService size | 500 KB | Just one key (`ROOT_FOLDER_ID`) |
| CacheService value size | 100 KB | RSS feeds well under that; index might approach it for 50+ books |

Apps Script web apps' own bandwidth (i.e. what `doGet` returns) has no
documented per-day cap for free use. MP3 bytes are served by Drive, not by
us, so they don't count against Apps Script quotas at all.

## 11a. Known limitations

Discovered while validating v0.x:

- **HEAD requests return 403.** Apps Script web apps only support GET (via
  `doGet`) and POST (via `doPost`). There is no `doHead` hook. The Google
  frontend rejects HEAD with 403 regardless of what the script does.
  Consequence: Apple Podcasts, which performs a HEAD probe before subscribing,
  refuses these feeds. Overcast, Pocket Casts, Castro, AntennaPod all tolerate
  it. Fix-when-needed: a ~10-line Cloudflare Worker in front that synthesises
  HEAD responses and proxies GETs through.
- **`MimeType.RSS` does not stick.** Setting
  `ContentService.MimeType.RSS` should produce `application/rss+xml` but the
  final response served (after Apps Script's internal redirect to
  `script.googleusercontent.com`) reports `text/plain; charset=utf-8`. Strict
  validators (e.g. castfeedvalidator, Apple Podcasts validator) flag this.
  Same Cloudflare-Worker workaround would also rewrite the Content-Type.
- **Workspace-domain accounts inject `/a/<domain>/` into the deployment URL.**
  `ScriptApp.getService().getUrl()` returns the domain-prefixed form, which
  requires the visitor to be authenticated to that Workspace domain. Strip it
  in `getDeploymentUrl()` to get the bare form that ANYONE_ANONYMOUS access
  expects. Already fixed; documented here so we don't put it back.
- **First-ever request per book is slow (~15-30s).** `setSharing` must be
  called on every chapter file the first time the script discovers them.
  Mitigated by `ensureChaptersShared` which tracks per-folder "last fully
  shared at" timestamp in `PropertiesService`; subsequent cache misses skip
  the per-file checks entirely as long as the folder hasn't been modified.
  Run `prewarmAll()` from the editor after adding new books to absorb the
  cost before any podcast client polls.
- **Audible-style chapter filenames sometimes include cumulative-prefix
  titles** (e.g. "...Episode One_ The Sudan_ Episode Two_ Beijing"). Our
  cleanup strips the book title + ASIN prefix correctly but the per-chapter
  cumulative concatenation is genuine in the source data — we'd need either a
  smarter heuristic or user-supplied chapter names to fix it. Not a code bug.

## 12. Open questions

- If the index ever grows past `CacheService`'s 100 KB per-value limit
  (~50+ books), shard the cache: `index-page-1`, `index-page-2`, or render
  on demand without caching the full HTML.
- Multiple curated indexes (e.g., a `family-friendly` page that excludes some
  books). Defer.
- `itunes:duration` backfill — would require an MP3 metadata parser in Apps
  Script. Acceptable to skip; podcast apps compute it on first play.
- Failure-mode handling if Drive ever changes its public-download URL format.
  Mitigation: keep all URL builders in `Drive.js` so they're in one place;
  if formats change, only one file needs updating.
- Migration path to B2 if Drive URLs prove unreliable: change the URL builders
  to point at a B2 bucket; add an upload step that mirrors new files into B2
  on first scan. The rest of the codebase is unchanged. About a day's work.
