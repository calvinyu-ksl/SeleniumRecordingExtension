// Test script for clearing extension state
// Run in browser developer tools Console

// Clear all storage data
chrome.storage.local.clear().then(() => {
    console.log("All storage data cleared");
});

// Or only clear specific state data
chrome.storage.local.remove([
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
]).then(() => {
    console.log("Recording state data cleared");
});