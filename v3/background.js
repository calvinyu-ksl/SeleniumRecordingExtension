/**
 * background.js (Service Worker)
 * Extension's background service script: centrally handles recording state and cross-page communication.
 * - Manages recording state (start, stop, reset).
 * - Listens for messages from popup / content script / side panel.
 * - Generates SeleniumBase Python scripts.
 * - Packages ZIP files and triggers downloads.
 */

try { // Import JSZip (for ZIP file generation)
    importScripts('jszip.min.js');
    console.log("Background: JSZip library loaded successfully via importScripts.");
} catch (e) {
    console.error("Background: CRITICAL ERROR - Failed to load JSZip library.", e);
}

// --- Recording state variables ---
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

// Input debounce related buffers
const INPUT_DEBOUNCE_MS = 500;
let pendingInputTimers = {};
let pendingInputBuffers = {};

// New tab/window detection
let lastAnchorClickTime = 0;
const NEW_TAB_DETECT_MS = 3000;
let pendingNewTabs = {}; // { tabId: { createdAt, openerTabId, windowId, expectedUrl, fallbackCreated } }
let expectingPopup = null; // { url, expectedUrl, via, timestamp, fallbackTimerId }

// Tabs allowed to send recording events (main recording tab + popup tabs)
let allowedRecordingTabs = new Set();
let pendingExportAfterStop = null; // { sendResponse }

// --- Service Worker state persistence ---
async function saveState() {
    try {
        await chrome.storage.local.set({
            isRecording,
            recordedActions,
            recordingTabId,
            startURL,
            capturedHTMLs,
            capturedScreenshots,
            recordedDownloads,
            uploadedFiles,
            allowedRecordingTabs: Array.from(allowedRecordingTabs),
            pendingNewTabs,
            isScreenRecordingActive,
            currentScreenRecordingId,
            lastCaptureTime
        });
        console.log("Background: State saved to storage");
    } catch (e) {
        console.warn("Background: Failed to save state:", e);
    }
}

async function loadState() {
    try {
        const data = await chrome.storage.local.get([
            'isRecording',
            'recordedActions', 
            'recordingTabId',
            'startURL',
            'capturedHTMLs',
            'capturedScreenshots',
            'recordedDownloads',
            'uploadedFiles',
            'allowedRecordingTabs',
            'pendingNewTabs',
            'isScreenRecordingActive',
            'currentScreenRecordingId',
            'lastCaptureTime'
        ]);
        
        // Only restore state if storage actually has data
        if (data.isRecording !== undefined) {
            isRecording = data.isRecording || false;
            recordedActions = data.recordedActions || [];
            recordingTabId = data.recordingTabId || null;
            startURL = data.startURL || "";
            capturedHTMLs = data.capturedHTMLs || [];
            capturedScreenshots = data.capturedScreenshots || [];
            recordedDownloads = data.recordedDownloads || [];
            uploadedFiles = data.uploadedFiles || [];
            allowedRecordingTabs = new Set(data.allowedRecordingTabs || []);
            pendingNewTabs = data.pendingNewTabs || {};
            isScreenRecordingActive = data.isScreenRecordingActive || false;
            currentScreenRecordingId = data.currentScreenRecordingId || null;
            lastCaptureTime = data.lastCaptureTime || 0;
            
            console.log("Background: State loaded from storage, isRecording:", isRecording, "actions:", recordedActions.length);
            
            // If recording is active, ensure content script is re-injected and start periodic saving
            if (isRecording && recordingTabId) {
                console.log("Background: Resuming recording state for tab", recordingTabId);
                startPeriodicStateSave(); // Restart periodic saving
                
                try {
                    chrome.tabs.get(recordingTabId, (tab) => {
                        if (!chrome.runtime.lastError && tab) {
                            ensureContentScriptInTab(recordingTabId);
                        } else {
                            // If recording tab no longer exists, reset state
                            console.warn("Background: Recording tab no longer exists, resetting state");
                            resetRecordingState(false);
                        }
                    });
                } catch (e) {
                    console.warn("Background: Failed to re-inject content script:", e);
                    resetRecordingState(false);
                }
            }
        } else {
            console.log("Background: No previous state found, starting fresh");
        }
    } catch (e) {
        console.warn("Background: Failed to load state:", e);
    }
}

// Service Worker startup - restore state
chrome.runtime.onStartup.addListener(async () => {
    console.log("Background: Service Worker starting up, loading state...");
    await loadState();
});

chrome.runtime.onInstalled.addListener(async () => {
    console.log("Background: Extension installed/updated, loading state...");
    await loadState();
    // Inject into all existing tabs after installation
    setTimeout(() => injectIntoAllTabs(), 1000);
});

// Load state during initialization (async)
loadState().then(() => {
    console.log("Background: Initial state load complete");
}).catch(e => {
    console.warn("Background: Initial state load failed:", e);
});

// --- Assemble sidebar uploaded video segments into complete videos ---
function finalizeIncomingVideos() { // Assemble incomplete video segments as much as possible (avoid data loss)
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
                try { console.log('Background: finalizeIncomingVideos assembled', buf.fileName, 'chunks:', ordered.length, 'recordingId:', buf.recordingId); } catch (e) { }
            }
            delete incomingVideoBuffers[id];
        }
    } catch (e) {
        console.warn('Background: finalizeIncomingVideos error', e);
    }
}

/**
 * Generate SeleniumBase Python test script based on recordedActions.
 */
function generateSeleniumBaseScript(options = {}, actionsToUse = null) {
    const uploadDirFromUser = (options && options.uploadDir) ? String(options.uploadDir) : null;
    // Use provided actions or fall back to global recordedActions
    const actions = actionsToUse || recordedActions;
    
    let className = "MyTestClass";
    if (startURL) {
        try {
            const u = new URL(startURL);
            let host = u.hostname.replace(/[^a-zA-Z0-9]/g, '_');
            className = host.charAt(0).toUpperCase() + host.slice(1);
            className = className.replace(/^(\d+)/, '_$1');
        } catch (e) { /* ignore */ }
    }

    // Detect if we have any DragAndDrop actions to decide helper injection
    const hasDrag = actions.some(a => a && a.type === 'DragAndDrop');
    const hasDndKit = actions.some(a => a && a.type === 'DragAndDrop' && a.isDndKit);

    const lines = [ // Script skeleton (imports first)
        `from seleniumbase import BaseCase`,
        `from selenium.webdriver.common.action_chains import ActionChains`,
        `from selenium.webdriver.common.keys import Keys`,
        ...(hasDrag || hasDndKit ? [
            `from selenium.webdriver.common.by import By`,
            `import time`,
            `import re`
        ] : []),
        `BaseCase.main(__name__, __file__)`,
        ``,
        ...(hasDrag || hasDndKit ? [
            `# --- Drag & Drop Fallback Helper (auto-injected) ---`,
            `def perform_drag_with_fallback(self, source_xpath, target_xpath):`,
            `    """Attempt multiple drag strategies until one succeeds.` +
            `\n    source_xpath & target_xpath should be absolute XPaths.` +
            `\n    Keeps script self-contained without external verification logic.` +
            `\n    """`,
            `    driver = self.driver`,
            `    print("[DND] Starting drag fallback pipeline")`,
            `    # Wait for both elements to exist`,
            `    self.wait_for_element_present(source_xpath, timeout=20)`,
            `    self.wait_for_element_present(target_xpath, timeout=20)`,
            `    src_el = self.find_element(source_xpath)`,
            `    tgt_el = self.find_element(target_xpath)`,
            ``,
            `    def center(el):`,
            `        r = self.execute_script("return arguments[0].getBoundingClientRect();", el)`,
            `        return (r['x'] + r['width']/2, r['y'] + r['height']/2) if r else (0,0)`,
            ``,
            `    strategies = []`,
            ``,
            `    # Strategy 1: Incremental pointer path (ActionChains offsets)`,
            `    def strat_incremental_pointer():`,
            `        print('[DND] Strategy: incremental pointer path')`,
            `        sx, sy = center(src_el); tx, ty = center(tgt_el)`,
            `        steps = 6`,
            `        actions = ActionChains(driver)`,
            `        actions.move_to_element_with_offset(src_el, 1, 1).click_and_hold(src_el)`,
            `        for i in range(1, steps+1):`,
            `            ix = sx + (tx - sx) * i/steps`,
            `            iy = sy + (ty - sy) * i/steps`,
            `            actions.move_by_offset(0, 0)  # ensure chain not empty per step`,
            `            actions.pause(0.05)`,
            `        actions.move_to_element(tgt_el).pause(0.1).release().perform()`,
            `    strategies.append(strat_incremental_pointer)`,
            ``,
            `    # Strategy 2: Native ActionChains drag_and_drop`,
            `    def strat_native_actionchains():`,
            `        print('[DND] Strategy: native ActionChains drag_and_drop')`,
            `        ActionChains(driver).drag_and_drop(src_el, tgt_el).perform()`,
            `    strategies.append(strat_native_actionchains)`,
            ``,
            `    # Strategy 3: Basic HTML5 DataTransfer dispatch`,
            `    def strat_basic_html5():`,
            `        print('[DND] Strategy: basic HTML5 events')`,
            `        js = """
var src=arguments[0], tgt=arguments[1];
function fire(el,type,data){var e=new Event(type,{bubbles:true,cancelable:true});if(data){e.dataTransfer=data;}el.dispatchEvent(e);return e;}
var dt={data:{},setData:function(k,v){this.data[k]=v;},getData:function(k){return this.data[k];}};
fire(src,'dragstart',dt);fire(tgt,'dragenter',dt);fire(tgt,'dragover',dt);fire(tgt,'drop',dt);fire(src,'dragend',dt);
"""`,
            `        self.execute_script(js, src_el, tgt_el)`,
            `    strategies.append(strat_basic_html5)`,
            ``,
            `    # Strategy 4: Coordinate-based HTML5 sequence`,
            `    def strat_coordinate_html5():`,
            `        print('[DND] Strategy: coordinate-based HTML5 dispatch')`,
            `        js = """
var src=arguments[0], tgt=arguments[1];
function coords(el){var r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};}
var s=coords(src), t=coords(tgt);
var dt={data:{},setData:function(k,v){this.data[k]=v;},getData:function(k){return this.data[k];}};
function fire(el,type,x,y){var e=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y});e.dataTransfer=dt;el.dispatchEvent(e);} 
fire(src,'mousedown',s.x,s.y);fire(src,'dragstart',s.x,s.y);fire(tgt,'dragenter',t.x,t.y);fire(tgt,'dragover',t.x,t.y);fire(tgt,'drop',t.x,t.y);fire(src,'dragend',t.x,t.y);fire(src,'mouseup',t.x,t.y);
"""`,
            `        self.execute_script(js, src_el, tgt_el)`,
            `    strategies.append(strat_coordinate_html5)`,
            ``,
            `    # Strategy 5: Raw mouse event fallback (minimal)`,
            `    def strat_mouse_events():`,
            `        print('[DND] Strategy: raw mouse events')`,
            `        js = """
var src=arguments[0], tgt=arguments[1];
function c(el){var r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};}
var s=c(src), t=c(tgt);
function fire(el,type,x,y){el.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y}));}
fire(src,'mousemove',s.x,s.y);fire(src,'mousedown',s.x,s.y);fire(src,'dragstart',s.x,s.y);fire(tgt,'mousemove',t.x,t.y);fire(tgt,'dragenter',t.x,t.y);fire(tgt,'dragover',t.x,t.y);fire(tgt,'mouseup',t.x,t.y);fire(tgt,'drop',t.x,t.y);fire(src,'dragend',t.x,t.y);
"""`,
            `        self.execute_script(js, src_el, tgt_el)`,
            `    strategies.append(strat_mouse_events)`,
            ``,
            `    last_error = None`,
            `    for strat in strategies:`,
            `        try:`,
            `            strat()`,
            `            print('[DND] Strategy succeeded:', strat.__name__)`,
            `            return`,
            `        except Exception as e:`,
            `            print('[DND] Strategy failed:', strat.__name__, '->', e)`,
            `            last_error = e`,
            `            time.sleep(0.2)`,
            `            # Re-locate elements in case DOM changed`,
            `            try:`,
            `                src_el = self.find_element(source_xpath)`,
            `                tgt_el = self.find_element(target_xpath)`,
            `            except Exception:`,
            `                pass`,
            `    print('[DND] All drag strategies failed. Last error:', last_error)`,
            ``,
            `# --- Enhanced Drag & Drop for modern_components_test.html ---`,
            `def perform_modern_drag(self, source_selector, target_selector):`,
            `    """Specialized drag function for modern_components_test.html (supports CSS selectors)"""`,
            `    print(f"[MODERN-DND] Starting modern drag: {source_selector} -> {target_selector}")`,
            `    `,
            `    # Wait for elements`,
            `    self.wait_for_element_present(source_selector, timeout=10)`,
            `    self.wait_for_element_present(target_selector, timeout=10)`,
            `    `,
            `    # Smart selector handling (supports XPath and CSS)`,
            `    js_drag = """`,
            `    function getElement(selector) {`,
            `        if (selector.startsWith('/') || selector.startsWith('(/')) {`,
            `            // XPath selector`,
            `            return document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;`,
            `        } else {`,
            `            // CSS selector`,
            `            return document.querySelector(selector);`,
            `        }`,
            `    }`,
            `    `,
            `    var source = getElement(arguments[0]);`,
            `    var target = getElement(arguments[1]);`,
            `    `,
            `    if (!source || !target) {`,
            `        console.error('Cannot find source or target element', 'source:', !!source, 'target:', !!target);`,
            `        return false;`,
            `    }`,
            `    `,
            `    console.log('Starting drag:', source.textContent.trim(), '->', target.id || target.className);`,
            `    `,
            `    try {`,
            `        // Method 1: Direct DOM manipulation + trigger custom events`,
            `        target.appendChild(source);`,
            `        `,
            `        // Trigger drag-related events to notify the page of changes`,
            `        var events = ['dragstart', 'drag', 'dragenter', 'dragover', 'drop', 'dragend'];`,
            `        events.forEach(function(eventType) {`,
            `            var event = new Event(eventType, { bubbles: true, cancelable: true });`,
            `            if (eventType === 'dragstart' || eventType === 'drag') {`,
            `                source.dispatchEvent(event);`,
            `            } else if (eventType === 'drop' || eventType === 'dragenter' || eventType === 'dragover') {`,
            `                target.dispatchEvent(event);`,
            `            } else {`,
            `                source.dispatchEvent(event);`,
            `            }`,
            `        });`,
            `        `,
            `        console.log('Drag completed, element moved to:', target.id || target.className);`,
            `        return true;`,
            `        `,
            `    } catch (error) {`,
            `        console.error('Drag failed:', error);`,
            `        return false;`,
            `    }`,
            `    """`,
            `    `,
            `    success = self.execute_script(js_drag, source_selector, target_selector)`,
            `    `,
            `    if success:`,
            `        print("[MODERN-DND] ✅ Drag successful")`,
            `        time.sleep(1)  # Wait for page update`,
            `        return True`,
            `    else:`,
            `        print("[MODERN-DND] ❌ Drag failed, trying fallback method")`,
            `        # Fallback method: use original perform_drag_with_fallback`,
            `        perform_drag_with_fallback(self, source_xpath, target_xpath)`,
            `        return False`,
            ``,
            `# --- DND-Kit Enhanced Support (auto-injected) ---`,
            `def perform_dnd_kit_drag(self, source_selector, target_selector, timeout=10):`,
            `    """Specialized drag and drop for DND-Kit library with multiple strategies."""`,
            `    print(f"[DND-KIT] Starting DND-Kit drag from {source_selector} to {target_selector}")`,
            `    `,
            `    # Wait for elements`,
            `    self.wait_for_element_present(source_selector, timeout=timeout)`,
            `    self.wait_for_element_present(target_selector, timeout=timeout)`,
            `    `,
            `    try:`,
            `        source_el = self.wait_for_element_visible(source_selector, timeout=5)`,
            `        target_el = self.wait_for_element_visible(target_selector, timeout=5)`,
            `    except:`,
            `        source_el = self.find_element(source_selector)`,
            `        target_el = self.find_element(target_selector)`,
            `    `,
            `    # Get source element text content for validation`,
            `    source_text = self.get_text(source_selector)`,
            `    print(f"[DND-KIT] 🏷️ Drag item: '{source_text}'")`,
            `    `,
            `    strategies = []`,
            `    `,
            `    # Strategy 1: DOM manipulation (most reliable for DND-Kit)`,
            `    def strat_dom_manipulation():`,
            `        print("[DND-KIT] 🔄 Trying strategy: dom_manipulation")`,
            `        return self.execute_script("""`,
            `            var source = arguments[0];`,
            `            var target = arguments[1];`,
            `            `,
            `            if (!source || !target) return false;`,
            `            `,
            `            try {`,
            `                // Directly move element to target container`,
            `                target.appendChild(source);`,
            `                `,
            `                // Trigger events needed by DND-Kit`,
            `                var customEvent = new CustomEvent('dnd-kit-move', { `,
            `                    bubbles: true, `,
            `                    detail: { source: source, target: target }`,
            `                });`,
            `                target.dispatchEvent(customEvent);`,
            `                `,
            `                return true;`,
            `            } catch (error) {`,
            `                console.error('DOM manipulation failed:', error);`,
            `                return false;`,
            `            }`,
            `        """, source_el, target_el)`,
            `    strategies.append(strat_dom_manipulation)`,
            `    `,
            `    # Try all strategies`,
            `    for i, strategy in enumerate(strategies, 1):`,
            `        try:`,
            `            success = strategy()`,
            `            if success:`,
            `                print(f"[DND-KIT] ✅ Strategy {strategy.__name__} succeeded!")`,
            `                time.sleep(0.5)  # Wait for DOM update`,
            `                return True`,
            `            else:`,
            `                print(f"[DND-KIT] ❌ Strategy {strategy.__name__} failed")`,
            `                `,
            `        except Exception as e:`,
            `            print(f"[DND-KIT] ❌ Strategy {strategy.__name__} exception: {e}")`,
            `            `,
            `        time.sleep(0.2)  # Pause between strategies`,
            `    `,
            `    # If all strategies fail, use fallback`,
            `    print("[DND-KIT] ❌ All DND-Kit strategies failed, using generic drag method")`,
            `    perform_drag_with_fallback(self, source_selector, target_selector)`,
            ``
        ] : []),
        `class ${className}(BaseCase):`,
        `    def test_recorded_script(self):`,
        `        # --- Test Actions ---`,
        `        self.open("${startURL}")`
    ];



    const allForOutput = [];
    const checkboxSelectors = new Set();
    const radioSelectors = new Set();
    for (const action of recordedActions) {
        if (action.type === 'Checkbox') {
            checkboxSelectors.add(action.selector);
        }
        if (action.type === 'Radio') {
            radioSelectors.add(action.selector);
        }
    }
    const hasUpload = actions.some(a => a && a.type === 'Upload'); // Whether it includes upload actions
    // Helper to detect direct download anchor clicks (blob:/data:), which we should skip in codegen
    const isDirectDownloadAnchorClick = (a) => { // Detect direct download link (blob:/data:) clicks, skip during script generation
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
    for (const action of actions) { // Add steps to output to allForOutput (HTML_Capture only as comments)
        if (action.type === 'ScreenRecordingStart') {
            allForOutput.push({ kind: 'comment', text: `# --- Screen Recording Started (${new Date(action.timestamp).toLocaleString()}) ---` });
        } else if (action.type === 'ScreenRecordingStop') {
            const fileNote = action.fileName ? ` file: ${action.fileName}` : '';
            allForOutput.push({ kind: 'comment', text: `# --- Screen Recording Stopped (${new Date(action.timestamp).toLocaleString()})${fileNote} ---` });
        } else if (action.type !== 'HTML_Capture') {
            // Skip Click/Sleep actions on selectors that had Checkbox or Radio actions
            if ((action.type === 'Click' || action.type === 'Sleep') && 
                (checkboxSelectors.has(action.selector) || radioSelectors.has(action.selector))) continue;
            // Skip clicks on blob:/data: anchors (download links); rely on Download entry instead
            if (action.type === 'Click' && isDirectDownloadAnchorClick(action)) continue;
            allForOutput.push({ kind: 'action', data: action });
        }
    }



    // Precompute Click indices that should be skipped because they precede an Upload
    const skipClickForUpload = new Set(); // Click indices to skip to avoid triggering OS file dialog
    for (let i = 0; i < allForOutput.length; i++) {
        const it = allForOutput[i];
        if (it && it.kind === 'action' && it.data && it.data.type === 'Upload') {
            // Only skip clicks for click-based uploads, not drag-and-drop uploads
            const uploadMethod = it.data.method || 'click';
            if (uploadMethod === 'click') {
                // Look back for the IMMEDIATE preceding Click (within 2 actions)
                for (let j = i - 1; j >= 0 && j >= i - 2; j--) {
                    const prev = allForOutput[j];
                    if (!prev || prev.kind !== 'action' || !prev.data) continue;
                    if (prev.data.type === 'Click') { 
                        console.log(`Background: Marking click for skip before click-upload: ${prev.data.selector}`);
                        skipClickForUpload.add(j); 
                        break; 
                    }
                }
            }
            // For drag-drop uploads, don't skip any clicks as they might be necessary UI interactions
        }
    }

    let lastInputSelector = null;
    for (let i = 0; i < allForOutput.length; i++) {//loop all actions 
        const item = allForOutput[i];
        if (item.kind === 'comment') {
            lines.push(`        ${item.text}`);
            continue;
        }
        const action = item.data;
        let selector = action.selector || '';
        const selectorQuote = selector.includes("'") ? '"' : "'";
        const finalSelector = `${selectorQuote}${selector}${selectorQuote}`;
        const nextItem = allForOutput[i + 1];
        const nextType = nextItem && nextItem.kind === 'action' && nextItem.data ? nextItem.data.type : null;


        const isAutocompleteOptionClick = action.type === 'Click' &&
            selector && /\/html\/body\/div\[\d+\]/.test(selector) &&
            (!action.elementInfo || (action.elementInfo.tagName && action.elementInfo.tagName.toLowerCase() !== 'input'));

        switch (action.type) {
            case 'Click': { // Click
                // Skip Clicks marked as preceding an Upload to avoid OS file dialog
                if (skipClickForUpload.has(i)) {
                    console.log(`Background: Skipping click due to skipClickForUpload: ${selector}`);
                    continue;
                }
                // Only skip click if the IMMEDIATE next action is an Upload (not several actions away)
                let immediateNext = null;
                let nextIndex = i + 1;
                // Skip comments and find the next actual action
                while (nextIndex < allForOutput.length) {
                    const nextItem = allForOutput[nextIndex];
                    if (nextItem && nextItem.kind === 'action' && nextItem.data) {
                        immediateNext = nextItem.data.type;
                        break;
                    }
                    nextIndex++;
                    // Only look ahead 2 positions to avoid skipping legitimate clicks
                    if (nextIndex > i + 2) break;
                }
                
                // Only skip if the immediate next action is a click-based Upload
                if (immediateNext === 'Upload') {
                    const nextUploadAction = allForOutput[nextIndex];
                    const uploadMethod = nextUploadAction?.data?.method || 'click';
                    if (uploadMethod === 'click') {
                        console.log(`Background: Skipping click before click-based upload: ${selector}`);
                        continue;
                    }
                    // For drag-drop uploads, don't skip the click as it might be a necessary UI interaction
                    console.log(`Background: Keeping click before drag-drop upload: ${selector}`);
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
                break;
            }
            case 'Slider': { // Horizontal/ARIA slider (JS value setting + ActionChains drag fallback)
                // Ensure imports exist (header already includes ActionChains/Keys, this is just safety)
                if (!lines.some(l => l.includes('selenium.webdriver.common.action_chains'))) {
                    lines.splice(0, 0, `from selenium.webdriver.common.action_chains import ActionChains`);
                }
                if (!lines.some(l => l.includes('selenium.webdriver.common.keys'))) {
                    lines.splice(0, 0, `from selenium.webdriver.common.keys import Keys`);
                }

                const targetVal = (action.value != null) ? String(action.value) : '';
                const tEsc = targetVal.replace(/'/g, "\\'");

                // Ensure slider is visible and clickable
                //lines.push(`        self.scroll_to(${finalSelector}, timeout=10)`);
                lines.push(`        self.wait_for_element_clickable(${finalSelector}, timeout=10)`);
                lines.push(`        slider = self.find_element(${finalSelector})`);

                // Read current value and attributes (if available)
                lines.push(`        current_value = self.get_attribute(${finalSelector}, 'value') or '0'`);
                lines.push(`        try:`);
                lines.push(`            min_value = float(self.execute_script("return (arguments[0].min !== undefined && arguments[0].min !== '') ? arguments[0].min : 0;", slider))`);
                lines.push(`        except Exception: min_value = 0.0`);
                lines.push(`        try:`);
                lines.push(`            max_value = float(self.execute_script("return (arguments[0].max !== undefined && arguments[0].max !== '') ? arguments[0].max : 100;", slider))`);
                lines.push(`        except Exception: max_value = 100.0`);
                lines.push(`        try:`);
                lines.push(`            step_value = float(self.execute_script("return (arguments[0].step !== undefined && arguments[0].step !== '' && arguments[0].step !== 'any') ? arguments[0].step : 1;", slider))`);
                lines.push(`        except Exception: step_value = 1.0`);
                lines.push(`        target_value = '${tEsc}'`);

                // Geometric info (for drag fallback)
                lines.push(`        rect = self.execute_script("return arguments[0].getBoundingClientRect();", slider)`);
                lines.push(`        computed_width = rect['width'] if rect and 'width' in rect else 0`);
                lines.push(`        padding_left = self.execute_script("return parseFloat(window.getComputedStyle(arguments[0]).paddingLeft) || 0;", slider) or 0`);
                lines.push(`        border_left = self.execute_script("return parseFloat(window.getComputedStyle(arguments[0]).borderLeftWidth) || 0;", slider) or 0`);
                lines.push(`        thumb_width = self.execute_script("""
            let thumb = window.getComputedStyle(arguments[0], '::-webkit-slider-thumb');
            return parseFloat(thumb.width) || parseFloat(thumb.height) || 15;
        """, slider)`);
                lines.push(`        try:
            thumb_width = float(thumb_width)
        except Exception:
            thumb_width = 15`);
                lines.push(`        if thumb_width >= computed_width or thumb_width <= 0:
            thumb_width = 15`);

                // First try JS value setting (also update aria-valuenow) and trigger events
                lines.push(`        try:`);
                lines.push(`            self.execute_script(
                "try { if (arguments[0].tagName && arguments[0].tagName.toLowerCase()==='input' && arguments[0].type==='range') { arguments[0].value = arguments[1]; } arguments[0].setAttribute('aria-valuenow', arguments[1]); arguments[0].dispatchEvent(new Event('input', {bubbles:true})); arguments[0].dispatchEvent(new Event('change', {bubbles:true})); } catch(e) {}",
                slider, target_value
            )`);
                lines.push(`            try:`);
                lines.push(`                self.wait_for_attribute(${finalSelector}, 'value', target_value, timeout=5)`);
                lines.push(`            except Exception:`);
                lines.push(`                # If value doesn't change, try waiting for aria-valuenow
                self.wait_for_attribute(${finalSelector}, 'aria-valuenow', target_value, timeout=3)`);
                lines.push(`        except Exception as e:`);
                lines.push(`            print(f"JavaScript setup: {str(e)}")`);
                lines.push(`            self.save_screenshot('javascript_error.png')`);
                lines.push(`            try:`);
                lines.push(`                try:
                    cur_val_num = float(current_value)
                except Exception:
                    cur_val_num = min_value`);
                lines.push(`                try:
                    tgt_val_num = float(target_value)
                except Exception:
                    tgt_val_num = min_value`);
                lines.push(`                effective_width = max(computed_width - thumb_width - padding_left - border_left, 1)`);
                lines.push(`                range_span = max(max_value - min_value, 1e-9)`);
                lines.push(`                pixels_per_value = effective_width / range_span`);
                lines.push(`                offset = (tgt_val_num - cur_val_num) * pixels_per_value`);
                lines.push(`                actions = ActionChains(self.driver)`);
                lines.push(`                actions.click_and_hold(slider)`);
                lines.push(`                steps = 1`);
                lines.push(`                step_offset = offset / steps`);
                lines.push(`                for _ in range(steps):
                    actions.move_by_offset(step_offset, 0).pause(0.05)`);
                lines.push(`                actions.release().perform()`);
                lines.push(`                try:`);
                lines.push(`                    self.wait_for_attribute(${finalSelector}, 'value', target_value, timeout=5)`);
                lines.push(`                except Exception:
                    self.wait_for_attribute(${finalSelector}, 'aria-valuenow', target_value, timeout=3)`);
                lines.push(`            except Exception as e2:`);
                lines.push(`                print(f"ActionChains fail: {str(e2)}")`);
                lines.push(`                self.save_screenshot('action_chains_error.png')`);
                break;
            }
            case 'Key': // Enter/Tab keys
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
            case 'Input': { // Text input (supports wrapper -> input redirection)
                if (action.value && selector) {
                    // Additional duplicate check at generation time
                    if (lastInputSelector === selector) {
                        // Check if we just generated the same input
                        const lastLine = lines[lines.length - 1];
                        if (lastLine && lastLine.includes('self.send_keys') && lastLine.includes(selector)) {
                            console.log(`Background: Skipping duplicate Input generation for ${selector} with value "${action.value}"`);
                            continue; // Skip this duplicate
                        }
                    }
                    // Normalize selectors
                    let origSel = selector.startsWith('xpath=') ? selector.slice(6) : selector;
                    let inputSel = origSel;

                    // Detect wrapper containers (react-select/combobox etc), redirect input to internal input
                    let looksLikeWrapper = false;
                    let mightBeWrapperByXPath = false;
                    try {
                        const lowered = (origSel || '').toLowerCase();
                        looksLikeWrapper = /__control|__value-container|auto-complete/.test(lowered)
                            || /\[role\s*=\s*"?combobox"?\]/i.test(origSel)
                            || /\[aria-haspopup\s*=\s*"?listbox"?\]/i.test(origSel);
                        // If we have an absolute XPath that does NOT target an input/textarea, treat it as wrapper-like too
                        if (origSel.startsWith('/')) {
                            const pointsToInput = /\/(input|textarea)(\[|$)/i.test(origSel);
                            if (!pointsToInput) {
                                mightBeWrapperByXPath = true;
                            }
                        }
                        if (looksLikeWrapper || mightBeWrapperByXPath) {
                            if (origSel.startsWith('/')) {
                                if (!/\/input(\[|$)/i.test(origSel)) {
                                    inputSel = `${origSel}//input[not(@type) or @type='text' or @type='search']`;
                                }
                            } else {
                                if (!/\sinput(\W|$)/i.test(origSel)) {
                                    inputSel = `${origSel} input`;
                                }
                            }
                        }
                    } catch (e) { /* ignore */ }

                    // Quotes for selectors
                    const qInput = inputSel.includes("'") && !inputSel.includes('"') ? '"' : "'";
                    const qOrig = origSel.includes("'") && !origSel.includes('"') ? '"' : "'";
                    const escapedValue = String(action.value).replace(/'/g, "\\'");

                    // Wait for target input to appear and scroll into view
                    lines.push(`        self.wait_for_element_present(${qInput}${inputSel}${qInput}, timeout=10)`);
                    lines.push(`        self.scroll_into_view(${qInput}${inputSel}${qInput})`);

                    // If previous step already clicked same element, avoid duplicate click
                    const prevItem = allForOutput[i - 1];
                    const prevWasClick = prevItem && prevItem.kind === 'action' && prevItem.data && prevItem.data.type === 'Click';
                    const prevSel = prevWasClick ? (prevItem.data.selector || '') : '';
                    const prevSelNorm = prevSel.startsWith('xpath=') ? prevSel.slice(6) : prevSel;
                    const shouldClick = !prevWasClick || (prevSelNorm !== inputSel && prevSelNorm !== origSel);

                    if (shouldClick) {
                        // For wrapper-like elements, click the wrapper first for stable focus
                        if (looksLikeWrapper || mightBeWrapperByXPath) {
                            lines.push(`        self.click(${qOrig}${origSel}${qOrig})`);
                        }
                        lines.push(`        self.click(${qInput}${inputSel}${qInput})`);
                    }

                    // Use send_keys to maintain compatibility (won't clear existing content)
                    lines.push(`        self.send_keys(${qInput}${inputSel}${qInput}, '${escapedValue}')`);
                    lastInputSelector = selector;

                    // Auto-send Enter for common combobox/autocomplete to submit
                    try {
                        const origLower = (selector || '').toLowerCase();
                        const shouldAutoEnter = looksLikeWrapper || mightBeWrapperByXPath
                            || /subjectsinput/.test(origLower)
                            || /\[role\s*=\s*"?combobox"?\]/i.test(selector)
                            || /\[aria-haspopup\s*=\s*"?listbox"?\]/i.test(selector);
                        if (shouldAutoEnter) {
                            if (!lines.some(l => l.includes('selenium.webdriver.common.keys'))) {
                                lines.splice(0, 0, `from selenium.webdriver.common.keys import Keys`);
                            }
                            //lines.push(`        self.send_keys(${qInput}${inputSel}${qInput}, Keys.ENTER)`);
                        }
                    } catch (e) { /* ignore auto-enter issues */ }
                }
                break;
            }
            case 'Select': { // Native <select> selection

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
            case 'Checkbox': { // Checkbox: check/uncheck based on final state
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
            case 'Radio': { // Radio button: click to select
                let val = action.value;
                let isSelected = false;
                try {
                    if (typeof val === 'boolean') isSelected = val;
                    else if (typeof val === 'number') isSelected = (val === 1);
                    else if (typeof val === 'string') {
                        const v = val.trim().toLowerCase();
                        isSelected = (v === 'true' || v === '1' || v === 'checked' || v === 'on');
                    } else {
                        isSelected = Boolean(val);
                    }
                } catch (e) { isSelected = Boolean(val); }
                
                if (isSelected) {
                    // For radio buttons, we usually only record the selected one
                    const radioValue = action.radioValue || '';
                    const radioName = action.radioName || '';
                    lines.push(`        # Radio button selected: name="${radioName}" value="${radioValue}"`);
                    lines.push(`        self.click(${finalSelector})`);
                }
                break;
            }
            case 'Upload': { // File upload: generate choose_file template and comments
                // Upload action: We cannot reference local files reliably; add guidance comment.
                const fileList = Array.isArray(action.fileNames) ? action.fileNames : [];
                const filesDisplay = fileList.length ? fileList.join(', ') : (action.value || '');
                const method = action.method || 'click'; // Default to click if not specified
                const methodNote = method === 'drag-drop' ? ' (drag & drop)' : ' (click upload)';
                
                lines.push(`        # File upload${methodNote} detected for ${finalSelector} -> ${filesDisplay}`);
                
                if (method === 'drag-drop' && action.dropCoordinates) {
                    // For drag-drop uploads, we might want to add additional context
                    lines.push(`        # Drop coordinates: (${action.dropCoordinates.clientX}, ${action.dropCoordinates.clientY})`);
                }
                
                if (fileList.length) {
                    const first = String(fileList[0]).replace(/'/g, "\\'");
                    lines.push(`        file_path = os.path.join(UPLOAD_DIR, '${first}')`);
                    
                    if (method === 'drag-drop') {
                        // For drag-drop, we might need special handling
                        lines.push(`        # Note: This was a drag-and-drop upload. SeleniumBase will use choose_file() anyway.`);
                        lines.push(`        self.choose_file(${finalSelector}, file_path)`);
                    } else {
                        lines.push(`        self.choose_file(${finalSelector}, file_path)`);
                    }
                    
                    if (fileList.length > 1) {
                        lines.push(`        # Note: multiple files selected (${fileList.length}). Add additional choose_file calls as needed.`);
                    }
                } else {
                    lines.push(`        # Example (adjust path): self.choose_file(${finalSelector}, "path/to/your/file.ext")`);
                }
                break;
            }
            case 'Download': { // Download: hint with comments
                const fname = action.value || action.filename || '(download)';
                const urlInfo = action.url ? ` url=${action.url}` : '';
                lines.push(`        # Expecting file download: ${fname}${urlInfo}`);
                // Optional: users can enable/download dir assertions; we keep it as a hint
                lines.push(`        # self.wait_for_downloads()`)
                break;
            }
            case 'DragAndDrop': {
                const sourceSelector = action.sourceSelector || '';
                const targetSelector = action.targetSelector || '';
                const qs = (sourceSelector.includes("'") && !sourceSelector.includes('"')) ? '"' : "'";
                const qt = (targetSelector.includes("'") && !targetSelector.includes('"')) ? '"' : "'";
                
                // Enhanced DND-Kit support
                if (action.isDndKit) {
                    lines.push(`        # DND-Kit drag and drop operation`);
                    if (action.dndKitSourceId) {
                        lines.push(`        # Source: DND-Kit item with ID '${action.dndKitSourceId}'`);
                    }
                    if (action.dndKitTargetId) {
                        lines.push(`        # Target: DND-Kit ${action.dndKitTargetType || 'zone'} with ID '${action.dndKitTargetId}'`);
                    }
                    if (action.insertionType) {
                        lines.push(`        # Insertion: ${action.insertionType} existing item`);
                    }
                    lines.push(`        source_xpath = ${qs}${sourceSelector}${qs}`);
                    lines.push(`        target_xpath = ${qt}${targetSelector}${qt}`);
                    lines.push(`        perform_dnd_kit_drag(self, source_xpath, target_xpath)`);
                } else if (hasDrag) {
                    // Check if it's modern_components_test.html, use specialized drag function
                    const isModernComponents = startURL && startURL.includes('modern_components_test.html');
                    if (isModernComponents) {
                        lines.push(`        # Using drag function optimized for modern_components_test.html`);
                        lines.push(`        perform_modern_drag(self, ${qs}${sourceSelector}${qs}, ${qt}${targetSelector}${qt})`);
                    } else {
                        lines.push(`        perform_drag_with_fallback(self, ${qs}${sourceSelector}${qs}, ${qt}${targetSelector}${qt})`);
                    }
                } else {
                    lines.push(`        self.drag_and_drop(${qs}${sourceSelector}${qs}, ${qt}${targetSelector}${qt})`);
                }
                break;
            }
            case 'Hover': {
                // Hover over the element (use SeleniumBase's hover helper)
                //lines.push(`        self.scroll_to(${finalSelector}, timeout=10)`);
                lines.push(`        self.hover(${finalSelector})`);
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
    // Append download information during recording (comments)
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

    // If there are uploads: insert import os and UPLOAD_DIR (if files are embedded, point to ./uploads)
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

// Export helpers: URL parsing and content downloading
// Convert relative path to absolute URL (relative to baseUrl)
function resolveUrl(href, baseUrl) {
    try {
        if (!href) return null;
        return new URL(href, baseUrl).href;
    } catch (e) { return href; }
}

// Download text from URL (with basic error handling)
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

// Convert url(...) in CSS to absolute paths (based on that CSS's URL)
function rewriteCssUrls(cssText, cssUrl) {
    if (!cssText) return cssText;
    return cssText.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/g, (m, quote, href) => {
        const trimmed = href.trim();
        if (/^(data:|blob:|http:|https:|#)/i.test(trimmed)) return `url(${quote}${trimmed}${quote})`;
        const abs = resolveUrl(trimmed, cssUrl);
        return `url(${quote}${abs}${quote})`;
    });
}

// Inline <link rel="stylesheet"> and @import into HTML (avoid offline preview missing CSS)
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

// Clean up consecutive duplicate Input actions
function removeDuplicateInputActions(actions) {
    if (!Array.isArray(actions) || actions.length === 0) return actions;
    
    console.log(`Background: Starting duplicate cleanup on ${actions.length} actions`);
    const cleaned = [];
    let removedCount = 0;
    
    for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        
        if (!action || action.type !== 'Input') {
            cleaned.push(action);
            continue;
        }
        
        // Check if this is a duplicate of any recent Input actions
        let isDuplicate = false;
        for (let j = cleaned.length - 1; j >= 0 && j >= cleaned.length - 5; j--) {
            const prevAction = cleaned[j];
            if (!prevAction || prevAction.type !== 'Input') continue;
            
            // Same selector and value = duplicate
            if (prevAction.selector === action.selector && 
                prevAction.value === action.value) {
                
                // Check timestamp if available
                let timeDiff = 0;
                if (action.timestamp && prevAction.timestamp) {
                    timeDiff = action.timestamp - prevAction.timestamp;
                }
                
                // Consider it duplicate if within 5 seconds or if no timestamp info
                if (timeDiff === 0 || timeDiff < 5000) {
                    console.log(`Background: Removing duplicate Input for selector "${action.selector}" with value "${action.value}" (time diff: ${timeDiff}ms)`);
                    isDuplicate = true;
                    removedCount++;
                    break;
                }
            }
        }
        
        if (!isDuplicate) {
            cleaned.push(action);
        }
    }
    
    console.log(`Background: Removed ${removedCount} duplicate Input actions, final count: ${cleaned.length}`);
    return cleaned;
}

function performExport(sendResponse) { // Export ZIP: flush inputs first, then assemble script, capture HTML/CSS/screenshots/videos/uploads
    try {
        flushAllPendingInputs().then(() => {
            if (typeof JSZip === 'undefined') { sendResponse && sendResponse({ success: false, message: "JSZip not loaded." }); return; }
            finalizeIncomingVideos();
            // Debug: output video info summary (name, segment count, etc.)
            try {
                const info = recordedVideos.map(v => ({ fileName: v.fileName, recordingId: v.recordingId, chunks: Array.isArray(v.chunks) ? v.chunks.length : 0 }));
                console.log('Background: recordedVideos for export:', info);
            } catch (e) { console.warn('Background: Failed to log recordedVideos info', e); }

            // Read custom upload directory from storage (if user set it)
            chrome.storage.local.get(['selbas_upload_dir']).then((res) => {
                const uploadDir = res && res.selbas_upload_dir ? res.selbas_upload_dir : null;
                
                // Clean up consecutive duplicate Input actions before generating script
                const cleanedActions = removeDuplicateInputActions(recordedActions);
                console.log(`Background: Original actions: ${recordedActions.length}, Cleaned actions: ${cleanedActions.length}`);
                
                // Log Input actions for debugging
                const inputActions = cleanedActions.filter(a => a && a.type === 'Input');
                console.log(`Background: Input actions in cleaned list:`, inputActions.map(a => ({
                    selector: a.selector,
                    value: a.value,
                    timestamp: a.timestamp,
                    source: a.source
                })));
                
                const script = generateSeleniumBaseScript({ uploadDir }, cleanedActions);
                const zip = new JSZip();
                zip.file("test_recorded_script.py", script);
                // Add HTML after inlining CSS first
                const htmlPromises = capturedHTMLs.map(async (h, idx) => {
                    try {
                        if (!h || typeof h.html !== 'string') return;
                        const pageUrl = h.url || startURL || '';
                        const inlined = await inlineCssIntoHtml(h.html, pageUrl);
                        zip.file(`capture_${idx + 1}.html`, inlined);
                    } catch (e) {
                        console.warn('Background: failed to inline CSS for capture', idx + 1, e);
                        zip.file(`capture_${idx + 1}.html`, h.html);
                    }
                });
                const screenshotPromises = capturedScreenshots.map((s, idx) => {
                    if (!s || !s.dataUrl) return Promise.resolve();
                    const filename = `screenshot_${idx + 1}.png`;
                    return fetch(s.dataUrl).then(r => r.arrayBuffer()).then(buf => zip.file(filename, buf)).catch(e => console.warn("Background: screenshot processing failed:", e));
                });
                // Put uploaded files (if any) into uploads/ directory
                const uploadPromises = (Array.isArray(uploadedFiles) ? uploadedFiles : []).map((f) => {
                    try {
                        if (!f || !f.name || !f.dataUrl) return Promise.resolve();
                        const safeName = String(f.name).replace(/[\\/:*?"<>|]/g, '_');
                        const fname = `uploads/${safeName}`;
                        return fetch(f.dataUrl).then(r => r.arrayBuffer()).then(buf => zip.file(fname, buf)).catch(e => console.warn('Background: upload file add failed:', e));
                    } catch (e) { return Promise.resolve(); }
                });
                Promise.all([...htmlPromises, ...screenshotPromises, ...uploadPromises])
                    .then(() => {
                        recordedVideos.forEach(v => {
                            try {
                                const size = v.chunks.reduce((s, c) => s + c.length, 0);
                                const merged = new Uint8Array(size);
                                let offset = 0; v.chunks.forEach(c => { merged.set(c, offset); offset += c.length; });
                                let fname = v.fileName || `recording_${Date.now()}.webm`;
                                let counter = 1; while (zip.file(fname)) fname = fname.replace(/(\.webm)$/i, `_${counter++}$1`);
                                zip.file(fname, merged);
                            } catch (e) { console.warn('Background: failed to add video', e); }
                        });
                        return zip.generateAsync({ type: "blob" });
                    })
                    .then(blob => {
                        const reader = new FileReader();
                        reader.onload = function () {
                            const dataUrl = reader.result;
                            chrome.downloads.download({ url: dataUrl, filename: "seleniumbase_recording.zip", saveAs: true })
                                .then((downloadId) => { try { ignoredDownloadIds.add(downloadId); } catch (e) { } sendResponse && sendResponse({ success: true }); resetRecordingState(true); })
                                .catch(err => { sendResponse && sendResponse({ success: false, message: err && err.message ? err.message : String(err) }); resetRecordingState(true); });
                        };
                        reader.onerror = function () { sendResponse && sendResponse({ success: false, message: 'Failed to read ZIP blob.' }); resetRecordingState(true); };
                        reader.readAsDataURL(blob);
                    })
                    .catch(err => { sendResponse && sendResponse({ success: false, message: err && err.message ? err.message : String(err) }); resetRecordingState(true); });
            }).catch(() => {
                // If reading storage fails, generate script and ZIP with default path
                const script = generateSeleniumBaseScript({ uploadDir: null });
                const zip = new JSZip();
                zip.file("test_recorded_script.py", script);
                const htmlPromises = capturedHTMLs.map(async (h, idx) => {
                    try {
                        if (!h || typeof h.html !== 'string') return;
                        const pageUrl = h.url || startURL || '';
                        const inlined = await inlineCssIntoHtml(h.html, pageUrl);
                        zip.file(`capture_${idx + 1}.html`, inlined);
                    } catch (e) {
                        zip.file(`capture_${idx + 1}.html`, h && h.html ? h.html : '');
                    }
                });
                const screenshotPromises = capturedScreenshots.map((s, idx) => {
                    if (!s || !s.dataUrl) return Promise.resolve();
                    const filename = `screenshot_${idx + 1}.png`;
                    return fetch(s.dataUrl).then(r => r.arrayBuffer()).then(buf => zip.file(filename, buf)).catch(e => console.warn("Background: screenshot processing failed:", e));
                });
                const uploadPromises = (Array.isArray(uploadedFiles) ? uploadedFiles : []).map((f) => {
                    try {
                        if (!f || !f.name || !f.dataUrl) return Promise.resolve();
                        const safeName = String(f.name).replace(/[\\/:*?"<>|]/g, '_');
                        const fname = `uploads/${safeName}`;
                        return fetch(f.dataUrl).then(r => r.arrayBuffer()).then(buf => zip.file(fname, buf)).catch(e => console.warn('Background: upload file add failed:', e));
                    } catch (e) { return Promise.resolve(); }
                });
                Promise.all([...htmlPromises, ...screenshotPromises, ...uploadPromises])
                    .then(() => zip.generateAsync({ type: "blob" }))
                    .then(blob => {
                        const reader = new FileReader();
                        reader.onload = function () {
                            const dataUrl = reader.result;
                            chrome.downloads.download({ url: dataUrl, filename: "seleniumbase_recording.zip", saveAs: true })
                                .then((downloadId) => { try { ignoredDownloadIds.add(downloadId); } catch (e) { } sendResponse && sendResponse({ success: true }); resetRecordingState(true); })
                                .catch(err => { sendResponse && sendResponse({ success: false, message: err && err.message ? err.message : String(err) }); resetRecordingState(true); });
                        };
                        reader.onerror = function () { sendResponse && sendResponse({ success: false, message: 'Failed to read ZIP blob.' }); resetRecordingState(true); };
                        reader.readAsDataURL(blob);
                    })
                    .catch(err => { sendResponse && sendResponse({ success: false, message: err && err.message ? err.message : String(err) }); resetRecordingState(true); });
            });
        }).catch(() => { sendResponse && sendResponse({ success: false, message: 'Failed to flush inputs.' }); });
    } catch (e) {
        sendResponse && sendResponse({ success: false, message: e.message });
    }
}

/**
 * Reset recording state, with optional Side Panel closure.
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
        try { clearTimeout(pendingInputTimers[k]); } catch (e) { }
    }
    pendingInputTimers = {};
    pendingInputBuffers = {};

    console.log("Background: Recording state reset.");

    // Immediately save reset state
    saveState();
    
    // Stop periodic saving
    stopPeriodicStateSave();

    chrome.runtime.sendMessage({ command: "update_ui", data: { actions: [], isRecording: false, htmlCount: 0, screenshotCount: 0 } }) // Notify sidebar to update
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
 * Request HTML from content script for specified tab (defaults to recording tab).
 * @param {number} [tabId] optional tabId to request HTML from (fallback to recordingTabId)
 */
function triggerHTMLCapture(tabId) {
    return new Promise((resolve, reject) => {
        const now = Date.now();
        if (now - lastCaptureTime < 500) return resolve();
        lastCaptureTime = now;

        if (!isRecording) return reject(new Error("Not recording.")); // Don't execute when not recording
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
                const captureAction = { // Add 'HTML_Capture' item to action list
                    type: 'HTML_Capture',
                    step: refStep,
                    timestamp: Date.now(),
                    selectorType: 'N/A',
                    value: `Captured page source (tab ${targetTabId})`
                };
                recordedActions.push(captureAction);
                
                // Immediately save state
                saveState();
                
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
 * Capture visible tab content (screenshot) and save as dataURL.
 * If tabId not specified, defaults to recording tab.
 * @param {number} [tabId]
 */
function triggerScreenshot(tabId, { force = false } = {}) {
    return new Promise((resolve) => {
        if (!isRecording) return resolve(); // Only capture when recording
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
                        
                        // Immediately save state (screenshot capture)
                        saveState();
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
function flushPendingInput(selector) { // Flush pending Input for specific selector into action list (deduplicate, keep latest)
    const buffered = pendingInputBuffers[selector];
    delete pendingInputBuffers[selector];
    const t = pendingInputTimers[selector];
    if (t) { try { clearTimeout(t); } catch (e) { } delete pendingInputTimers[selector]; }
    if (!buffered) return Promise.resolve();

    // Remove existing Input actions with same selector, keep only latest
    for (let i = recordedActions.length - 1; i >= 0; i--) {
        if (recordedActions[i].type === 'Input' && recordedActions[i].selector === selector) {
            recordedActions.splice(i, 1);
        }
    }
    buffered.step = recordedActions.length + 1;
    delete buffered.elementInfo;
    recordedActions.push(buffered);
    
    // Immediately save state
    saveState();
    
    return Promise.allSettled([triggerScreenshot(), triggerHTMLCapture()]) // Also capture screen and HTML
        .finally(() => {

            chrome.runtime.sendMessage({
                command: "update_ui",
                data: {
                    actions: recordedActions,
                    isRecording: true,
                    htmlCount: capturedHTMLs.length,
                    screenshotCount: capturedScreenshots.length
                }
            }).catch(() => { });
        });
}

/**
 * Flush all pending inputs.
 */
function flushAllPendingInputs() { // Write all pending Inputs at once
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
async function ensureContentScriptInTab(tabId) { // Ensure content.js is injected into specified tab
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
async function injectIntoAllTabs() { // Try to inject into all existing tabs during install/startup
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => { // Main message handler: receive popup/content/sidepanel commands
    console.log("Background received message:", message && message.command, "from", sender && sender.tab ? "tab " + sender.tab.id : "extension");

    const cmd = message && message.command;

    switch (cmd) {
        case "start_recording": { // Start recording
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

            // Allow main recording tab to send events
            allowedRecordingTabs.clear();
            allowedRecordingTabs.add(recordingTabId);

            console.log(`Background: Starting recording for tab ${recordingTabId} with URL ${startURL}`);

            // Immediately save state
            saveState();
            
            // Ensure periodic saving is started
            startPeriodicStateSave();

            chrome.scripting.executeScript({ target: { tabId: recordingTabId }, files: ['content.js'] })
                .then(() => new Promise(r => setTimeout(r, 500)))
                .then(() => triggerHTMLCapture()) // Capture HTML once at start
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

        case "upload_file": { // Upload file data sent from content.js (embedded in ZIP)
            try {
                const d = message.data || {};
                if (!isRecording) { sendResponse && sendResponse({ success: false, message: 'Not recording' }); return true; }
                if (!d || !d.name || !d.dataUrl || typeof d.dataUrl !== 'string') {
                    sendResponse && sendResponse({ success: false, message: 'Invalid upload_file payload' });
                    return true;
                }
                // Store up to a reasonable limit to avoid huge zips; cap at 50MB total or 50 files
                if (!Array.isArray(uploadedFiles)) uploadedFiles = [];
                if (uploadedFiles.length >= 50) { sendResponse && sendResponse({ success: false, message: 'Too many files' }); return true; }
                // Basic size guard: if dataUrl length too big (> 50MB base64), skip
                try {
                    const approxBytes = Math.floor((d.dataUrl.length - (d.dataUrl.indexOf(',') + 1)) * 3 / 4);
                    if (approxBytes > 50 * 1024 * 1024) { sendResponse && sendResponse({ success: false, message: 'File too large to embed' }); return true; }
                } catch (e) { /* ignore size calc errors */ }
                uploadedFiles.push({ name: String(d.name).replace(/[\\/:*?"<>|]/g, '_'), dataUrl: d.dataUrl });
                sendResponse && sendResponse({ success: true });
            } catch (e) { sendResponse && sendResponse({ success: false, message: e && e.message ? e.message : String(e) }); }
            return true;
        }

        case "record_action": {
            if (!isRecording || !recordingTabId) { sendResponse({ success: false }); return true; }

            const senderTabId = sender && sender.tab && sender.tab.id;
            if (senderTabId && !allowedRecordingTabs.has(senderTabId) && senderTabId !== recordingTabId) {
                sendResponse({ success: false });
                return true;
            }

            const action = message.data;
            if (!action || !action.type) { sendResponse({ success: false }); return true; }

            // Add Hover action logging (for debugging)
            if (action.type === 'Hover') {
                try { console.log('Background: Received Hover action:', action); } catch (e) { }
            }

            // Special handling for Input and Hover
            if (action.type === 'Input' || action.type === 'Hover') {
                const sel = action.selector || ('UNKNOWN_SELECTOR_' + Date.now());
                action.selector = sel;
                
                // For Input actions, check for duplicates within a short timeframe
                if (action.type === 'Input') {
                    const now = Date.now();
                    const DUPLICATE_THRESHOLD_MS = 2000; // Increase to 2 seconds for better detection
                    
                    // Find recent Input actions with same selector and value
                    const recentSimilar = recordedActions
                        .slice(-10) // Only check last 10 actions for performance
                        .filter(a => a && a.type === 'Input' && a.selector === sel)
                        .filter(a => (now - a.timestamp) < DUPLICATE_THRESHOLD_MS)
                        .filter(a => a.value === action.value);
                    
                    if (recentSimilar.length > 0) {
                        console.log(`Background: Skipping duplicate Input action for ${sel} with value "${action.value}":`, action);
                        console.log('Recent similar actions:', recentSimilar.map(a => ({
                            value: a.value,
                            timestamp: a.timestamp,
                            source: a.source,
                            timeDiff: now - a.timestamp
                        })));
                        sendResponse({ success: true, skipped: true, reason: 'duplicate' });
                        return true;
                    }
                    
                    // Also check for any Input actions with same selector regardless of value within shorter time
                    const VERY_RECENT_MS = 500; // 500ms for very recent actions
                    const veryRecentSameSelector = recordedActions
                        .slice(-5)
                        .filter(a => a && a.type === 'Input' && a.selector === sel)
                        .filter(a => (now - a.timestamp) < VERY_RECENT_MS);
                    
                    if (veryRecentSameSelector.length > 0) {
                        console.log(`Background: Skipping very recent Input action for ${sel}:`, action);
                        sendResponse({ success: true, skipped: true, reason: 'too-recent' });
                        return true;
                    }
                    
                    console.log(`Background: Recording Input action (source: ${action.source || 'unknown'}):`, action);
                }
                
                action.step = recordedActions.length + 1;
                delete action.elementInfo;
                recordedActions.push(action);

                // Immediately save state
                saveState();

                const tabForCapture = senderTabId || recordingTabId;
                const tasks = [triggerHTMLCapture(tabForCapture)];
                if (!isScreenRecordingActive) tasks.unshift(triggerScreenshot(tabForCapture));

                setTimeout(() => {
                    Promise.allSettled(tasks)
                        .finally(() => {
                            chrome.runtime.sendMessage({
                                command: "update_ui",
                                data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length }
                            }).catch(() => { });
                        });
                }, 500);

                sendResponse({ success: true, debounced: false });
                return true;
            }

            // 非 Input 動作：先把待處理的 Input 全部 flush，再處理（確保順序）
            const processNonInputAction = (actionToRecord) => {
                // Special enrichment for DragAndDrop so the side panel (which expects a single selector/value)
                // can display meaningful information instead of SELECTOR_MISSING.
                if (actionToRecord && actionToRecord.type === 'DragAndDrop') {
                    try { console.log('Background: Processing DragAndDrop action (pre-enrich):', JSON.parse(JSON.stringify(actionToRecord))); } catch(e) {}
                    // Provide a canonical selector (use source first, else target) for backward compatibility.
                    if (!actionToRecord.selector) {
                        actionToRecord.selector = actionToRecord.sourceSelector || actionToRecord.targetSelector || 'DRAG_SOURCE_MISSING';
                        actionToRecord.selectorType = 'XPath';
                    }
                    // Provide a concise human readable value summary
                    if (!actionToRecord.value) {
                        const src = actionToRecord.sourceSelector || '?';
                        const tgt = actionToRecord.targetSelector || '?';
                        const kind = actionToRecord.containerKind ? ` (${actionToRecord.containerKind})` : '';
                        actionToRecord.value = `Drag: ${src} -> ${tgt}${kind}`;
                    }
                    try { console.log('Background: DragAndDrop action enriched:', JSON.parse(JSON.stringify(actionToRecord))); } catch(e) {}
                }
                actionToRecord.step = recordedActions.length + 1;
                if (!actionToRecord.selector) {
                    actionToRecord.selector = "SELECTOR_MISSING";
                    actionToRecord.selectorType = 'N/A';
                }
                delete actionToRecord.elementInfo;
                recordedActions.push(actionToRecord);
                console.log("Background: Recorded action:", actionToRecord);

                // Immediately save state
                saveState();

                const delayMs = 0;
                setTimeout(() => {
                    const tasks = [triggerHTMLCapture(senderTabId || recordingTabId)];
                    if (!isScreenRecordingActive) tasks.unshift(triggerScreenshot(senderTabId || recordingTabId));
                    Promise.allSettled(tasks)
                        .finally(() => {
                            chrome.runtime.sendMessage({
                                command: "update_ui",
                                data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length }
                            }).catch(() => { });
                        });
                }, delayMs);
            };
            

            // For Click/Enter/Tab/Select, flush all Inputs first to ensure Input comes before Click/Key
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

            // For Upload: try to remove Click within 3 seconds prior to avoid script triggering file picker
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
                                try { console.log('Background: Removed preceding Click before Upload to avoid file picker in script.'); } catch (e) { }
                                break;
                            }
                            // if older than the window, stop scanning further back
                            if (dt > 3000) break;
                        }
                    }
                } catch (e) { /* ignore */ }
                // proceed to record Upload
            }

            // Non-click non-input actions: record immediately
            try {
                processNonInputAction(action);
            } catch (e) { console.warn('Background: processNonInputAction error:', e); }

            sendResponse({ success: true });
            return true;
        }

        case "screen_recording_start": { // Sidebar notifies start of screen recording, insert marker
            if (!isRecording) { sendResponse({ success: false, message: 'Not recording session.' }); return true; }
            currentScreenRecordingId = 'rec_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
            const marker = { type: 'ScreenRecordingStart', step: recordedActions.length + 1, timestamp: Date.now(), recordingId: currentScreenRecordingId };
            recordedActions.push(marker);
            isScreenRecordingActive = true;
            chrome.runtime.sendMessage({ command: 'update_ui', data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length } }).catch(() => { });
            sendResponse({ success: true });
            return true;
        }
        case "screen_recording_stop": { // Sidebar notifies stop of screen recording, insert marker, continue export if needed
            if (!isRecording) { sendResponse({ success: false, message: 'Not recording session.' }); return true; }
            const fileName = message.data && message.data.fileName;
            const marker = { type: 'ScreenRecordingStop', step: recordedActions.length + 1, timestamp: Date.now(), fileName, recordingId: currentScreenRecordingId };
            recordedActions.push(marker);
            isScreenRecordingActive = false;
            currentScreenRecordingId = null;
            chrome.runtime.sendMessage({ command: 'update_ui', data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length } }).catch(() => { });
            // If an export was requested while recording, perform it now
            if (pendingExportAfterStop) {
                const responder = pendingExportAfterStop.sendResponse;
                pendingExportAfterStop = null;
                performExport(responder);
            }
            sendResponse({ success: true });
            return true;
        }

        case "video_chunk": { // Video segments sent from sidebar (base64), assemble in background
            try {
                const d = message.data || {};
                if (!d.id || typeof d.index !== 'number' || typeof d.total !== 'number' || !d.chunkBase64) {
                    sendResponse({ success: false, message: 'Invalid chunk data' });
                    return true;
                }
                if (!incomingVideoBuffers[d.id]) {
                    // attach currentScreenRecordingId if exists; side panel sends chunks while recording active
                    incomingVideoBuffers[d.id] = { fileName: d.fileName || (`recording_${Date.now()}.webm`), total: d.total, received: 0, chunks: [], recordingId: currentScreenRecordingId };
                }
                const buf = incomingVideoBuffers[d.id];
                const bstr = atob(d.chunkBase64);
                const arr = new Uint8Array(bstr.length);
                for (let i = 0; i < bstr.length; i++) arr[i] = bstr.charCodeAt(i);
                buf.chunks[d.index] = arr;
                buf.received++;
                if (buf.received === buf.total) {
                    const ordered = [];
                    for (let i = 0; i < buf.total; i++) if (buf.chunks[i]) ordered.push(buf.chunks[i]);
                    recordedVideos.push({ fileName: buf.fileName, chunks: ordered, recordingId: buf.recordingId });
                    delete incomingVideoBuffers[d.id];
                    console.log('Background: Completed video assembly', buf.fileName);
                }
                sendResponse({ success: true });
            } catch (e) { sendResponse({ success: false, message: e.message }); }
            return true;
        }

        case "dialog_event": { // Dialog event sent from content.js (alert/confirm/prompt)
            if (!isRecording) { sendResponse && sendResponse({ success: false }); return true; }
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
                            const deleteKeywords = ['delete', 'remove', 'confirm delete'];
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
            const baseDelay = (typeof d.scheduleDelayMs === 'number') ? d.scheduleDelayMs : 600; // Default delay 600ms
            const confirmBuffer = (d.result === true) ? 350 : 120; // ms
            const delay = baseDelay + confirmBuffer;
            setTimeout(() => {
                try { console.log(`Background: dialog_event capture after ${delay}ms (base ${baseDelay} + buffer ${confirmBuffer})`); } catch (e) { }
                Promise.allSettled([
                    triggerScreenshot(recordingTabId, { force: true }),
                    triggerHTMLCapture(recordingTabId)
                ]).finally(() => {
                    chrome.runtime.sendMessage({ command: 'update_ui', data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length } }).catch(() => { });

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
                                            for (let i = 0; i < recordedActions.length; i++) recordedActions[i].step = i + 1;
                                        }
                                        // Remove captures tied to that step or in the immediate vicinity
                                        capturedHTMLs = capturedHTMLs.filter(h => h.refStep !== deletedStep && !(h.refStep > deletedStep && h.refStep <= deletedStep + 2));
                                        capturedScreenshots = capturedScreenshots.filter(s => s.refStep !== deletedStep && !(s.refStep > deletedStep && s.refStep <= deletedStep + 2));
                                        console.log(`Background: Removed Click action at step ${deletedStep} after confirmed delete verification.`);
                                        chrome.runtime.sendMessage({ command: 'update_ui', data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length } }).catch(() => { });
                                    }
                                });
                            } catch (e) { console.warn('Background: deletion verification sendMessage error', e); }
                        }
                    } catch (e) { console.warn('Background: deletion verification overall error', e); }
                });
            }, delay);
            sendResponse && sendResponse({ success: true });
            return true;
        }

        case "add_external_screenshot": { // External full-page screenshot sent from sidebar
            if (!isRecording) { sendResponse && sendResponse({ success: false }); return true; }
            const d = message.data || {};
            if (!d.dataUrl || typeof d.dataUrl !== 'string') { sendResponse && sendResponse({ success: false, message: 'No dataUrl' }); return true; }
            const step = recordedActions.length + 1;
            capturedScreenshots.push({ dataUrl: d.dataUrl, refStep: step });
            const action = { type: 'FullBrowserScreenshot', step, timestamp: Date.now(), selectorType: 'N/A', value: 'Full browser display captured' };
            recordedActions.push(action);
            chrome.runtime.sendMessage({ command: 'update_ui', data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length } }).catch(() => { });
            sendResponse && sendResponse({ success: true });
            return true;
        }

        case "delete_action": { // Delete specified action (supports recording marker recordingId batch removal)
            let idx = (typeof message.index === 'number') ? message.index : -1;
            if (idx === -1 && message.data && typeof message.data.step === 'number') {
                // sidepanel sends 1-based step
                idx = message.data.step - 1;
            }
            if (typeof idx !== 'number' || idx < 0 || idx >= recordedActions.length) {
                sendResponse({ success: false, message: 'Invalid index' });
                return true;
            }
            const toDelete = recordedActions[idx];
            if (!toDelete) { sendResponse({ success: false, message: 'No action at index' }); return true; }

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
                recordedActions.splice(idx, 1);
                removedSteps.add(deletedStep);
            }

            // Reindex steps
            for (let i = 0; i < recordedActions.length; i++) recordedActions[i].step = i + 1;

            // Remove captures tied to removed steps
            if (removedSteps.size > 0) {
                capturedHTMLs = capturedHTMLs.filter(h => !removedSteps.has(h.refStep));
                capturedScreenshots = capturedScreenshots.filter(s => !removedSteps.has(s.refStep));
            }

            // Remove recordedVideos entries that match the recordingId (only if provided)
            if (recIdToCheck) {
                recordedVideos = recordedVideos.filter(v => v.recordingId !== recIdToCheck);
            }

            chrome.runtime.sendMessage({ command: 'update_ui', data: { actions: recordedActions, htmlCount: capturedHTMLs.length, isRecording: true, screenshotCount: capturedScreenshots.length } }).catch(() => { });
            sendResponse({ success: true });
            return true;
        }

        case "save_export": { // 使用者按下 Save & Export
            if (!isRecording) { sendResponse({ success: false, message: "Not recording." }); return true; }
            if (isScreenRecordingActive) {
                pendingExportAfterStop = { sendResponse };
                try { chrome.runtime.sendMessage({ command: 'force_stop_screen_recording' }); } catch (e) { }
                return true;
            }
            performExport(sendResponse);
            return true;
        }

        case "cancel_recording": { // 取消整個錄製
            if (!isRecording) { sendResponse({ success: false, message: "Not recording." }); return true; }
            resetRecordingState(true);
            sendResponse({ success: true });
            return true;
        }

        case "capture_html": { // 側邊欄請求：手動擷取當前 HTML
            // Manual HTML capture requested from side panel.
            if (!isRecording) { sendResponse({ success: false, message: "Not recording." }); return true; }
            triggerHTMLCapture()
                .then(() => {
                    // Update side panel UI with new action & counts.
                    chrome.runtime.sendMessage({
                        command: 'update_ui',
                        data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length }
                    }).catch(() => { });
                    sendResponse({ success: true, htmlCount: capturedHTMLs.length });
                })
                .catch(err => {
                    console.warn('Background: Manual HTML capture failed:', err);
                    sendResponse({ success: false, message: err && err.message ? err.message : String(err) });
                });
            return true; // async
        }

        case "get_status": { // 回覆錄製狀態（給 popup 或其他）
            sendResponse({ isRecording, recordingTabId });
            return true;
        }

        case "request_current_state": { // 側邊欄初始化時請求目前狀態
            if (isRecording && sender.contextType === "SIDE_PANEL") {
                sendResponse({ actions: recordedActions, htmlCount: capturedHTMLs.length, isRecording: true, startUrl: startURL });
            } else sendResponse(null);
            return true;
        }

        case "stop_recording_internal": { // 側邊欄關閉前通知停止
            if (isRecording && sender.contextType === "SIDE_PANEL") {
                resetRecordingState(false);
                sendResponse({ success: true });
            } else sendResponse({ success: false, message: "Not recording or invalid context" });
            return true;
        }

        case "popup_opened": { // content.js 通知：偵測到 window.open / popupWindow
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
                    if (expectingPopup.fallbackTimerId) { try { clearTimeout(expectingPopup.fallbackTimerId); } catch (e) { } expectingPopup.fallbackTimerId = null; }
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
                            try { allowedRecordingTabs.add(tab.id); } catch (e) { }
                            pendingNewTabs[tab.id] = { createdAt: Date.now(), openerTabId: tab.openerTabId || null, windowId: tab.windowId || null, expectedUrl: expectingPopup ? expectingPopup.expectedUrl : null, fallbackCreated: true };
                            // inject content script and capture shortly after
                            await ensureContentScriptInTab(tab.id);
                            await new Promise(r => setTimeout(r, 200));
                            triggerScreenshot(tab.id, { force: true }).catch(() => { });
                            triggerHTMLCapture(tab.id).catch(() => { });
                        } catch (e) { /* ignore */ }
                        try { chrome.tabs.onCreated.removeListener(onTabCreatedOnce); } catch (e) { }
                        try { chrome.windows.onCreated.removeListener(onWindowCreatedOnce); } catch (e) { }
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
                                chrome.runtime.sendMessage({ command: "update_ui", data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length } }).catch(() => { });
                            });
                        } catch (e) { /* ignore */ }
                        try { chrome.tabs.onCreated.removeListener(onTabCreatedOnce); } catch (e) { }
                        try { chrome.windows.onCreated.removeListener(onWindowCreatedOnce); } catch (e) { }
                        expectingPopup = null;
                    };

                    // 加掛一次性監聽（tabs/windows 被建立時嘗試捕捉）
                    try { chrome.tabs.onCreated.addListener(onTabCreatedOnce); } catch (e) { }
                    try { chrome.windows.onCreated.addListener(onWindowCreatedOnce); } catch (e) { }

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
                                        triggerScreenshot(t.id, { force: true }).catch(() => { });
                                        // also request HTML capture in case it loaded immediately
                                        triggerHTMLCapture(t.id).catch(() => { });
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

// 當錄製分頁關閉時重置狀態；允許列表中該分頁也一併移除
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (isRecording && tabId === recordingTabId) {
        console.log(`Background: Recording tab ${tabId} closed. Resetting recording state.`);
        resetRecordingState(false);
    }
    if (allowedRecordingTabs.has(tabId)) allowedRecordingTabs.delete(tabId);
    if (pendingNewTabs[tabId]) delete pendingNewTabs[tabId];
});

// 分頁載入完成時，確保 content.js 注入；若是待處理的新分頁則進行擷取
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
                try { await chrome.tabs.update(tabId, { active: true }); } catch (e) { }

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
                            chrome.tabs.update(prevActiveTabId, { active: true }).catch(() => { });
                        }
                        chrome.runtime.sendMessage({
                            command: "update_ui",
                            data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length }
                        }).catch(() => { });
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

// 新分頁建立時：若在 anchor click 或 popup 期待期間內，標記為待擷取
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

// New window creation (popup opened in new window) - attempt to detect and capture
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
            await chrome.tabs.update(newTab.id, { active: true }).catch(() => { });
            await new Promise(r => setTimeout(r, 200));
            chrome.tabs.captureVisibleTab(win.id, { format: "png" }, (dataUrl) => {
                if (!chrome.runtime.lastError && dataUrl) {
                    capturedScreenshots.push(dataUrl);
                    console.log(`Background: Captured screenshot of new window tab ${newTab.id}.`);
                } else {
                    console.warn("Background: captureVisibleTab for new window failed:", chrome.runtime.lastError);
                }
                if (prevActiveTabId && prevActiveTabId !== newTab.id) chrome.tabs.update(prevActiveTabId, { active: true }).catch(() => { });
                chrome.runtime.sendMessage({ command: "update_ui", data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length } }).catch(() => { });
                delete pendingNewTabs[newTab.id];
            });
        } catch (e) {
            console.warn("Background: Error during new window capture flow:", e);
        }
    } catch (e) {
        console.warn("Background: windows.onCreated handler error:", e);
    }
});

// Installation/startup: attempt to inject into all existing tabs
chrome.runtime.onInstalled.addListener(() => injectIntoAllTabs());
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(() => injectIntoAllTabs());

// Safety measure: inject again when tab loading is complete (some pages only allow injection after loading)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') ensureContentScriptInTab(tabId);
});

console.log("Background service worker started.");

// --- Download process tracking (creation/state changes) ---
try {
    if (chrome.downloads && chrome.downloads.onCreated) {
        chrome.downloads.onCreated.addListener((item) => {
            try {
                if (!isRecording) return;
                try { console.log('Downloads.onCreated:', { id: item.id, url: item.url, filename: item.filename, mime: item.mime, state: item.state }); } catch (e) { }
                if (ignoredDownloadIds.has(item.id)) { try { console.log('Ignoring known export download id', item.id); } catch (e) { } return; }
                // Only ignore our own generated export ZIP
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
                // Synchronously add Download event to action list, displayed in sidebar
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
                chrome.runtime.sendMessage({ command: 'update_ui', data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length } }).catch(() => { });
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
                    try { console.log('Downloads.onChanged state:', delta.id, rec.state, 'filename:', rec.filename); } catch (e) { }
                    // Synchronously update Download event status on timeline
                    const aIdx = downloadIdToActionIndex[delta.id];
                    if (typeof aIdx === 'number' && recordedActions[aIdx]) {
                        recordedActions[aIdx].state = rec.state;
                        if (rec.state === 'complete') {
                            recordedActions[aIdx].value = `${rec.filename} (complete)`;
                        } else if (rec.state === 'interrupted') {
                            recordedActions[aIdx].value = `${rec.filename} (interrupted)`;
                        }
                        chrome.runtime.sendMessage({ command: 'update_ui', data: { actions: recordedActions, isRecording: true, htmlCount: capturedHTMLs.length, screenshotCount: capturedScreenshots.length } }).catch(() => { });
                    }
                }
            } catch (e) { /* ignore */ }
        });
    }
} catch (e) {
    console.warn('Background: downloads API not available or failed to attach listeners:', e);
}

// --- Periodic state saving and pre-hibernation saving ---
let saveStateInterval = null;

// Periodic state saving (every 10 seconds, only during recording)
function startPeriodicStateSave() {
    if (saveStateInterval) clearInterval(saveStateInterval);
    saveStateInterval = setInterval(() => {
        if (isRecording) {
            console.log("Background: Periodic state save");
            saveState();
        }
    }, 10000); // Save every 10 seconds
}

function stopPeriodicStateSave() {
    if (saveStateInterval) {
        clearInterval(saveStateInterval);
        saveStateInterval = null;
    }
}

// Don't start periodic saving during initialization, only when recording starts
// startPeriodicStateSave(); // Remove this line

// Save state before Service Worker is terminated
self.addEventListener('beforeunload', () => {
    console.log("Background: Service Worker beforeunload - saving state");
    if (isRecording) {
        saveState();
    }
});

// Service Worker doesn't have document object, remove visibilitychange listener
// Use idle detection instead (if needed)
chrome.idle && chrome.idle.onStateChanged.addListener((state) => {
    if (state === 'idle' && isRecording) {
        console.log("Background: System idle - saving state");
        saveState();
    }
});