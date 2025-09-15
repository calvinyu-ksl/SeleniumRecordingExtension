/**
 * background.js (Service Worker)
 * Handles background tasks for the SeleniumBase Recorder extension.
 * - Manages recording state.
 * - Listens for messages from popup, content script, and side panel.
 * - Generates the SeleniumBase script.
 * - Creates and downloads the ZIP archive.
 */

try {
    importScripts('jszip.min.js');
    console.log("Background: JSZip library loaded successfully via importScripts.");
} catch (e) {
    console.error("Background: CRITICAL ERROR - Failed to load JSZip library.", e);
}

// --- State Variables ---
let isRecording = false;
let recordedActions = [];
let capturedHTMLs = []; // [{ html, refStep, url }]
let capturedScreenshots = []; // [{ dataUrl, refStep }]
let recordedVideos = []; // { fileName, chunks: [Uint8Array,...], recordingId }
let recordedDownloads = []; // { filename, url, mime, startTime, endTime, state, id }
let downloadIdToActionIndex = {}; // map chrome.downloads id -> recordedActions index
let ignoredDownloadIds = new Set(); // download ids to ignore (e.g., our export)
let uploadedFiles = []; // [{ name, dataUrl }] files selected in file inputs (embedded into export)
let startURL = '';
let recordingTabId = null;
let lastCaptureTime = 0; // debounce for HTML capture
let isScreenRecordingActive = false; // active screen recording toggle
let incomingVideoBuffers = {}; // id -> { fileName, total, received, chunks[], recordingId }
let currentScreenRecordingId = null; // id assigned at start, reused for video + markers

// Input debounce buffers
const INPUT_DEBOUNCE_MS = 500;
let pendingInputTimers = {};
let pendingInputBuffers = {};

// New-tab/window detection
let lastAnchorClickTime = 0;
const NEW_TAB_DETECT_MS = 3000;
let pendingNewTabs = {}; // { tabId: { createdAt, openerTabId, windowId, expectedUrl, fallbackCreated } }
let expectingPopup = null; // { url, expectedUrl, via, timestamp, fallbackTimerId }

// Tabs allowed to send recording actions (recordingTab + popups)
let allowedRecordingTabs = new Set();
let pendingExportAfterStop = null; // { sendResponse }

// --- Helpers for video assembly ---
function finalizeIncomingVideos() {
    try {
        const ids = Object.keys(incomingVideoBuffers || {});
        for (const id of ids) {
            const buf = incomingVideoBuffers[id];
            if (!buf) continue;
            // Even if not all chunks received, assemble what we have to avoid losing data.
            const ordered = [];
            for (let i = 0; i < buf.total; i++) {
                if (buf.chunks[i]) ordered.push(buf.chunks[i]);
                // do not break; include any available chunks to avoid losing whole recording
            }
            if (ordered.length) {
                recordedVideos.push({ fileName: buf.fileName || (`recording_${Date.now()}.webm`), chunks: ordered, recordingId: buf.recordingId || null });
                try { console.log('Background: finalizeIncomingVideos assembled', buf.fileName, 'chunks:', ordered.length, 'recordingId:', buf.recordingId); } catch(e){}
            }
            delete incomingVideoBuffers[id];
        }
    } catch (e) {
        console.warn('Background: finalizeIncomingVideos error', e);
    }
}

/**
 * Generate a SeleniumBase Python test script from recordedActions.
 */
function generateSeleniumBaseScript(options = {}) {
    const uploadDirFromUser = (options && options.uploadDir) ? String(options.uploadDir) : null;
    let className = "MyTestClass";
    if (startURL) {
        try {
            const u = new URL(startURL);
            let host = u.hostname.replace(/[^a-zA-Z0-9]/g, '_');
            className = host.charAt(0).toUpperCase() + host.slice(1);
            className = className.replace(/^(\d+)/, '_$1');
        } catch (e) { /* ignore */ }
    }

    const lines = [
        `from seleniumbase import BaseCase`,
        `BaseCase.main(__name__, __file__)`,
        ``,
        `class ${className}(BaseCase):`,
        `    def test_recorded_script(self):`,
        `        # --- Test Actions ---`,
        `        self.open("${startURL}")`
    ];


   
    const allForOutput = [];
    const checkboxSelectors = new Set();
    for (const action of recordedActions) {
        if (action.type === 'Checkbox') {
            checkboxSelectors.add(action.selector);
        }
    }
    const hasUpload = recordedActions.some(a => a && a.type === 'Upload');
    // Helper to detect direct download anchor clicks (blob:/data:), which we should skip in codegen
    const isDirectDownloadAnchorClick = (a) => {
        try {
            if (!a || a.type !== 'Click') return false;
            const href = (a.anchorHref || '').toString();
            const sel = (a.selector || '').toString();
            if (/^blob:/i.test(href) || /^data:/i.test(href)) return true;
            if (/href\s*=\s*['"]\s*blob:/i.test(sel)) return true;
            if (/href\s*=\s*['"]\s*data:/i.test(sel)) return true;
            return false;
        } catch (e) { return false; }
    };
    for (const action of recordedActions) {
        if (action.type === 'ScreenRecordingStart') {
            allForOutput.push({ kind: 'comment', text: `# --- Screen Recording Started (${new Date(action.timestamp).toLocaleString()}) ---` });
        } else if (action.type === 'ScreenRecordingStop') {
            const fileNote = action.fileName ? ` file: ${action.fileName}` : '';
            allForOutput.push({ kind: 'comment', text: `# --- Screen Recording Stopped (${new Date(action.timestamp).toLocaleString()})${fileNote} ---` });
        } else if (action.type !== 'HTML_Capture') {
            // Skip Click/Sleep actions on selectors that had Checkbox actions
            if ((action.type === 'Click' || action.type === 'Sleep') && checkboxSelectors.has(action.selector)) continue;
            // Skip clicks on blob:/data: anchors (download links); rely on Download entry instead
            if (action.type === 'Click' && isDirectDownloadAnchorClick(action)) continue;
            allForOutput.push({ kind: 'action', data: action });
        }
    }


    
    // Precompute Click indices that should be skipped because they precede an Upload
    const skipClickForUpload = new Set();
    for (let i = 0; i < allForOutput.length; i++) {
        const it = allForOutput[i];
        if (it && it.kind === 'action' && it.data && it.data.type === 'Upload') {
            // Look back up to a few prior actions for the triggering Click
            for (let j = i - 1; j >= 0 && j >= i - 5; j--) {
                const prev = allForOutput[j];
                if (!prev || prev.kind !== 'action' || !prev.data) continue;
                if (prev.data.type === 'Click') { skipClickForUpload.add(j); break; }
            }
        }
    }

    let lastInputSelector = null;
    for (let i = 0; i < allForOutput.length; i++) {
        const item = allForOutput[i];
        if (item.kind === 'comment') {
            lines.push(`        ${item.text}`);
            continue;
        }
        const action = item.data;
        let selector = action.selector || '';
        const selectorQuote = selector.includes("'") ? '"' : "'";
        const finalSelector = `${selectorQuote}${selector}${selectorQuote}`;
    const nextItem = allForOutput[i+1];
    const nextType = nextItem && nextItem.kind === 'action' && nextItem.data ? nextItem.data.type : null;


        const isAutocompleteOptionClick = action.type === 'Click' &&
            selector && /\/html\/body\/div\[\d+\]/.test(selector) &&
            (!action.elementInfo || (action.elementInfo.tagName && action.elementInfo.tagName.toLowerCase() !== 'input'));

        switch (action.type) {
            case 'Click': {
                // Skip Clicks marked as preceding an Upload to avoid OS file dialog
                if (skipClickForUpload.has(i)) {
                    continue;
                }
                // If the next action is an Upload, skip this click to avoid opening the OS file picker during test run.
                if (nextType === 'Upload') {
                    // Skip generating this click and also skip the default sleep for this action.
                    continue;
                }
                // If XPath selector ends with '/input' or '/input[n]', strip the trailing input segment
                let selForClick = selector;
                if (typeof selForClick === 'string' && selForClick.startsWith('/') && /\/input(?:\[\d+\])?$/.test(selForClick)) {
                    selForClick = selForClick.replace(/\/input(?:\[\d+\])?$/, '');
                }
                const q = selForClick.includes("'") ? '"' : "'";
                const finalClickSelector = `${q}${selForClick}${q}`;

                if (isAutocompleteOptionClick) {
                    lines.push(`        self.click(${finalClickSelector})`);
                } else {
                    lines.push(`        self.click(${finalClickSelector})`);
                }
                break; }
            case 'Key':
                if (action.key && (action.key === 'Enter' || action.key === 'Return' || action.key === 'Tab')) {
                    if (!lines.some(l => l.includes('selenium.webdriver.common.keys'))) {
                        lines.splice(0, 0, `from selenium.webdriver.common.keys import Keys`);
                    }
                    if (action.key === 'Tab') {
                        const mod = action.shift ? 'Keys.SHIFT + Keys.TAB' : 'Keys.TAB';
                        lines.push(`        self.send_keys(${finalSelector}, ${mod})`);
                    } else {
                        lines.push(`        self.send_keys(${finalSelector}, Keys.ENTER)`);
                    }
                }
                break;
            case 'Input': {
                if (action.value && selector) {
                    // Normalize selector: strip legacy 'xpath=' prefix (raw leading '/' already acceptable to seleniumbase)
                    let selForScript = selector;
                    if (selForScript.startsWith('xpath=')) selForScript = selForScript.slice(6);
                    const selQuote = selForScript.includes("'") && !selForScript.includes('"') ? '"' : "'";
                    const escapedValue = String(action.value).replace(/'/g, "\\'");
                    lines.push(`        self.type(${selQuote}${selForScript}${selQuote}, '${escapedValue}')`);
                    lastInputSelector = selector;
                }
                break; }
            case 'Select': {
               
                const isNativeSelect = selector && /select|option/.test(selector);
                const rawVal = (action.value !== undefined && action.value !== null) ? action.value
                    : (action.selectedValue !== undefined && action.selectedValue !== null) ? action.selectedValue
                    : (action.optionValue !== undefined && action.optionValue !== null) ? action.optionValue
                    : (action.selected !== undefined && action.selected !== null) ? action.selected
                    : '';
                const sval = String(rawVal || '');
                if (isNativeSelect) {
                    if (!sval) {
                        lines.push(`        # SELECT action recorded but no value captured for ${finalSelector}`);
                    } else {
                        lines.push(`        self.select_option_by_value(${finalSelector}, '${sval.replace(/'/g, "\\'")}')`);
                    }
                }
                break;
            }
            case 'Checkbox': {
                let val = action.value;
                let isChecked = false;
                try {
                    if (typeof val === 'boolean') isChecked = val;
                    else if (typeof val === 'number') isChecked = (val === 1);
                    else if (typeof val === 'string') {
                        const v = val.trim().toLowerCase();
                        isChecked = (v === 'true' || v === '1' || v === 'checked' || v === 'on');
                    } else {
                        isChecked = Boolean(val);
                    }
                } catch (e) { isChecked = Boolean(val); }
                if (isChecked) lines.push(`        self.check_if_unchecked(${finalSelector})`);
                else lines.push(`        self.uncheck_if_checked(${finalSelector})`);
                break;
            }
            case 'Upload': {
                // Upload action: We cannot reference local files reliably; add guidance comment.
                const fileList = Array.isArray(action.fileNames) ? action.fileNames : [];
                const filesDisplay = fileList.length ? fileList.join(', ') : (action.value || '');
                lines.push(`        # File upload detected for ${finalSelector} -> ${filesDisplay}`);
                if (fileList.length) {
                    const first = String(fileList[0]).replace(/'/g, "\\'");
                    lines.push(`        file_path = os.path.join(UPLOAD_DIR, '${first}')`);
                    lines.push(`        self.choose_file(${finalSelector}, file_path)`);
                    if (fileList.length > 1) {
                        lines.push(`        # Note: multiple files selected (${fileList.length}). Add additional choose_file calls as needed.`);
                    }
                } else {
                    lines.push(`        # Example (adjust path): self.choose_file(${finalSelector}, "path/to/your/file.ext")`);
                }
                break;
            }
            case 'Download': {
                const fname = action.value || action.filename || '(download)';
                const urlInfo = action.url ? ` url=${action.url}` : '';
                lines.push(`        # Expecting file download: ${fname}${urlInfo}`);
                // Optional: users can enable/download dir assertions; we keep it as a hint
                // lines.push(`        # self.wait_for_downloads()`)
                break;
            }
        }
        // Sleep policy: avoid long waits right after clicks that trigger immediate downloads
        if (action.type === 'Click' && nextType === 'Upload') {
            // We skipped the preceding click for file inputs; no sleep needed here.
        } else if (action.type === 'Click' && nextType === 'Download') {
            lines.push(`        self.sleep(0.2)`);
        } else {
            lines.push(`        self.sleep(1)`);
        }
    }

    lines.push(``);
    // Append download info as comments for user validation
    if (Array.isArray(recordedDownloads) && recordedDownloads.length) {
        lines.push(`        # --- Downloads detected during recording ---`);
        for (const d of recordedDownloads) {
            const nm = (d && d.filename) ? d.filename : '(unknown)';
            const u = (d && d.url) ? d.url : '';
            const st = (d && d.state) ? d.state : '';
            lines.push(`        # Download: ${nm} | url=${u} | state=${st}`);
        }
        lines.push(`        # You can validate downloads with SeleniumBase using 'self.wait_for_downloads()' if configured.`);
        lines.push(``);
    }
    lines.push(`        print("\\n*** Test script complete! ***")`);
    lines.push(``);

    // If uploads exist, ensure import and set UPLOAD_DIR. Prefer embedded uploads folder when present.
    if (hasUpload) {
        if (!lines.some(l => /^import\s+os$/.test(l))) {
            lines.splice(0, 0, `import os`);
        }
        const openIdx = lines.findIndex(l => l.includes('self.open('));
        if (openIdx !== -1) {
            // If we've embedded files into the zip, point to a local 'uploads' folder relative to the script.
            const useEmbedded = Array.isArray(uploadedFiles) && uploadedFiles.length > 0;
            if (useEmbedded) {
                lines.splice(openIdx + 1, 0,
                    `        # Uploaded files are embedded in the export under './uploads'`,
                    `        UPLOAD_DIR = os.path.join(os.path.dirname(__file__), 'uploads')`
                );
            } else {
                const dirVal = uploadDirFromUser && uploadDirFromUser.length ? uploadDirFromUser : `C:\\path\\to\\uploads`;
                const safeDir = String(dirVal).replace(/\"/g, '\\"');
                lines.splice(openIdx + 1, 0,
                    `        # Set your local upload directory`,
                    `        UPLOAD_DIR = r"${safeDir}"`
                );
            }
        }
    }
    return lines.join('\n');
}

// Export helper encapsulating previous zip creation logic
// Resolve a possibly relative URL against a base URL
function resolveUrl(href, baseUrl) {
    try {
        if (!href) return null;
        return new URL(href, baseUrl).href;
    } catch (e) { return href; }
}

// Download text content from a URL with basic guards
async function fetchText(url) {
    try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ct = res.headers.get('content-type') || '';
        const txt = await res.text();
        return { text: txt, contentType: ct };
    } catch (e) {
        console.warn('Background: fetchText failed for', url, e);
        return { text: '', contentType: '' };
    }
}

// Rewrite url(...) references inside CSS to absolute URLs based on cssUrl
function rewriteCssUrls(cssText, cssUrl) {
    if (!cssText) return cssText;
    return cssText.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/g, (m, quote, href) => {
        const trimmed = href.trim();
        if (/^(data:|blob:|http:|https:|#)/i.test(trimmed)) return `url(${quote}${trimmed}${quote})`;
        const abs = resolveUrl(trimmed, cssUrl);
        return `url(${quote}${abs}${quote})`;
    });
}

// Inline <link rel="stylesheet"> and @import rules into HTML. Keeps script tags intact.
async function inlineCssIntoHtml(html, pageUrl) {
    try {
        if (!html || typeof html !== 'string') return html;

        // Inline <link rel="stylesheet" href="...">
        const linkRegex = /<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi;
        const links = html.match(linkRegex) || [];
        let inlined = html;
        for (const tag of links) {
            // Extract href
            const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
            const href = hrefMatch ? hrefMatch[1] : null;
            if (!href) continue;
            const absUrl = resolveUrl(href, pageUrl);
            const { text: cssText } = await fetchText(absUrl);
            if (!cssText) continue;
            const rewritten = rewriteCssUrls(cssText, absUrl);
            const styleTag = `<style data-inlined-from="${absUrl}">\n${rewritten}\n</style>`;
            inlined = inlined.replace(tag, styleTag);
        }

        // Inline @import rules inside any existing <style>
        const styleRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
        inlined = await (async () => {
            let result = '';
            let lastIndex = 0;
            let m;
            while ((m = styleRegex.exec(inlined)) !== null) {
                result += inlined.slice(lastIndex, m.index);
                const fullTag = m[0];
                const cssBody = m[1] || '';
                const importRegex = /@import\s+(?:url\()?\s*["']?([^"')]+)["']?\s*\)?\s*;/gi;
                const imports = [...cssBody.matchAll(importRegex)].map(mm => mm[0]);
                let newCssBody = cssBody;
                for (const imp of imports) {
                    const urlMatch = imp.match(/@import\s+(?:url\()?\s*["']?([^"')]+)["']?/i);
                    const u = urlMatch ? urlMatch[1] : null;
                    if (!u) continue;
                    const abs = resolveUrl(u, pageUrl);
                    const { text: cssImp } = await fetchText(abs);
                    if (!cssImp) continue;
                    const rewrittenImp = rewriteCssUrls(cssImp, abs);
                    newCssBody = newCssBody.replace(imp, `\n/* inlined: ${abs} */\n${rewrittenImp}\n`);
                }
                const newTag = fullTag.replace(cssBody, newCssBody);
                result += newTag;
                lastIndex = styleRegex.lastIndex;
            }
            result += inlined.slice(lastIndex);
            return result;
        })();

        return inlined;
    } catch (e) {
        console.warn('Background: inlineCssIntoHtml failed', e);
        return html;
    }
}

function performExport(sendResponse) {
    try {
        flushAllPendingInputs().then(() => {
            if (typeof JSZip === 'undefined') { sendResponse && sendResponse({ success: false, message: "JSZip not loaded." }); return; }
            finalizeIncomingVideos();
            // Debugging: log recordedVideos so we can see what's available for export
            try {
                const info = recordedVideos.map(v => ({ fileName: v.fileName, recordingId: v.recordingId, chunks: Array.isArray(v.chunks) ? v.chunks.length : 0 }));
                console.log('Background: recordedVideos for export:', info);
            } catch (e) { console.warn('Background: Failed to log recordedVideos info', e); }

            // Read optional upload dir from storage before building the script
            chrome.storage.local.get(['selbas_upload_dir']).then((res) => {
                const uploadDir = res && res.selbas_upload_dir ? res.selbas_upload_dir : null;
                const script = generateSeleniumBaseScript({ uploadDir });
            const zip = new JSZip();
            zip.file("test_recorded_script.py", script);
            // Inline CSS for captured HTMLs before adding to zip
            const htmlPromises = capturedHTMLs.map(async (h, idx) => {
                try {
                    if (!h || typeof h.html !== 'string') return;
                    const pageUrl = h.url || startURL || '';
                    const inlined = await inlineCssIntoHtml(h.html, pageUrl);
                    zip.file(`capture_${idx+1}.html`, inlined);
                } catch (e) {
                    console.warn('Background: failed to inline CSS for capture', idx+1, e);
                    zip.file(`capture_${idx+1}.html`, h.html);
                }
            });
            const screenshotPromises = capturedScreenshots.map((s, idx) => {
                if (!s || !s.dataUrl) return Promise.resolve();
                const filename = `screenshot_${idx+1}.png`;
                return fetch(s.dataUrl).then(r => r.arrayBuffer()).then(buf => zip.file(filename, buf)).catch(e => console.warn("Background: screenshot processing failed:", e));
            });
            // Add uploaded files (if any) under uploads/
            const uploadPromises = (Array.isArray(uploadedFiles) ? uploadedFiles : []).map((f) => {
                try {
                    if (!f || !f.name || !f.dataUrl) return Promise.resolve();
                    const safeName = String(f.name).replace(/[\\/:*?"<>|]/g, '_');
                    const fname = `uploads/${safeName}`;
                    return fetch(f.dataUrl).then(r => r.arrayBuffer()).then(buf => zip.file(fname, buf)).catch(e => console.warn('Background: upload file add failed:', e));
                } catch(e) { return Promise.resolve(); }
            });
            Promise.all([...htmlPromises, ...screenshotPromises, ...uploadPromises])
                .then(() => {
                    recordedVideos.forEach(v => {
                        try {
                            const size = v.chunks.reduce((s,c)=>s+c.length,0);
                            const merged = new Uint8Array(size);
                            let offset = 0; v.chunks.forEach(c => { merged.set(c, offset); offset += c.length; });
                            let fname = v.fileName || `recording_${Date.now()}.webm`;
                            let counter = 1; while (zip.file(fname)) fname = fname.replace(/(\.webm)$/i, `_${counter++}$1`);
                            zip.file(fname, merged);
                        } catch(e) { console.warn('Background: failed to add video', e); }
                    });
                    return zip.generateAsync({ type: "blob" });
                })
                .then(blob => {
                    const reader = new FileReader();
                    reader.onload = function() {
                        const dataUrl = reader.result;
                        chrome.downloads.download({ url: dataUrl, filename: "seleniumbase_recording.zip", saveAs: true })
                            .then((downloadId) => { try { ignoredDownloadIds.add(downloadId); } catch(e) {} sendResponse && sendResponse({ success: true }); resetRecordingState(true); })
                            .catch(err => { sendResponse && sendResponse({ success:false, message: err && err.message ? err.message : String(err)}); resetRecordingState(true); });
                    };
                    reader.onerror = function() { sendResponse && sendResponse({ success:false, message:'Failed to read ZIP blob.'}); resetRecordingState(true); };
                    reader.readAsDataURL(blob);
                })
                .catch(err => { sendResponse && sendResponse({ success:false, message: err && err.message ? err.message : String(err)}); resetRecordingState(true); });
            }).catch(() => {
                // Fallback if storage retrieval fails
                const script = generateSeleniumBaseScript({ uploadDir: null });
                const zip = new JSZip();
                zip.file("test_recorded_script.py", script);
                const htmlPromises = capturedHTMLs.map(async (h, idx) => {
                    try {
                        if (!h || typeof h.html !== 'string') return;
                        const pageUrl = h.url || startURL || '';
                        const inlined = await inlineCssIntoHtml(h.html, pageUrl);
                        zip.file(`capture_${idx+1}.html`, inlined);
                    } catch (e) {
                        zip.file(`capture_${idx+1}.html`, h && h.html ? h.html : '');
                    }
                });
                const screenshotPromises = capturedScreenshots.map((s, idx) => {
                    if (!s || !s.dataUrl) return Promise.resolve();
                    const filename = `screenshot_${idx+1}.png`;
                    return fetch(s.dataUrl).then(r => r.arrayBuffer()).then(buf => zip.file(filename, buf)).catch(e => console.warn("Background: screenshot processing failed:", e));
                });
                const uploadPromises = (Array.isArray(uploadedFiles) ? uploadedFiles : []).map((f) => {
                    try {
                        if (!f || !f.name || !f.dataUrl) return Promise.resolve();
                        const safeName = String(f.name).replace(/[\\/:*?"<>|]/g, '_');
                        const fname = `uploads/${safeName}`;
                        return fetch(f.dataUrl).then(r => r.arrayBuffer()).then(buf => zip.file(fname, buf)).catch(e => console.warn('Background: upload file add failed:', e));
                    } catch(e) { return Promise.resolve(); }
                });
                Promise.all([...htmlPromises, ...screenshotPromises, ...uploadPromises])
                    .then(() => zip.generateAsync({ type: "blob" }))
                    .then(blob => {
                        const reader = new FileReader();
                        reader.onload = function() {
                            const dataUrl = reader.result;
                            chrome.downloads.download({ url: dataUrl, filename: "seleniumbase_recording.zip", saveAs: true })
                                .then((downloadId) => { try { ignoredDownloadIds.add(downloadId); } catch(e) {} sendResponse && sendResponse({ success: true }); resetRecordingState(true); })
                                .catch(err => { sendResponse && sendResponse({ success:false, message: err && err.message ? err.message : String(err)}); resetRecordingState(true); });
                        };
                        reader.onerror = function() { sendResponse && sendResponse({ success:false, message:'Failed to read ZIP blob.'}); resetRecordingState(true); };
                        reader.readAsDataURL(blob);
                    })
                    .catch(err => { sendResponse && sendResponse({ success:false, message: err && err.message ? err.message : String(err)}); resetRecordingState(true); });
            });
        }).catch(() => { sendResponse && sendResponse({ success:false, message:'Failed to flush inputs.'}); });
    } catch (e) {
        sendResponse && sendResponse({ success:false, message: e.message });
    }
}

/**
 * Reset recording state and optionally disable the side panel.
 */
function resetRecordingState(disablePanel = false) {
    const closingTabId = recordingTabId;
    isRecording = false;
    recordedActions = [];
    capturedHTMLs = [];
    capturedScreenshots = [];
    recordedVideos = [];
    recordedDownloads = [];
    uploadedFiles = [];
    startURL = '';
    recordingTabId = null;
    lastCaptureTime = 0;
    isScreenRecordingActive = false;
    incomingVideoBuffers = {};

    allowedRecordingTabs.clear();

    for (const k in pendingInputTimers) {
        try { clearTimeout(pendingInputTimers[k]); } catch (e) {}
    }
    pendingInputTimers = {};
    pendingInputBuffers = {};

    console.log("Background: Recording state reset.");

    chrome.runtime.sendMessage({ command: "update_ui", data: { actions: [], isRecording: false, htmlCount: 0, screenshotCount: 0 } })
        .catch(() => { /* side panel may be closed */ });

    if (disablePanel && closingTabId) {
        chrome.tabs.get(closingTabId, (tab) => {
            if (!chrome.runtime.lastError && tab && chrome.sidePanel && chrome.sidePanel.setOptions) {
                chrome.sidePanel.setOptions({ tabId: closingTabId, enabled: false })
                    .then(() => console.log(`Background: Side panel disabled for tab ${closingTabId}.`))
                    .catch(e => console.warn(`Background: Failed to disable side panel for tab ${closingTabId}:`, e));
            }
        });
    }
}

/**
 * Request content script to return page HTML for the recording tab (or an explicit tab).
 * @param {number} [tabId] optional tabId to request HTML from (fallback to recordingTabId)
 */
function triggerHTMLCapture(tabId) {
    return new Promise((resolve, reject) => {
        const now = Date.now();
        if (now - lastCaptureTime < 500) return resolve();
        lastCaptureTime = now;

        if (!isRecording) return reject(new Error("Not recording."));
        const targetTabId = tabId || recordingTabId;
        if (!targetTabId) return reject(new Error("No target tab for HTML capture."));

    chrome.tabs.sendMessage(targetTabId, { command: "get_html" }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Background: Error requesting HTML from content script:", chrome.runtime.lastError.message);
                return reject(new Error(chrome.runtime.lastError.message));
            }
            if (response && response.success && typeof response.html === 'string') {
                const refStep = recordedActions.length + 1; // will match captureAction.step
                capturedHTMLs.push({ html: response.html, refStep, url: response.url || null });
                const captureAction = {
                    type: 'HTML_Capture',
                    step: refStep,
                    timestamp: Date.now(),
                    selectorType: 'N/A',
                    value: `Captured page source (tab ${targetTabId})`
                };
                recordedActions.push(captureAction);
                console.log(`Background: HTML captured from tab ${targetTabId} (${capturedHTMLs.length}).`);
                resolve();
            } else {
                console.error("Background: Invalid HTML response from content script.", response);
                reject(new Error("Failed to get HTML from content script."));
            }
        });
    });
}

/**
 * Capture visible tab for the given tab's window and store as dataURL.
 * If tabId omitted, falls back to recordingTabId.
 * @param {number} [tabId]
 */
function triggerScreenshot(tabId, { force = false } = {}) {
    return new Promise((resolve) => {
    if (!isRecording) return resolve();
    if (isScreenRecordingActive && !force) return resolve();
        const targetTabId = tabId || recordingTabId;
        if (!targetTabId) return resolve();

        chrome.tabs.get(targetTabId, (tab) => {
            if (chrome.runtime.lastError || !tab) return resolve();
            const windowId = tab.windowId;
            try {
                chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
                    if (!chrome.runtime.lastError && dataUrl) {
                        const refStep = recordedActions.length + 1; // this screenshot tied to upcoming action just pushed
                        capturedScreenshots.push({ dataUrl, refStep });
                        console.log(`Background: Screenshot captured for tab ${targetTabId} (window ${windowId}) (${capturedScreenshots.length}).`);
                    } else {
                        console.warn("Background: captureVisibleTab failed:", chrome.runtime.lastError);
                    }
                    resolve();
                });
            } catch (e) {
                console.warn("Background: Exception during screenshot capture:", e);
                resolve();
            }
        });
    });
}

/**
 * Flush one pending input buffer into recorded actions and capture.
 */
function flushPendingInput(selector) {
    const buffered = pendingInputBuffers[selector];
    delete pendingInputBuffers[selector];
    const t = pendingInputTimers[selector];
    if (t) { try { clearTimeout(t); } catch (e) {} delete pendingInputTimers[selector]; }
    if (!buffered) return Promise.resolve();

    // 移除已存在的同 selector Input，只保留最新
    for (let i = recordedActions.length - 1; i >= 0; i--) {
        if (recordedActions[i].type === 'Input' && recordedActions[i].selector === selector) {
            recordedActions.splice(i, 1);
        }
    }
    buffered.step = recordedActions.length + 1;
    delete buffered.elementInfo;
    recordedActions.push(buffered);
    return Promise.allSettled([ triggerScreenshot(), triggerHTMLCapture() ])
        .finally(() => {
            chrome.runtime.sendMessage({
                command: "update_ui",
                data: {
                    actions: recordedActions,
                    isRecording: true,
                    htmlCount: capturedHTMLs.length,
                    screenshotCount: capturedScreenshots.length
                }
            }).catch(() => {});
        });
}

/**
 * Flush all pending inputs.
 */
function flushAllPendingInputs() {
    const selectors = Object.keys(pendingInputBuffers);
    const promises = selectors.map(s => flushPendingInput(s));
    return Promise.allSettled(promises).finally(() => {
        pendingInputTimers = {};
        pendingInputBuffers = {};
    });
}

/**
 * Ensure content.js is present in a tab using scripting.executeScript.
 */
async function ensureContentScriptInTab(tabId) {
    try {
        if (!tabId) return;
        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['content.js']
        });
        console.log(`Background: Injected content.js into tab ${tabId}`);
    } catch (e) {
        console.warn(`Background: Failed to inject content.js into tab ${tabId}:`, e && e.message ? e.message : e);
    }
}

/**
 * Inject content.js into all existing tabs (used on startup/installation).
 */
async function injectIntoAllTabs() {
    try {
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) {
            if (!t.id || !t.url) continue;
            await ensureContentScriptInTab(t.id);
        }
        console.log("Background: Completed injecting content.js into existing tabs.");
    } catch (e) {
        console.warn("Background: injectIntoAllTabs error:", e);
    }
}

/**
 * Handle messages from content scripts / popup / side panel.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("Background received message:", message && message.command, "from", sender && sender.tab ? "tab " + sender.tab.id : "extension");

    const cmd = message && message.command;

    switch (cmd) {
        case "start_recording": {
            if (isRecording) {
                sendResponse({ success: false, message: "Recording already active." });
                return true;
            }
            const { tabId, url } = message.data || {};
            if (!tabId || !url) {
                sendResponse({ success: false, message: "Missing data from popup." });
                return true;
            }

            // reset and initialize
            resetRecordingState(false);
            recordingTabId = tabId;
            startURL = url;
            isRecording = true;

            // allow main recording tab
            allowedRecordingTabs.clear();
            allowedRecordingTabs.add(recordingTabId);

            console.log(`Background: Starting recording for tab ${recordingTabId} with URL ${startURL}`);

            chrome.scripting.executeScript({ target: { tabId: recordingTabId }, files: ['content.js'] })
                .then(() => new Promise(r => setTimeout(r, 500)))
                .then(() => triggerHTMLCapture())
                .then(() => {
                    return chrome.runtime.sendMessage({
                        command: "update_ui",
                        data: { actions: recordedActions, isRecording: true, startUrl: startURL, htmlCount: capturedHTMLs.length }
                    });
                })
                .then(() => {
                    sendResponse({ success: true });
                })
                .catch(err => {
                    console.error("Background: Error during start_recording sequence:", err);
                    resetRecordingState(true);
                    sendResponse({ success: false, message: err && err.message ? err.message : String(err) });
                });
            return true;
        }

        case "upload_file": {
            try {
                const d = message.data || {};
                if (!isRecording) { sendResponse && sendResponse({ success:false, message:'Not recording' }); return true; }
                if (!d || !d.name || !d.dataUrl || typeof d.dataUrl !== 'string') {
                    sendResponse && sendResponse({ success:false, message:'Invalid upload_file payload' });
                    return true;
                }
                // Store up to a reasonable limit to avoid huge zips; cap at 50MB total or 50 files
                if (!Array.isArray(uploadedFiles)) uploadedFiles = [];
                if (uploadedFiles.length >= 50) { sendResponse && sendResponse({ success:false, message:'Too many files' }); return true; }
                // Basic size guard: if dataUrl length too big (> 50MB base64), skip
                try {
                    const approxBytes = Math.floor((d.dataUrl.length - (d.dataUrl.indexOf(',') + 1)) * 3/4);
                    if (approxBytes > 50 * 1024 * 1024) { sendResponse && sendResponse({ success:false, message:'File too large to embed' }); return true; }
                } catch(e) { /* ignore size calc errors */ }
                uploadedFiles.push({ name: String(d.name).replace(/[\\/:*?"<>|]/g, '_'), dataUrl: d.dataUrl });
                sendResponse && sendResponse({ success:true });
            } catch(e) { sendResponse && sendResponse({ success:false, message: e && e.message ? e.message : String(e) }); }
            return true;
        }

        case "record_action": {
            if (!isRecording || !recordingTabId) { sendResponse({ success: false }); return true; }

            const senderTabId = sender && sender.tab && sender.tab.id;
            if (senderTabId && !allowedRecordingTabs.has(senderTabId) && senderTabId !== recordingTabId) {
                // ignore actions from tabs not permitted
                sendResponse({ success: false });
                return true;
            }

            const action = message.data;
            if (!action || !action.type) { sendResponse({ success: false }); return true; }

            // Debug: log Select actions arrival for troubleshooting
            if (action.type === 'Select') {
                try { console.log('Background: Received Select action:', action); } catch (e) {}
            }
            // Debug: log Checkbox actions arrival
            if (action.type === 'Checkbox') {
                try { console.log('Background: Received Checkbox action:', action); } catch (e) {}
            }


          
            if (action.type === 'Input') {
                const sel = action.selector || ('UNKNOWN_SELECTOR_' + Date.now());
               
                if (sel.startsWith('/') || sel.startsWith('//') || sel.startsWith('xpath=') || (action.selectorType === 'XPath')) {
                    
                    const buffered = {
                        type: 'Input',
                        selector: sel,
                        value: action.value,
                        timestamp: Date.now(),
                        sourceTabId: senderTabId || recordingTabId
                    };
                    
                    for (let i = recordedActions.length - 1; i >= 0; i--) {
                        if (recordedActions[i].type === 'Input' && recordedActions[i].selector === sel) {
                            recordedActions.splice(i, 1);
                        }
                    }
                    buffered.step = recordedActions.length + 1;
                    recordedActions.push(buffered);
                    chrome.runtime.sendMessage({
                        command: "update_ui",
                        data: {
                            actions: recordedActions,
                            isRecording: true,
                            htmlCount: capturedHTMLs.length,
                            screenshotCount: capturedScreenshots.length
                        }
                    }).catch(() => {});
                    sendResponse({ success: true, debounced: false });
                    return true;
                } else {
                    
                    pendingInputBuffers[sel] = {
                        type: 'Input',
                        selector: sel,
                        value: action.value,
                        timestamp: Date.now(),
                        sourceTabId: senderTabId || recordingTabId
                    };
                    if (pendingInputTimers[sel]) clearTimeout(pendingInputTimers[sel]);
                    pendingInputTimers[sel] = setTimeout(() => {
                        flushPendingInput(sel).catch(e => console.warn("Background: flushPendingInput error:", e));
                    }, INPUT_DEBOUNCE_MS);
                    sendResponse({ success: true, debounced: true });
                    return true;
                }
            }

            // Non-input actions: ensure Input buffers are flushed before processing Clicks.
            const processNonInputAction = (actionToRecord) => {
                const elementTag = (actionToRecord.elementInfo && actionToRecord.elementInfo.tagName) || actionToRecord.tagName || '';
                const isAnchor = (elementTag && typeof elementTag === 'string' && elementTag.toLowerCase() === 'a')
                                 || (actionToRecord.selector && /\ba\b/.test(actionToRecord.selector))
                                 || Boolean(actionToRecord.anchorSelector || (actionToRecord.elementInfo && actionToRecord.elementInfo.closestAnchorSelector));

                actionToRecord.step = recordedActions.length + 1;
                if (!actionToRecord.selector) {
                    actionToRecord.selector = "SELECTOR_MISSING";
                    actionToRecord.selectorType = 'N/A';
                }

                delete actionToRecord.elementInfo;
                recordedActions.push(actionToRecord);
                console.log("Background: Recorded action:", actionToRecord);

                // If click on anchor happened in popup tab, capture that popup window instead
                if (actionToRecord.type === 'Click' && isAnchor) {
                    if (!isScreenRecordingActive) {
                        triggerScreenshot(senderTabId || recordingTabId).catch(e => console.warn("Background: anchor click screenshot failed:", e));
                    }
                    lastAnchorClickTime = Date.now();
                }

                const delayMs = (actionToRecord.type === 'Input') ? 500 : 0;
                setTimeout(() => {
                    if (actionToRecord.type === 'Click' && isAnchor) {
                        Promise.allSettled([ triggerHTMLCapture(senderTabId || recordingTabId) ])
                            .finally(() => {
                                chrome.runtime.sendMessage({
                                    command: "update_ui",
                                    data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length }
                                }).catch(() => {});
                            });
                    } else {
                        const tasks = [ triggerHTMLCapture(senderTabId || recordingTabId) ];
                        if (!isScreenRecordingActive) tasks.unshift(triggerScreenshot(senderTabId || recordingTabId));
                        Promise.allSettled(tasks)
                            .finally(() => {
                                chrome.runtime.sendMessage({
                                    command: "update_ui",
                                    data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length }
                                }).catch(() => {});
                            });
                    }
                }, delayMs);
            };

            // If this is a Click, Enter, or Tab Key, flush any pending Input buffers first so Input actions appear before the Click/Key
            const isEnterKey = (action.type === 'Key' && (action.key === 'Enter' || action.key === 'Return'));
            const isTabKey = (action.type === 'Key' && action.key === 'Tab');
            const isSelect = (action.type === 'Select');
            // Flush pending inputs before Click, Select, Enter, or Tab so Input actions appear first
            if (action.type === 'Click' || isSelect || isEnterKey || isTabKey) {
                flushAllPendingInputs().then(() => {
                    try {
                        // For Enter key we keep the action type as 'Key' but still record it like a Click marker
                        processNonInputAction(action);
                    } catch (e) { console.warn('Background: processNonInputAction error after flush:', e); }
                    sendResponse({ success: true });
                }).catch((e) => {
                    console.warn('Background: flushAllPendingInputs before Click failed, recording Click anyway:', e);
                    try { processNonInputAction(action); } catch (err) { console.warn('Background: processNonInputAction error (fallback):', err); }
                    sendResponse({ success: true });
                });
                return true; // indicate async response
            }

            // Non-click non-input actions: special-case Upload to prune the preceding file-picker Click
            if (action.type === 'Upload') {
                try {
                    const nowTs = action.timestamp || Date.now();
                    // search back for the nearest Click within 3 seconds prior
                    for (let i = recordedActions.length - 1; i >= 0; i--) {
                        const prev = recordedActions[i];
                        if (!prev) continue;
                        if (prev.type === 'Click') {
                            const dt = nowTs - (prev.timestamp || nowTs);
                            if (dt >= 0 && dt <= 3000) {
                                recordedActions.splice(i, 1);
                                // reindex steps
                                for (let k = 0; k < recordedActions.length; k++) recordedActions[k].step = k + 1;
                                try { console.log('Background: Removed preceding Click before Upload to avoid file picker in script.'); } catch(e){}
                                break;
                            }
                            // if older than the window, stop scanning further back
                            if (dt > 3000) break;
                        }
                    }
                } catch(e) { /* ignore */ }
                // proceed to record Upload
            }

            // Non-click non-input actions: record immediately
            try {
                processNonInputAction(action);
            } catch (e) { console.warn('Background: processNonInputAction error:', e); }

            sendResponse({ success: true });
            return true;
        }

        case "screen_recording_start": {
            if (!isRecording) { sendResponse({ success:false, message: 'Not recording session.'}); return true; }
            currentScreenRecordingId = 'rec_' + Date.now() + '_' + Math.floor(Math.random()*100000);
            const marker = { type: 'ScreenRecordingStart', step: recordedActions.length + 1, timestamp: Date.now(), recordingId: currentScreenRecordingId };
            recordedActions.push(marker);
            isScreenRecordingActive = true;
            chrome.runtime.sendMessage({ command:'update_ui', data:{ actions: recordedActions, isRecording:true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length }}).catch(()=>{});
            sendResponse({ success:true });
            return true;
        }
        case "screen_recording_stop": {
            if (!isRecording) { sendResponse({ success:false, message: 'Not recording session.'}); return true; }
            const fileName = message.data && message.data.fileName;
            const marker = { type: 'ScreenRecordingStop', step: recordedActions.length + 1, timestamp: Date.now(), fileName, recordingId: currentScreenRecordingId };
            recordedActions.push(marker);
            isScreenRecordingActive = false;
            currentScreenRecordingId = null;
            chrome.runtime.sendMessage({ command:'update_ui', data:{ actions: recordedActions, isRecording:true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length }}).catch(()=>{});
            // If an export was requested while recording, perform it now
            if (pendingExportAfterStop) {
                const responder = pendingExportAfterStop.sendResponse;
                pendingExportAfterStop = null;
                performExport(responder);
            }
            sendResponse({ success:true });
            return true;
        }

    case "video_chunk": {
            try {
                const d = message.data || {};
                if (!d.id || typeof d.index !== 'number' || typeof d.total !== 'number' || !d.chunkBase64) {
                    sendResponse({ success:false, message:'Invalid chunk data' });
                    return true;
                }
                if (!incomingVideoBuffers[d.id]) {
            // attach currentScreenRecordingId if exists; side panel sends chunks while recording active
            incomingVideoBuffers[d.id] = { fileName: d.fileName || (`recording_${Date.now()}.webm`), total: d.total, received: 0, chunks: [], recordingId: currentScreenRecordingId };
                }
                const buf = incomingVideoBuffers[d.id];
                const bstr = atob(d.chunkBase64);
                const arr = new Uint8Array(bstr.length);
                for (let i=0;i<bstr.length;i++) arr[i] = bstr.charCodeAt(i);
                buf.chunks[d.index] = arr;
                buf.received++;
                if (buf.received === buf.total) {
                    const ordered = [];
                    for (let i=0;i<buf.total;i++) if (buf.chunks[i]) ordered.push(buf.chunks[i]);
            recordedVideos.push({ fileName: buf.fileName, chunks: ordered, recordingId: buf.recordingId });
                    delete incomingVideoBuffers[d.id];
                    console.log('Background: Completed video assembly', buf.fileName);
                }
                sendResponse({ success:true });
            } catch(e) { sendResponse({ success:false, message:e.message }); }
            return true;
        }

    case "dialog_event": {
            if (!isRecording) { sendResponse && sendResponse({ success:false }); return true; }
            const d = message.data || {};
            const action = {
                type: 'Dialog',
                dialogType: d.dialogType,
                message: d.message,
                value: d.result,
                step: recordedActions.length + 1,
                timestamp: Date.now()
            };
            recordedActions.push(action);

            // Deletion handling: detect confirm dialogs that look like deletions, but
            // defer actual removal until after the capture delay and verify the target
            // element is gone. This avoids removing actions when confirm() is used for
            // other purposes or if the deletion failed.
            let looksLikeDelete = false;
            let deleteCandidatePrev = null;
            try {
                const confirmed = (d.result === true);
                if (confirmed && String(d.dialogType).toLowerCase() === 'confirm') {
                    const prevIndex = recordedActions.length - 2; // action before the Dialog
                    if (prevIndex >= 0) {
                        const prev = recordedActions[prevIndex];
                        if (prev && prev.type === 'Click') {
                            const msg = (d.message || '').toString().toLowerCase();
                            const deleteKeywords = ['delete', '刪除', '確定刪除', 'remove', '確定'];
                            looksLikeDelete = deleteKeywords.some(k => msg.includes(k));
                            if (looksLikeDelete) deleteCandidatePrev = prev;
                        }
                    }
                }
            } catch (e) { console.warn('Background: dialog delete-detection (initial) error', e); }
        // Use provided scheduleDelayMs, but add a small buffer when the dialog was confirmed
        // (result === true) so that page-side actions that run after confirm() have time to complete
        // (for example: deleting an item after user confirms). This reduces captures that occur
        // before the deletion finishes. Default base is 600ms.
        const baseDelay = (typeof d.scheduleDelayMs === 'number') ? d.scheduleDelayMs : 600;
        const confirmBuffer = (d.result === true) ? 350 : 120; // ms
        const delay = baseDelay + confirmBuffer;
            setTimeout(()=>{
                    try { console.log(`Background: dialog_event capture after ${delay}ms (base ${baseDelay} + buffer ${confirmBuffer})`); } catch(e){}
                    Promise.allSettled([
                triggerScreenshot(recordingTabId, { force: true }),
                        triggerHTMLCapture(recordingTabId)
                    ]).finally(()=>{
                        chrome.runtime.sendMessage({ command:'update_ui', data:{ actions: recordedActions, isRecording:true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length }}).catch(()=>{});

                        // After captures complete, if this looked like a delete confirm, verify
                        // the element no longer exists in the page before pruning the prior Click
                        // and its captures. Use content script to check selector existence.
                        try {
                            if (looksLikeDelete && deleteCandidatePrev && deleteCandidatePrev.selector) {
                                const tabToQuery = (deleteCandidatePrev.sourceTabId || recordingTabId);
                                try {
                                    chrome.tabs.sendMessage(tabToQuery, { command: 'check_selector_exists', selector: deleteCandidatePrev.selector }, (resp) => {
                                        if (chrome.runtime.lastError) {
                                            console.warn('Background: check_selector_exists error:', chrome.runtime.lastError.message);
                                            return;
                                        }
                                        const exists = resp && resp.exists;
                                        if (!exists) {
                                            // Find the action by its original step value (if present) or by matching type/selector
                                            const deletedStep = deleteCandidatePrev.step;
                                            let foundIdx = recordedActions.findIndex(a => a && a.step === deletedStep);
                                            if (foundIdx === -1) {
                                                foundIdx = recordedActions.findIndex(a => a && a.type === 'Click' && a.selector === deleteCandidatePrev.selector);
                                            }
                                            if (foundIdx !== -1) {
                                                recordedActions.splice(foundIdx, 1);
                                                for (let i = 0; i < recordedActions.length; i++) recordedActions[i].step = i+1;
                                            }
                                            // Remove captures tied to that step or in the immediate vicinity
                                            capturedHTMLs = capturedHTMLs.filter(h => h.refStep !== deletedStep && !(h.refStep > deletedStep && h.refStep <= deletedStep + 2));
                                            capturedScreenshots = capturedScreenshots.filter(s => s.refStep !== deletedStep && !(s.refStep > deletedStep && s.refStep <= deletedStep + 2));
                                            console.log(`Background: Removed Click action at step ${deletedStep} after confirmed delete verification.`);
                                            chrome.runtime.sendMessage({ command:'update_ui', data:{ actions: recordedActions, isRecording:true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length }}).catch(()=>{});
                                        }
                                    });
                                } catch (e) { console.warn('Background: deletion verification sendMessage error', e); }
                            }
                        } catch (e) { console.warn('Background: deletion verification overall error', e); }
                    });
                }, delay);
            sendResponse && sendResponse({ success:true });
            return true;
        }

        case "add_external_screenshot": {
            if(!isRecording) { sendResponse && sendResponse({ success:false }); return true; }
            const d = message.data || {};
            if(!d.dataUrl || typeof d.dataUrl !== 'string') { sendResponse && sendResponse({ success:false, message:'No dataUrl' }); return true; }
            const step = recordedActions.length + 1;
            capturedScreenshots.push({ dataUrl: d.dataUrl, refStep: step });
            const action = { type:'FullBrowserScreenshot', step, timestamp: Date.now(), selectorType:'N/A', value:'Full browser display captured'};
            recordedActions.push(action);
            chrome.runtime.sendMessage({ command:'update_ui', data:{ actions: recordedActions, isRecording:true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length }}).catch(()=>{});
            sendResponse && sendResponse({ success:true });
            return true;
        }

        case "delete_action": {
            let idx = (typeof message.index === 'number') ? message.index : -1;
            if (idx === -1 && message.data && typeof message.data.step === 'number') {
                // sidepanel sends 1-based step
                idx = message.data.step - 1;
            }
            if (typeof idx !== 'number' || idx < 0 || idx >= recordedActions.length) {
                sendResponse({ success:false, message:'Invalid index'});
                return true;
            }
            const toDelete = recordedActions[idx];
            if (!toDelete) { sendResponse({ success:false, message:'No action at index' }); return true; }

            // If a recordingId was provided in the delete request, prefer using it
            // to remove only the matching recordedVideos and both markers associated
            // with that recordingId. Otherwise fall back to deleting the single step.
            const removedSteps = new Set();
            let recIdToCheck = message.data && message.data.recordingId ? message.data.recordingId : null;
            if (recIdToCheck) {
                // Remove start/stop markers referencing this recordingId
                const toRemove = recordedActions.filter(a => a && (a.type === 'ScreenRecordingStart' || a.type === 'ScreenRecordingStop') && a.recordingId === recIdToCheck);
                if (toRemove && toRemove.length) {
                    recordedActions = recordedActions.filter(a => !(a && (a.type === 'ScreenRecordingStart' || a.type === 'ScreenRecordingStop') && a.recordingId === recIdToCheck));
                    toRemove.forEach(a => { if (a && typeof a.step === 'number') removedSteps.add(a.step); });
                }
            } else if (toDelete && (toDelete.type === 'ScreenRecordingStart' || toDelete.type === 'ScreenRecordingStop') && toDelete.recordingId) {
                // fall back to using the action's recordingId if message didn't include one
                recIdToCheck = toDelete.recordingId;
                const toRemove = recordedActions.filter(a => a && (a.type === 'ScreenRecordingStart' || a.type === 'ScreenRecordingStop') && a.recordingId === recIdToCheck);
                if (toRemove && toRemove.length) {
                    recordedActions = recordedActions.filter(a => !(a && (a.type === 'ScreenRecordingStart' || a.type === 'ScreenRecordingStop') && a.recordingId === recIdToCheck));
                    toRemove.forEach(a => { if (a && typeof a.step === 'number') removedSteps.add(a.step); });
                }
            } else {
                // Normal single-action deletion
                const deletedStep = toDelete.step;
                recordedActions.splice(idx,1);
                removedSteps.add(deletedStep);
            }

            // Reindex steps
            for (let i=0;i<recordedActions.length;i++) recordedActions[i].step = i+1;

            // Remove captures tied to removed steps
            if (removedSteps.size > 0) {
                capturedHTMLs = capturedHTMLs.filter(h => !removedSteps.has(h.refStep));
                capturedScreenshots = capturedScreenshots.filter(s => !removedSteps.has(s.refStep));
            }

            // Remove recordedVideos entries that match the recordingId (only if provided)
            if (recIdToCheck) {
                recordedVideos = recordedVideos.filter(v => v.recordingId !== recIdToCheck);
            }

            chrome.runtime.sendMessage({ command: 'update_ui', data: { actions: recordedActions, htmlCount: capturedHTMLs.length, isRecording: true, screenshotCount: capturedScreenshots.length } }).catch(()=>{});
            sendResponse({ success:true });
            return true;
        }

        case "save_export": {
            if (!isRecording) { sendResponse({ success: false, message: "Not recording." }); return true; }
            if (isScreenRecordingActive) {
                pendingExportAfterStop = { sendResponse };
                try { chrome.runtime.sendMessage({ command: 'force_stop_screen_recording' }); } catch(e) {}
                return true;
            }
            performExport(sendResponse);
            return true;
        }

        case "cancel_recording": {
            if (!isRecording) { sendResponse({ success: false, message: "Not recording." }); return true; }
            resetRecordingState(true);
            sendResponse({ success: true });
            return true;
        }

        case "capture_html": {
            // Manual HTML capture requested from side panel.
            if (!isRecording) { sendResponse({ success:false, message: "Not recording." }); return true; }
            triggerHTMLCapture()
                .then(() => {
                    // Update side panel UI with new action & counts.
                    chrome.runtime.sendMessage({
                        command: 'update_ui',
                        data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length }
                    }).catch(()=>{});
                    sendResponse({ success:true, htmlCount: capturedHTMLs.length });
                })
                .catch(err => {
                    console.warn('Background: Manual HTML capture failed:', err);
                    sendResponse({ success:false, message: err && err.message ? err.message : String(err) });
                });
            return true; // async
        }

        case "get_status": {
            sendResponse({ isRecording, recordingTabId });
            return true;
        }

        case "request_current_state": {
            if (isRecording && sender.contextType === "SIDE_PANEL") {
                sendResponse({ actions: recordedActions, htmlCount: capturedHTMLs.length, isRecording: true, startUrl: startURL });
            } else sendResponse(null);
            return true;
        }

        case "stop_recording_internal": {
            if (isRecording && sender.contextType === "SIDE_PANEL") {
                resetRecordingState(false);
                sendResponse({ success: true });
            } else sendResponse({ success: false, message: "Not recording or invalid context" });
            return true;
        }

        case "popup_opened": {
            if (!isRecording) { sendResponse({ success: false, message: "Not recording." }); return true; }
            const data = message.data || {};
            let expectedUrl = data.url || null;
            try {
                if (expectedUrl && startURL && !/^(https?:)?\/\//i.test(expectedUrl)) {
                    const base = new URL(startURL);
                    expectedUrl = new URL(expectedUrl, base).href;
                }
            } catch (e) { /* keep original */ }

            expectingPopup = {
                url: data.url || null,
                expectedUrl: expectedUrl,
                via: data.via || null,
                timestamp: Date.now(),
                fallbackTimerId: null
            };
            lastAnchorClickTime = Date.now();
            console.log("Background: popup_opened received, expecting new tab/window:", expectingPopup);

            try {
                // NOTE: previously we auto-created a fallback tab when the page indicated a popup URL
                // (this could cause the extension to open a new tab automatically). To avoid that behavior,
                // we no longer auto-create a fallback tab. We keep the expectingPopup info so that when
                // the browser actually opens a new tab/window the normal onCreated/onUpdated handlers
                // will detect it and mark it pending.
                if (expectingPopup.expectedUrl) {
                    if (expectingPopup.fallbackTimerId) { try { clearTimeout(expectingPopup.fallbackTimerId); } catch(e){} expectingPopup.fallbackTimerId = null; }
                    // set a short timeout to clear expectingPopup if nothing happens,
                    // but also try a non-invasive fallback: scan existing tabs for a tab
                    // whose URL matches the expected popup URL and capture it. This
                    // helps when openerTabId isn't set or the popup opens in a new
                    // window quickly such that onCreated/onUpdated handlers miss it.
                    // Register one-time listeners: if a new tab or window is created within
                    // the detection window, treat it as the popup and capture it.
                    const onTabCreatedOnce = async (tab) => {
                        try {
                            if (!isRecording) return;
                            // mark pending and allow recording from this tab
                            try { allowedRecordingTabs.add(tab.id); } catch(e){}
                            pendingNewTabs[tab.id] = { createdAt: Date.now(), openerTabId: tab.openerTabId || null, windowId: tab.windowId || null, expectedUrl: expectingPopup ? expectingPopup.expectedUrl : null, fallbackCreated: true };
                            // inject content script and capture shortly after
                            await ensureContentScriptInTab(tab.id);
                            await new Promise(r => setTimeout(r, 200));
                            triggerScreenshot(tab.id, { force: true }).catch(()=>{});
                            triggerHTMLCapture(tab.id).catch(()=>{});
                        } catch(e) { /* ignore */ }
                        try { chrome.tabs.onCreated.removeListener(onTabCreatedOnce); } catch(e){}
                        try { chrome.windows.onCreated.removeListener(onWindowCreatedOnce); } catch(e){}
                        expectingPopup = null;
                    };

                    const onWindowCreatedOnce = async (win) => {
                        try {
                            if (!isRecording) return;
                            // wait for tabs to settle
                            await new Promise(r => setTimeout(r, 300));
                            const tabsInWindow = await chrome.tabs.query({ windowId: win.id });
                            if (!tabsInWindow || tabsInWindow.length === 0) return;
                            const newTab = tabsInWindow.find(t => t.active) || tabsInWindow[0];
                            if (!newTab || !newTab.id) return;
                            allowedRecordingTabs.add(newTab.id);
                            pendingNewTabs[newTab.id] = { createdAt: Date.now(), openerTabId: newTab.openerTabId || null, windowId: win.id, expectedUrl: expectingPopup ? expectingPopup.expectedUrl : null, fallbackCreated: true };
                            await ensureContentScriptInTab(newTab.id);
                            await new Promise(r => setTimeout(r, 200));
                            chrome.tabs.captureVisibleTab(win.id, { format: "png" }, (dataUrl) => {
                                if (!chrome.runtime.lastError && dataUrl) {
                                    capturedScreenshots.push(dataUrl);
                                    console.log(`Background: Captured screenshot of popup window tab ${newTab.id} (fallback).`);
                                }
                                chrome.runtime.sendMessage({ command: "update_ui", data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length } }).catch(()=>{});
                            });
                        } catch(e) { /* ignore */ }
                        try { chrome.tabs.onCreated.removeListener(onTabCreatedOnce); } catch(e){}
                        try { chrome.windows.onCreated.removeListener(onWindowCreatedOnce); } catch(e){}
                        expectingPopup = null;
                    };

                    // Attach one-time listeners
                    try { chrome.tabs.onCreated.addListener(onTabCreatedOnce); } catch(e) {}
                    try { chrome.windows.onCreated.addListener(onWindowCreatedOnce); } catch(e) {}

                    expectingPopup.fallbackTimerId = setTimeout(async () => {
                        try {
                            const expected = expectingPopup && expectingPopup.expectedUrl;
                            if (!expected) { expectingPopup = null; return; }
                            // query all tabs and try to find a reasonable match
                            const tabs = await chrome.tabs.query({});
                            for (const t of tabs) {
                                if (!t || !t.url) continue;
                                // match by exact or substring (handles relative URLs)
                                if (t.url === expected || (expected && t.url.includes(expected))) {
                                    try {
                                        // allow this tab to record and capture screenshot
                                        allowedRecordingTabs.add(t.id);
                                        await new Promise(r => setTimeout(r, 150));
                                        triggerScreenshot(t.id, { force: true }).catch(() => {});
                                        // also request HTML capture in case it loaded immediately
                                        triggerHTMLCapture(t.id).catch(() => {});
                                    } catch (e) { /* ignore per-fallback errors */ }
                                    break;
                                }
                            }
                        } catch (e) {
                            console.warn('Background: popup fallback scanner failed:', e);
                        } finally {
                            expectingPopup = null;
                        }
                    }, NEW_TAB_DETECT_MS + 200);
                }
            } catch (e) { console.warn("Background: Failed to schedule popup fallback:", e); }

            sendResponse({ success: true });
            return true;
        }

        default:
            sendResponse({ success: false, message: "Unknown command" });
            return true;
    }
});

// Remove recording when recording tab closed; also remove any allowed tab on close
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (isRecording && tabId === recordingTabId) {
        console.log(`Background: Recording tab ${tabId} closed. Resetting recording state.`);
        resetRecordingState(false);
    }
    if (allowedRecordingTabs.has(tabId)) allowedRecordingTabs.delete(tabId);
    if (pendingNewTabs[tabId]) delete pendingNewTabs[tabId];
});

// When a tab finishes loading, inject content script and handle pending new tabs capture
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') {
        // Ensure content script is injected
        ensureContentScriptInTab(tabId);
    }

    // If this tab was marked pending (new popup/new tab), capture it when complete
    if (pendingNewTabs[tabId] && changeInfo.status === 'complete') {
        (async () => {
            try {
                const info = pendingNewTabs[tabId];
                const t = tab;
                // Save previous active tab in that window to restore later
                const prevActiveTabs = await chrome.tabs.query({ active: true, windowId: t.windowId });
                const prevActiveTabId = (prevActiveTabs && prevActiveTabs[0]) ? prevActiveTabs[0].id : null;

                // Ensure new tab is active to capture its visible content
                try { await chrome.tabs.update(tabId, { active: true }); } catch (e) {}

                await new Promise(r => setTimeout(r, 200));

                chrome.tabs.get(tabId, (gt) => {
                    if (chrome.runtime.lastError || !gt) {
                        delete pendingNewTabs[tabId];
                        return;
                    }
                    chrome.tabs.captureVisibleTab(gt.windowId, { format: "png" }, (dataUrl) => {
                        if (!chrome.runtime.lastError && dataUrl) {
                            capturedScreenshots.push(dataUrl);
                            console.log(`Background: Captured screenshot of new tab ${tabId} (total: ${capturedScreenshots.length}).`);
                        } else {
                            console.warn("Background: captureVisibleTab for new tab failed:", chrome.runtime.lastError);
                        }
                        // Restore previous active tab if different
                        if (prevActiveTabId && prevActiveTabId !== tabId) {
                            chrome.tabs.update(prevActiveTabId, { active: true }).catch(() => {});
                        }
                        chrome.runtime.sendMessage({
                            command: "update_ui",
                            data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length }
                        }).catch(() => {});
                        // Allow actions from this new tab (recording can continue inside popup)
                        allowedRecordingTabs.add(tabId);
                        delete pendingNewTabs[tabId];
                    });
                });
            } catch (e) {
                console.warn("Background: Error capturing new tab screenshot:", e);
                delete pendingNewTabs[tabId];
            }
        })();
    }
});

// When a new tab is created, mark as pending if opened near an anchor click or expectingPopup
chrome.tabs.onCreated.addListener((tab) => {
    try {
        if (!isRecording) return;
        const sinceLastClick = Date.now() - lastAnchorClickTime;
        const openerMatches = tab.openerTabId && tab.openerTabId === recordingTabId && sinceLastClick <= NEW_TAB_DETECT_MS;
        const expectingMatches = expectingPopup && (Date.now() - expectingPopup.timestamp <= NEW_TAB_DETECT_MS);

        if (openerMatches || expectingMatches) {
            pendingNewTabs[tab.id] = {
                createdAt: Date.now(),
                openerTabId: tab.openerTabId || null,
                windowId: tab.windowId || null,
                expectedUrl: expectingPopup ? expectingPopup.expectedUrl : null,
                fallbackCreated: false
            };
            // allow actions from this new tab (popup)
            allowedRecordingTabs.add(tab.id);
            console.log(`Background: Detected new tab ${tab.id} opened (pending capture).`, pendingNewTabs[tab.id]);
            if (expectingMatches) expectingPopup = null;
        }

        // Inject content script into newly created tab after a short delay
        setTimeout(() => { if (tab && tab.id) ensureContentScriptInTab(tab.id); }, 300);
    } catch (e) {
        console.warn("Background: tabs.onCreated handler error:", e);
    }
});

// When a new browser window is created (popup opened as a new window), try to detect and capture
chrome.windows.onCreated.addListener(async (win) => {
    try {
        if (!isRecording) return;
        const sinceLastClick = Date.now() - lastAnchorClickTime;
        const expectingMatches = expectingPopup && (Date.now() - expectingPopup.timestamp <= NEW_TAB_DETECT_MS);
        if (!expectingMatches && sinceLastClick > NEW_TAB_DETECT_MS) return;

        // wait for tabs to settle
        await new Promise(r => setTimeout(r, 300));
        const tabsInWindow = await chrome.tabs.query({ windowId: win.id });
        if (!tabsInWindow || tabsInWindow.length === 0) return;
        const newTab = tabsInWindow.find(t => t.active) || tabsInWindow[0];
        if (!newTab || !newTab.id) return;

        pendingNewTabs[newTab.id] = {
            createdAt: Date.now(),
            openerTabId: newTab.openerTabId || null,
            windowId: win.id,
            expectedUrl: expectingPopup ? expectingPopup.expectedUrl : null,
            fallbackCreated: false
        };
        allowedRecordingTabs.add(newTab.id);
        console.log(`Background: Detected new window ${win.id} with tab ${newTab.id}; marked pending.`);

        if (expectingMatches) expectingPopup = null;

        await ensureContentScriptInTab(newTab.id);

        try {
            const prevActiveTabs = await chrome.tabs.query({ active: true, windowId: win.id });
            const prevActiveTabId = (prevActiveTabs && prevActiveTabs[0]) ? prevActiveTabs[0].id : null;
            await chrome.tabs.update(newTab.id, { active: true }).catch(() => {});
            await new Promise(r => setTimeout(r, 200));
            chrome.tabs.captureVisibleTab(win.id, { format: "png" }, (dataUrl) => {
                if (!chrome.runtime.lastError && dataUrl) {
                    capturedScreenshots.push(dataUrl);
                    console.log(`Background: Captured screenshot of new window tab ${newTab.id}.`);
                } else {
                    console.warn("Background: captureVisibleTab for new window failed:", chrome.runtime.lastError);
                }
                if (prevActiveTabId && prevActiveTabId !== newTab.id) chrome.tabs.update(prevActiveTabId, { active: true }).catch(() => {});
                chrome.runtime.sendMessage({ command: "update_ui", data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length } }).catch(()=>{});
                delete pendingNewTabs[newTab.id];
            });
        } catch (e) {
            console.warn("Background: Error during new window capture flow:", e);
        }
    } catch (e) {
        console.warn("Background: windows.onCreated handler error:", e);
    }
});

// Inject into all tabs on install/startup
chrome.runtime.onInstalled.addListener(() => injectIntoAllTabs());
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(() => injectIntoAllTabs());

// Ensure injection when a tab completes (some pages only accept injection after load)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') ensureContentScriptInTab(tabId);
});

console.log("Background service worker started.");

// --- Downloads tracking ---
try {
    if (chrome.downloads && chrome.downloads.onCreated) {
        chrome.downloads.onCreated.addListener((item) => {
            try {
                if (!isRecording) return;
                try { console.log('Downloads.onCreated:', { id: item.id, url: item.url, filename: item.filename, mime: item.mime, state: item.state }); } catch(e){}
                if (ignoredDownloadIds.has(item.id)) { try { console.log('Ignoring known export download id', item.id); } catch(e){} return; }
                // Ignore only the export ZIP download
                const baseName = (item.filename || '').split(/[\\/]/).pop();
                if (baseName === 'seleniumbase_recording.zip') return;
                recordedDownloads.push({
                    id: item.id,
                    filename: baseName,
                    url: item.url || '',
                    mime: item.mime || item.mimeType || '',
                    startTime: Date.now(),
                    state: item.state || 'in_progress'
                });
                // Also create a visible action in the timeline
                const step = recordedActions.length + 1;
                const action = {
                    type: 'Download',
                    selector: null,
                    selectorType: 'N/A',
                    value: baseName || '(download started)',
                    url: item.url || '',
                    state: item.state || 'in_progress',
                    step,
                    timestamp: Date.now()
                };
                recordedActions.push(action);
                downloadIdToActionIndex[item.id] = recordedActions.length - 1;
                chrome.runtime.sendMessage({ command: 'update_ui', data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length } }).catch(()=>{});
            } catch (e) { /* ignore */ }
        });
    }
    if (chrome.downloads && chrome.downloads.onChanged) {
        chrome.downloads.onChanged.addListener((delta) => {
            try {
                if (!isRecording || !delta || typeof delta.id !== 'number') return;
                if (ignoredDownloadIds.has(delta.id)) return;
                const idx = recordedDownloads.findIndex(d => d.id === delta.id);
                if (idx === -1) return;
                const rec = recordedDownloads[idx];
                if (delta.filename && delta.filename.current) {
                    rec.filename = (delta.filename.current || '').split(/[\\/]/).pop();
                }
                if (delta.state && delta.state.current) {
                    rec.state = delta.state.current;
                    if (rec.state === 'complete' || rec.state === 'interrupted') rec.endTime = Date.now();
                    try { console.log('Downloads.onChanged state:', delta.id, rec.state, 'filename:', rec.filename); } catch(e){}
                    // Update the corresponding action entry for clarity
                    const aIdx = downloadIdToActionIndex[delta.id];
                    if (typeof aIdx === 'number' && recordedActions[aIdx]) {
                        recordedActions[aIdx].state = rec.state;
                        if (rec.state === 'complete') {
                            recordedActions[aIdx].value = `${rec.filename} (complete)`;
                        } else if (rec.state === 'interrupted') {
                            recordedActions[aIdx].value = `${rec.filename} (interrupted)`;
                        }
                        chrome.runtime.sendMessage({ command: 'update_ui', data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length } }).catch(()=>{});
                    }
                }
            } catch (e) { /* ignore */ }
        });
    }
} catch (e) {
    console.warn('Background: downloads API not available or failed to attach listeners:', e);
}