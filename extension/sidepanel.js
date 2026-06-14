const { PDFDocument } = PDFLib;

// ---------- 工具函式 ----------
function buildTemplate(sampleUrl) {
  return sampleUrl.replace(/\/i-\d+\.jpg/, '/i-{page}.jpg');
}
function formatPage(n) { return String(n).padStart(3, '0'); }
function getPageUrl(template, n) { return template.replace('{page}', formatPage(n)); }

// ---------- 狀態 ----------
let capturedImages = {};
let downloadLink = null;
let downloadToken = null;
let resolvedTemplate = null; // 探測後確認可用的 template

// 候選 template（依可信度排序）：已掃描到的真實 URL > API item/ > API root
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

// 找出可用的 template（快取）
// DOM 掃描到的 URL 必然可用，直接採用；否則才探測 API 候選
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

// ---------- UI 更新 ----------
function updateDetection(images) {
  capturedImages = images || {};
  const count = Object.keys(capturedImages).length;
  document.getElementById('img-count').textContent = count;

  const hint = document.getElementById('detect-hint');
  const domRangeEl = document.getElementById('dom-range');
  if (count === 0) {
    hint.textContent = '請開啟博客來電子書閱讀器並翻幾頁…';
    hint.hidden = false;
    if (domRangeEl) domRangeEl.hidden = true;
    return;
  }
  const pages = Object.values(capturedImages);
  if (domRangeEl) {
    domRangeEl.textContent = `DOM 掃描：第 ${Math.min(...pages)}～${Math.max(...pages)} 頁`;
    domRangeEl.hidden = false;
  }
  hint.textContent = '翻更多頁可取得更完整範圍。';
  hint.hidden = false;
}

function applyDownloadInfo(link, token) {
  downloadLink = link;
  downloadToken = token;
  document.getElementById('api-badge').hidden = false;
  // 探測可用 template，再 binary search 找末頁
  detectTotalPages();
}

function applyBookTitle(title) {
  const el = document.getElementById('whole-title');
  if (el && !el.dataset.userEdited) el.value = title;
}

function setWholePagesHint(text) {
  const el = document.getElementById('whole-end-hint');
  if (el) { el.textContent = text; el.hidden = false; }
}

// ---------- Binary search 找末頁（GET，不用 Range）----------
async function pageExists(url) {
  try {
    const r = await fetch(url);
    return r.status === 200;
  } catch {
    return false;
  }
}

let detectingPages = false;
async function detectTotalPages() {
  if (detectingPages) return;
  detectingPages = true;
  setWholePagesHint('自動偵測中…');
  try {
    const template = await resolveTemplate();
    if (!template) {
      setWholePagesHint('無法存取圖片，可改用「分章節」手動填頁碼，或留空嘗試');
      return;
    }
    // 顯示確認可用的 template
    const display = template.replace(/DownloadToken=\S{20}.*$/, 'DownloadToken=…');
    document.getElementById('template-display').textContent = display;
    document.getElementById('template-wrap').hidden = false;

    let low = 1, high = 9999;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (await pageExists(getPageUrl(template, mid))) low = mid;
      else high = mid - 1;
    }
    const endInput = document.getElementById('whole-end');
    if (endInput && !endInput.dataset.userEdited) endInput.value = low;
    setWholePagesHint(`自動偵測：共 ${low} 頁`);
  } catch {
    setWholePagesHint('偵測失敗，請手動輸入或留空（留空將下載至結尾）');
  } finally {
    detectingPages = false;
  }
}

// ---------- 章節自動填入 ----------
let chaptersAutoFilled = false;

function applyBookChapters(chapters) {
  if (!chapters?.length || chaptersAutoFilled) return;
  chaptersAutoFilled = true;
  const tbody = document.getElementById('chapters-body');
  tbody.innerHTML = '';
  chapters.forEach((ch, i) => {
    const endPage = i + 1 < chapters.length ? chapters[i + 1].startPage - 1 : '';
    addChapterRow(ch.name, ch.startPage, endPage);
  });
  document.getElementById('toc-badge').hidden = false;
}

// ---------- Session storage ----------
chrome.storage.session.get(
  ['capturedImages', 'bookTitle', 'downloadLink', 'downloadToken', 'estimatedTotal', 'bookChapters'],
  (data) => {
    updateDetection(data.capturedImages);
    if (data.bookTitle) applyBookTitle(data.bookTitle);
    if (data.estimatedTotal) {
      setWholePagesHint(`依閱讀進度估算：約 ${data.estimatedTotal} 頁`);
    }
    if (data.downloadLink && data.downloadToken) {
      applyDownloadInfo(data.downloadLink, data.downloadToken);
    }
    if (data.bookChapters) applyBookChapters(data.bookChapters);
  }
);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes.capturedImages) updateDetection(changes.capturedImages.newValue);
  if (changes.bookTitle) applyBookTitle(changes.bookTitle.newValue);
  if (changes.estimatedTotal && !document.getElementById('whole-end')?.dataset.userEdited) {
    setWholePagesHint(`依閱讀進度估算：約 ${changes.estimatedTotal.newValue} 頁`);
  }
  if (changes.downloadLink || changes.downloadToken) {
    const link = changes.downloadLink?.newValue || downloadLink;
    const token = changes.downloadToken?.newValue || downloadToken;
    if (link && token && !downloadLink) applyDownloadInfo(link, token);
  }
  if (changes.bookChapters) applyBookChapters(changes.bookChapters.newValue);
});

// ---------- Mark user edits ----------
['whole-title', 'whole-end'].forEach(id => {
  document.addEventListener('input', (e) => {
    if (e.target.id === id) e.target.dataset.userEdited = '1';
  });
});

// ---------- Tab 切換 ----------
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('tab-whole').hidden = tab !== 'whole';
    document.getElementById('tab-chapter').hidden = tab !== 'chapter';
  });
});

// ---------- 章節表格 ----------
function addChapterRow(name = '', start = '', end = '') {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="ch-name" type="text" value="${name}" placeholder="chapter1"></td>
    <td><input class="ch-start" type="number" value="${start}" min="1" placeholder="1"></td>
    <td><input class="ch-end" type="number" value="${end}" min="1" placeholder="50"></td>
    <td><button class="row-del">✕</button></td>`;
  tr.querySelector('.row-del').addEventListener('click', () => tr.remove());
  document.getElementById('chapters-body').appendChild(tr);
}

document.getElementById('add-btn').addEventListener('click', () => addChapterRow());
// 預設列：只有在目錄尚未自動填入時才加入
if (!chaptersAutoFilled) addChapterRow('chapter1', '', '');

function collectChapters() {
  return Array.from(document.querySelectorAll('#chapters-body tr')).map((tr, i) => ({
    name: tr.querySelector('.ch-name').value.trim() || `chapter${i + 1}`,
    start: parseInt(tr.querySelector('.ch-start').value, 10),
    end: parseInt(tr.querySelector('.ch-end').value, 10),
  })).filter(ch => !isNaN(ch.start) && !isNaN(ch.end) && ch.end >= ch.start);
}

// ---------- 進度 ----------
function appendLog(text, cls = '') {
  const log = document.getElementById('log');
  const div = document.createElement('div');
  div.className = 'line ' + cls;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function setProgress(ratio) {
  document.getElementById('progress-bar').style.width = `${Math.min(100, Math.round(ratio * 100))}%`;
}

// ---------- 核心下載（有末頁 → 固定範圍；無末頁 → 下載到 404 為止）----------
async function downloadChapters(chapters, filenameOverride = null) {
  if (templateCandidates().length === 0) {
    appendLog('尚未取得圖片網址，請稍候 API 偵測或翻幾頁書本。', 'err');
    return;
  }
  const template = await resolveTemplate(chapters[0]?.start || 1);
  if (!template) {
    appendLog('無法存取任何圖片頁，請確認登入狀態或書本是否有閱讀權限。', 'err');
    return;
  }

  document.getElementById('progress-card').hidden = false;
  document.getElementById('log').innerHTML = '';
  document.getElementById('pdf-list').innerHTML = '';
  setProgress(0);

  const hasFixedEnd = chapters.every(ch => !isNaN(ch.end));
  const totalPages = hasFixedEnd
    ? chapters.reduce((sum, ch) => sum + (ch.end - ch.start + 1), 0)
    : 0;
  let donePages = 0;

  const MAX_MISS = 2; // 留空模式：連續 miss 幾次才視為書本結尾

  for (const ch of chapters) {
    const fixedEnd = !isNaN(ch.end);
    appendLog(fixedEnd
      ? `▶ ${ch.name}（第 ${ch.start}～${ch.end} 頁）`
      : `▶ ${ch.name}（第 ${ch.start} 頁起，自動偵測結尾）`);

    const pdfDoc = await PDFDocument.create();
    let errors = 0;
    let added = 0;
    let consecutiveMiss = 0;
    let page = ch.start;

    while (true) {
      if (fixedEnd && page > ch.end) break;

      const url = getPageUrl(template, page);
      let ok = false;
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const bytes = await resp.arrayBuffer();
        const img = await pdfDoc.embedJpg(bytes);
        const pdfPage = pdfDoc.addPage([img.width, img.height]);
        pdfPage.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        ok = true;
        added++;
      } catch (e) {
        if (fixedEnd) {
          appendLog(`  ✗ 頁 ${page}：${e.message}`, 'err');
          errors++;
        } else {
          consecutiveMiss++;
          // 還沒下載到任何一頁時，要把失敗顯示出來方便診斷
          if (added === 0) appendLog(`  ✗ 頁 ${page}：${e.message}`, 'err');
          if (consecutiveMiss >= MAX_MISS) break; // 連續 miss → 書本結尾
          page++;
          continue;
        }
      }

      if (ok) consecutiveMiss = 0;
      donePages++;
      if (hasFixedEnd) setProgress(donePages / totalPages);
      else if (added && added % 20 === 0) appendLog(`  已下載 ${added} 頁…`);
      page++;
    }

    if (added === 0) {
      appendLog(`✗ ${ch.name}：一頁都沒抓到，請檢查上方錯誤（403=Token 問題，404=頁碼起點問題）`, 'err');
      continue;
    }

    try {
      const pdfBytes = await pdfDoc.save();
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const blobUrl = URL.createObjectURL(blob);
      const filename = `${filenameOverride || ch.name}.pdf`;
      await chrome.downloads.download({ url: blobUrl, filename, saveAs: false });
      URL.revokeObjectURL(blobUrl);
      const status = errors ? `${errors} 頁失敗` : '完整';
      appendLog(`✔ ${filename}（共 ${added} 頁，${status}）`, errors ? 'err' : 'ok');
      const li = document.createElement('li');
      li.innerHTML = `<span class="ok">✓ ${filename} 下載完成</span>`;
      document.getElementById('pdf-list').appendChild(li);
    } catch (e) {
      appendLog(`✗ ${ch.name} PDF 產生失敗：${e.message}`, 'err');
    }
  }

  setProgress(1);
  appendLog('全部完成。', 'ok');
}

// ---------- 整本下載 ----------
document.getElementById('whole-dl-btn').addEventListener('click', async () => {
  const title = document.getElementById('whole-title').value.trim() || 'ebook';
  const endVal = document.getElementById('whole-end').value.trim();
  const end = endVal ? parseInt(endVal, 10) : NaN;

  const ch = isNaN(end)
    ? { name: title, start: 1, end: NaN }   // 留空 → 下載到 404
    : { name: title, start: 1, end };

  const btn = document.getElementById('whole-dl-btn');
  btn.disabled = true;
  await downloadChapters([ch], title);
  btn.disabled = false;
});

// ---------- 分章節下載 ----------
document.getElementById('chapter-dl-btn').addEventListener('click', async () => {
  const btn = document.getElementById('chapter-dl-btn');
  btn.disabled = true;
  await downloadChapters(collectChapters());
  btn.disabled = false;
});
