// Folder-name → probable-title cleanup + Open Library lookup. DESIGN.md §3a.
//
// On cache miss for a book that has no metadata.json, we hit Open Library
// once, persist the result back into the book folder, and use it for the
// current render. If the lookup fails, defaults are used and no file is
// written (so the next scan retries).

function loadOrLookupMetadata(book) {
  const existing = findMetadataJson(book.id);
  if (existing) return applyMetadataDefaults(existing, book);

  const looked = lookupOpenLibrary(book.name);
  if (looked) {
    try { writeMetadataJson(book.id, looked); }
    catch (e) { Logger.log('writeMetadataJson failed: ' + e.message); }
    return applyMetadataDefaults(looked, book);
  }
  return applyMetadataDefaults({}, book);
}

function applyMetadataDefaults(m, book) {
  return {
    title: m.title || book.name,
    author: m.author || 'Unknown',
    narrator: m.narrator || '',
    year: m.year || null,
    description: m.description || '',
    language: m.language || 'en'
  };
}

function cleanFolderNameForSearch(name) {
  let s = name || '';
  s = s.replace(/\([^)]*\)/g, ' ');
  s = s.replace(/\[[^\]]*\]/g, ' ');
  s = s.replace(/\b(19|20)\d{2}\b/g, ' ');
  s = s.replace(/\b(unabridged|abridged|audiobook|audio\s*book)\b/gi, ' ');
  s = s.replace(/[_\-]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function lookupOpenLibrary(folderName) {
  const cleaned = cleanFolderNameForSearch(folderName);
  if (!cleaned) return null;

  const searchUrl = 'https://openlibrary.org/search.json?title=' +
    encodeURIComponent(cleaned) + '&limit=1';

  let docs;
  try {
    const resp = UrlFetchApp.fetch(searchUrl, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { 'User-Agent': 'bookcast/0.1' }
    });
    if (resp.getResponseCode() !== 200) return null;
    docs = (JSON.parse(resp.getContentText()).docs) || [];
  } catch (e) {
    Logger.log('Open Library search failed: ' + e.message);
    return null;
  }
  if (!docs.length) return null;

  const doc = docs[0];
  const obj = {
    title: doc.title || cleaned,
    author: (doc.author_name && doc.author_name[0]) || 'Unknown',
    year: doc.first_publish_year || null,
    language: (doc.language && doc.language[0]) || 'en',
    description: ''
  };

  if (doc.key) {
    try {
      const wResp = UrlFetchApp.fetch('https://openlibrary.org' + doc.key + '.json', {
        muteHttpExceptions: true,
        headers: { 'User-Agent': 'bookcast/0.1' }
      });
      if (wResp.getResponseCode() === 200) {
        const w = JSON.parse(wResp.getContentText());
        if (w.description) {
          obj.description = (typeof w.description === 'string')
            ? w.description
            : (w.description.value || '');
        }
      }
    } catch (e) {
      Logger.log('Open Library work fetch failed: ' + e.message);
    }
  }

  return obj;
}
