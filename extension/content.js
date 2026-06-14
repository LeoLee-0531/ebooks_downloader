(() => {
  const XLINK = 'http://www.w3.org/1999/xlink';
  const IMG_RE = /https?:\/\/streaming-ebook\.books\.com\.tw\/[^\s"'<>]+\/i-(\d+)\.jpg[^\s"'<>]*/;

  // ---------- 圖片 URL 收集 ----------
  function addUrl(url) {
    if (!url || typeof url !== 'string') return;
    const m = url.match(IMG_RE);
    if (!m) return;
    const page = parseInt(m[1], 10);
    const fullUrl = m[0];
    chrome.storage.session.get('capturedImages', (data) => {
      const current = data.capturedImages || {};
      const existing = Object.entries(current).find(([, p]) => p === page);
      if (existing && existing[0].length >= fullUrl.length) return;
      if (existing) delete current[existing[0]];
      current[fullUrl] = page;
      chrome.storage.session.set({ capturedImages: current });
    });
  }

  function readHref(el) {
    try { if (el.href && el.href.baseVal) return el.href.baseVal; } catch (_) {}
    return el.getAttributeNS(XLINK, 'href') || el.getAttribute('xlink:href') ||
      el.getAttribute('href') || el.src || '';
  }

  function scanDoc(doc) {
    try {
      doc.querySelectorAll('img[src]').forEach(el => addUrl(el.src));
      doc.querySelectorAll('image').forEach(el => addUrl(readHref(el)));
      doc.querySelectorAll('iframe').forEach(f => {
        try { if (f.contentDocument) scanDoc(f.contentDocument); } catch (_) {}
      });
    } catch (_) {}
  }

  function scanAll() { scanDoc(document); }

  new MutationObserver(scanAll).observe(document.documentElement || document, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['src', 'href', 'xlink:href'],
  });
  setInterval(scanAll, 1000);
  scanAll();

  // ---------- 主動呼叫 API（content script 在頁面 context，cookie 有效）----------
  const bookId = new URLSearchParams(window.location.search).get('book_uni_id');
  if (bookId) {
    chrome.storage.session.set({ bookUniId: bookId });
    fetchBookApis(bookId);
  }

  async function fetchBookApis(id) {
    // BookInfo：書名 + 讀取進度（用於估算總頁數）
    try {
      const r = await fetch(
        `https://appapi-ebook.books.com.tw/V1.7/CMSAPIApp/BookInfo?book_uni_id=${encodeURIComponent(JSON.stringify([id]))}`,
        { credentials: 'include' }
      );
      const data = await r.json();
      const info = data?.records?.[0]?.item_info;
      if (!info) throw new Error('no info');

      const update = {};
      if (info.c_title) update.bookTitle = info.c_title;

      // percent + last_loc → 估算總頁數
      // last_loc 格式："epubcfi(/6/216[p-107]!/4/1:0)" → p-107 即當前圖片頁碼
      if (info.percent > 0 && info.last_loc) {
        const m = info.last_loc.match(/\[p-(\d+)\]/);
        if (m) {
          const curPage = parseInt(m[1], 10);
          update.estimatedTotal = Math.round(curPage / (info.percent / 100));
        }
      }

      if (Object.keys(update).length) chrome.storage.session.set(update);
    } catch (_) {}

    // BookDownLoadURL：下載連結 + Token + nav.xhtml 目錄
    try {
      const r = await fetch(
        `https://appapi-ebook.books.com.tw/V1.7/CMSAPIApp/BookDownLoadURL?book_uni_id=${encodeURIComponent(id)}&t=${Date.now()}`,
        { credentials: 'include' }
      );
      const data = await r.json();
      if (data.download_link && data.download_token) {
        chrome.storage.session.set({
          downloadLink: data.download_link,
          downloadToken: data.download_token,
        });
        // 順帶抓 nav.xhtml 取得完整目錄
        fetchNavXhtml(data.download_link, data.download_token);
      }
    } catch (_) {}
  }

  async function fetchNavXhtml(link, token) {
    const urls = [
      `${link}item/nav.xhtml?DownloadToken=${encodeURIComponent(token)}`,
      `${link}item/nav.xhtml?DownloadToken=${token}`,
      `${link}nav.xhtml?DownloadToken=${encodeURIComponent(token)}`,
      `${link}nav.xhtml?DownloadToken=${token}`,
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) continue;
        const html = await r.text();
        const chapters = parseNavXhtml(html);
        if (chapters.length > 0) {
          chrome.storage.session.set({ bookChapters: chapters });
          return;
        }
      } catch (_) {}
    }
  }

  function parseNavXhtml(html) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'application/xhtml+xml');
      const seen = new Set();
      const chapters = [];
      doc.querySelectorAll('nav a[href], ol a[href]').forEach(a => {
        const href = a.getAttribute('href');
        const m = href && href.match(/p-(\d+)\.xhtml/);
        if (!m) return;
        const page = parseInt(m[1], 10);
        if (seen.has(page)) return;
        seen.add(page);
        const name = a.textContent.trim();
        if (name) chapters.push({ name, startPage: page });
      });
      return chapters.sort((a, b) => a.startPage - b.startPage);
    } catch (_) {
      return [];
    }
  }
})();
