/**
 * popup.js
 * Handles extension popup window logic.
 * Supports two modes: Recorder and Editor
 */

// Helper function to disable side panel for all tabs except the target tab
async function disableSidePanelForOtherTabs(targetTabId) {
    try {
        const tabs = await chrome.tabs.query({});
        console.log(`Disabling side panel for ${tabs.length} tabs except tab ${targetTabId}`);
        for (const tab of tabs) {
            if (tab.id !== targetTabId) {
                try {
                    await chrome.sidePanel.setOptions({
                        tabId: tab.id,
                        enabled: false
                    });
                } catch (err) {
                    // Ignore errors for tabs that don't support side panel
                }
            }
        }
        console.log("Side panel disabled for all other tabs");
    } catch (error) {
        console.error("Error disabling side panel for other tabs:", error);
    }
}

// Get UI elements
const startRecordingBtn = document.getElementById('startRecordingBtn');
const statusMessage = document.getElementById('statusMessage');
const openEditorBtn = document.getElementById('openEditorBtn');
const editorStatusMessage = document.getElementById('editorStatusMessage');

// Mode switching logic
const modeButtons = document.querySelectorAll('.mode-btn');
const modeContents = document.querySelectorAll('.mode-content');

modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const targetMode = btn.dataset.mode;
        
        // Update active button
        modeButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        // Show corresponding content
        modeContents.forEach(content => {
            if (content.id === targetMode + 'Mode') {
                content.classList.add('active');
            } else {
                content.classList.remove('active');
            }
        });
    });
});

// ============= RECORDER MODE =============

// When popup opens, check if currently recording
chrome.runtime.sendMessage({ command: "get_status" }, (response) => {
    if (chrome.runtime.lastError) {
        console.error("Popup: Error getting status:", chrome.runtime.lastError.message);
        statusMessage.textContent = "Error checking status.";
        startRecordingBtn.disabled = true;
        return;
    }
    if (response && response.isRecording) {
        startRecordingBtn.textContent = "Open Side Panel";
        startRecordingBtn.disabled = false; // Enable button so user can reopen side panel
        const actionCount = response.actionCount || 0;
        statusMessage.textContent = `Recording in progress (${actionCount} action${actionCount !== 1 ? 's' : ''}). Click to open side panel.`;
        statusMessage.style.color = '#4CAF50';
    } else {
        startRecordingBtn.textContent = "Start Recording";
        startRecordingBtn.disabled = false;
        statusMessage.textContent = "";
        statusMessage.style.color = '';
    }
});

// Start Recording button click handler
startRecordingBtn.addEventListener('click', async () => {
    // Check if already recording first
    const statusResponse = await chrome.runtime.sendMessage({ command: "get_status" });
    
    if (statusResponse && statusResponse.isRecording) {
        // Already recording - just reopen the side panel
        console.log("Popup: Already recording, reopening side panel");
        statusMessage.textContent = "Opening side panel...";
        
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const currentTab = tabs[0];
            
            // Reopen side panel
            await chrome.sidePanel.open({ windowId: currentTab.windowId });
            console.log("Popup: Side panel reopened");
            statusMessage.textContent = "Side panel opened!";
            statusMessage.style.color = '#4CAF50';
            
            // Auto close popup
            setTimeout(() => window.close(), 500);
        } catch (error) {
            console.error("Popup: Error reopening side panel:", error);
            statusMessage.textContent = `Error: ${error.message}`;
            statusMessage.style.color = '#f44336';
            startRecordingBtn.disabled = false;
        }
        return;
    }
    
    // Not recording yet - start new recording
    statusMessage.textContent = "Starting...";
    startRecordingBtn.disabled = true;

    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || tabs.length === 0) {
            throw new Error("Could not find active tab.");
        }
        const currentTab = tabs[0];
        if (!currentTab.id || !currentTab.url || currentTab.url.startsWith('chrome://') || currentTab.url.startsWith('about:')) {
             throw new Error("Cannot record on this type of page.");
        }
        const tabId = currentTab.id;
        console.log(`Popup: Target Tab ID: ${tabId}`);

        // Recorder mode: Enable side panel globally (for all tabs) for cross-tab recording
        await chrome.sidePanel.setOptions({
            path: 'sidepanel.html',
            enabled: true
        });
        console.log("Popup: Side panel enabled globally for recorder mode");

        // Open side panel
        await chrome.sidePanel.open({ windowId: currentTab.windowId });
        console.log("Popup: Side panel open command issued for window", currentTab.windowId);

        // Notify background to start recording
        chrome.runtime.sendMessage({ command: "start_recording", data: { tabId: tabId, url: currentTab.url } }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Popup: Error sending start_recording message:", chrome.runtime.lastError.message);
                statusMessage.textContent = `Error starting: ${chrome.runtime.lastError.message}`;
                startRecordingBtn.disabled = false;
            } else if (response && response.success) {
                statusMessage.textContent = "Recording started!";
                startRecordingBtn.textContent = "Recording...";
            } else {
                statusMessage.textContent = response?.message || "Failed to start recording (background error).";
                startRecordingBtn.disabled = false;
            }
        });

    } catch (error) {
        console.error("Popup: Error during startup:", error);
        statusMessage.textContent = `Error: ${error.message}`;
        startRecordingBtn.disabled = false;
    }
});

// ============= EDITOR MODE =============

// Open Editor button click handler
openEditorBtn.addEventListener('click', async () => {
    editorStatusMessage.textContent = "Opening editor...";
    openEditorBtn.disabled = true;

    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || tabs.length === 0) {
            throw new Error("Could not find active tab.");
        }
        const currentTab = tabs[0];
        const tabId = currentTab.id;

        // Editor mode: Enable side panel ONLY for this specific tab
        await disableSidePanelForOtherTabs(tabId);

        await chrome.sidePanel.setOptions({
            tabId: tabId,
            path: 'sidepanel.html',
            enabled: true
        });
        console.log("Popup: Side panel enabled only for tab", tabId);

        // Open side panel using tabId (tab-specific)
        await chrome.sidePanel.open({ tabId: tabId });
        console.log("Popup: Editor side panel opened for tab", tabId);

        // Notify background to switch to editor mode
        chrome.runtime.sendMessage({ command: "open_editor", data: { tabId: tabId } }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Popup: Error opening editor:", chrome.runtime.lastError.message);
                editorStatusMessage.textContent = `Error: ${chrome.runtime.lastError.message}`;
                openEditorBtn.disabled = false;
            } else if (response && response.success) {
                editorStatusMessage.textContent = "Editor opened!";
                // Auto close popup after opening editor
                setTimeout(() => window.close(), 500);
            } else {
                editorStatusMessage.textContent = response?.message || "Failed to open editor.";
                openEditorBtn.disabled = false;
            }
        });

    } catch (error) {
        console.error("Popup: Error opening editor:", error);
        editorStatusMessage.textContent = `Error: ${error.message}`;
        openEditorBtn.disabled = false;
    }
});
