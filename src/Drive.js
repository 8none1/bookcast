// Drive folder traversal, sharing, URL builders. DESIGN.md §3, §6.
//
// HARD RULE: ensureAnyoneWithLink is only ever called on leaf files (MP3s
// and cover images). NEVER on folders. A leaked file URL exposes one file;
// a leaked folder URL would expose the whole library by enumeration.

const AUDIO_MIME = ['audio/mpeg', 'audio/mp3'];

function listBookFolders(rootFolderId) {
  const root = DriveApp.getFolderById(rootFolderId);
  const out = [];
  const iter = root.getFolders();
  while (iter.hasNext()) {
    const f = iter.next();
    out.push({ id: f.getId(), name: f.getName() });
  }
  out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return out;
}

function listChapters(bookFolderId) {
  const folder = DriveApp.getFolderById(bookFolderId);
  const out = [];
  const iter = folder.getFiles();
  while (iter.hasNext()) {
    const f = iter.next();
    const mt = f.getMimeType();
    const isAudio = AUDIO_MIME.indexOf(mt) !== -1 || /\.mp3$/i.test(f.getName());
    if (!isAudio) continue;
    out.push({ id: f.getId(), name: f.getName(), size: f.getSize() });
  }
  out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return out;
}

// Largest image file in the folder. Prefer JPEG; fall back to PNG.
function findCover(bookFolderId) {
  const folder = DriveApp.getFolderById(bookFolderId);
  let bestJpeg = null;
  let bestPng = null;
  const iter = folder.getFiles();
  while (iter.hasNext()) {
    const f = iter.next();
    const mt = f.getMimeType();
    const name = f.getName();
    const isJpeg = mt === 'image/jpeg' || /\.jpe?g$/i.test(name);
    const isPng = mt === 'image/png' || /\.png$/i.test(name);
    if (!isJpeg && !isPng) continue;
    const candidate = { id: f.getId(), name: name, size: f.getSize() };
    if (isJpeg) {
      if (!bestJpeg || candidate.size > bestJpeg.size) bestJpeg = candidate;
    } else {
      if (!bestPng || candidate.size > bestPng.size) bestPng = candidate;
    }
  }
  return bestJpeg || bestPng;
}

function findMetadataJson(bookFolderId) {
  const folder = DriveApp.getFolderById(bookFolderId);
  const iter = folder.getFilesByName('metadata.json');
  if (!iter.hasNext()) return null;
  const f = iter.next();
  try {
    return JSON.parse(f.getBlob().getDataAsString());
  } catch (e) {
    Logger.log('Bad metadata.json in folder; ignoring.');
    return null;
  }
}

function writeMetadataJson(bookFolderId, obj) {
  const folder = DriveApp.getFolderById(bookFolderId);
  if (folder.getFilesByName('metadata.json').hasNext()) return; // don't clobber
  folder.createFile('metadata.json', JSON.stringify(obj, null, 2), 'application/json');
}

function ensureAnyoneWithLink(fileId) {
  try {
    const file = DriveApp.getFileById(fileId);
    if (file.getSharingAccess() === DriveApp.Access.ANYONE_WITH_LINK) return;
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    Logger.log('setSharing failed (continuing): ' + e.message);
  }
}

// Idempotent share-all-chapters with a per-folder "last fully shared at"
// timestamp in PropertiesService. Avoids 26+ Drive API calls per cold cache
// miss when the folder hasn't been modified since the last share.
//
// Folder.getLastUpdated() bumps when a child is added/renamed/deleted, so
// new chapters force a re-share on the next request. Files modified outside
// our script (e.g. someone manually unshares a chapter) won't be detected —
// run flushSharedState() from the editor to force a full re-share if needed.
function ensureChaptersShared(folder, chapters) {
  const key = 'shared:' + folder.getId();
  const props = PropertiesService.getScriptProperties();
  const lastSharedAt = parseInt(props.getProperty(key) || '0', 10);
  const folderUpdated = folder.getLastUpdated().getTime();

  if (lastSharedAt && folderUpdated < lastSharedAt) {
    return; // folder unchanged since last full share — trust it
  }

  chapters.forEach(function (c) { ensureAnyoneWithLink(c.id); });
  props.setProperty(key, String(Date.now()));
}

// Editor-invokable. Wipes the per-folder share timestamps so the next request
// re-checks every file. Use after manually fiddling with Drive sharing.
function flushSharedState() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const toDelete = Object.keys(all).filter(function (k) { return k.indexOf('shared:') === 0; });
  toDelete.forEach(function (k) { props.deleteProperty(k); });
  Logger.log('Cleared ' + toDelete.length + ' shared-state entries.');
}

function audioUrl(fileId) {
  return 'https://drive.usercontent.google.com/download?id=' + fileId + '&export=download';
}

function imageUrl(fileId, size) {
  return 'https://lh3.googleusercontent.com/d/' + fileId + '=s' + (size || 1400);
}
