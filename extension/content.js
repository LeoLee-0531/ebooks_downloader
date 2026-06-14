(() => {
  'use strict';

  if (new URLSearchParams(window.location.search).get('readlist')) return;

  const XLINK = 'http://www.w3.org/1999/xlink';
  const IMG_RE = /https?:\/\/streaming-ebook\.books\.com\.tw\/[^\s"'<>]+\/i-(\d+)\.jpg[^\s"'<>]*/;
  const isTop = window.top === window.self;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- 圖片 URL 收集 ----------
  function saveUrl(fullUrl, page) {
    // Only called from top frame — chrome.storage available here
    chrome.storage.session.get('capturedImages', (data) => {
      if (chrome.runtime.lastError) return;
      const current = (data && data.capturedImages) || {};
      const existing = Object.entries(current).find(([, p]) => p === page);
      if (existing && existing[0].length >= fullUrl.length) return;
      if (existing) delete current[existing[0]];
      current[fullUrl] = page;
      chrome.storage.session.set({ capturedImages: current });
    });
  }

  function addUrl(url) {
    if (!url || typeof url !== 'string') return;
    const m = url.match(IMG_RE);
    if (!m) return;
    const fullUrl = m[0];
    const page = parseInt(m[1], 10);
    if (isTop) {
      saveUrl(fullUrl, page);
    } else {
      try { window.top.postMessage({ __ext: 'url', url: fullUrl, page }, '*'); } catch (_) {}
    }
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
      // Only recurse into same-origin iframes (cross-origin throws, caught silently)
      doc.querySelectorAll('iframe').forEach(f => {
        try { if (f.contentDocument) scanDoc(f.contentDocument); } catch (_) {}
      });
    } catch (_) {}
  }

  function scanAll() {
    scanDoc(document);
    try { performance.getEntriesByType('resource').forEach(e => addUrl(e.name)); } catch (_) {}
  }

  // Intercept fetch / XHR
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

  // Top frame: relay postMessages from sub-frames into chrome.storage
  if (isTop) {
    window.addEventListener('message', e => {
      if (!e.data?.__ext) return;
      if (e.data.__ext === 'url') saveUrl(e.data.url, e.data.page);
      if (e.data.__ext === 'toc') {
        chrome.storage.session.set({ tocNodes: e.data.nodes });
      }
    });
  }

  // ---------- API 偵測（只在頂層框架執行）----------
  if (isTop) {
    const bookId = new URLSearchParams(window.location.search).get('book_uni_id');
    if (bookId) {
      chrome.storage.session.set({ bookUniId: bookId });
      fetchBookApis(bookId);
    }
  }

  async function fetchBookApis(id) {
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
        if (m) update.estimatedTotal = Math.round(parseInt(m[1], 10) / (info.percent / 100));
      }
      if (Object.keys(update).length) chrome.storage.session.set(update);
    } catch (_) {}

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
  let tocLis = [];
  let lastTocHash = '';

  function liIndent(li) {
    const span = li.querySelector('span');
    if (!span) return 0;
    const m = (span.getAttribute('style') || '').match(/padding-left:\s*([\d.]+)/);
    if (m) return parseFloat(m[1]);
    const cs = parseFloat((span.ownerDocument.defaultView || window).getComputedStyle(span).paddingLeft);
    return Number.isFinite(cs) ? cs : 0;
  }

  setInterval(() => {
    try {
      // Each frame searches only its own document
      const ul = document.getElementById('UiObj-panel-chapter-list');
      if (!ul) return;
      const lis = Array.from(ul.querySelectorAll('li'));
      if (!lis.length) return;

      const hash = lis.map(li => (li.textContent || '').trim()).join('|');
      if (hash === lastTocHash) return;
      lastTocHash = hash;

      const indents = lis.map(liIndent);
      const uniq = [...new Set(indents)].sort((a, b) => a - b);
      tocLis = lis;

      const nodes = lis.map((li, idx) => ({
        idx,
        name: (li.textContent || '').trim().replace(/\s+/g, ' ') || `章節${idx + 1}`,
        indent: indents[idx],
        level: uniq.indexOf(indents[idx]),
      }));

      if (isTop) {
        chrome.storage.session.set({ tocNodes: nodes });
      } else {
        try { window.top.postMessage({ __ext: 'toc', nodes }, '*'); } catch (_) {}
      }
    } catch (_) {}
  }, 800);

  // ---------- 頁碼偵測 ----------
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
      try { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); } catch (_) {}
    });
  }

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
      result[idx] = pages.length ? pages[0] : null;
      if (pages.length) prevKey = pages.join(',');
    }
    return result;
  }

  // DETECT_PAGES is broadcast to all frames; only the frame with tocLis responds
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== 'DETECT_PAGES') return false;
    if (tocLis.length === 0) return false; // not our frame, let another handle it
    detectPages(msg.indices)
      .then(pages => sendResponse({ pages }))
      .catch(() => sendResponse({ pages: {} }));
    return true; // async
  });
})();
