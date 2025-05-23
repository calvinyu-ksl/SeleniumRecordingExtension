/**
 * sidepanel.js
 * Handles the logic for the extension's side panel UI.
 * - Displays recorded actions (including HTML captures, pauses, selector type).
 * - Handles button clicks for capturing HTML, exporting, canceling, adding pauses, and deleting steps.
 * - Communicates with the background script.
 */

const captureHtmlBtn = document.getElementById('captureHtmlBtn');
const saveExportBtn = document.getElementById('saveExportBtn');
const cancelExitBtn = document.getElementById('cancelExitBtn');
const addPauseBtn = document.getElementById('addPauseBtn'); // Get pause button
const pauseDurationInput = document.getElementById('pauseDuration'); // Get pause input
const actionsList = document.getElementById('actionsList');
const htmlCountSpan = document.getElementById('htmlCount');
const statusText = document.getElementById('statusText');

let isRecordingActive = false; // Track recording state locally

/**
 * Sends a message to the background script to delete an action.
 * @param {number} stepToDelete - The step number to delete.
 */
function requestActionDelete(stepToDelete) {
    console.log(`Sidepanel: Requesting delete for step ${stepToDelete}`);
    statusText.textContent = `Deleting step ${stepToDelete}...`;
    chrome.runtime.sendMessage({ command: "delete_action", data: { step: stepToDelete } }, (response) => {
         if (chrome.runtime.lastError) {
            console.error("Sidepanel: Error sending delete_action:", chrome.runtime.lastError.message);
            statusText.textContent = `Error deleting: ${chrome.runtime.lastError.message}`;
        } else if (response && response.success) {
            statusText.textContent = `Recording...`; // Reset status, list will update via message
        } else {
            statusText.textContent = `Failed to delete step: ${response?.message || 'Unknown error'}`;
            console.error("Sidepanel: Delete action command failed:", response?.message);
        }
    });
}

/**
 * Sends a message to the background script to add a pause action.
 * @param {number} durationSeconds - The duration of the pause in seconds.
 */
function requestAddPause(durationSeconds) {
    console.log(`Sidepanel: Requesting add pause for ${durationSeconds} seconds.`);
    statusText.textContent = `Adding pause...`;
    chrome.runtime.sendMessage({ command: "add_pause", data: { duration: durationSeconds } }, (response) => {
         if (chrome.runtime.lastError) {
            console.error("Sidepanel: Error sending add_pause:", chrome.runtime.lastError.message);
            statusText.textContent = `Error adding pause: ${chrome.runtime.lastError.message}`;
        } else if (response && response.success) {
            statusText.textContent = `Recording...`; // Reset status, list will update via message
        } else {
            statusText.textContent = `Failed to add pause: ${response?.message || 'Unknown error'}`;
            console.error("Sidepanel: Add pause command failed:", response?.message);
        }
    });
}


/**
 * Updates the list of recorded actions displayed in the UI.
 * Handles different action types including 'HTML_Capture', 'Pause', 'Switch_Tab'.
 * Displays the selector type (CSS/XPath).
 * Adds a delete button for each action.
 * @param {Array} actions - Array of recorded action objects.
 */
function updateActionsList(actions) {
    actionsList.innerHTML = ''; // Clear the current list

    if (!actions || actions.length === 0) {
        actionsList.innerHTML = '<li><i>Waiting for actions...</i></li>';
        return;
    }

    actions.forEach((action, index) => {
        const li = document.createElement('li');
        const actionContent = document.createElement('div');
        actionContent.className = 'action-content';

        const stepSpan = document.createElement('span');
        stepSpan.className = 'action-step';
        stepSpan.textContent = `${action.step || '?'}.`;

        actionContent.appendChild(stepSpan);

        const detailsSpan = document.createElement('span');
        detailsSpan.className = 'action-details'; // Default class

        // *** Handle different action types ***
        switch (action.type) {
            case 'HTML_Capture':
                detailsSpan.classList.add('action-info');
                detailsSpan.innerHTML = '<i>HTML Capture Completed</i>';
                break;
            case 'Pause':
                detailsSpan.classList.add('action-info');
                detailsSpan.innerHTML = `<i>Pause for ${action.duration || '?'} seconds</i>`;
                break;
             case 'Switch_Tab': // Handle new action type for popups
                 detailsSpan.classList.add('action-info');
                 detailsSpan.innerHTML = `<i>Switch to New Tab/Window (ID: ${action.tabId || '?'})</i>`;
                 break;
            case 'Click':
            case 'Input':
            case 'Select':
            default: // Default display for standard interactions
                const typeSpan = document.createElement('span');
                typeSpan.className = 'action-type';
                typeSpan.textContent = action.type || 'Unknown';

                const selectorTypeSpan = document.createElement('span');
                selectorTypeSpan.className = 'selector-label';
                selectorTypeSpan.textContent = ` (${action.selectorType || 'CSS'}):`;

                const selectorSpan = document.createElement('span');
                selectorSpan.className = 'action-selector';
                selectorSpan.textContent = ` ${action.selector || 'N/A'}`;

                detailsSpan.appendChild(typeSpan);
                detailsSpan.appendChild(selectorTypeSpan);
                detailsSpan.appendChild(selectorSpan);

                if (action.hasOwnProperty('value') && action.value !== null && action.value !== undefined) {
                    const valueSpan = document.createElement('span');
                    valueSpan.className = 'action-value';
                    let displayValue = String(action.value);
                    if (displayValue.length > 50) {
                         displayValue = displayValue.substring(0, 50) + '...';
                    }
                    valueSpan.textContent = ` (${displayValue})`;
                    detailsSpan.appendChild(valueSpan);
                }
                break; // End default case
        }

        actionContent.appendChild(detailsSpan); // Add the details span
        li.appendChild(actionContent); // Add step and details container

        // Add Delete Button (for all action types)
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-action-btn';
        deleteBtn.textContent = '✕';
        deleteBtn.title = `Delete step ${action.step}`;
        deleteBtn.dataset.step = action.step;

        deleteBtn.addEventListener('click', (event) => {
            const stepToDelete = parseInt(event.target.dataset.step);
            if (!isNaN(stepToDelete)) {
                requestActionDelete(stepToDelete);
            } else {
                console.error("Could not determine step to delete from button:", event.target);
            }
        });

        li.appendChild(deleteBtn);
        actionsList.appendChild(li);
    });

    actionsList.scrollTop = actionsList.scrollHeight;
}

/**
 * Updates the UI state (button enablement, status text).
 * @param {boolean} isRecording - Whether recording is currently active.
 * @param {number} [htmlCount=0] - The number of captured HTML snapshots.
 * @param {string} [statusMsg] - Optional status message override.
 */
function updateUIState(isRecording, htmlCount = 0, statusMsg = null) {
    isRecordingActive = isRecording;
    statusText.textContent = statusMsg || (isRecording ? "Recording..." : "Idle");
    captureHtmlBtn.disabled = !isRecording;
    saveExportBtn.disabled = !isRecording;
    cancelExitBtn.disabled = !isRecording;
    addPauseBtn.disabled = !isRecording; // Disable pause button if not recording
    pauseDurationInput.disabled = !isRecording; // Disable input if not recording
    htmlCountSpan.textContent = htmlCount;

    if (!isRecording && !statusMsg) {
         statusText.textContent = "Stopped.";
    }
}


// --- Event Listeners ---

captureHtmlBtn.addEventListener('click', () => {
    if (!isRecordingActive) return;
    statusText.textContent = "Capturing HTML...";
    captureHtmlBtn.disabled = true;

    chrome.runtime.sendMessage({ command: "capture_html" }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("Sidepanel: Error sending capture_html:", chrome.runtime.lastError.message);
            statusText.textContent = `Error: ${chrome.runtime.lastError.message}`;
        } else if (response && response.success) {
            statusText.textContent = `Recording...`;
        } else {
            statusText.textContent = "Failed to capture HTML.";
            console.error("Sidepanel: Capture HTML command failed:", response?.message);
        }
        captureHtmlBtn.disabled = !isRecordingActive;
    });
});

saveExportBtn.addEventListener('click', () => {
     if (!isRecordingActive) return;
    statusText.textContent = "Generating script & ZIP...";
    saveExportBtn.disabled = true;
    captureHtmlBtn.disabled = true;
    cancelExitBtn.disabled = true;
    addPauseBtn.disabled = true;
    pauseDurationInput.disabled = true;

    chrome.runtime.sendMessage({ command: "save_export" }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("Sidepanel: Error sending save_export:", chrome.runtime.lastError.message);
            statusText.textContent = `Error: ${chrome.runtime.lastError.message}`;
             saveExportBtn.disabled = !isRecordingActive;
             captureHtmlBtn.disabled = !isRecordingActive;
             cancelExitBtn.disabled = !isRecordingActive;
             addPauseBtn.disabled = !isRecordingActive;
             pauseDurationInput.disabled = !isRecordingActive;
        } else if (response && response.success) {
            statusText.textContent = "Export successful! Recording stopped.";
        } else {
            statusText.textContent = `Export failed: ${response?.message || 'Unknown error'}`;
            console.error("Sidepanel: Save/Export command failed:", response?.message);
             saveExportBtn.disabled = !isRecordingActive;
             captureHtmlBtn.disabled = !isRecordingActive;
             cancelExitBtn.disabled = !isRecordingActive;
             addPauseBtn.disabled = !isRecordingActive;
             pauseDurationInput.disabled = !isRecordingActive;
        }
    });
});

cancelExitBtn.addEventListener('click', () => {
    if (!isRecordingActive) return;
    statusText.textContent = "Cancelling recording...";
    saveExportBtn.disabled = true;
    captureHtmlBtn.disabled = true;
    cancelExitBtn.disabled = true;
    addPauseBtn.disabled = true;
    pauseDurationInput.disabled = true;

    chrome.runtime.sendMessage({ command: "cancel_recording" }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("Sidepanel: Error sending cancel_recording:", chrome.runtime.lastError.message);
            statusText.textContent = `Error cancelling: ${chrome.runtime.lastError.message}`;
        } else if (response && response.success) {
            statusText.textContent = "Recording cancelled.";
        } else {
            statusText.textContent = `Failed to cancel: ${response?.message || 'Unknown error'}`;
        }
    });
});

// *** Add listener for Pause button ***
addPauseBtn.addEventListener('click', () => {
    if (!isRecordingActive) return;
    const duration = parseInt(pauseDurationInput.value);
    if (isNaN(duration) || duration <= 0) {
        statusText.textContent = "Invalid pause duration.";
        // Optionally add visual feedback to input field
        return;
    }
    requestAddPause(duration);
});


// Listen for updates from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.command === "update_ui") {
        console.log("Sidepanel received UI update:", message.data);
        try {
            const { actions, isRecording, htmlCount, startUrl, statusMessage } = message.data;
            const currentHtmlCount = htmlCount !== undefined ? htmlCount : parseInt(htmlCountSpan.textContent || '0');

            if (actions !== undefined) {
                updateActionsList(actions);
            }

            if (isRecording !== undefined) {
                updateUIState(isRecording, currentHtmlCount, statusMessage);
            } else if (htmlCount !== undefined) {
                 htmlCountSpan.textContent = htmlCount;
            } else if (statusMessage) {
                 statusText.textContent = statusMessage;
            }

        } catch (error) {
            console.error("Sidepanel: Error processing 'update_ui' message:", error);
            statusText.textContent = "Error updating UI!";
            actionsList.innerHTML = `<li><i>Error displaying actions: ${error.message}</i></li>`;
        }
        sendResponse({success: true});
    }
    return true; // Keep message channel open
});

// Initial state request when side panel loads
setTimeout(() => {
    chrome.runtime.sendMessage({ command: "get_status" }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("Sidepanel: Error getting initial status:", chrome.runtime.lastError.message);
            statusText.textContent = "Error loading status.";
            updateUIState(false);
        } else if (response) {
            console.log("Sidepanel: Initial status received:", response);
            if(response.isRecording) {
                chrome.runtime.sendMessage({ command: "request_current_state" })
                    .then(state => {
                         if (state) {
                             updateActionsList(state.actions || []);
                             updateUIState(true, state.htmlCount || 0);
                         } else {
                             updateUIState(true);
                         }
                    })
                    .catch(e => {
                         console.error("Sidepanel: Error requesting full state:", e);
                         updateUIState(response.isRecording);
                    });
            } else {
                 updateUIState(false);
                 actionsList.innerHTML = '<li><i>Start recording via the extension icon.</i></li>';
            }
        }
    });
}, 150);

console.log("Side panel script loaded.");

// Add CSS rule for the selector label (optional)
const styleSheet = document.styleSheets[0];
if (styleSheet) {
    try {
        styleSheet.insertRule('.selector-label { color: #888; font-size: 0.9em; margin-left: 5px; }', styleSheet.cssRules.length);
    } catch (e) {
        console.warn("Could not insert CSS rule for selector label:", e);
    }
}
