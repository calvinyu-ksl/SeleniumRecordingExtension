/**
 * popup.js
 * Handles the logic for the extension's popup window.
 * Allows the user to start a recording session.
 * *** Opens the side panel globally for the current window. ***
 */

const startRecordingBtn = document.getElementById('startRecordingBtn');
const statusMessage = document.getElementById('statusMessage');

// Check the initial recording state when the popup opens
chrome.runtime.sendMessage({ command: "get_status" }, (response) => {
    if (chrome.runtime.lastError) {
        console.error("Popup: Error getting status:", chrome.runtime.lastError.message);
        statusMessage.textContent = "Error checking status.";
        startRecordingBtn.disabled = true; // Disable if there's an issue
        return;
    }
    if (response && response.isRecording) {
        startRecordingBtn.textContent = "Recording...";
        startRecordingBtn.disabled = true;
        statusMessage.textContent = "Recording in progress in this window."; // Adjusted message
    } else {
        startRecordingBtn.textContent = "Start Recording";
        startRecordingBtn.disabled = false;
    }
});

// Add click listener to the start button
startRecordingBtn.addEventListener('click', async () => {
    statusMessage.textContent = "Starting...";
    startRecordingBtn.disabled = true;

    try {
        // 1. Get the current active tab AND window
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || tabs.length === 0) {
            throw new Error("Could not find active tab.");
        }
        const currentTab = tabs[0];
        if (!currentTab.id || !currentTab.windowId || !currentTab.url || currentTab.url.startsWith('chrome://') || currentTab.url.startsWith('about:')) {
             throw new Error("Cannot record on this type of page or get window ID.");
        }
        const tabId = currentTab.id;
        const windowId = currentTab.windowId; // Get window ID
        console.log(`Popup: Target Tab ID: ${tabId}, Window ID: ${windowId}`);

        // 2. Configure and open the side panel GLOBALLY for the window
        await chrome.sidePanel.setOptions({
            // tabId: tabId, // Remove tabId to make it global for the window
            path: 'sidepanel.html',
            enabled: true
        });
        console.log("Popup: Global side panel options set.");

        // Open the panel in the context of the window
        await chrome.sidePanel.open({ windowId: windowId });
        console.log("Popup: Side panel open command issued for window.");

        // 3. Send message to background script to start recording logic
        //    Include both tabId (as starting point) and windowId
        chrome.runtime.sendMessage({ command: "start_recording", data: { tabId: tabId, windowId: windowId, url: currentTab.url } }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Popup: Error sending start_recording message:", chrome.runtime.lastError.message);
                statusMessage.textContent = `Error starting: ${chrome.runtime.lastError.message}`;
                startRecordingBtn.disabled = false;
            } else if (response && response.success) {
                statusMessage.textContent = "Recording started!";
                startRecordingBtn.textContent = "Recording...";
                // window.close(); // Optionally close popup
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
