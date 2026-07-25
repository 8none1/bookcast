# Bookcast

A truly serverless audiobook publisher built entirely on Google Apps Script and Google Drive.

Drop audiobook MP3s into a Drive folder. Bookcast turns each top-level subfolder into a podcast feed and serves an index page that links to all your books. You bookmark the index on your phone, tap **Subscribe** in your podcast app of choice, and listen the same way you listen to any other podcast.

There is no server to maintain, no database, no CI/CD pipeline, no third-party hosting. Everything runs inside Google's infrastructure. The entire system is a few hundred lines of JavaScript executed lazily on each request to a single Apps Script web app.

For the architecture and design rationale see [DESIGN.md](./DESIGN.md). This README is the practical "how do I get this running on my own Drive" guide.

> 🤖 **Using an AI coding assistant** (Claude Code, Cursor, GitHub Copilot Workspace, etc.)? Hand it [SETUP_WITH_CLAUDE.md](./SETUP_WITH_CLAUDE.md) instead — that file is written as a playbook the assistant can execute against your environment, walking you through every step interactively and running the commands for you where it can.

## What you get

- A single URL that lists every book in your Drive folder, with cover art, title, author, and a short description.
- One **Subscribe** button per book, with dedicated buttons for Overcast and Pocket Casts plus a generic `podcast://` link and a Copy URL fallback for Apple Podcasts.
- A QR code on the index page so you can set up another device by pointing a phone camera at it.
- Per-book RSS feeds that work in every major podcast client (Overcast, Pocket Casts, Castro, AntennaPod, etc.).
- Auto-fetched metadata: if a book folder has no `metadata.json`, Bookcast looks up the title in Open Library, pulls a description and author, and writes the result back to your Drive folder so you can hand-edit it if it got something wrong.

## What it deliberately isn't

- A public podcast platform. Feeds live at unguessable URLs. Sharing scope is controlled socially — give the URL only to people you'd lend the audiobooks to.
- A subscriber auth system. Anyone with the URL can listen.
- A transcoder. Whatever MP3s you upload are what subscribers get.
- Compatible with Apple Podcasts validators (see [Known limitations](#known-limitations)). It works in every other major podcast app.

## Prerequisites

You will need:

- A Google account (personal Gmail account, Workspace account, or both — see notes below).
- A modern web browser (for the Google Cloud Console and Apps Script editor steps).
- A local machine with:
  - **Node.js 18+** and **npm** (for installing `clasp`).
  - **git** (for cloning this repo).
  - **gcloud CLI** ([install instructions](https://cloud.google.com/sdk/docs/install)) — strictly optional but makes the GCP project creation step a single command instead of clicking through the web console.
- Some audiobook MP3s to publish. Each book is a folder of MP3 chapter files; see [Drive folder layout](#drive-folder-layout).

### A note on accounts

The Apps Script project runs **as the user who deploys it**, with that user's full Drive access. Pick a Google account you're comfortable giving a personal-use script broad read/write access to your Drive. Best practice is to use a personal account, not a corporate Workspace account, so you don't accidentally grant the script visibility into work data.

If your Google account is enrolled in **Google's Advanced Protection Program**, the standard `clasp login` flow will be blocked — you'll need to create your own OAuth client. See [Auth troubleshooting](#auth-troubleshooting) below; it's a few extra clicks.

## Drive folder layout

Bookcast treats one Drive folder as the audiobook root. Inside it:

```
Audiobooks/                            ← the "root folder"
├── The Hitchhiker's Guide to the Galaxy/
│   ├── metadata.json                  ← optional; auto-fetched if absent
│   ├── Hitchhikers Guide cover.jpg    ← any image file; the largest wins
│   ├── 01 - Chapter One.mp3
│   ├── 02 - Chapter Two.mp3
│   └── ...
├── Wind in the Willows/
│   ├── wind-in-the-willows.jpg
│   ├── 01.mp3
│   ├── 02.mp3
│   └── ...
```

Rules:

- **Top-level subfolders are books.** The folder name becomes the default book title.
- **Audio files inside a book folder are chapters.** Recognised extensions: `.mp3`, `.m4a`, `.m4b`, `.mp4`, `.aac`, `.ogg`, `.opus`. They're ordered by filename — prefix with `01`, `02`, ... to guarantee the order. A stray `1.mp3` next to `10.mp3` will mis-sort lexically.
- **Each chapter should be under ~100 MB.** Above that, Drive serves a virus-scan interstitial that breaks podcast clients. Split larger files before upload.
- **A single whole-book `.m4b` is not a good fit.** It's one episode with no chapter navigation, and it will almost certainly be over the 100 MB line. Run it through [`tools/split_m4b.py`](#splitting-an-m4b-audiobook) first.
- **Cover image:** drop any JPG (or PNG) into the folder. Bookcast picks the largest image file (preferring JPEG over PNG) and serves it as the cover at 1400×1400 — the Apple-Podcasts-recommended size. The cover should ideally be a square ≥1400×1400.
- **`metadata.json`** is optional. If absent, Bookcast searches Open Library by the folder name on the first request, writes the resulting JSON into the book folder, and uses it from then on. If you don't like what Open Library returned, edit the file by hand.

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

### Splitting an .m4b audiobook

Most audiobook downloads are a single `.m4b`: one MP4 container holding the whole book plus chapter markers. Bookcast's model is one file per episode, so an unsplit `.m4b` gives you a single multi-hour episode that's too big for Drive to serve. `tools/split_m4b.py` turns it into a ready-to-upload book folder:

```bash
tools/split_m4b.py "This Way Up.m4b" -o ~/audiobooks
```

It reads the embedded chapter markers, stream-copies each chapter into its own `.m4a` (no re-encode, so it's fast and lossless), zero-pads the filenames so they sort correctly, extracts the embedded cover art, and writes a `metadata.json` from the container tags so Bookcast skips the Open Library lookup. Pass `--mp3` if you'd rather transcode for maximum client compatibility, and `--bitrate` to control the result.

The book folder is named from the container's own title tag, plus the Audible ASIN in square brackets where the file has one — downloaded filenames are frequently mangled (duplicated subtitles, colons replaced with underscores) while the embedded tags are what the publisher actually wrote. Use `--name` to override. Bookcast's Open Library fallback strips bracketed text, so the ASIN never interferes with a metadata lookup.

Requires `ffmpeg` and `ffprobe` on your PATH. If the file has no chapter markers, the script tells you how to split it into fixed-length parts instead. Upload the resulting folder into your Drive root, then run `flushCache()`.

## Setup

These instructions assume you've cloned this repo and have a shell open in the project directory.

```bash
git clone https://github.com/<your-fork-or-this-repo>.git bookcast
cd bookcast
```

### 1. Create the audiobook root folder in Drive

In your browser, signed into the Google account you'll use for Bookcast:

1. Open https://drive.google.com.
2. Create a new folder (call it whatever you like — `Audiobooks`, `Books`, etc.).
3. **Do not share it.** Leave it private. Bookcast's security model relies on per-file link sharing applied to individual MP3s, not folder sharing. A link-shared folder would let anyone with the URL enumerate the entire library.
4. Drop in 1–2 books for your first test. [LibriVox](https://librivox.org/) is the easy public-domain source — pick something short with few chapters so the first feed test is quick.
5. Note the folder's Drive ID — it's the long string in the URL when you open the folder (`https://drive.google.com/drive/folders/<THIS_PART>`). You'll need it later. **Don't commit it to git.** Bookcast keeps it in `PropertiesService` at runtime, not in source.

### 2. Create a Google Cloud project

Bookcast needs its own GCP project to host the OAuth client `clasp` will use. The Apps Script API also needs to be enabled on it.

With `gcloud` CLI installed:

```bash
gcloud auth login                              # if not already authenticated
PROJECT_ID=bookcast-$(date +%Y%m%d)            # any unique ID works
gcloud projects create "$PROJECT_ID" --name=bookcast
gcloud config set project "$PROJECT_ID"
gcloud services enable script.googleapis.com drive.googleapis.com --project="$PROJECT_ID"
gcloud auth application-default set-quota-project "$PROJECT_ID"
```

If you don't have `gcloud`, do the equivalent via the [Cloud Console](https://console.cloud.google.com/):

1. Create a new project (any name).
2. Open **APIs & Services → Library** and enable **Apps Script API** and **Google Drive API**.

### 3. Enable the user-level Apps Script API

Apps Script has a per-user toggle that gates third-party API access. Open https://script.google.com/home/usersettings (signed in as the same account) and set **Google Apps Script API** to **On**.

### 4. Create an OAuth client for clasp

> Skip this step and just run `clasp login` instead if your account is **not** in Advanced Protection or a similarly restrictive Workspace. The bundled clasp OAuth client works for most accounts. Come back here only if `clasp login` is blocked.

In the Cloud Console for the project you created above:

1. Go to **APIs & Services → OAuth consent screen**.
   - User type: **External**.
   - App name: `bookcast` (or anything you like).
   - User support email + developer contact: your email.
   - Save and continue → skip the Scopes page → on **Test users**, add your own email → Save and Continue.
   - Leave publishing status as **Testing**. You don't need to publish.
2. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   - Application type: **Desktop app**.
   - Name: `bookcast clasp` (or anything).
   - Click **Create**, then **Download JSON** on the resulting dialog.
3. Save the downloaded file as `clasp-oauth.json` in this repo's root. It's already gitignored so it won't be committed.

### 5. Install clasp and log in

```bash
npm install -g @google/clasp
```

If you skipped step 4 (no Advanced Protection):

```bash
clasp login
```

If you did step 4 (custom OAuth client):

```bash
clasp login --creds clasp-oauth.json
```

In both cases a browser opens. Sign in as the Google account that owns the Drive folder. If you used the custom OAuth client, you'll see an "unverified app" warning — that's because you (the developer) haven't gone through Google's app verification. Click **Advanced** → **Go to bookcast (unsafe)** → **Allow**. You're trusting an app you yourself created.

Verify:

```bash
clasp show-authorized-user
# → "You are logged in as <your-email>"
```

### 6. Create the Apps Script project and push the code

From this repo's root:

```bash
clasp create-script --type standalone --rootDir ./src --title bookcast
clasp push --force
```

The first command creates a new Apps Script project bound to `./src`, writes `.clasp.json` (gitignored) with the project's script ID, and uploads the manifest. The second uploads all the source files. `--force` accepts the manifest change without prompting (clasp 3.x asks for confirmation otherwise and the prompt doesn't work in non-interactive shells).

### 7. Configure the root folder ID

This is the only piece of setup that requires the Apps Script editor. The folder ID is intentionally **not** stored in source — it lives only in your script's `PropertiesService`.

Create a local-only file `src/Local.js` (already gitignored) with your folder ID:

```javascript
// src/Local.js — pushed via clasp, never committed to git.
function setupOnce() {
  const id = setRootFolderId('PASTE_YOUR_DRIVE_FOLDER_ID_HERE');
  Logger.log('ROOT_FOLDER_ID set to: ' + id);
  Logger.log('Now run runDiagnostics() to verify Drive access.');
}
```

Push it:

```bash
clasp push
```

Open the editor:

```bash
clasp open-script
```

(Or visit `https://script.google.com/d/<scriptId>/edit` — the script ID is in `.clasp.json`.)

In the editor:

1. Open `Local.gs` from the sidebar.
2. In the toolbar at the top, set the function dropdown to **`setupOnce`** and click **Run** (▶).
3. The first run prompts for authorization. Click **Review permissions** → choose your account → **Advanced** → **Go to bookcast (unsafe)** → **Allow** for the requested scopes (Drive, external requests, ScriptApp).
4. The execution log at the bottom should show `ROOT_FOLDER_ID set to: ...`.
5. Switch the dropdown to **`runDiagnostics`** and Run. You should see a list of your books with chapter counts and detected covers, e.g.:

   ```
   Top-level book folder count: 2
     - The Hitchhiker's Guide to the Galaxy | chapters: 12 | cover: cover.jpg | metadata.json: absent
     - Wind in the Willows | chapters: 17 | cover: cover.jpg | metadata.json: absent
   ```

If `runDiagnostics` shows the right books with sensible chapter counts and covers, you're ready to deploy.

### 8. Deploy

```bash
clasp deploy --description "v0.1"
```

This prints a deployment ID. The actual URL is:

```
https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec
```

**Save this URL somewhere private** — your password manager is the right place. It's the index URL for your library, and its unguessability is the entire security model. Don't paste it into PR descriptions, screenshots, or chat with anyone you wouldn't lend the books to.

### 9. First load + cache warm

The very first time each feed is requested, Bookcast has to call Drive's `setSharing` on every chapter file (~300ms each). For a 30-chapter book that's ~10 seconds. After that, the share state is cached in `PropertiesService` and never re-checked unless the folder is modified.

You can absorb this cost up front by running `prewarmAll` from the editor: function dropdown → **prewarmAll** → Run. It'll iterate all books, share all chapters, and populate the feed-XML cache. After this, podcast clients hit warm caches and get fast responses.

### 10. Use it

- Open the deployment URL in a desktop browser. Confirm the index page lists your books with cover art.
- On your phone, open the same URL. Tap **Open in Overcast** (or whichever podcast app you use) — the feed loads in your podcast app and you can listen.
- Bookmark the index URL or use Safari's "Add to Home Screen" so it's one tap away from your phone's home screen.
- Scan the QR code at the top of the page to set up additional devices without typing the URL.

## Updating the code later

**`clasp push` does not update your live URL.** A web app deployment is pinned to the code version that existed when it was created; pushing only updates the editor's HEAD. Symptom: `runDiagnostics()` in the editor behaves correctly (it runs HEAD) while `/exec` keeps serving the old behaviour. Redeploy over the *same* deployment ID:

```bash
clasp push
clasp deployments                                     # find the ID — it's the AKfycb... in your URL
clasp deploy -i <deploymentId> --description "v0.2"   # same URL, new code
```

Redeploying to the same ID keeps the URL identical, so subscribers are unaffected. A bare `clasp deploy` with no `-i` creates a *second* deployment on a *new* URL and leaves the old one live and stale — almost never what you want.

Then run `flushCache()`, or the previous response stays cached for up to 10 minutes and it'll look like the redeploy failed.

## Adding books later

1. Create a new subfolder in your Drive root folder.
2. Drop MP3 chapters in (sortable filenames: `01 - ...`, `02 - ...`).
3. Drop in a cover image.
4. *(Optional)* Add a `metadata.json` — otherwise Bookcast auto-fetches one from Open Library on the next request.
5. From the Apps Script editor, run **`flushCache`** so the next index render picks up the new book immediately. (Without this, the index will show the new book within 10 minutes when the cache TTL expires.)
6. *(Optional but recommended)* Run **`prewarmAll`** to absorb the per-chapter sharing cost up front.

## Editor utilities

These functions live in `Code.gs` and `Drive.gs` and are intended to be run from the Apps Script editor.

Two editor quirks worth knowing before you go looking for them: the IDE does **not** reload after a `clasp push`, so refresh the browser tab first or you'll be looking at stale files; and the **Run dropdown only lists functions from the file currently open** in the editor, so select `Drive.gs` in the file list before hunting for `flushSharedState()`.

| Function | What it does |
|---|---|
| `setupOnce()` (in your local-only `Local.gs`) | Sets `ROOT_FOLDER_ID` in `PropertiesService`. Run once at setup. |
| `runDiagnostics()` | Lists detected books with chapter counts, covers, and metadata.json status. Useful for verifying setup before deploying. |
| `flushCache()` | Wipes the rendered HTML/XML cache. Use after adding new books or fixing a `metadata.json`. |
| `flushSharedState()` | Wipes the per-folder "files have been shared" state. Use if you manually changed Drive sharing on chapter files outside Bookcast and want it re-checked. |
| `prewarmAll()` | Hits the index + every feed once, populating caches and applying sharing to all new files. Run after adding books to make first podcast-client polls instant. |

## Auth troubleshooting

**`clasp login` shows "blocked by Advanced Protection"** — Your Google account is enrolled in Google's Advanced Protection Program (or a Workspace admin has applied similar restrictions). APP refuses to grant scopes to most third-party OAuth clients, including clasp's bundled one. The fix is step 4 above: create your own OAuth client in your own GCP project and use `clasp login --creds clasp-oauth.json`. APP allows OAuth clients you own.

**`clasp create-script` fails with "Apps Script API not enabled"** — You missed step 3 above. Toggle the API on at https://script.google.com/home/usersettings and wait ~30 seconds for the change to propagate, then retry.

**`clasp push` exits with "Skipping push."** — You changed `appsscript.json`. clasp 3.x asks for confirmation before pushing manifest changes; in non-interactive shells, the prompt auto-answers no. Use `clasp push --force` to push anyway.

**The deployment URL returns 403 to anonymous fetches** — The Apps Script manifest's `webapp.access` setting is wrong. Check `src/appsscript.json` includes:

```json
"webapp": { "executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS" }
```

…then `clasp push --force` and `clasp redeploy <deploymentId> --description "fix webapp config"`.

**Feed URLs contain `/a/<domain>/macros/...`** — Workspace-domain accounts get a domain-prefixed URL from `ScriptApp.getService().getUrl()`, which requires the visitor to be authenticated to the Workspace domain. Bookcast strips it; if you see it in your feed XML, make sure you're running the current `Code.gs` (search for `getDeploymentUrl` and confirm the `.replace(/\/a\/[^/]+\/macros\//, ...)` is there).

**The book shows on the index page but my podcast app says "no episodes"** — the folder contains no file Bookcast recognises as audio. Run `runDiagnostics()` in the Apps Script editor; it logs a chapter count per book and warns when a folder has none. The usual cause is a single `.m4b` (see [Splitting an .m4b audiobook](#splitting-an-m4b-audiobook)) or an archive that was never unpacked. Remember to `flushCache()` after fixing it, otherwise you'll keep getting the cached empty feed for up to 10 minutes.

**Episodes appear in the feed but won't download / play** — fetch one of the enclosure URLs with `curl -sSL '<url>' | file -`. If it says `HTML document` rather than audio, the chapter files aren't link-shared and Drive is serving a sign-in page. Run `flushSharedState()` then `prewarmAll()` from the editor. Bookcast tracks a per-folder "fully shared at" timestamp to avoid re-checking every file on every request, and anything that unshares files behind its back (or any older build that didn't recognise those files as audio) leaves that timestamp lying.

**Subscribe button on iPhone opens Apple Podcasts even though I use Overcast** — `podcast://` is iOS's default scheme for Apple Podcasts. Use the orange **Open in Overcast** button instead, which uses Overcast's `overcast://x-callback-url/add?url=...` scheme.

## Known limitations

See [DESIGN.md §11a](./DESIGN.md#11a-known-limitations) for the full list. The two that matter:

- **HEAD requests return 403.** Apple Podcasts' validator performs a HEAD probe and refuses to subscribe to feeds that don't support it. Apps Script web apps don't expose a HEAD handler. Workaround: put a tiny Cloudflare Worker in front that synthesises HEAD responses. Roughly 10 lines of code; not in the box.
- **Content-Type comes back as `text/plain`, not `application/rss+xml`.** Same workaround — the Cloudflare Worker would also rewrite the Content-Type. Overcast, Pocket Casts, Castro, AntennaPod all tolerate the wrong Content-Type. Apple Podcasts does not.

## Security model

Worth re-reading [DESIGN.md §10](./DESIGN.md#10-security-model), but the headline:

- **URL obscurity is the access control.** The deployment URL contains an unguessable token; Drive file IDs are also unguessable. There is no per-listener authentication.
- **Sharing is per-file, never per-folder.** Each MP3 and each cover image is link-shared individually when Bookcast first sees it. The Drive folder itself is never link-shared. A leaked file URL exposes one file; a leaked folder URL would expose the whole library.
- **The repository must be private.** Inadvertent commits of `.clasp.json` (script ID), a deployment URL, or your folder ID would defeat URL obscurity. The `.gitignore` keeps these out by default, but a private repo is a second line of defence.
- **If a URL leaks**, `clasp undeploy <id>` and a fresh `clasp deploy` rotate it. Existing subscribers will need the new URL; per-chapter MP3 URLs already in their podcast app's download queue continue to work until they next refresh the feed.

## Repository layout

```
src/
├── appsscript.json    Apps Script manifest (runtime, scopes, web app config)
├── Code.js            doGet() entry; editor utilities (flushCache, prewarmAll, runDiagnostics)
├── Drive.js           Folder/file traversal, sharing, URL builders
├── State.js           PropertiesService + CacheService wrappers
├── Metadata.js        Open Library lookup; folder-name → title heuristics
├── Feed.js            RSS XML rendering via XmlService
├── Index.js           HTML index page rendering
└── Local.js           NOT in git. Your local-only setupOnce() that hardcodes the folder ID.
tools/
└── split_m4b.py       Split a single .m4b into a per-chapter book folder (needs ffmpeg)
.gitignore             Excludes .clasp.json, clasp-oauth.json, src/Local.js
CLAUDE.md              Project conventions for AI assistants working on the codebase
DESIGN.md              Architecture, design rationale, decision log
LICENSE                MIT licence
README.md              This file
SETUP_WITH_CLAUDE.md   Setup playbook for AI assistants to walk a new user through install
```

## License

MIT — see [LICENSE](./LICENSE).
