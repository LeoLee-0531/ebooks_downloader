(function () {
  'use strict';

  if (new URLSearchParams(window.location.search).get('readlist')) return;

  // PDFLib is loaded only in the top frame (see manifest); access it lazily.
  const XLINK = 'http://www.w3.org/1999/xlink';
  const IMG_RE = /https?:\/\/streaming-ebook\.books\.com\.tw\/[^\s"'<>]+\/i-(\d+)\.jpg[^\s"'<>]*/;
  const isTop = window.top === window.self;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- 圖片收集（備援） ----------
  const captured = new Map(); // pageNum → url

  // ---------- API 偵測快取 ----------
  let apiLink = null;
  let apiToken = null;
  let apiBookTitle = null;
  let resolvedTemplate = null;

  // 目錄樹狀態
  let tocNodes = [];
  const tocCollapsed = new Set();
  const tocSelected = new Set();

  // ---------- 背景 service worker fetch 代理 ----------
  // 內容腳本在 MV3 無法跨來源 fetch，改由背景代理（host_permissions 解除 CORS）
  function bgSend(message) {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime?.id) { reject(new Error('extension context invalidated')); return; }
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(res || {});
        });
      } catch (e) { reject(e); }
    });
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function bytesToB64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  async function fetchImage(url) {
    const r = await bgSend({ type: 'FETCH_IMG', url });
    if (!r.ok) throw new Error(`HTTP ${r.status || '?'}`);
    return b64ToBytes(r.b64);
  }

  async function checkPageExists(url) {
    try {
      const r = await bgSend({ type: 'CHECK_PAGE', url });
      return !!r.ok;
    } catch (_) { return false; }
  }

  async function gmGet(url) {
    const r = await bgSend({ type: 'GM_GET', url });
    if (!r.ok) throw new Error('request failed');
    return r.json;
  }

  // ---------- URL 工具 ----------
  function buildTemplate(sampleUrl) { return sampleUrl.replace(/\/i-\d+\.jpg/, '/i-{page}.jpg'); }
  function formatPage(n) { return String(n).padStart(3, '0'); }
  function getPageUrl(template, n) { return template.replace('{page}', formatPage(n)); }

  function templateCandidates() {
    const list = [];
    if (captured.size > 0) list.push(buildTemplate(captured.values().next().value));
    if (apiLink && apiToken) {
      list.push(`${apiLink}item/i-{page}.jpg?DownloadToken=${encodeURIComponent(apiToken)}`);
      list.push(`${apiLink}item/i-{page}.jpg?DownloadToken=${apiToken}`);
      list.push(`${apiLink}i-{page}.jpg?DownloadToken=${encodeURIComponent(apiToken)}`);
      list.push(`${apiLink}i-{page}.jpg?DownloadToken=${apiToken}`);
    }
    return [...new Set(list)];
  }

  async function resolveTemplate(probePage = 1) {
    if (resolvedTemplate) return resolvedTemplate;
    if (captured.size > 0) {
      resolvedTemplate = buildTemplate(captured.values().next().value);
      return resolvedTemplate;
    }
    for (const tmpl of templateCandidates()) {
      if (await checkPageExists(getPageUrl(tmpl, probePage))) {
        resolvedTemplate = tmpl;
        return tmpl;
      }
    }
    return null;
  }

  // ---------- 圖片收集邏輯 ----------
  function addUrl(url) {
    if (!url || typeof url !== 'string') return;
    const m = url.match(IMG_RE);
    if (!m) return;
    const page = parseInt(m[1], 10);
    const fullUrl = m[0];
    if (isTop) {
      const existing = captured.get(page);
      if (!existing || fullUrl.length > existing.length) {
        captured.set(page, fullUrl);
      }
    } else {
      try { window.top.postMessage({ __bk: 'url', url: fullUrl }, '*'); } catch (_) {}
    }
  }

  if (isTop) {
    window.addEventListener('message', (e) => {
      if (!e.origin.endsWith('.books.com.tw') && e.origin !== 'https://books.com.tw') return;
      if (e.data && e.data.__bk === 'url') addUrl(e.data.url);
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
    try { performance.getEntriesByType('resource').forEach(e => addUrl(e.name)); } catch (_) {}
  }

  new MutationObserver(scanAll).observe(document.documentElement || document, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['src', 'href', 'xlink:href'],
  });
  setInterval(scanAll, 1000);

  // ---------- 下載 ----------
  // 內容腳本無法存取 chrome.downloads（僅 background 可用），故含子目錄時
  // 經 background 用 chrome.downloads.download 建立真實資料夾結構；
  // 失敗或無子目錄則退回 <a download>（瀏覽器會把 / 濾掉，改為底線）。
  async function downloadPdf(bytes, filename) {
    const hasSubDir = filename.includes('/');
    if (hasSubDir) {
      try {
        const r = await bgSend({ type: 'DOWNLOAD_PDF', b64: bytesToB64(bytes), filename });
        if (r.ok) return;
      } catch (_) {}
      // background 下載失敗 → 退回扁平單檔
      anchorDownload(bytes, filename.replace(/\//g, '_'));
      return;
    }
    anchorDownload(bytes, filename);
  }

  function anchorDownload(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ---------- 目錄偵測 ----------
  function findChapterListUl(doc = document) {
    try {
      const ul = doc.getElementById('UiObj-panel-chapter-list');
      if (ul) return ul;
      for (const f of doc.querySelectorAll('iframe')) {
        try { if (f.contentDocument) { const r = findChapterListUl(f.contentDocument); if (r) return r; } } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  function readCurrentPages(doc = document, set = new Set()) {
    try {
      doc.querySelectorAll('img[src], image').forEach(el => {
        const u = readHref(el);
        const m = u && u.match(/\/i-(\d+)\.jpg/);
        if (m) set.add(parseInt(m[1], 10));
      });
      doc.querySelectorAll('iframe').forEach(f => {
        try { if (f.contentDocument) readCurrentPages(f.contentDocument, set); } catch (_) {}
      });
    } catch (_) {}
    return [...set].sort((a, b) => a - b);
  }

  function fireChapterClick(li) {
    const target = li.querySelector('span') || li;
    ['mousedown', 'mouseup', 'click'].forEach(type => {
      try { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); } catch (_) {}
    });
  }

  function liIndent(li) {
    const span = li.querySelector('span');
    if (!span) return 0;
    const m = (span.getAttribute('style') || '').match(/padding-left:\s*([\d.]+)/);
    if (m) return parseFloat(m[1]);
    const cs = parseFloat((span.ownerDocument.defaultView || window).getComputedStyle(span).paddingLeft);
    return Number.isFinite(cs) ? cs : 0;
  }

  function sanitizeName(s) {
    return (s || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'chapter';
  }

  function loadTocTree() {
    const ul = findChapterListUl();
    if (!ul) throw new Error('找不到目錄，請先在閱讀器點開「目錄」面板');
    const lis = Array.from(ul.querySelectorAll('li'));
    if (lis.length === 0) throw new Error('目錄是空的');
    const indents = lis.map(liIndent);
    const uniq = [...new Set(indents)].sort((a, b) => a - b);
    tocNodes = lis.map((li, idx) => ({
      idx, li,
      name: (li.textContent || '').trim().replace(/\s+/g, ' ') || `章節${idx + 1}`,
      indent: indents[idx],
      level: uniq.indexOf(indents[idx]),
    }));
    tocCollapsed.clear();
    tocSelected.clear();
    renderTocTree();
  }

  function nodePath(i) {
    const chain = [tocNodes[i].name];
    let ind = tocNodes[i].indent;
    for (let j = i - 1; j >= 0; j--) {
      if (tocNodes[j].indent < ind) {
        chain.unshift(tocNodes[j].name);
        ind = tocNodes[j].indent;
      }
    }
    return chain.map(sanitizeName).join('/');
  }

  function subtreeEnd(i) {
    const ind = tocNodes[i].indent;
    let j = i + 1;
    while (j < tocNodes.length && tocNodes[j].indent > ind) j++;
    return j;
  }
  function isParentNode(i) {
    return i + 1 < tocNodes.length && tocNodes[i + 1].indent > tocNodes[i].indent;
  }
  function isHidden(i) {
    for (const c of tocCollapsed) {
      if (i > c && i < subtreeEnd(c)) return true;
    }
    return false;
  }

  function renderTocTree() {
    const box = document.getElementById('bk-toc-tree');
    if (!box) return;
    box.innerHTML = '';
    tocNodes.forEach((n, i) => {
      if (isHidden(i)) return;
      const row = document.createElement('div');
      row.className = 'bk-toc-row';
      row.style.paddingLeft = (n.level * 14) + 'px';

      const tgl = document.createElement('span');
      tgl.className = 'bk-toc-tgl';
      if (isParentNode(i)) {
        tgl.innerHTML = icon(tocCollapsed.has(i) ? 'chevronRight' : 'chevronDown', 14);
        tgl.classList.add('bk-toc-tgl-on');
        tgl.addEventListener('click', () => {
          if (tocCollapsed.has(i)) tocCollapsed.delete(i); else tocCollapsed.add(i);
          renderTocTree();
        });
      }

      const cbWrap = document.createElement('label');
      cbWrap.className = 'bk-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = tocSelected.has(i);
      cb.addEventListener('change', () => {
        if (cb.checked) tocSelected.add(i); else tocSelected.delete(i);
        updateSelectedCount();
      });
      const box2 = document.createElement('span');
      box2.className = 'bk-check-box';
      box2.innerHTML = icon('check', 12);
      cbWrap.append(cb, box2);

      const lbl = document.createElement('span');
      lbl.className = 'bk-toc-name';
      lbl.textContent = n.name;
      lbl.addEventListener('click', () => { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); });

      row.append(tgl, cbWrap, lbl);
      box.appendChild(row);
    });
    updateSelectedCount();
  }

  function updateSelectedCount() {
    const el = document.getElementById('bk-toc-count');
    if (el) el.textContent = tocSelected.size;
  }

  async function detectPagesForIndices(indices, onProgress) {
    const map = new Map();
    let prevKey = readCurrentPages().join(',');
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      fireChapterClick(tocNodes[i].li);
      let pages = [];
      for (let t = 0; t < 20; t++) {
        await sleep(150);
        pages = readCurrentPages();
        if (pages.length && pages.join(',') !== prevKey) break;
      }
      if (!pages.length) pages = readCurrentPages();
      const pg = pages.length ? pages[0] : null;
      if (pages.length) prevKey = pages.join(',');
      map.set(i, pg);
      if (onProgress) onProgress(k + 1, indices.length, tocNodes[i].name, pg);
    }
    return map;
  }

  async function downloadSelectedToc(onProgress) {
    const sel = [...tocSelected].sort((a, b) => a - b);
    if (sel.length === 0) throw new Error('尚未勾選任何章節');
    const need = new Set();
    sel.forEach(i => { need.add(i); const e = subtreeEnd(i); if (e < tocNodes.length) need.add(e); });
    const pages = await detectPagesForIndices([...need].sort((a, b) => a - b), onProgress);

    const chapters = sel.map(i => {
      const e = subtreeEnd(i);
      const start = pages.get(i);
      const endPage = (e < tocNodes.length && pages.get(e) != null) ? pages.get(e) - 1 : NaN;
      return { name: nodePath(i), start, end: endPage };
    }).filter(c => Number.isFinite(c.start));

    if (chapters.length === 0) throw new Error('無法取得所選章節的頁碼');
    await downloadChapters(chapters);
  }

  async function fetchBookMeta() {
    const params = new URLSearchParams(window.location.search);
    const bookId = params.get('book_uni_id');
    if (!bookId) return;

    try {
      const data = await gmGet(
        `https://appapi-ebook.books.com.tw/V1.7/CMSAPIApp/BookInfo?book_uni_id=${encodeURIComponent(JSON.stringify([bookId]))}`
      );
      const info = data?.records?.[0]?.item_info;
      if (info?.c_title) { apiBookTitle = info.c_title; setUI('bk-whole-title', info.c_title); }
    } catch (_) {}

    try {
      const data = await gmGet(
        `https://appapi-ebook.books.com.tw/V1.7/CMSAPIApp/BookDownLoadURL?book_uni_id=${encodeURIComponent(bookId)}&t=${Date.now()}`
      );
      if (data.download_link && data.download_token) {
        apiLink = data.download_link;
        apiToken = data.download_token;
      }
    } catch (_) {}
  }

  function setUI(id, value) {
    const el = document.getElementById(id);
    if (el && !el.dataset.userEdited) el.value = value;
  }

  // ---------- UI（只在 top frame）----------
  if (!isTop) {
    if (document.body) scanAll();
    else document.addEventListener('DOMContentLoaded', scanAll);
    return;
  }

  // ---------- 圖示 ----------
  function icon(name, size = 20) {
    const paths = {
      book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
      close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
      check: '<path d="M20 6 9 17l-5-5"/>',
      download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
      chevronRight: '<path d="m9 18 6-6-6-6"/>',
      chevronDown: '<path d="m6 9 6 6 6-6"/>',
      plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    };
    return `<svg class="bk-ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
  }

  function appendLog(text, cls = '') {
    const log = document.getElementById('bk-log');
    if (!log) return;
    const div = document.createElement('div');
    div.className = 'bk-line ' + cls;
    const ic = cls === 'bk-ok' ? icon('check', 14) : cls === 'bk-err' ? icon('close', 14) : '';
    div.innerHTML = ic + '<span></span>';
    div.querySelector('span').textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function setStatus(text) {
    const el = document.getElementById('bk-status');
    if (el) el.textContent = text || '';
  }

  function setProgress(ratio) {
    const bar = document.getElementById('bk-bar');
    const wrap = document.getElementById('bk-progress');
    if (!bar) return;
    if (ratio == null) {
      if (wrap) wrap.classList.add('bk-indet');
      bar.style.width = '40%';
    } else {
      if (wrap) wrap.classList.remove('bk-indet');
      bar.style.width = `${Math.round(ratio * 100)}%`;
    }
  }

  async function withProgress(btn, fn) {
    const prog = document.getElementById('bk-progress');
    if (btn) btn.style.display = 'none';
    if (prog) prog.style.display = 'block';
    setProgress(null);
    setStatus('準備中…');
    try {
      await fn();
    } catch (e) {
      setStatus('✗ ' + (e && e.message ? e.message : '發生錯誤'));
      await new Promise(r => setTimeout(r, 1500));
    } finally {
      if (prog) prog.style.display = 'none';
      setProgress(0);
      setStatus('');
      if (btn) btn.style.display = '';
    }
  }

  async function downloadChapters(chapters, filenameOverride = null, folder = undefined) {
    if (chapters.length === 0) {
      appendLog('請填寫至少一個章節的起始與結束頁。', 'bk-err');
      return;
    }
    if (templateCandidates().length === 0) {
      appendLog('尚未取得圖片網址，請等候 API 偵測或翻幾頁後再試。', 'bk-err');
      return;
    }
    const template = await resolveTemplate(chapters[0].start || 1);
    if (!template) {
      appendLog('無法存取任何圖片頁，請確認登入狀態或閱讀權限。', 'bk-err');
      return;
    }

    document.getElementById('bk-log').innerHTML = '';
    const hasFixedEnd = chapters.every(c => !isNaN(c.end));
    const totalPages = hasFixedEnd ? chapters.reduce((s, c) => s + (c.end - c.start + 1), 0) : 0;
    const MAX_MISS = 2;
    let done = 0;
    let okCount = 0;

    for (let ci = 0; ci < chapters.length; ci++) {
      const ch = chapters[ci];
      const shortName = String(ch.name).split('/').pop();
      const fixedEnd = !isNaN(ch.end);
      const pdfDoc = await PDFLib.PDFDocument.create();
      let added = 0;
      let consecutiveMiss = 0;
      let page = ch.start;

      while (true) {
        if (fixedEnd && page > ch.end) break;
        let ok = false;
        try {
          const bytes = await fetchImage(getPageUrl(template, page));
          const img = await pdfDoc.embedJpg(bytes);
          const p = pdfDoc.addPage([img.width, img.height]);
          p.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
          ok = true;
          added++;
        } catch (e) {
          if (!fixedEnd) {
            consecutiveMiss++;
            if (consecutiveMiss >= MAX_MISS) break;
            page++;
            continue;
          }
        }
        if (ok) consecutiveMiss = 0;
        done++;
        if (hasFixedEnd) setProgress(done / totalPages);
        else setProgress(null);
        setStatus(chapters.length > 1
          ? `下載中 ${ci + 1}/${chapters.length}：${shortName}（${added} 頁）`
          : `下載中：${shortName}（${added} 頁）`);
        page++;
      }

      if (added === 0) {
        appendLog(`${shortName}：無法取得頁面`, 'bk-err');
        continue;
      }

      try {
        const pdfBytes = await pdfDoc.save();
        const uiTitle = (document.getElementById('bk-whole-title') || {}).value?.trim() || '';
        const bookTitle = uiTitle || apiBookTitle || '';
        const dir = folder === undefined ? (bookTitle ? sanitizeName(bookTitle) + '/' : '') : (folder ? folder + '/' : '');
        const fname = `${dir}${filenameOverride || ch.name}.pdf`;
        await downloadPdf(pdfBytes, fname);
        okCount++;
      } catch (e) {
        appendLog(`${shortName}：PDF 產生失敗`, 'bk-err');
      }
    }

    setProgress(1);
  }

  function addChapterRow(name = '', start = '', end = '') {
    const tbody = document.getElementById('bk-tbody');
    if (!tbody) return;
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td><input class="bk-in bk-name" placeholder="章節名"></td>` +
      `<td><input class="bk-in bk-start" type="number" placeholder="1" min="1"></td>` +
      `<td><input class="bk-in bk-end" type="number" placeholder="50" min="1"></td>` +
      `<td><button class="bk-del" title="刪除">${icon('close', 16)}</button></td>`;
    tr.querySelector('.bk-name').value = name;
    tr.querySelector('.bk-start').value = start;
    tr.querySelector('.bk-end').value = end;
    tr.querySelector('.bk-del').addEventListener('click', () => { tr.remove(); updateChapterThead(); });
    tbody.appendChild(tr);
    updateChapterThead();
  }

  function updateChapterThead() {
    const thead = document.getElementById('bk-thead');
    const tbody = document.getElementById('bk-tbody');
    if (thead && tbody) thead.style.display = tbody.children.length ? '' : 'none';
  }

  const PANEL_CSS = `
    #bk-fab, #bk-panel, #bk-panel * { box-sizing:border-box; }
    #bk-fab {
      position:fixed!important;bottom:24px!important;right:24px!important;z-index:2147483647!important;
      width:56px!important;height:56px!important;border-radius:50%!important;background:#171717!important;color:#fff!important;
      border:none!important;cursor:pointer!important;box-shadow:0 6px 20px rgba(0,0,0,.18)!important;
      display:flex!important;align-items:center!important;justify-content:center!important;
      visibility:visible!important;opacity:1!important;overflow:visible!important;
      transition:transform .15s, background .15s;
    }
    #bk-fab:hover{background:#000!important;transform:translateY(-1px)}
    #bk-fab:active{transform:scale(.94)}
    #bk-panel {
      position:fixed!important;bottom:92px!important;right:24px!important;z-index:2147483646!important;
      width:400px;max-width:calc(100vw - 32px);max-height:84vh;overflow-y:auto;
      background:#fff;color:#171717;border:1px solid #e5e5e5;
      border-radius:16px;padding:18px;
      font-family:"Plus Jakarta Sans",-apple-system,"Segoe UI","PingFang TC",sans-serif;
      font-size:15px;line-height:1.55;box-shadow:0 12px 40px rgba(0,0,0,.14);display:none;
    }
    #bk-panel .bk-ic{display:block;flex:none}
    #bk-panel .bk-head{display:flex;align-items:center;gap:9px;margin-bottom:14px}
    #bk-panel .bk-head-ic{width:30px;height:30px;border-radius:8px;background:#171717;color:#fff;
      display:flex;align-items:center;justify-content:center;flex:none}
    #bk-panel .bk-head h3{margin:0;font-size:17px;font-weight:700;letter-spacing:-.01em;flex:1}
    #bk-panel .bk-close{width:30px;height:30px;border:none;background:transparent;color:#9ca3af;
      border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.15s}
    #bk-panel .bk-close:hover{background:#f3f4f6;color:#171717}
    #bk-panel .bk-hint{color:#6b7280;font-size:13.5px;margin:2px 0 12px}
    #bk-panel .bk-switch{position:relative;display:flex;background:#f3f4f6;border-radius:11px;padding:4px;margin-bottom:14px}
    #bk-panel .bk-switch-thumb{position:absolute;top:4px;left:4px;width:calc(50% - 4px);height:calc(100% - 8px);
      background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.12);
      transition:transform .22s cubic-bezier(.4,0,.2,1)}
    #bk-panel .bk-switch[data-active="1"] .bk-switch-thumb{transform:translateX(100%)}
    #bk-panel .bk-seg{position:relative;z-index:1;flex:1;border:none;background:transparent;cursor:pointer;
      padding:8px 0;font-size:14px;font-weight:600;color:#6b7280;transition:color .2s;font-family:inherit}
    #bk-panel .bk-seg.active{color:#171717}
    #bk-panel .bk-sec{display:none}#bk-panel .bk-sec.active{display:block}
    #bk-panel .bk-field{margin:12px 0}
    #bk-panel .bk-flabel{font-size:13px;font-weight:600;color:#374151;margin-bottom:5px}
    #bk-panel .bk-finput{width:100%;background:#fff;border:1px solid #e5e5e5;border-radius:10px;
      color:#171717;padding:10px 12px;font-size:15px;font-family:inherit;transition:border .15s, box-shadow .15s}
    #bk-panel .bk-finput::placeholder{color:#9ca3af}
    #bk-panel .bk-finput:focus{outline:none;border-color:#171717;box-shadow:0 0 0 3px rgba(23,23,23,.08)}
    #bk-panel .bk-end-hint{font-size:12.5px;color:#6b7280;margin-top:6px;display:none}
    #bk-panel input[type=number].bk-finput, #bk-panel input[type=number].bk-in{-moz-appearance:textfield;appearance:textfield}
    #bk-panel input[type=number].bk-finput::-webkit-outer-spin-button,
    #bk-panel input[type=number].bk-finput::-webkit-inner-spin-button,
    #bk-panel input[type=number].bk-in::-webkit-outer-spin-button,
    #bk-panel input[type=number].bk-in::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
    #bk-panel table{width:100%;border-collapse:collapse;margin:6px 0 8px}
    #bk-panel th{color:#6b7280;font-size:12px;font-weight:600;padding:4px;text-align:left}
    #bk-panel td{padding:3px 4px}
    #bk-panel .bk-in{width:100%;background:#fff;border:1px solid #e5e5e5;border-radius:8px;
      color:#171717;padding:7px 9px;font-size:14px;font-family:inherit}
    #bk-panel .bk-in:focus{outline:none;border-color:#171717;box-shadow:0 0 0 3px rgba(23,23,23,.07)}
    #bk-panel .bk-del{background:transparent;color:#9ca3af;border:none;cursor:pointer;padding:5px;
      border-radius:7px;display:flex;align-items:center;justify-content:center;transition:.15s}
    #bk-panel .bk-del:hover{background:#fef2f2;color:#dc2626}
    #bk-panel .bk-btn{border:none;border-radius:11px;padding:10px 16px;font-size:14.5px;font-weight:600;
      cursor:pointer;transition:.15s;font-family:inherit;display:inline-flex;align-items:center;
      justify-content:center;gap:7px}
    #bk-panel .bk-primary{background:#171717;color:#fff;width:100%;padding:13px}
    #bk-panel .bk-primary:hover{background:#000}
    #bk-panel .bk-primary:active{transform:scale(.985)}
    #bk-panel .bk-secondary{background:#fff;color:#171717;border:1px solid #e5e5e5;width:100%}
    #bk-panel .bk-secondary:hover{background:#f9fafb;border-color:#d1d5db}
    #bk-panel .bk-btn:disabled{opacity:.45;cursor:not-allowed}
    #bk-panel #bk-progress{display:none;margin-top:14px}
    #bk-panel .bk-progress-bar{height:6px;background:#f0f0f1;border-radius:99px;overflow:hidden}
    #bk-panel #bk-bar{height:100%;width:0;background:#171717;border-radius:99px;transition:width .25s ease}
    #bk-panel #bk-progress.bk-indet #bk-bar{animation:bk-indet 1.1s ease-in-out infinite}
    @keyframes bk-indet{0%{margin-left:-40%}100%{margin-left:100%}}
    #bk-panel #bk-status{font-size:13px;color:#374151;margin-top:8px;text-align:center;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #bk-panel #bk-log{margin-top:12px;display:flex;flex-direction:column;gap:3px}
    #bk-panel #bk-log:empty{display:none}
    #bk-panel .bk-line{display:flex;align-items:center;gap:6px;font-size:13px;color:#374151;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #bk-panel .bk-line span{overflow:hidden;text-overflow:ellipsis}
    #bk-panel .bk-ok{color:#15803d}#bk-panel .bk-err{color:#dc2626}
    #bk-panel .bk-toc-actions{display:flex;align-items:center;gap:6px;margin:12px 0 8px;flex-wrap:wrap}
    #bk-panel .bk-mini{background:#fff;color:#374151;border:1px solid #e5e5e5;border-radius:8px;
      font-size:12.5px;padding:5px 10px;cursor:pointer;font-family:inherit;transition:.15s}
    #bk-panel .bk-mini:hover{background:#f9fafb;border-color:#d1d5db}
    #bk-panel .bk-toc-selinfo{font-size:12.5px;color:#6b7280;margin-left:auto}
    #bk-panel .bk-toc-selinfo b{color:#171717}
    #bk-panel .bk-toc-tree{max-height:260px;overflow-y:auto;background:#fafafa;border:1px solid #e5e5e5;
      border-radius:12px;padding:8px;margin:6px 0 10px}
    #bk-panel .bk-toc-row{display:flex;align-items:center;gap:7px;padding:4px 4px;border-radius:7px;font-size:14px}
    #bk-panel .bk-toc-row:hover{background:#f0f0f1}
    #bk-panel .bk-toc-tgl{width:16px;height:16px;display:flex;align-items:center;justify-content:center;
      color:#9ca3af;flex:none}
    #bk-panel .bk-toc-tgl-on{cursor:pointer;border-radius:5px}
    #bk-panel .bk-toc-tgl-on:hover{background:#e5e7eb;color:#171717}
    #bk-panel .bk-toc-name{cursor:pointer;color:#171717;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
    #bk-panel .bk-check{position:relative;display:flex;flex:none;cursor:pointer}
    #bk-panel .bk-check input{position:absolute;opacity:0;width:0;height:0}
    #bk-panel .bk-check-box{width:19px;height:19px;border:1.5px solid #d1d5db;border-radius:6px;background:#fff;
      display:flex;align-items:center;justify-content:center;color:#fff;transition:.15s}
    #bk-panel .bk-check-box .bk-ic{opacity:0;transition:opacity .12s}
    #bk-panel .bk-check input:checked + .bk-check-box{background:#171717;border-color:#171717}
    #bk-panel .bk-check input:checked + .bk-check-box .bk-ic{opacity:1}
    #bk-panel .bk-check input:focus-visible + .bk-check-box{box-shadow:0 0 0 3px rgba(23,23,23,.15)}
    #bk-panel .bk-adv{margin-top:14px;border-top:1px solid #eee;padding-top:10px}
    #bk-panel .bk-adv summary{font-size:13.5px;color:#6b7280;cursor:pointer;user-select:none;list-style:none}
    #bk-panel .bk-adv summary::-webkit-details-marker{display:none}
    #bk-panel .bk-adv summary:hover{color:#171717}
    #bk-panel .bk-adv summary::before{content:"›";display:inline-block;margin-right:6px;transition:transform .2s}
    #bk-panel .bk-adv[open] summary::before{transform:rotate(90deg)}
    #bk-panel ::-webkit-scrollbar, #bk-panel::-webkit-scrollbar{width:9px;height:9px}
    #bk-panel ::-webkit-scrollbar-thumb, #bk-panel::-webkit-scrollbar-thumb{
      background:#d4d4d8;border-radius:99px;border:2px solid transparent;background-clip:content-box}
    #bk-panel ::-webkit-scrollbar-thumb:hover, #bk-panel::-webkit-scrollbar-thumb:hover{background:#a1a1aa;background-clip:content-box}
    #bk-panel ::-webkit-scrollbar-track, #bk-panel::-webkit-scrollbar-track{background:transparent}
    @media (prefers-reduced-motion: reduce){
      #bk-panel *, #bk-fab{transition:none!important;animation:none!important}
    }
  `;

  const PANEL_HTML = `
    <div class="bk-head">
      <span class="bk-head-ic">${icon('book', 18)}</span>
      <h3>電子書下載</h3>
      <button class="bk-close" id="bk-close" title="關閉">${icon('close', 18)}</button>
    </div>

    <div class="bk-switch" id="bk-switch" data-active="0">
      <span class="bk-switch-thumb"></span>
      <button class="bk-seg active" data-tab="whole">整本下載</button>
      <button class="bk-seg" data-tab="chapter">分章節下載</button>
    </div>

    <div class="bk-sec active" id="bk-sec-whole">
      <div class="bk-field">
        <div class="bk-flabel">書名（檔名）</div>
        <input class="bk-finput" id="bk-whole-title" placeholder="書名">
      </div>
      <div class="bk-field">
        <div class="bk-flabel">結束頁（書本總頁數）</div>
        <input class="bk-finput" id="bk-whole-end" type="number" min="1" placeholder="留空 = 自動下載至結尾">
        <div class="bk-end-hint" id="bk-whole-end-hint"></div>
      </div>
      <button class="bk-btn bk-primary" id="bk-whole-btn">${icon('download', 18)}下載整本 PDF</button>
    </div>

    <div class="bk-sec" id="bk-sec-chapter">
      <p class="bk-hint" id="bk-toc-hint">請在閱讀器點開「目錄」面板，目錄將自動載入。</p>
      <div id="bk-toc-wrap" style="display:none">
        <div class="bk-toc-actions">
          <button class="bk-mini" id="bk-toc-all">全選</button>
          <button class="bk-mini" id="bk-toc-none">全不選</button>
          <button class="bk-mini" id="bk-toc-top">只選最上層</button>
          <button class="bk-mini" id="bk-toc-collapse">全部收合</button>
          <span class="bk-toc-selinfo">已選 <b id="bk-toc-count">0</b></span>
        </div>
        <div id="bk-toc-tree" class="bk-toc-tree"></div>
        <button class="bk-btn bk-primary" id="bk-dl-selected">${icon('download', 18)}下載所選章節</button>
      </div>

      <details class="bk-adv">
        <summary>進階：手動輸入頁碼範圍</summary>
        <table><thead id="bk-thead" style="display:none"><tr><th>名稱</th><th>起始頁</th><th>結束頁</th><th></th></tr></thead>
          <tbody id="bk-tbody"></tbody></table>
        <button class="bk-btn bk-secondary" id="bk-add">${icon('plus', 16)}新增章節</button>
        <button class="bk-btn bk-primary" id="bk-chapter-btn" style="margin-top:8px">${icon('download', 18)}下載手動章節</button>
      </details>
    </div>

    <div id="bk-progress">
      <div class="bk-progress-bar"><div id="bk-bar"></div></div>
      <div id="bk-status"></div>
    </div>
    <div id="bk-log"></div>
  `;

  let togglePanel = null;

  function initUI() {
    if (document.getElementById('bk-fab')) return;

    const style = document.createElement('style');
    style.id = 'bk-style';
    style.textContent = PANEL_CSS;
    document.documentElement.appendChild(style);

    const fab = document.createElement('button');
    fab.id = 'bk-fab'; fab.title = '電子書下載工具';
    fab.innerHTML = icon('book', 26);
    document.documentElement.appendChild(fab);

    const panel = document.createElement('div');
    panel.id = 'bk-panel';
    panel.innerHTML = PANEL_HTML;
    document.documentElement.appendChild(panel);

    const sw = document.getElementById('bk-switch');
    sw.querySelectorAll('.bk-seg').forEach((btn, i) => {
      btn.addEventListener('click', () => {
        sw.dataset.active = String(i);
        sw.querySelectorAll('.bk-seg').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        document.getElementById('bk-sec-whole').classList.toggle('active', tab === 'whole');
        document.getElementById('bk-sec-chapter').classList.toggle('active', tab === 'chapter');
      });
    });

    let open = false;
    togglePanel = (show) => {
      open = show != null ? show : !open;
      panel.style.display = open ? 'block' : 'none';
      if (open) scanAll();
    };
    fab.addEventListener('click', () => togglePanel());
    document.getElementById('bk-close').addEventListener('click', () => togglePanel(false));

    ['bk-whole-title', 'bk-whole-end'].forEach(id => {
      document.addEventListener('input', (e) => {
        if (e.target.id === id) e.target.dataset.userEdited = '1';
      });
    });

    if (apiBookTitle) setUI('bk-whole-title', apiBookTitle);

    document.getElementById('bk-add').addEventListener('click', () => addChapterRow());
    document.querySelector('.bk-adv').addEventListener('toggle', function () {
      if (this.open && !document.getElementById('bk-tbody').children.length) addChapterRow();
    });

    document.getElementById('bk-whole-btn').addEventListener('click', () => {
      const btn = document.getElementById('bk-whole-btn');
      const title = document.getElementById('bk-whole-title').value.trim() || 'ebook';
      const endVal = document.getElementById('bk-whole-end').value.trim();
      const end = endVal ? parseInt(endVal, 10) : NaN;
      const ch = isNaN(end) ? { name: title, start: 1, end: NaN } : { name: title, start: 1, end };
      withProgress(btn, () => downloadChapters([ch], title, ''));
    });

    (function startTocPoll() {
      const timer = setInterval(() => {
        try {
          loadTocTree();
          clearInterval(timer);
          document.getElementById('bk-toc-wrap').style.display = '';
          document.getElementById('bk-toc-hint').style.display = 'none';
        } catch (_) {}
      }, 800);
    })();

    document.getElementById('bk-toc-all').addEventListener('click', () => {
      tocNodes.forEach((_, i) => tocSelected.add(i)); renderTocTree();
    });
    document.getElementById('bk-toc-none').addEventListener('click', () => {
      tocSelected.clear(); renderTocTree();
    });
    document.getElementById('bk-toc-top').addEventListener('click', () => {
      tocSelected.clear();
      tocNodes.forEach((n, i) => { if (n.level === 0) tocSelected.add(i); });
      renderTocTree();
    });
    document.getElementById('bk-toc-collapse').addEventListener('click', () => {
      tocCollapsed.clear();
      tocNodes.forEach((_, i) => { if (isParentNode(i)) tocCollapsed.add(i); });
      renderTocTree();
    });

    document.getElementById('bk-dl-selected').addEventListener('click', () => {
      const btn = document.getElementById('bk-dl-selected');
      withProgress(btn, () => downloadSelectedToc((done, total, name) => {
        setStatus(`偵測頁碼 ${done}/${total}：${String(name).split('/').pop()}`);
      }));
    });

    document.getElementById('bk-chapter-btn').addEventListener('click', () => {
      const rows = document.querySelectorAll('#bk-tbody tr');
      const chapters = Array.from(rows).map((tr, i) => ({
        name: tr.querySelector('.bk-name').value.trim() || `chapter${i + 1}`,
        start: parseInt(tr.querySelector('.bk-start').value, 10),
        end: parseInt(tr.querySelector('.bk-end').value, 10),
      })).filter(ch => !isNaN(ch.start) && !isNaN(ch.end) && ch.end >= ch.start);
      const btn = document.getElementById('bk-chapter-btn');
      withProgress(btn, () => downloadChapters(chapters));
    });
  }

  function boot() {
    if (new URLSearchParams(window.location.search).get('readlist')) return;
    initUI();
    scanAll();
    if (window.location.hostname.includes('viewer-ebook')) {
      fetchBookMeta();
    }
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);

  // SPA 清空 body 時重新注入 FAB
  new MutationObserver(() => {
    if (!chrome.runtime?.id) return;
    if (!document.getElementById('bk-fab') && !new URLSearchParams(window.location.search).get('readlist')) {
      initUI();
    }
  }).observe(document.documentElement, { childList: true });

  // 工具列圖示點擊 → 開關面板
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'TOGGLE_PANEL' && togglePanel) togglePanel();
  });
})();
