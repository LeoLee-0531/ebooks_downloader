(() => {
  'use strict';

  // Skip bookshelf page
  if (new URLSearchParams(window.location.search).get('readlist')) return;

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
      // Find if we already have an entry for this page number
      const existingEntry = Object.entries(current).find(([u]) => {
        const em = u.match(/\/i-(\d+)\.jpg/);
        return em && parseInt(em[1], 10) === page;
      });
      if (existingEntry && existingEntry[0].length >= fullUrl.length) return;
      if (existingEntry) delete current[existingEntry[0]];
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

  function scanAll() {
    scanDoc(document);
    try {
      performance.getEntriesByType('resource').forEach(e => addUrl(e.name));
    } catch (_) {}
  }

  // Intercept fetch / XHR to supplement URL collection
  try {
    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (...args) {
        try { addUrl(args[0] instanceof Request ? args[0].url : String(args[0] || '')); } catch (_) {}
        return origFetch.apply(this, args);
      };
    }
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try { addUrl(String(url || '')); } catch (_) {}
      return origOpen.apply(this, [method, url, ...rest]);
    };
  } catch (_) {}

  new MutationObserver(scanAll).observe(document.documentElement || document, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['src', 'href', 'xlink:href'],
  });
  setInterval(scanAll, 1000);
  scanAll();

  // ---------- API 偵測 ----------
  const bookId = new URLSearchParams(window.location.search).get('book_uni_id');
  if (bookId) {
    chrome.storage.session.set({ bookUniId: bookId });
    fetchBookApis(bookId);
  }

  async function fetchBookApis(id) {
    // BookInfo：書名 + 讀取進度估算
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

      if (info.percent > 0 && info.last_loc) {
        const m = info.last_loc.match(/\[p-(\d+)\]/);
        if (m) {
          const curPage = parseInt(m[1], 10);
          update.estimatedTotal = Math.round(curPage / (info.percent / 100));
        }
      }

      if (Object.keys(update).length) chrome.storage.session.set(update);
    } catch (_) {}

    // BookDownLoadURL：下載連結 + Token
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
      }
    } catch (_) {}
  }

  // ---------- TOC 偵測 ----------
  // Keep actual DOM <li> elements indexed by idx for click detection
  let tocLis = []; // array of <li> DOM elements

  // Recursive iframe search for #UiObj-panel-chapter-list
  function findChapterListUl(doc) {
    try {
      const ul = doc.getElementById('UiObj-panel-chapter-list');
      if (ul) return ul;
      for (const f of doc.querySelectorAll('iframe')) {
        try {
          if (f.contentDocument) {
            const r = findChapterListUl(f.contentDocument);
            if (r) return r;
          }
        } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  // Read padding-left from span style/computed to determine indent level
  function liIndent(li) {
    const span = li.querySelector('span');
    if (!span) return 0;
    const m = (span.getAttribute('style') || '').match(/padding-left:\s*([\d.]+)/);
    if (m) return parseFloat(m[1]);
    const cs = parseFloat((span.ownerDocument.defaultView || window).getComputedStyle(span).paddingLeft);
    return Number.isFinite(cs) ? cs : 0;
  }

  // Poll for TOC every 800ms
  let tocPollTimer = null;
  let lastTocHash = '';

  function startTocPoll() {
    if (tocPollTimer) return;
    tocPollTimer = setInterval(() => {
      try {
        const ul = findChapterListUl(document);
        if (!ul) return;
        const lis = Array.from(ul.querySelectorAll('li'));
        if (lis.length === 0) return;

        // Check if TOC changed (by text content hash)
        const hash = lis.map(li => (li.textContent || '').trim()).join('|');
        if (hash === lastTocHash) return;
        lastTocHash = hash;

        const indents = lis.map(liIndent);
        const uniq = [...new Set(indents)].sort((a, b) => a - b);

        // Store serializable data in session storage
        const nodes = lis.map((li, idx) => ({
          idx,
          name: (li.textContent || '').trim().replace(/\s+/g, ' ') || `章節${idx + 1}`,
          indent: indents[idx],
          level: uniq.indexOf(indents[idx]),
        }));

        // Keep actual DOM references in local array
        tocLis = lis;

        chrome.storage.session.set({ tocNodes: nodes });
      } catch (_) {}
    }, 800);
  }

  startTocPoll();

  // ---------- 頁碼偵測工具 ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Read currently rendered page numbers by scanning images recursively through iframes
  function readCurrentPages(doc, set) {
    if (!set) set = new Set();
    try {
      doc.querySelectorAll('img[src], image').forEach(el => {
        const u = readHref(el) || el.src || '';
        const m = u && u.match(/\/i-(\d+)\.jpg/);
        if (m) set.add(parseInt(m[1], 10));
      });
      doc.querySelectorAll('iframe').forEach(f => {
        try { if (f.contentDocument) readCurrentPages(f.contentDocument, set); } catch (_) {}
      });
    } catch (_) {}
    return [...set].sort((a, b) => a - b);
  }

  function fireClick(li) {
    const target = li.querySelector('span') || li;
    ['mousedown', 'mouseup', 'click'].forEach(type => {
      try {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      } catch (_) {}
    });
  }

  // Click each tocLis[idx], wait for page change, return {[idx]: firstPage}
  async function detectPages(indices) {
    const result = {};
    let prevKey = readCurrentPages(document).join(',');

    for (const idx of indices) {
      const li = tocLis[idx];
      if (!li) continue;
      fireClick(li);
      let pages = [];
      for (let t = 0; t < 20; t++) {
        await sleep(150);
        pages = readCurrentPages(document);
        if (pages.length && pages.join(',') !== prevKey) break;
      }
      if (!pages.length) pages = readCurrentPages(document);
      const pg = pages.length ? pages[0] : null;
      if (pages.length) prevKey = pages.join(',');
      result[idx] = pg;
    }
    return result;
  }

  // ---------- 訊息監聽 ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'DETECT_PAGES') {
      detectPages(msg.indices).then(pages => sendResponse({ pages })).catch(() => sendResponse({ pages: {} }));
      return true; // async
    }
  });
})();
