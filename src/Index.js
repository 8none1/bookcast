// HTML index page. DESIGN.md §7.
//
// One card per book. QR code at the top encodes the page's own URL so a new
// device can be set up by scanning. Inline CSS; the only JS is the
// clipboard helper for the Copy URL buttons.

function renderIndex(books, deploymentUrl) {
  const podcastBase = deploymentUrl.replace(/^https?:\/\//, 'podcast://');
  const cards = books.map(function (b) { return renderBookCard(b, deploymentUrl, podcastBase); }).join('\n');

  // QR via api.qrserver.com. Acceptable v1 dependency; tracked in DESIGN.md §12
  // as a tech-debt item to replace with inline SVG later.
  const qrSrc = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' +
    encodeURIComponent(deploymentUrl);

  return [
    '<!doctype html>',
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Bookcast</title>',
    '<style>' + INDEX_CSS + '</style>',
    '</head><body>',
    '<header>',
    '  <h1>Bookcast</h1>',
    '  <img class="qr" src="' + escapeHtml(qrSrc) + '" alt="QR code for this page">',
    '  <p class="hint">Scan to set up another device, or bookmark this page.</p>',
    '</header>',
    '<main>',
    cards || '<p class="empty">No books found in the Drive root folder.</p>',
    '</main>',
    '<footer><p>Tap <b>Subscribe</b> in your podcast app of choice. On Apple Podcasts, tap <b>Copy URL</b> then paste into "Follow a Show by URL".</p></footer>',
    '<script>' + INDEX_JS + '</script>',
    '</body></html>'
  ].join('\n');
}

function renderBookCard(b, deploymentUrl, podcastBase) {
  const feedUrl = deploymentUrl + '?feed=' + b.id;
  const podcastUrl = podcastBase + '?feed=' + b.id;
  // Overcast: documented x-callback-url scheme. iOS routes overcast:// to the
  // Overcast app directly, bypassing the system default-podcast-app behaviour
  // that hijacks podcast:// links to Apple Podcasts.
  const overcastUrl = 'overcast://x-callback-url/add?url=' + encodeURIComponent(feedUrl);
  // Pocket Casts: pktc://subscribe/<feed-url-without-scheme>
  const pocketCastsUrl = 'pktc://subscribe/' + feedUrl.replace(/^https?:\/\//, '');
  const coverImg = b.cover
    ? '<img class="cover" src="' + escapeHtml(imageUrl(b.cover.id, 400)) + '" alt="cover">'
    : '<div class="cover placeholder">No cover</div>';
  return [
    '<article class="book">',
    coverImg,
    '<div class="info">',
    '  <h2>' + escapeHtml(b.metadata.title) + '</h2>',
    '  <p class="author">' + escapeHtml(b.metadata.author) + '</p>',
    b.metadata.description ? '  <p class="desc">' + escapeHtml(truncate(b.metadata.description, 260)) + '</p>' : '',
    '  <div class="actions">',
    '    <a class="subscribe overcast" href="' + escapeHtml(overcastUrl) + '">Open in Overcast</a>',
    '    <a class="subscribe pocketcasts" href="' + escapeHtml(pocketCastsUrl) + '">Pocket Casts</a>',
    '    <a class="subscribe podcast" href="' + escapeHtml(podcastUrl) + '">Apple Podcasts</a>',
    '    <button class="copy" type="button" data-url="' + escapeHtml(feedUrl) + '">Copy URL</button>',
    '  </div>',
    '</div>',
    '</article>'
  ].join('\n');
}

const INDEX_CSS = [
  '*{box-sizing:border-box}',
  'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:820px;margin:0 auto;padding:1rem 1rem 3rem;background:#faf8f5;color:#222;line-height:1.4}',
  'header{text-align:center;margin-bottom:1.5rem}',
  'header h1{font-size:1.6rem;margin:0 0 0.5rem;letter-spacing:-0.01em}',
  '.qr{display:block;margin:0.5rem auto;width:180px;height:180px;border-radius:8px}',
  '.hint{color:#888;font-size:0.85rem;margin:0.25rem 0 0}',
  'main{display:grid;gap:1rem}',
  '.empty{text-align:center;color:#888;padding:2rem;background:white;border-radius:8px}',
  '.book{display:flex;gap:1rem;background:white;padding:1rem;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,0.06)}',
  '.cover{width:128px;height:128px;object-fit:cover;border-radius:6px;flex-shrink:0;background:#eee}',
  '.cover.placeholder{display:flex;align-items:center;justify-content:center;color:#999;font-size:0.85rem;background:#e8e2d4}',
  '.info{flex:1;min-width:0}',
  '.info h2{margin:0 0 0.25rem;font-size:1.1rem}',
  '.author{margin:0 0 0.5rem;color:#666;font-size:0.9rem}',
  '.desc{margin:0 0 0.75rem;font-size:0.85rem;color:#444}',
  '.actions{display:flex;gap:0.5rem;flex-wrap:wrap}',
  '.subscribe{background:#6b4226;color:white;padding:0.55rem 0.9rem;border-radius:6px;text-decoration:none;font-size:0.85rem;font-weight:500}',
  '.subscribe:hover{filter:brightness(0.9)}',
  '.subscribe.overcast{background:#fc7e0f}',
  '.subscribe.pocketcasts{background:#f43e37}',
  '.subscribe.podcast{background:#a854e6}',
  '.copy{background:#f0ece5;border:1px solid #d8d0c0;color:#444;padding:0.5rem 1rem;border-radius:6px;cursor:pointer;font-size:0.9rem;font-family:inherit}',
  '.copy.copied{background:#d8e5d0;border-color:#b8d0a8}',
  'footer{margin-top:2rem;color:#888;font-size:0.8rem;text-align:center}',
  '@media (max-width:520px){.book{flex-direction:column}.cover{width:100%;height:auto;max-height:240px}}'
].join('');

const INDEX_JS = [
  '(function(){',
  '  document.querySelectorAll(".copy").forEach(function(b){',
  '    b.addEventListener("click", function(){',
  '      var url = b.dataset.url;',
  '      var done = function(){ b.textContent = "Copied"; b.classList.add("copied"); setTimeout(function(){ b.textContent = "Copy URL"; b.classList.remove("copied"); }, 1500); };',
  '      if (navigator.clipboard && navigator.clipboard.writeText) {',
  '        navigator.clipboard.writeText(url).then(done, function(){ window.prompt("Copy this URL:", url); });',
  '      } else { window.prompt("Copy this URL:", url); }',
  '    });',
  '  });',
  '})();'
].join('');

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(s, n) {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n).replace(/\s+\S*$/, '').trim() + '…';
}
