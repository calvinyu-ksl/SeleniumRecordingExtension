/**
 * popup.js
 * Handles the logic for the extension's popup window.
 * Allows the user to start a recording session.
 * *** Now also handles opening the side panel directly on user gesture. ***
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
        statusMessage.textContent = "Recording in progress in another tab.";
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
        // 1. Get the current active tab
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

        // 2. Configure and open the side panel for the specific tab
        //    This happens directly in response to the click.
        await chrome.sidePanel.setOptions({
            tabId: tabId,
            path: 'sidepanel.html',
            enabled: true
        });
        console.log("Popup: Side panel options set.");

        await chrome.sidePanel.open({ tabId: tabId });
        console.log("Popup: Side panel open command issued.");

        // 3. Send message to background script to ACTUALLY start recording logic
        //    The background script no longer needs to open the panel itself.
        chrome.runtime.sendMessage({ command: "start_recording", data: { tabId: tabId, url: currentTab.url } }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Popup: Error sending start_recording message:", chrome.runtime.lastError.message);
                statusMessage.textContent = `Error starting: ${chrome.runtime.lastError.message}`;
                // Should we try to close the panel here? Maybe not, let user handle it.
                startRecordingBtn.disabled = false; // Re-enable button on error
            } else if (response && response.success) {
                statusMessage.textContent = "Recording started!";
                startRecordingBtn.textContent = "Recording...";
                // Optionally close the popup window after starting successfully
                // window.close();
            } else {
                statusMessage.textContent = response?.message || "Failed to start recording (background error).";
                startRecordingBtn.disabled = false; // Re-enable on failure
            }
        });

    } catch (error) {
        console.error("Popup: Error during startup:", error);
        statusMessage.textContent = `Error: ${error.message}`;
        startRecordingBtn.disabled = false; // Re-enable button on error
    }
});
