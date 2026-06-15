// Service worker acts as a cross-origin fetch proxy for the content script.
// Content scripts cannot make cross-origin requests in MV3; the SW can via host_permissions.

function abToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'FETCH_IMG') {
    fetch(msg.url)
      .then(async (r) => {
        if (!r.ok) { sendResponse({ ok: false, status: r.status }); return; }
        const buf = await r.arrayBuffer();
        sendResponse({ ok: true, status: r.status, b64: abToB64(buf) });
      })
      .catch(() => sendResponse({ ok: false, status: 0 }));
    return true;
  }

  if (msg.type === 'CHECK_PAGE') {
    fetch(msg.url, { method: 'HEAD' })
      .then(r => sendResponse({ ok: r.status === 200, status: r.status }))
      .catch(() => sendResponse({ ok: false, status: 0 }));
    return true;
  }

  if (msg.type === 'DOWNLOAD_PDF') {
    // 內容腳本無法用 chrome.downloads；由背景以 data: URL 下載，
    // filename 內的 / 會在「下載」資料夾下建立對應子目錄。
    // service worker 無 URL.createObjectURL，故用 data: URL。
    const url = `data:application/pdf;base64,${msg.b64}`;
    try {
      chrome.downloads.download(
        { url, filename: msg.filename, saveAs: false, conflictAction: 'uniquify' },
        (id) => {
          const err = chrome.runtime.lastError;
          sendResponse({ ok: !err && id != null, error: err?.message });
        }
      );
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return true;
  }

  if (msg.type === 'GM_GET') {
    fetch(msg.url, { credentials: 'include', headers: { Accept: 'application/json' } })
      .then(async (r) => {
        try { sendResponse({ ok: true, json: await r.json() }); }
        catch { sendResponse({ ok: false }); }
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return false;
});

// Toolbar icon click → toggle the in-page panel
chrome.action.onClicked.addListener((tab) => {
  if (tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' }, () => void chrome.runtime.lastError);
  }
});
