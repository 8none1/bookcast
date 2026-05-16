// RSS XML for one book. DESIGN.md §7.
//
// Use XmlService — never string-concat into XML.

const PUBDATE_BASE_MS = Date.UTC(2020, 0, 1, 0, 0, 0); // 2020-01-01T00:00:00Z
const ITUNES_NS_URI = 'http://www.itunes.com/dtds/podcast-1.0.dtd';

function renderFeed(book, chapters, metadata, cover, deploymentUrl) {
  const itunes = XmlService.getNamespace('itunes', ITUNES_NS_URI);

  // XmlService.Element has no addNamespaceDeclaration; the serializer adds
  // xmlns:itunes automatically wherever the namespace is first used. The
  // declaration may appear on a child element rather than on <rss>, which is
  // valid XML and accepted by every podcast client.
  const rss = XmlService.createElement('rss').setAttribute('version', '2.0');

  const channel = XmlService.createElement('channel');

  channel.addContent(XmlService.createElement('title').setText(metadata.title));
  channel.addContent(XmlService.createElement('description').setText(metadata.description || metadata.title));
  channel.addContent(XmlService.createElement('language').setText(metadata.language || 'en'));
  channel.addContent(XmlService.createElement('link').setText(deploymentUrl + '?feed=' + book.id));

  channel.addContent(XmlService.createElement('author', itunes).setText(metadata.author));
  channel.addContent(XmlService.createElement('type', itunes).setText('serial'));
  channel.addContent(XmlService.createElement('explicit', itunes).setText('false'));

  if (cover) {
    const itunesImage = XmlService.createElement('image', itunes)
      .setAttribute('href', imageUrl(cover.id, 1400));
    channel.addContent(itunesImage);

    // Plain RSS <image> for clients that don't grok itunes:image
    const rssImage = XmlService.createElement('image');
    rssImage.addContent(XmlService.createElement('url').setText(imageUrl(cover.id, 1400)));
    rssImage.addContent(XmlService.createElement('title').setText(metadata.title));
    rssImage.addContent(XmlService.createElement('link').setText(deploymentUrl + '?feed=' + book.id));
    channel.addContent(rssImage);
  }

  chapters.forEach(function (chapter, idx) {
    const ordinal = idx + 1;
    const pubDate = new Date(PUBDATE_BASE_MS + ordinal * 60 * 1000);

    const item = XmlService.createElement('item');

    const title = cleanChapterTitle(chapter.name, book.name);
    item.addContent(XmlService.createElement('title').setText(title));

    const enclosure = XmlService.createElement('enclosure')
      .setAttribute('url', audioUrl(chapter.id))
      .setAttribute('length', String(chapter.size || 0))
      .setAttribute('type', 'audio/mpeg');
    item.addContent(enclosure);

    const guid = XmlService.createElement('guid').setText(chapter.id);
    guid.setAttribute('isPermaLink', 'false');
    item.addContent(guid);

    item.addContent(XmlService.createElement('pubDate').setText(formatRfc822(pubDate)));
    item.addContent(XmlService.createElement('episode', itunes).setText(String(ordinal)));
    item.addContent(XmlService.createElement('episodeType', itunes).setText('full'));

    channel.addContent(item);
  });

  rss.addContent(channel);
  return XmlService.getRawFormat().format(XmlService.createDocument(rss));
}

function formatRfc822(date) {
  return Utilities.formatDate(date, 'GMT', "EEE, dd MMM yyyy HH:mm:ss 'GMT'");
}

// Audible-style filenames embed the full book title + [ASIN] before each
// chapter name. Strip that so the podcast app shows just "01 - Opening
// Credits" rather than "Ramble Book_ Musings on... [0008293368] - 01 - ...".
function cleanChapterTitle(filename, bookFolderName) {
  let s = filename.replace(/\.mp3$/i, '');
  // 1. If there's a "...] - " section, take what's after the last "] - ".
  const m = s.match(/\]\s*-\s*(.+)$/);
  if (m) return m[1].trim();
  // 2. Otherwise, if the chapter starts with the book folder name, strip it.
  if (bookFolderName && s.indexOf(bookFolderName) === 0) {
    s = s.slice(bookFolderName.length).replace(/^[\s\-_]+/, '');
  }
  return s.trim();
}
