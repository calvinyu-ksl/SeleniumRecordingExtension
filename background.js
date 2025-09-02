/**
 * background.js (Service Worker)
 * Handles background tasks for the SeleniumBase Recorder extension.
 * - Manages recording state.
 * - Listens for messages from popup, content script, and side panel.
 * - Generates the SeleniumBase script.
 * - Creates and downloads the ZIP archive.
 */

// --- Load required scripts ---
try {
    importScripts('jszip.min.js');
    console.log("Background: JSZip library loaded successfully via importScripts.");
} catch (e) {
    console.error("Background: CRITICAL ERROR - Failed to load JSZip library.", e);
}


// --- State Variables ---
let isRecording = false;
let recordedActions = [];
let capturedHTMLs = [];
let startURL = '';
let recordingTabId = null;
let lastCaptureTime = 0; // Debounce timer for HTML capture

/**
 * Generates the Python SeleniumBase script content.
 * @returns {string} The generated Python script.
 */
function generateSeleniumBaseScript() {
    // Get a unique name for the test class based on the URL
    let className = "MyTestClass";
    if (startURL) {
        try {
            const url = new URL(startURL);
            let host = url.hostname.replace(/[^a-zA-Z0-9]/g, '_');
            // Capitalize first letter and remove leading numbers if any
            className = host.charAt(0).toUpperCase() + host.slice(1);
            className = className.replace(/^(\d+)/, '_$1');
        } catch (e) {
            // Keep default name if URL is invalid
        }
    }


    let scriptLines = [
        `from seleniumbase import BaseCase`,
        ``,
        `class ${className}(BaseCase):`,
        `    def test_recorded_script(self):`,
        `        # --- Test Actions ---`,
        `        self.open("${startURL}")`
    ];

    const scriptableActions = recordedActions.filter(action => action.type !== 'HTML_Capture');

    scriptableActions.forEach(action => {
        const selector = action.selector;

        // Determine the correct quote type for the Python string literal.
        // If the selector contains a single quote (common in XPaths), use double quotes.
        // Otherwise, use single quotes. This prevents syntax errors in the generated script.
        const selectorQuote = selector.includes("'") ? '"' : "'";
        const finalSelector = `${selectorQuote}${selector}${selectorQuote}`;

        switch (action.type) {
            case 'Click':
                scriptLines.push(`        self.click(${finalSelector})`);
                break;
            case 'Input':
                // The value string is always wrapped in single quotes, with internal single quotes escaped.
                scriptLines.push(`        self.type(${finalSelector}, '${action.value.replace(/'/g, "\\'")}')`);
                break;
            case 'Select':
                // The value for a select option typically doesn't contain quotes, but we escape just in case.
                scriptLines.push(`        self.select_option_by_value(${finalSelector}, '${action.value.replace(/'/g, "\\'")}')`);
                break;
            case 'Checkbox':
                if (action.value) { // value is true, should be checked
                    scriptLines.push(`        self.check_if_unchecked(${finalSelector})`);
                } else { // value is false, should be unchecked
                    scriptLines.push(`        self.uncheck_if_checked(${finalSelector})`);
                }
                break;
        }
        // Add a pause for better visualization during playback, can be removed by user
        scriptLines.push(`        self.sleep(1)`);
    });
    
    scriptLines.push(``);
    scriptLines.push(`        print("\\n*** Test script complete! ***")`);
    scriptLines.push(``);

    return scriptLines.join('\n');
}


/**
 * Helper function to mimic Python's repr() for safely embedding strings in the generated script.
 * Handles quotes and escape sequences.
 * @param {*} value - The value to represent.
 * @returns {string} A string representation suitable for embedding in Python code.
 */
function repr(value) {
    return JSON.stringify(String(value));
}

/**
 * Resets the recording state and optionally disables the side panel.
 * @param {boolean} [disablePanel=false] - Whether to attempt to disable the side panel.
 */
function resetRecordingState(disablePanel = false) {
    const closingTabId = recordingTabId;
    isRecording = false;
    recordedActions = [];
    capturedHTMLs = [];
    startURL = '';
    recordingTabId = null;
    lastCaptureTime = 0;
    console.log("Background: Recording state reset.");

    chrome.runtime.sendMessage({ command: "update_ui", data: { actions: [], isRecording: false, htmlCount: 0 } })
        .catch(e => console.log("Background: Side panel likely closed during reset (expected)."));

    if (disablePanel && closingTabId) {
        console.log(`Background: Attempting to disable side panel for tab ${closingTabId}.`);
        chrome.tabs.get(closingTabId, (tab) => {
            if (!chrome.runtime.lastError && tab) {
                chrome.sidePanel.setOptions({ tabId: closingTabId, enabled: false })
                    .then(() => console.log(`Background: Side panel disabled for tab ${closingTabId}.`))
                    .catch(e => console.warn(`Background: Failed to disable side panel for tab ${closingTabId}:`, e));
            } else {
                console.log(`Background: Tab ${closingTabId} not found or error checking tab, skipping side panel disable.`);
            }
        });
    }
}

/**
 * Captures the current HTML of the recording tab, debouncing to prevent rapid captures.
 */
function triggerHTMLCapture() {
    return new Promise((resolve, reject) => {
        const now = Date.now();
        if (now - lastCaptureTime < 500) { // 500ms debounce window
            console.log("Background: HTML capture request ignored due to debouncing.");
            return resolve(); // Resolve without capturing
        }
        lastCaptureTime = now;

        if (!isRecording || !recordingTabId) {
            return reject(new Error("Not recording."));
        }

        console.log("Background: Triggering HTML capture.");
        chrome.tabs.sendMessage(recordingTabId, { command: "get_html" }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Background: Error requesting HTML from content script:", chrome.runtime.lastError.message);
                return reject(new Error(chrome.runtime.lastError.message));
            }
            if (response && response.success && typeof response.html === 'string') {
                capturedHTMLs.push(response.html);
                console.log(`Background: HTML captured (${capturedHTMLs.length} total).`);
                const captureAction = {
                    type: 'HTML_Capture',
                    step: recordedActions.length + 1,
                    timestamp: Date.now(),
                    selectorType: 'N/A',
                    value: `Captured page source`
                };
                recordedActions.push(captureAction);
                console.log("Background: Recording HTML capture action:", captureAction);
                resolve();
            } else {
                console.error("Background: Failed to get valid HTML from content script.", response);
                reject(new Error("Failed to get valid HTML from content script."));
            }
        });
    });
}

// --- Event Listeners ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("Background received message:", message.command, "from", sender.tab ? "tab " + sender.tab.id : "extension");

    switch (message.command) {
        case "start_recording":
            if (isRecording) {
                console.warn("Background: Recording already in progress.");
                sendResponse({ success: false, message: "Recording already active." });
                return true;
            }
            const { tabId, url } = message.data || {};
            if (!tabId || !url) {
                console.error("Background: Missing tabId or url in start_recording message.");
                sendResponse({ success: false, message: "Missing data from popup." });
                return true;
            }
            resetRecordingState(false);
            recordingTabId = tabId;
            startURL = url;
            isRecording = true;
            console.log(`Background: Starting recording state for tab ${recordingTabId} with URL: ${startURL}`);

            chrome.scripting.executeScript({
                target: { tabId: recordingTabId },
                files: ['content.js']
            })
            .then(() => {
                console.log("Background: Content script injected. Waiting before sending messages.");
                // Add a delay to give the content script and side panel time to initialize
                return new Promise(resolve => setTimeout(resolve, 500));
            })
            .then(() => {
                 // Initial HTML capture on start
                return triggerHTMLCapture();
            })
            .then(() => {
                console.log("Background: Sending initial UI update to side panel.");
                return chrome.runtime.sendMessage({
                    command: "update_ui",
                    data: {
                        actions: recordedActions,
                        isRecording: true,
                        startUrl: startURL,
                        htmlCount: capturedHTMLs.length
                    }
                });
            })
            .then(() => {
                console.log("Background: Initial UI update sent successfully.");
                sendResponse({ success: true });
            })
            .catch(error => {
                console.error("Background: Error during recording start sequence:", error);
                resetRecordingState(true);
                sendResponse({ success: false, message: `Failed to start recording logic: ${error.message}` });
            });
            return true;

        case "record_action":
            if (!isRecording || !recordingTabId || (sender.tab && sender.tab.id !== recordingTabId)) {
                return true;
            }
            const action = message.data;
            action.step = recordedActions.length + 1;
            
            if (action.selector && action.selector.startsWith('xpath=')) {
                action.selectorType = 'XPath';
            } else {
                action.selectorType = 'CSS';
            }
            
            if (!action.selector) {
                console.warn("Background: Action received without selector:", action);
                action.selector = "SELECTOR_MISSING";
                action.selectorType = 'N/A';
            }

            delete action.elementInfo;
            console.log("Background: Recording action:", action);
            recordedActions.push(action);

            // Automatically capture HTML after the action
            triggerHTMLCapture()
                .finally(() => {
                    // Always update UI, even if capture fails
                    chrome.runtime.sendMessage({
                        command: "update_ui",
                        data: {
                            actions: recordedActions,
                            isRecording: true,
                            htmlCount: capturedHTMLs.length
                        }
                    })
                    .catch(e => console.warn("Background: Side panel not available for action update:", e));
                });

            sendResponse({ success: true });
            return true;

        case "capture_html": // Manual capture still supported
            if (!isRecording || !recordingTabId) {
                sendResponse({ success: false, message: "Not recording." });
                return true;
            }
            triggerHTMLCapture()
                .then(() => {
                    chrome.runtime.sendMessage({
                        command: "update_ui",
                        data: {
                            actions: recordedActions,
                            htmlCount: capturedHTMLs.length,
                            isRecording: true
                        }
                    }).catch(e => console.warn("Background: Side panel not available for HTML count update:", e));
                    sendResponse({ success: true, count: capturedHTMLs.length });
                })
                .catch(error => {
                    console.error("Background: Manual HTML Capture failed:", error);
                    sendResponse({ success: false, message: error.message });
                });
            return true;

        case "delete_action":
            if (!isRecording) {
                sendResponse({ success: false, message: "Not recording." });
                return true;
            }
            const stepToDelete = message.data?.step;
            if (typeof stepToDelete !== 'number') {
                console.error("Background: Invalid step number received for deletion.");
                sendResponse({ success: false, message: "Invalid step number." });
                return true;
            }
            console.log(`Background: Attempting to delete action at step ${stepToDelete}`);
            
            const indexToDelete = recordedActions.findIndex(action => action.step === stepToDelete);

            if (indexToDelete === -1) {
                console.warn(`Background: Action with step ${stepToDelete} not found.`);
                sendResponse({ success: false, message: "Step not found." });
                return true;
            }
            
            const deletedAction = recordedActions[indexToDelete];

            // Find the corresponding HTML capture to remove
            if (deletedAction.type === 'HTML_Capture') {
                // Count how many HTML captures occurred up to this point
                let htmlCaptureIndex = -1;
                let count = 0;
                for(let i = 0; i <= indexToDelete; i++){
                    if(recordedActions[i].type === 'HTML_Capture'){
                        count++;
                    }
                }
                htmlCaptureIndex = count - 1;

                if (htmlCaptureIndex >= 0 && htmlCaptureIndex < capturedHTMLs.length) {
                    console.log(`Background: Removing associated HTML capture at index ${htmlCaptureIndex}`);
                    capturedHTMLs.splice(htmlCaptureIndex, 1);
                } else {
                    console.warn(`Background: Could not find matching HTML capture data for deleted action step ${stepToDelete}`);
                }
            }

            // Remove the action itself
            recordedActions.splice(indexToDelete, 1);
            console.log("Background: Deleted action:", deletedAction);

            // Renumber all subsequent steps
            for (let i = 0; i < recordedActions.length; i++) {
                recordedActions[i].step = i + 1;
            }
            console.log("Background: Renumbered subsequent steps.");

            chrome.runtime.sendMessage({
                command: "update_ui",
                data: {
                    actions: recordedActions,
                    htmlCount: capturedHTMLs.length,
                    isRecording: true
                }
            })
            .catch(e => console.warn("Background: Side panel not available for delete update:", e));
            sendResponse({ success: true });
            return true;

        case "save_export":
            if (!isRecording) {
                sendResponse({ success: false, message: "Not recording." });
                return true;
            }
            console.log("Background: Save and Export triggered.");
            if (typeof JSZip === 'undefined') {
                console.error("Background: JSZip is not defined. Export failed.");
                sendResponse({ success: false, message: "JSZip library error (not loaded)." });
                return true;
            }
            
            const seleniumBaseScript = generateSeleniumBaseScript();
            console.log("Background: SeleniumBase script generated.");

            try {
                const zip = new JSZip();
                zip.file("test_recorded_script.py", seleniumBaseScript);
                console.log(`Background: Preparing to zip ${capturedHTMLs.length} captured HTML file(s).`);

                capturedHTMLs.forEach((html, index) => {
                    const filename = `capture_${index + 1}.html`;
                    if (typeof html === 'string') {
                        zip.file(filename, html);
                    } else {
                        console.warn(`Background: Skipping invalid HTML data at index ${index}`);
                    }
                });

                console.log("Background: Generating ZIP blob...");
                zip.generateAsync({ type: "blob" })
                .then(content => {
                    console.log(`Background: ZIP blob generated (size: ${content.size}). Converting to data URL...`);
                    const reader = new FileReader();
                    reader.onload = function() {
                        const dataUrl = reader.result;
                        const zipFilename = "seleniumbase_recording.zip";
                        console.log(`Background: Blob converted to data URL (length: ${dataUrl.length}). Initiating download...`);
                        chrome.downloads.download({
                            url: dataUrl,
                            filename: zipFilename,
                            saveAs: true
                        }).then(downloadId => {
                            if (downloadId) {
                                console.log("Background: Download started with ID:", downloadId);
                                sendResponse({ success: true });
                                resetRecordingState(true);
                            } else {
                                console.error("Background: Download failed to initiate.");
                                sendResponse({ success: false, message: "Download failed to initiate." });
                                resetRecordingState(true);
                            }
                        }).catch(err => {
                            console.error("Background: Download failed:", err);
                            sendResponse({ success: false, message: `Download failed: ${err.message}` });
                            resetRecordingState(true);
                        });
                    };
                    reader.onerror = function() {
                        console.error("Background: FileReader failed to read blob.");
                        sendResponse({ success: false, message: "Failed to read generated ZIP data." });
                        resetRecordingState(true);
                    };
                    reader.readAsDataURL(content);
                })
                .catch(err => {
                    console.error("Background: Error generating ZIP blob:", err);
                    sendResponse({ success: false, message: `ZIP generation failed: ${err.message}` });
                    resetRecordingState(true);
                });
            } catch (e) {
                console.error("Background: Error during ZIP creation/processing:", e);
                sendResponse({ success: false, message: `JSZip library error: ${e.message}` });
                resetRecordingState(true);
            }
            return true;

        case "cancel_recording":
            if (!isRecording) {
                sendResponse({ success: false, message: "Not recording." });
                return true;
            }
            console.log("Background: Cancel recording request received.");
            resetRecordingState(true);
            sendResponse({ success: true });
            return true;

        case "get_status":
            sendResponse({ isRecording: isRecording, recordingTabId: recordingTabId });
            return true;

        case "request_current_state":
            if (isRecording && sender.contextType === "SIDE_PANEL") {
                console.log("Background: Side panel requested current state.");
                sendResponse({
                    actions: recordedActions,
                    htmlCount: capturedHTMLs.length,
                    isRecording: true,
                    startUrl: startURL
                });
            } else {
                sendResponse(null);
            }
            return true;

        case "stop_recording_internal":
             if (isRecording && sender.contextType === "SIDE_PANEL") {
                console.log("Background: Side panel closed or navigated away, stopping recording.");
                resetRecordingState(false);
                sendResponse({success: true});
            } else {
                sendResponse({success: false, message: "Not recording or invalid context"});
            }
            return true;

        default:
            console.log("Background: Unhandled command:", message.command);
            sendResponse({ success: false, message: "Unknown command" });
            return false;
    }
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (isRecording && tabId === recordingTabId) {
        console.log(`Background: Recorded tab (${tabId}) was closed. Stopping recording.`);
        resetRecordingState(false);
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (isRecording && tabId === recordingTabId) {
        if (changeInfo.status === 'complete') {
             console.log(`Background: Recorded tab (${tabId}) finished loading. Triggering HTML capture.`);
             triggerHTMLCapture().catch(e => console.error("Auto-capture on navigation failed:", e));
        }
    }
});

console.log("Background service worker started.");