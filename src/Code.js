// Web app entry. DESIGN.md §7, §8.

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const feedId = params.feed;
    if (feedId) return serveFeed(feedId);
    return serveIndex();
  } catch (err) {
    Logger.log('doGet error: ' + err + '\n' + (err.stack || ''));
    return ContentService
      .createTextOutput('Error: ' + err.message)
      .setMimeType(ContentService.MimeType.TEXT);
  }
}

function serveIndex() {
  const cached = getCached('index');
  if (cached) return HtmlService.createHtmlOutput(cached).setTitle('Bookcast');

  const rootId = getRootFolderId();
  const folders = listBookFolders(rootId);
  const url = getDeploymentUrl();

  const books = folders.map(function (folder) {
    const cover = findCover(folder.id);
    if (cover) ensureAnyoneWithLink(cover.id);
    const metadata = loadOrLookupMetadata(folder);
    return { id: folder.id, name: folder.name, cover: cover, metadata: metadata };
  });

  const html = renderIndex(books, url);
  putCached('index', html);
  return HtmlService.createHtmlOutput(html).setTitle('Bookcast');
}

function serveFeed(bookId) {
  const cacheKey = 'feed:' + bookId;
  const cached = getCached(cacheKey);
  if (cached) {
    return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.RSS);
  }

  const folder = DriveApp.getFolderById(bookId);
  const book = { id: bookId, name: folder.getName() };

  const chapters = listChapters(bookId);
  ensureChaptersShared(folder, chapters);

  const cover = findCover(bookId);
  if (cover) ensureAnyoneWithLink(cover.id);

  const metadata = loadOrLookupMetadata(book);
  const xml = renderFeed(book, chapters, metadata, cover, getDeploymentUrl());

  putCached(cacheKey, xml);
  return ContentService.createTextOutput(xml).setMimeType(ContentService.MimeType.RSS);
}

function getDeploymentUrl() {
  let u = ScriptApp.getService().getUrl() || 'https://script.google.com/macros/s/UNKNOWN/exec';
  // For Workspace-domain accounts, getUrl() returns a /a/<domain>/macros/...
  // form that requires the visitor to be authenticated to that domain.
  // The bare /macros/... form works for ANYONE_ANONYMOUS access.
  u = u.replace(/\/a\/[^/]+\/macros\//, '/macros/');
  return u;
}

// ===== Editor-invokable utilities =====

// Run once after deployment to wipe cached HTML/XML so the next request re-scans Drive.
function flushCache() {
  invalidateCache();
  Logger.log('Cache flushed.');
}

// Pre-warm everything. Useful right after adding a new book so the first
// real podcast-client poll hits a cached, fully-shared feed instead of
// paying the one-time per-chapter setSharing cost.
function prewarmAll() {
  const rootId = getRootFolderId();
  const folders = listBookFolders(rootId);
  Logger.log('Pre-warming ' + folders.length + ' book(s)...');
  serveIndex(); // populates index cache + shares all covers
  folders.forEach(function (f) {
    const start = Date.now();
    serveFeed(f.id);
    Logger.log('  - ' + f.name + ' warmed in ' + (Date.now() - start) + 'ms');
  });
  Logger.log('Pre-warm complete.');
}

// Smoke test — run from the editor after setRootFolderId(...) to confirm
// Drive listing works and books have what they need.
function runDiagnostics() {
  const rootId = getRootFolderId();
  Logger.log('ROOT_FOLDER_ID configured: ok');
  const folders = listBookFolders(rootId);
  Logger.log('Top-level book folder count: ' + folders.length);
  folders.forEach(function (f) {
    const chapters = listChapters(f.id);
    const cover = findCover(f.id);
    const meta = findMetadataJson(f.id);
    Logger.log(
      '  - ' + f.name +
      ' | chapters: ' + chapters.length +
      ' | cover: ' + (cover ? cover.name + ' (' + cover.size + ' bytes)' : 'NONE') +
      ' | metadata.json: ' + (meta ? 'present' : 'absent (will be auto-fetched)')
    );
  });
  Logger.log('Diagnostics complete.');
}
