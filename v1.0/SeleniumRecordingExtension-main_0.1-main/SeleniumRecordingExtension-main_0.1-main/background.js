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
let capturedHTMLs = []; // [{ html, refStep }]
let capturedScreenshots = []; // [{ dataUrl, refStep }]
let recordedVideos = []; // { fileName, chunks: [Uint8Array,...], recordingId }
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
                else break; // stop at first missing to avoid out-of-order corruption
            }
            if (ordered.length) {
                recordedVideos.push({ fileName: buf.fileName || (`recording_${Date.now()}.webm`), chunks: ordered });
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
function generateSeleniumBaseScript() {
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
        ``,
        `class ${className}(BaseCase):`,
        `    def test_recorded_script(self):`,
        `        # --- Test Actions ---`,
        `        self.open("${startURL}")`
    ];

    const scriptable = recordedActions.filter(a => !['HTML_Capture','ScreenRecordingStart','ScreenRecordingStop'].includes(a.type));

    // Insert comments for non-scriptable markers (screen recording) in order
    const allForOutput = [];
    for (const action of recordedActions) {
        if (action.type === 'ScreenRecordingStart') {
            allForOutput.push({ kind: 'comment', text: `# --- Screen Recording Started (${new Date(action.timestamp).toLocaleString()}) ---` });
        } else if (action.type === 'ScreenRecordingStop') {
            const fileNote = action.fileName ? ` file: ${action.fileName}` : '';
            allForOutput.push({ kind: 'comment', text: `# --- Screen Recording Stopped (${new Date(action.timestamp).toLocaleString()})${fileNote} ---` });
        } else if (action.type !== 'HTML_Capture') {
            allForOutput.push({ kind: 'action', data: action });
        }
    }

    for (const item of allForOutput) {
        if (item.kind === 'comment') {
            lines.push(`        ${item.text}`);
            continue;
        }
        const action = item.data;
        const selector = action.selector || '';
        const selectorQuote = selector.includes("'") ? '"' : "'";
        const finalSelector = `${selectorQuote}${selector}${selectorQuote}`;

        switch (action.type) {
            case 'Click':
                lines.push(`        self.click(${finalSelector})`);
                break;
            case 'Input':
                lines.push(`        self.type(${finalSelector}, '${String(action.value).replace(/'/g, "\\'")}')`);
                break;
            case 'Select':
                lines.push(`        self.select_option_by_value(${finalSelector}, '${String(action.value).replace(/'/g, "\\'")}')`);
                break;
            case 'Checkbox':
                if (action.value) lines.push(`        self.check_if_unchecked(${finalSelector})`);
                else lines.push(`        self.uncheck_if_checked(${finalSelector})`);
                break;
        }
    lines.push(`        self.sleep(1)`);
    }

    lines.push(``);
    lines.push(`        print("\\n*** Test script complete! ***")`);
    lines.push(``);
    return lines.join('\n');
}

// Export helper encapsulating previous zip creation logic
function performExport(sendResponse) {
    try {
        flushAllPendingInputs().then(() => {
            if (typeof JSZip === 'undefined') { sendResponse && sendResponse({ success: false, message: "JSZip not loaded." }); return; }
            finalizeIncomingVideos();
            const script = generateSeleniumBaseScript();
            const zip = new JSZip();
            zip.file("test_recorded_script.py", script);
            capturedHTMLs.forEach((h, idx) => { if (h && typeof h.html === 'string') zip.file(`capture_${idx+1}.html`, h.html); });
            const screenshotPromises = capturedScreenshots.map((s, idx) => {
                if (!s || !s.dataUrl) return Promise.resolve();
                const filename = `screenshot_${idx+1}.png`;
                return fetch(s.dataUrl).then(r => r.arrayBuffer()).then(buf => zip.file(filename, buf)).catch(e => console.warn("Background: screenshot processing failed:", e));
            });
            Promise.all(screenshotPromises)
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
                            .then(() => { sendResponse && sendResponse({ success: true }); resetRecordingState(true); })
                            .catch(err => { sendResponse && sendResponse({ success:false, message: err && err.message ? err.message : String(err)}); resetRecordingState(true); });
                    };
                    reader.onerror = function() { sendResponse && sendResponse({ success:false, message:'Failed to read ZIP blob.'}); resetRecordingState(true); };
                    reader.readAsDataURL(blob);
                })
                .catch(err => { sendResponse && sendResponse({ success:false, message: err && err.message ? err.message : String(err)}); resetRecordingState(true); });
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
                capturedHTMLs.push({ html: response.html, refStep });
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

            // Debounce Input actions
            if (action.type === 'Input') {
                const sel = action.selector || ('UNKNOWN_SELECTOR_' + Date.now());
                // store source tab so flushPendingInput can capture the correct window/html
                pendingInputBuffers[sel] = {
                    type: 'Input',
                    selector: sel,
                    selectorType: sel.startsWith('xpath=') ? 'XPath' : 'CSS',
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

            // Non-input actions: record immediately
            const elementTag = (action.elementInfo && action.elementInfo.tagName) || action.tagName || '';
            const isAnchor = (elementTag && typeof elementTag === 'string' && elementTag.toLowerCase() === 'a')
                             || (action.selector && /\ba\b/.test(action.selector))
                             || Boolean(action.anchorSelector || (action.elementInfo && action.elementInfo.closestAnchorSelector));

            action.step = recordedActions.length + 1;
            action.selectorType = (action.selector && action.selector.startsWith('xpath=')) ? 'XPath' : 'CSS';
            if (!action.selector) {
                action.selector = "SELECTOR_MISSING";
                action.selectorType = 'N/A';
            }

            delete action.elementInfo;
            recordedActions.push(action);
            console.log("Background: Recorded action:", action);

            // If click on anchor happened in popup tab, capture that popup window instead
            if (action.type === 'Click' && isAnchor) {
                if (!isScreenRecordingActive) {
                    triggerScreenshot(senderTabId || recordingTabId).catch(e => console.warn("Background: anchor click screenshot failed:", e));
                }
                lastAnchorClickTime = Date.now();
            }

            const delayMs = (action.type === 'Input') ? 500 : 0;
            setTimeout(() => {
                if (action.type === 'Click' && isAnchor) {
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
        const delay = typeof d.scheduleDelayMs === 'number' ? d.scheduleDelayMs : 600;
            setTimeout(()=>{
                Promise.allSettled([
            triggerScreenshot(recordingTabId, { force: true }),
                    triggerHTMLCapture(recordingTabId)
                ]).finally(()=>{
                    chrome.runtime.sendMessage({ command:'update_ui', data:{ actions: recordedActions, isRecording:true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length }}).catch(()=>{});
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
            let recIdToCheck = null;
            if (toDelete && (toDelete.type === 'ScreenRecordingStart' || toDelete.type === 'ScreenRecordingStop') && toDelete.recordingId) {
                recIdToCheck = toDelete.recordingId;
            }
            const deletedStep = toDelete.step;
            recordedActions.splice(idx,1);
            for (let i=0;i<recordedActions.length;i++) recordedActions[i].step = i+1;
            // Remove captures tied to that step (HTML_Capture action already removed, but stored html/screenshot arrays too)
            capturedHTMLs = capturedHTMLs.filter(h => h.refStep !== deletedStep);
            capturedScreenshots = capturedScreenshots.filter(s => s.refStep !== deletedStep);
            if (recIdToCheck) {
                const stillHas = recordedActions.some(a => (a.type === 'ScreenRecordingStart' || a.type === 'ScreenRecordingStop') && a.recordingId === recIdToCheck);
                if (!stillHas) recordedVideos = recordedVideos.filter(v => v.recordingId !== recIdToCheck);
            }
            // Reindex refStep values mapping to new step numbers (only necessary if you want alignment after deletions)
            const stepMap = {}; recordedActions.forEach(a => { stepMap[a.step] = a.step; });
            // For simplicity, keep original refStep; captures removed with their action so remaining remain valid.
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
                    // but DO NOT create a new tab automatically.
                    expectingPopup.fallbackTimerId = setTimeout(() => {
                        expectingPopup = null;
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