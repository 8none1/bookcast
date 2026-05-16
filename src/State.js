// Persistent config (ROOT_FOLDER_ID only) + short-TTL render cache.
// DESIGN.md §5.

const PROP_ROOT_FOLDER_ID = 'ROOT_FOLDER_ID';
const CACHE_TTL_SECONDS = 600;

function getRootFolderId() {
  const id = PropertiesService.getScriptProperties().getProperty(PROP_ROOT_FOLDER_ID);
  if (!id) {
    throw new Error(
      'ROOT_FOLDER_ID is not set. From the Apps Script editor, run ' +
      'setRootFolderId("<your-drive-folder-id-or-url>") once.'
    );
  }
  return id;
}

// Accepts either the bare Drive folder ID or a full /folders/<id> URL.
function setRootFolderId(idOrUrl) {
  if (!idOrUrl || typeof idOrUrl !== 'string') {
    throw new Error('setRootFolderId: argument must be a non-empty string');
  }
  let id = idOrUrl.trim();
  const m = id.match(/\/folders\/([^/?#]+)/);
  if (m) id = m[1];
  PropertiesService.getScriptProperties().setProperty(PROP_ROOT_FOLDER_ID, id);
  return id;
}

function getCached(key) {
  return CacheService.getScriptCache().get(key);
}

function putCached(key, value, ttlSeconds) {
  const ttl = ttlSeconds || CACHE_TTL_SECONDS;
  CacheService.getScriptCache().put(key, value, ttl);
}

function invalidateCache(key) {
  const cache = CacheService.getScriptCache();
  if (key) {
    cache.remove(key);
    return;
  }
  const keys = ['index'];
  try {
    const books = listBookFolders(getRootFolderId());
    for (let i = 0; i < books.length; i++) keys.push('feed:' + books[i].id);
  } catch (e) {
    // root not configured yet, or Drive listing failed — just drop the index
  }
  cache.removeAll(keys);
}
