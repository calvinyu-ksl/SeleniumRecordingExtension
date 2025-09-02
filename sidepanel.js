/**
 * sidepanel.js
 * Manages the UI and logic for the extension's side panel.
 * - Displays recorded actions.
 * - Handles user interactions like deleting actions, saving, and canceling.
 */

// Guard to prevent the script from being initialized multiple times, which can cause errors.
if (typeof window.sidePanelInitialized === 'undefined') {
    window.sidePanelInitialized = true;

    // --- DOM Elements ---
    const actionsList = document.getElementById('actions-list');
    const saveButton = document.getElementById('save-button');
    const cancelButton = document.getElementById('cancel-button');
    const statusMessage = document.getElementById('status-message');
    const htmlCountSpan = document.getElementById('html-count');
    const startUrlSpan = document.getElementById('start-url');
    const captureHtmlButton = document.getElementById('capture-html-button');

    let isRecording = false;

    /**
     * Renders the list of recorded actions in the side panel.
     * @param {Array<Object>} actions - The array of action objects to display.
     */
    function renderActions(actions = []) {
        actionsList.innerHTML = ''; // Clear previous list

        if (actions.length === 0) {
            const placeholder = document.createElement('div');
            placeholder.className = 'action-item-placeholder';
            placeholder.textContent = 'No actions recorded yet. Interact with the page to begin.';
            actionsList.appendChild(placeholder);
            return;
        }

        actions.forEach(action => {
            const item = document.createElement('div');
            item.className = 'action-item';
            item.dataset.step = action.step;

            const content = document.createElement('div');
            content.className = 'action-content';

            const step = document.createElement('span');
            step.className = 'action-step';
            step.textContent = `${action.step}.`;

            const type = document.createElement('span');
            type.className = 'action-type';
            type.textContent = action.type;

            const details = document.createElement('span');
            details.className = 'action-details';
            
            let detailText = '';
            if (action.type === 'HTML_Capture') {
                item.classList.add('html-capture-item');
                detailText = 'Page source captured';
            } else if (action.selector) {
                detailText = `${action.selectorType}: ${action.selector}`;
            }
            if (action.value && action.type !== 'HTML_Capture') {
                detailText += ` | Value: "${action.value}"`;
            }
            details.textContent = detailText;
            details.title = detailText;

            const deleteButton = document.createElement('button');
            deleteButton.className = 'delete-button';
            deleteButton.textContent = '✖';
            deleteButton.title = `Delete step ${action.step}`;
            deleteButton.addEventListener('click', (e) => {
                e.stopPropagation();
                handleDeleteAction(action.step);
            });

            content.appendChild(step);
            content.appendChild(type);
            content.appendChild(details);
            item.appendChild(content);
            item.appendChild(deleteButton);
            actionsList.appendChild(item);
        });
    }

    /**
     * Updates the entire UI state based on data from the background script.
     * @param {Object} data - The state data.
     */
    function updateUI(data) {
        if (!data) return;

        isRecording = data.isRecording;
        
        renderActions(data.actions || []);
        htmlCountSpan.textContent = data.htmlCount || 0;
        if (data.startUrl) {
            startUrlSpan.textContent = data.startUrl;
            startUrlSpan.href = data.startUrl;
        }

        saveButton.disabled = !isRecording || (data.actions && data.actions.length === 0);
        cancelButton.disabled = !isRecording;
        captureHtmlButton.disabled = !isRecording;

        if (isRecording) {
            statusMessage.textContent = 'Recording in progress...';
            statusMessage.classList.remove('status-stopped');
            statusMessage.classList.add('status-recording');
        } else {
            statusMessage.textContent = 'Recording stopped.';
            statusMessage.classList.remove('status-recording');
            statusMessage.classList.add('status-stopped');
        }
    }

    // --- Event Handlers ---

    function handleDeleteAction(step) {
        if (!isRecording) return;
        console.log(`Side Panel: Requesting to delete action step ${step}`);
        chrome.runtime.sendMessage({ command: 'delete_action', data: { step } })
            .catch(e => console.error("Side Panel: Error sending delete request:", e));
    }

    function handleSave() {
        if (!isRecording) return;
        console.log("Side Panel: Save & Export button clicked.");
        saveButton.disabled = true;
        saveButton.textContent = 'Saving...';
        chrome.runtime.sendMessage({ command: 'save_export' })
            .finally(() => {
                saveButton.textContent = 'Save & Export';
            });
    }

    function handleCancel() {
        if (!isRecording) return;
        console.log("Side Panel: Cancel button clicked.");
        if (confirm("Are you sure you want to cancel this recording? All recorded data will be lost.")) {
            chrome.runtime.sendMessage({ command: 'cancel_recording' })
                .catch(e => console.error("Side Panel: Error sending cancel request:", e));
        }
    }

    function handleCaptureHtml() {
        if (!isRecording) return;
        console.log("Side Panel: Manual HTML capture button clicked.");
        captureHtmlButton.disabled = true;
        chrome.runtime.sendMessage({ command: 'capture_html' })
            .finally(() => {
                setTimeout(() => {
                    if (isRecording) captureHtmlButton.disabled = false;
                }, 500);
            });
    }

    // --- Initialization ---

    saveButton.addEventListener('click', handleSave);
    cancelButton.addEventListener('click', handleCancel);
    captureHtmlButton.addEventListener('click', handleCaptureHtml);

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.command === 'update_ui') {
            console.log("Side Panel: Received UI update from background script.", message.data);
            updateUI(message.data);
            sendResponse({success: true});
        }
        return true;
    });

    document.addEventListener('DOMContentLoaded', () => {
        console.log("Side Panel: DOM loaded. Requesting current state.");
        chrome.runtime.sendMessage({ command: 'request_current_state' })
            .then(response => {
                if (response) {
                    updateUI(response);
                } else {
                    updateUI({ isRecording: false, actions: [], htmlCount: 0 });
                }
            })
            .catch(e => console.error("Side Panel: Error requesting initial state:", e));
    });

    window.addEventListener('beforeunload', () => {
        if (isRecording) {
            chrome.runtime.sendMessage({ command: 'stop_recording_internal' })
                .catch(e => console.error("Side Panel: Error informing background of closure:", e));
        }
    });

    console.log("Side Panel Initialized.");
} else {
    console.log("Side Panel already initialized. Skipping re-initialization.");
}
