# Setting up Bookcast — playbook for Claude (or any AI assistant)

This file is addressed to an AI coding assistant (Claude, Copilot, Cursor, etc.) that has been asked to help a user install Bookcast for themselves.

**If you are a human:** ignore this file; follow [README.md](./README.md) instead.

**If you are an AI assistant:** this is your playbook. The user has cloned this repo into their working directory and asked you to walk them through setting up their own Bookcast deployment from scratch. Follow the steps below in order. Adapt to the user's environment — they may already have parts done, or may have non-standard constraints (Advanced Protection, no `gcloud`, etc.). Verify each step before moving on. Stop and ask the user for input only where it's genuinely required (account choice, Drive folder URL, podcast-app preference, etc.); execute everything else yourself.

The complete reasoning behind the architecture is in [DESIGN.md](./DESIGN.md). Read it first so you can explain decisions if asked. The complete human-facing setup guide is in [README.md](./README.md) — refer the user there if they prefer to do steps manually.

## What you're building

A single Apps Script web app deployment that serves an HTML index of the user's audiobooks plus per-book RSS feeds. The user bookmarks the index URL on their phone, taps **Subscribe** in their podcast app of choice, and listens like they would to any podcast. No server, no database, no third-party hosting.

## Goal

The user is "done" when:
1. They have a deployed web app URL.
2. They can open that URL in a browser and see a list of their books with cover art and a "Subscribe" button per book.
3. They have successfully subscribed to at least one book in the podcast app they actually use.
4. They have bookmarked the URL on their phone.

## Hard rules — must not violate

Before you do anything else, internalise these. They're load-bearing for the project's security model:

- **Never apply `setSharing` to a folder.** Only ever to leaf MP3 files and cover image files. A leaked file URL exposes one file; a leaked folder URL exposes the entire library by enumeration. The relevant code lives in `src/Drive.js` — never edit it to share folders.
- **Never commit the user's Drive folder ID, deployment URL, or Apps Script script ID to git.** `.gitignore` is already set up to exclude `.clasp.json`, `clasp-oauth.json`, and `src/Local.js` — preserve that. If you generate a new file containing one of these values, add it to `.gitignore` before staging.
- **Never make the GitHub repo public for the user until they explicitly confirm.** Repository visibility is reversible only in a weak sense (forks and indexers may have cached the source). Default to private.
- **Never write the user's Drive folder ID directly into a committed file (CLAUDE.md, README.md, source files, etc.).** The only place it goes is `src/Local.js` (gitignored) plus PropertiesService at runtime.

## Pre-flight

Before starting, gather context:

1. Ask the user **which Google account** they want to deploy Bookcast under. Prefer personal accounts over corporate Workspace accounts — the script runs with the deployer's full Drive scope, and the smaller the blast radius, the better. Confirm they're signed into that account in their default browser.
2. Confirm they have **Node.js 18+, npm, and git** installed locally. Run `node --version && npm --version && git --version` to verify.
3. Check whether they have **gcloud CLI** installed: `gcloud --version`. If yes, the GCP project setup is one command. If no, fall back to web-console clicks (link them to README §2 and explain).
4. Ask whether they have **audiobook MP3s ready** or want to use a LibriVox public-domain audiobook as test content (recommend *The Wind in the Willows* — short chapters, valid test).

Don't proceed past pre-flight until #1 and #2 are confirmed.

## Step 1 — Drive folder

Ask the user to:

1. Sign into https://drive.google.com as the chosen account.
2. Create a new folder (any name — "Audiobooks", "Books", "My Library", etc.).
3. **Keep it private** — do NOT click "Share" or change link-sharing. Bookcast's security depends on this folder staying owned-by-one-user and never link-shared.
4. Upload 1–2 books, structured as per [DESIGN.md §3](./DESIGN.md#3-the-drive-folder): one subfolder per book, MP3 chapters inside (sortable names like `01 - ...`), one image file for the cover (any name, largest wins).
5. Copy the folder URL from the browser address bar and send it to you.

Extract the folder ID from the URL — it's the long string after `/folders/`. Example: from `https://drive.google.com/drive/folders/1aBcD3FgHiJk` the ID is `1aBcD3FgHiJk`.

**Do not write this ID into any committed file.** Hold it for step 7.

## Step 2 — GCP project

The Apps Script API needs to be enabled on a GCP project the user owns.

**If gcloud is available** (check `gcloud auth list` shows the right account as active — `gcloud config set account <email>` to switch if needed):

```bash
PROJECT_ID=bookcast-$(date +%Y%m%d-%H%M%S)
gcloud projects create "$PROJECT_ID" --name=bookcast
gcloud config set project "$PROJECT_ID"
gcloud services enable script.googleapis.com drive.googleapis.com --project="$PROJECT_ID"
gcloud auth application-default set-quota-project "$PROJECT_ID"
```

Save `$PROJECT_ID` for step 4.

**If gcloud is not available**, walk the user through the GCP web console:
- Create project at https://console.cloud.google.com/projectcreate (any name).
- Enable APIs at https://console.cloud.google.com/apis/library — search for and enable both "Apps Script API" and "Google Drive API".
- Note the project ID for step 4.

## Step 3 — User-level Apps Script API toggle

Apps Script has a per-user setting that gates third-party API access. This **cannot** be enabled via CLI.

Ask the user to:
1. Open https://script.google.com/home/usersettings (signed in as the chosen account).
2. Set **Google Apps Script API** to **On**.
3. Confirm back to you when done.

Wait for confirmation. Skipping this causes `clasp create-script` to fail with an unhelpful error in step 5.

## Step 4 — clasp login

Install clasp:

```bash
npm install -g @google/clasp
```

**Try the standard login first:**

```bash
clasp login
```

A browser opens. The user signs in with their chosen account and approves the scopes. If they see a "Sign-in error: this app is blocked" or "Advanced Protection" message, abort and use the alternative below.

Verify the right account:

```bash
clasp show-authorized-user
```

If this prints the wrong account or `unknown user`, run `clasp logout` and retry.

**Alternative: own OAuth client (required if Advanced Protection or strict Workspace policy blocks the standard flow).** The user creates an OAuth client in the GCP project from step 2:

1. Open https://console.cloud.google.com/apis/credentials/consent (in the right project). Configure consent screen: User type **External**, app name `bookcast`, user support + developer email = the user's email. Save and continue → skip the Scopes page → on Test users, add the user's own email → Save. Leave publishing status as Testing.
2. Open https://console.cloud.google.com/apis/credentials. **Create credentials → OAuth client ID → Application type: Desktop app → name "bookcast clasp" → Create**. On the resulting dialog, click **Download JSON**.
3. Tell the user to save the file as `clasp-oauth.json` in the repo root. It's already in `.gitignore`.
4. Run `clasp login --creds clasp-oauth.json`. Browser will show "Google hasn't verified this app" — that's normal for an unverified Desktop OAuth client. Tell the user to click **Advanced → Go to bookcast (unsafe) → Allow**.

## Step 5 — Create the Apps Script project

From the repo root:

```bash
clasp create-script --type standalone --rootDir ./src --title bookcast
clasp push --force
```

`--type` must be `standalone`, not `webapp` (clasp 3.x rejects `webapp`). `--force` is needed on subsequent pushes when the manifest changes, because clasp 3.x prompts interactively otherwise.

`clasp create-script` writes `.clasp.json` (gitignored) with the new project's script ID. Note the script ID — it appears in the editor URL `https://script.google.com/d/<scriptId>/edit`.

## Step 6 — One-time setup with the folder ID

Create `src/Local.js` (gitignored — `.gitignore` already excludes it):

```javascript
function setupOnce() {
  const id = setRootFolderId('PASTE_THE_FOLDER_ID_FROM_STEP_1_HERE');
  Logger.log('ROOT_FOLDER_ID set to: ' + id);
  Logger.log('Now run runDiagnostics() to verify Drive access.');
}
```

**Replace the placeholder with the actual folder ID from step 1.** Then:

```bash
clasp push
```

Open the Apps Script editor in the user's browser:

```bash
clasp open-script
```

…or send them the URL `https://script.google.com/d/<scriptId>/edit`.

Ask the user to, in the editor:
1. Open `Local.gs` from the file list on the left.
2. In the toolbar at the top, set the function dropdown to **`setupOnce`** and click **Run** (▶).
3. The first run triggers an authorization prompt. They click **Review permissions** → pick their account → **Advanced** → **Go to bookcast (unsafe)** → **Allow** for the requested scopes.
4. The execution log at the bottom should show `ROOT_FOLDER_ID set to: ...`.
5. Set the dropdown to **`runDiagnostics`** and click Run.
6. They paste the log output back to you.

The diagnostics output should list their book folders with chapter counts, cover filenames, and metadata.json status. Verify the counts and book names match expectations. If a book has zero chapters or no cover, fix the Drive folder layout before deploying.

## Step 7 — Deploy

```bash
clasp deploy --description "v0.1"
```

The output contains a deployment ID like `AKfycb...`. The actual URL is:

```
https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec
```

**This is the most sensitive identifier in the system.** Tell the user to save it in their password manager and not paste it into anywhere public — GitHub issues, screenshots, chat, etc.

## Step 8 — Validate

You can fetch the deployment URL directly to verify it's working:

```bash
curl -sL "https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec" | head -c 2000
```

The response is wrapped in an iframe-sandbox shell (Apps Script's standard HtmlService behaviour); the user's actual HTML is nested inside as an escaped string. Don't worry — the browser renders it correctly. Just confirm you get HTTP 200 and the response contains book titles.

The **first ever fetch** of any per-book feed will be slow (5–30 seconds depending on chapter count) because Apps Script calls `setSharing` on every chapter file once. To pre-warm everything before any podcast client polls, ask the user to run **`prewarmAll`** from the Apps Script editor (function dropdown → prewarmAll → Run). It iterates all books, applies sharing, and caches the rendered XML. After this, cold-cache renders are fast (~2-3s).

Then ask the user to:
1. Open the deployment URL in a desktop browser. Confirm they see book cards with covers, titles, authors, and Subscribe buttons.
2. Try the podcast-app button matching their actual podcast app (Open in Overcast, Pocket Casts, etc.).
3. Confirm the podcast app foregrounds and offers to add the feed.

## Step 9 — Bookmark on phone

Ask the user to:
1. Open the deployment URL on their phone.
2. Tap the share button → **Add to Home Screen** (iOS Safari) or equivalent (Android Chrome: three-dot menu → "Add to Home screen").
3. Confirm the home-screen icon opens the page and at least one Subscribe button works from the phone.

## Step 10 (optional) — Push to user's own GitHub repo

If the user wants a personal git remote separate from this upstream:

1. Confirm they want a **private** repo (default — discuss with them if they want public).
2. Verify `gh auth status` shows them logged in. If not, `gh auth login`.
3. Create + push:
   ```bash
   gh repo create <username>/bookcast-mine --private --source=. --remote=mine --push
   ```
   (Use a different remote name like `mine` to avoid clobbering the `origin` that may point at the upstream.)

## Common failures and how to handle them

- **`clasp create-script: Invalid container file type`** — You passed `--type webapp`. Use `--type standalone` instead.
- **`clasp create-script: User has not enabled the Apps Script API`** — Step 3 was missed, or hasn't propagated yet. Tell the user to verify the toggle at https://script.google.com/home/usersettings, then wait ~30 seconds and retry.
- **`clasp push` says "Skipping push."** — Manifest changed and clasp prompted for confirmation, which auto-failed in your non-interactive shell. Use `clasp push --force`.
- **Deployment URL returns 403 to anonymous requests** — `src/appsscript.json` is missing the `webapp` block. It must contain `"webapp": { "executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS" }`. Then `clasp push --force` and `clasp redeploy <id> --description "fix webapp config"`.
- **Feed XML contains `/a/<domain>/macros/`** — Workspace-domain accounts get a domain-prefixed URL from `ScriptApp.getService().getUrl()`. `src/Code.js#getDeploymentUrl` strips it; if you see it in output, confirm you didn't accidentally remove the `.replace(...)` line.
- **First feed render times out in podcast client** — Cold-cache + first-ever shareSharing pass exceeds the client's timeout. Ask the user to run `prewarmAll()` once from the editor; subsequent fetches will be fast.
- **`clasp login` browser shows "Sign-in error: access blocked"** — User account is in Advanced Protection or restrictive Workspace. Use the OAuth-client alternative in step 4.

## Definition of done

Tell the user you're finished only when:
1. `clasp deploy` has produced a URL.
2. You have curled the URL and confirmed HTTP 200 + book titles in the response.
3. The user has opened the URL in a browser and confirmed it looks right.
4. The user has subscribed to at least one feed in their podcast app and confirmed playback works.
5. The user has added the URL to their phone's home screen.
6. The user knows where they've saved the deployment URL (password manager).
7. *(Optional)* The user has decided whether they want a personal git remote.

Otherwise, name the specific step that's outstanding and stay engaged until it's resolved.
