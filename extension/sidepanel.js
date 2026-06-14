'use strict';

const { PDFDocument } = PDFLib;

// ---------- 工具函式 ----------
function buildTemplate(sampleUrl) { return sampleUrl.replace(/\/i-\d+\.jpg/, '/i-{page}.jpg'); }
function formatPage(n) { return String(n).padStart(3, '0'); }
function getPageUrl(template, n) { return template.replace('{page}', formatPage(n)); }

function sanitizeName(s) {
  return (s || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'chapter';
}

// ---------- 圖示（Lucide 風格 inline SVG）----------
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

// ---------- 狀態 ----------
let capturedImages = {};       // url → pageNum
let downloadLink = null;
let downloadToken = null;
let resolvedTemplate = null;
let bookTitle = null;
let tocNodes = [];             // [{idx, name, indent, level}] — serializable, no DOM refs
const tocCollapsed = new Set();
const tocSelected = new Set();
let detectingPages = false;

// ---------- Template 候選 ----------
function templateCandidates() {
  const list = [];
  const urls = Object.keys(capturedImages);
  if (urls.length > 0) list.push(buildTemplate(urls[0]));
  if (downloadLink && downloadToken) {
    list.push(`${downloadLink}item/i-{page}.jpg?DownloadToken=${encodeURIComponent(downloadToken)}`);
    list.push(`${downloadLink}item/i-{page}.jpg?DownloadToken=${downloadToken}`);
    list.push(`${downloadLink}i-{page}.jpg?DownloadToken=${encodeURIComponent(downloadToken)}`);
    list.push(`${downloadLink}i-{page}.jpg?DownloadToken=${downloadToken}`);
  }
  return [...new Set(list)];
}

async function pageExists(url) {
  try {
    const r = await fetch(url);
    return r.status === 200;
  } catch {
    return false;
  }
}

async function resolveTemplate(probePage = 1) {
  if (resolvedTemplate) return resolvedTemplate;
  const capturedUrls = Object.keys(capturedImages);
  if (capturedUrls.length > 0) {
    resolvedTemplate = buildTemplate(capturedUrls[0]);
    return resolvedTemplate;
  }
  for (const tmpl of templateCandidates()) {
    if (await pageExists(getPageUrl(tmpl, probePage))) {
      resolvedTemplate = tmpl;
      return tmpl;
    }
  }
  return null;
}

// ---------- TOC 樹狀輔助 ----------
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

function applyTocNodes(nodes) {
  tocNodes = nodes || [];
  tocCollapsed.clear();
  tocSelected.clear();
  document.getElementById('bk-toc-wrap').style.display = '';
  document.getElementById('bk-toc-hint').style.display = 'none';
  renderTocTree();
}

// ---------- Page detection via content script ----------
async function detectPagesViaContentScript(indices) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) throw new Error('找不到閱讀器分頁');
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabs[0].id, { type: 'DETECT_PAGES', indices }, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res?.pages || {});
    });
  });
}

// ---------- 下載所選章節 ----------
async function downloadSelectedToc() {
  const sel = [...tocSelected].sort((a, b) => a - b);
  if (sel.length === 0) throw new Error('尚未勾選任何章節');

  // Indices needed: each selected node + the boundary node after its subtree
  const need = new Set();
  sel.forEach(i => { need.add(i); const e = subtreeEnd(i); if (e < tocNodes.length) need.add(e); });
  const sortedNeed = [...need].sort((a, b) => a - b);

  setStatus(`偵測頁碼 0/${sortedNeed.length}…`);
  setProgress(null);

  const pagesMap = await detectPagesViaContentScript(sortedNeed);

  const chapters = sel.map(i => {
    const e = subtreeEnd(i);
    const start = pagesMap[i];
    const endPage = (e < tocNodes.length && pagesMap[e] != null) ? pagesMap[e] - 1 : NaN;
    return { name: nodePath(i), start, end: endPage };
  }).filter(c => Number.isFinite(c.start));

  if (chapters.length === 0) throw new Error('無法取得所選章節的頁碼');
  await downloadChapters(chapters);
}

// ---------- 進度 UI ----------
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

// ---------- 章節表格 ----------
function addChapterRow(name = '', start = '', end = '') {
  const tbody = document.getElementById('bk-tbody');
  if (!tbody) return;
  const tr = document.createElement('tr');
  tr.innerHTML =
    `<td><input class="bk-in bk-name" value="${name}" placeholder="章節名"></td>` +
    `<td><input class="bk-in bk-start" type="number" value="${start}" placeholder="1" min="1"></td>` +
    `<td><input class="bk-in bk-end" type="number" value="${end}" placeholder="50" min="1"></td>` +
    `<td><button class="bk-del" title="刪除">${icon('close', 16)}</button></td>`;
  tr.querySelector('.bk-del').addEventListener('click', () => { tr.remove(); updateChapterThead(); });
  tbody.appendChild(tr);
  updateChapterThead();
}

function updateChapterThead() {
  const thead = document.getElementById('bk-thead');
  const tbody = document.getElementById('bk-tbody');
  if (thead && tbody) thead.style.display = tbody.children.length ? '' : 'none';
}

// ---------- 偵測總頁數 ----------
async function detectTotalPages() {
  if (detectingPages) return;
  detectingPages = true;

  const hintEl = document.getElementById('bk-whole-end-hint');
  if (hintEl) { hintEl.textContent = '自動偵測中…'; hintEl.style.display = 'block'; }

  try {
    const template = await resolveTemplate();
    if (!template) {
      if (hintEl) { hintEl.textContent = '偵測失敗，請手動輸入'; hintEl.style.display = 'block'; }
      return;
    }
    let low = 1, high = 9999;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (await pageExists(getPageUrl(template, mid))) low = mid;
      else high = mid - 1;
    }
    setUI('bk-whole-end', String(low));
    if (hintEl) { hintEl.textContent = `自動偵測：共 ${low} 頁`; hintEl.style.display = 'block'; }
  } catch (_) {
    if (hintEl) { hintEl.textContent = '偵測失敗，請手動輸入'; hintEl.style.display = 'block'; }
  } finally {
    detectingPages = false;
  }
}

function setUI(id, value) {
  const el = document.getElementById(id);
  if (el && !el.dataset.userEdited) el.value = value;
}

// ---------- 核心下載 ----------
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
    const pdfDoc = await PDFDocument.create();
    let errors = 0;
    let added = 0;
    let consecutiveMiss = 0;
    let page = ch.start;

    while (true) {
      if (fixedEnd && page > ch.end) break;
      let ok = false;
      try {
        const resp = await fetch(getPageUrl(template, page));
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const bytes = await resp.arrayBuffer();
        const img = await pdfDoc.embedJpg(bytes);
        const p = pdfDoc.addPage([img.width, img.height]);
        p.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        ok = true;
        added++;
      } catch (e) {
        if (fixedEnd) { errors++; }
        else {
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
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const blobUrl = URL.createObjectURL(blob);
      // folder === undefined → use bookTitle as subfolder; '' → no subfolder
      const dir = folder === undefined
        ? (bookTitle ? sanitizeName(bookTitle) + '/' : '')
        : (folder ? folder + '/' : '');
      const filename = `${dir}${filenameOverride || ch.name}.pdf`;
      await chrome.downloads.download({ url: blobUrl, filename, saveAs: false });
      setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
      okCount++;
      appendLog(shortName, 'bk-ok');
    } catch (e) {
      appendLog(`${shortName}：PDF 產生失敗`, 'bk-err');
    }
  }

  setProgress(1);
  setStatus(`完成，共 ${okCount} 個 PDF`);
  await new Promise(r => setTimeout(r, 900));
}

// ---------- Session storage 初始化 ----------
chrome.storage.session.get(
  ['capturedImages', 'bookTitle', 'downloadLink', 'downloadToken', 'estimatedTotal', 'tocNodes'],
  (data) => {
    if (data.capturedImages) {
      capturedImages = data.capturedImages;
      resolvedTemplate = null; // reset so next resolveTemplate picks up fresh URLs
    }
    if (data.bookTitle) {
      bookTitle = data.bookTitle;
      setUI('bk-whole-title', bookTitle);
    }
    if (data.estimatedTotal) {
      const hintEl = document.getElementById('bk-whole-end-hint');
      if (hintEl) { hintEl.textContent = `依閱讀進度估算：約 ${data.estimatedTotal} 頁`; hintEl.style.display = 'block'; }
    }
    if (data.downloadLink && data.downloadToken) {
      downloadLink = data.downloadLink;
      downloadToken = data.downloadToken;
      detectTotalPages();
    }
    if (data.tocNodes && data.tocNodes.length > 0) {
      applyTocNodes(data.tocNodes);
    }
  }
);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;

  if (changes.capturedImages) {
    capturedImages = changes.capturedImages.newValue || {};
    resolvedTemplate = null;
  }
  if (changes.bookTitle) {
    bookTitle = changes.bookTitle.newValue;
    setUI('bk-whole-title', bookTitle);
  }
  if (changes.estimatedTotal) {
    const hintEl = document.getElementById('bk-whole-end-hint');
    if (hintEl && !document.getElementById('bk-whole-end')?.dataset.userEdited) {
      hintEl.textContent = `依閱讀進度估算：約 ${changes.estimatedTotal.newValue} 頁`;
      hintEl.style.display = 'block';
    }
  }
  if (changes.downloadLink || changes.downloadToken) {
    const link = changes.downloadLink?.newValue || downloadLink;
    const token = changes.downloadToken?.newValue || downloadToken;
    if (link && token && !(downloadLink && downloadToken)) {
      downloadLink = link;
      downloadToken = token;
      detectTotalPages();
    } else {
      if (changes.downloadLink) downloadLink = changes.downloadLink.newValue;
      if (changes.downloadToken) downloadToken = changes.downloadToken.newValue;
    }
  }
  if (changes.tocNodes) {
    const nodes = changes.tocNodes.newValue;
    if (nodes && nodes.length > 0) applyTocNodes(nodes);
  }
});

// ---------- DOM 就緒後初始化 UI ----------
document.addEventListener('DOMContentLoaded', () => {
  // Inject SVG icons into buttons
  document.getElementById('bk-head-ic') && (document.querySelector('.bk-head-ic').innerHTML = icon('book', 18));
  document.querySelector('.bk-head-ic').innerHTML = icon('book', 18);
  document.getElementById('bk-whole-btn').innerHTML = icon('download', 18) + '下載整本 PDF';
  document.getElementById('bk-dl-selected').innerHTML = icon('download', 18) + '下載所選章節';
  document.getElementById('bk-add').innerHTML = icon('plus', 16) + '新增章節';
  document.getElementById('bk-chapter-btn').innerHTML = icon('download', 18) + '下載手動章節';

  // Mark user edits
  ['bk-whole-title', 'bk-whole-end'].forEach(id => {
    document.addEventListener('input', (e) => {
      if (e.target.id === id) e.target.dataset.userEdited = '1';
    });
  });

  // Segmented switch
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

  // Whole book download
  document.getElementById('bk-whole-btn').addEventListener('click', () => {
    const btn = document.getElementById('bk-whole-btn');
    const title = document.getElementById('bk-whole-title').value.trim() || 'ebook';
    const endVal = document.getElementById('bk-whole-end').value.trim();
    const end = endVal ? parseInt(endVal, 10) : NaN;
    const ch = isNaN(end) ? { name: title, start: 1, end: NaN } : { name: title, start: 1, end };
    withProgress(btn, () => downloadChapters([ch], title, ''));
  });

  // TOC actions
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

  // Download selected TOC chapters
  document.getElementById('bk-dl-selected').addEventListener('click', () => {
    const btn = document.getElementById('bk-dl-selected');
    withProgress(btn, () => downloadSelectedToc());
  });

  // Manual chapter table
  document.getElementById('bk-add').addEventListener('click', () => addChapterRow());

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
});
