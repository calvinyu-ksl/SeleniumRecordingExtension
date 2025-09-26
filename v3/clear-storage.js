// 清除擴展狀態的測試腳本
// 在瀏覽器開發者工具的Console中運行

// 清除所有storage數據
chrome.storage.local.clear().then(() => {
    console.log("所有storage數據已清除");
});

// 或者只清除特定的狀態數據
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
    console.log("錄製狀態數據已清除");
});