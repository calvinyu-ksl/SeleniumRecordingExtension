/**
 * popup.js
 * 處理擴充功能的彈出視窗（popup）邏輯。
 * 讓使用者可以開始錄製工作階段。
 * 也在使用者點擊時直接開啟 Side Panel（側邊面板）。
 */

const startRecordingBtn = document.getElementById('startRecordingBtn'); // 取得「開始錄製」按鈕
const statusMessage = document.getElementById('statusMessage'); // 取得狀態訊息顯示元素

// 當 popup 開啟時，檢查當前是否已在錄製
chrome.runtime.sendMessage({ command: "get_status" }, (response) => {
    if (chrome.runtime.lastError) { // 若無法取得狀態，顯示錯誤並停用按鈕
        console.error("Popup: Error getting status:", chrome.runtime.lastError.message);
        statusMessage.textContent = "Error checking status."; // 顯示錯誤訊息
        startRecordingBtn.disabled = true; // 發生問題就停用按鈕
        return;
    }
    if (response && response.isRecording) { // 若已在錄製，更新按鈕與訊息
        startRecordingBtn.textContent = "Recording..."; // 顯示正在錄製
        startRecordingBtn.disabled = true; // 禁用避免重複操作
        statusMessage.textContent = "Recording in progress in another tab."; // 顯示錄製中
    } else { // 未在錄製
        startRecordingBtn.textContent = "Start Recording"; // 顯示開始錄製文字
        startRecordingBtn.disabled = false; // 啟用按鈕
    }
});

// 綁定「開始錄製」按鈕的點擊事件
startRecordingBtn.addEventListener('click', async () => {
    statusMessage.textContent = "Starting..."; // 提示正在啟動
    startRecordingBtn.disabled = true; // 暫時停用按鈕避免重複點擊

    try {
        // 1. 取得目前視窗中使用者正在看的分頁
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true }); // 查詢目前作用中的分頁
        if (!tabs || tabs.length === 0) { // 若找不到作用中分頁
            throw new Error("Could not find active tab."); // 拋出錯誤
        }
        const currentTab = tabs[0]; // 取得第一個作用中分頁
        // 屏蔽無法錄製的頁面（例如 chrome:// 或 about: 頁面）
        if (!currentTab.id || !currentTab.url || currentTab.url.startsWith('chrome://') || currentTab.url.startsWith('about:')) {
             throw new Error("Cannot record on this type of page."); // 拋出錯誤提示無法錄製
        }
        const tabId = currentTab.id; // 取得分頁 ID
        console.log(`Popup: Target Tab ID: ${tabId}`); // 記錄目標分頁 ID

        // 2. 設定並開啟該分頁的側邊面板（Side Panel）
        //    這一步在使用者點擊時直接執行，以符合使用者手勢（user gesture）要求
        await chrome.sidePanel.setOptions({
            tabId: tabId, // 指定目標分頁
            path: 'sidepanel.html', // 指向側邊面板頁面
            enabled: true // 啟用側邊面板
        });
        console.log("Popup: Side panel options set."); // 紀錄側邊面板設定已完成

        await chrome.sidePanel.open({ tabId: tabId }); // 開啟側邊面板
        console.log("Popup: Side panel open command issued."); // 紀錄側邊面板開啟請求已發出

        // 3. 通知背景腳本（background.js）實際開始錄製邏輯
        //    背景腳本不再需要自行開啟側邊面板
        chrome.runtime.sendMessage({ command: "start_recording", data: { tabId: tabId, url: currentTab.url } }, (response) => {
            if (chrome.runtime.lastError) { // 若傳送訊息出錯
                console.error("Popup: Error sending start_recording message:", chrome.runtime.lastError.message);
                statusMessage.textContent = `Error starting: ${chrome.runtime.lastError.message}`; // 顯示錯誤原因
                // 不強制關閉側邊面板，交由使用者決定
                startRecordingBtn.disabled = false; // 出錯就重新啟用按鈕
            } else if (response && response.success) { // 成功開始錄製
                statusMessage.textContent = "Recording started!"; // 顯示開始成功
                startRecordingBtn.textContent = "Recording..."; // 更新按鈕文字
                // 如果要啟動後自動關閉 popup，可取消下行註解
                // window.close();
            } else { // 背景腳本回應失敗
                statusMessage.textContent = response?.message || "Failed to start recording (background error)."; // 顯示失敗訊息
                startRecordingBtn.disabled = false; // 失敗時重新啟用按鈕
            }
        });

    } catch (error) { // 捕捉流程中任何錯誤
        console.error("Popup: Error during startup:", error);
        statusMessage.textContent = `Error: ${error.message}`; // 顯示錯誤訊息
        startRecordingBtn.disabled = false; // 發生錯誤重新啟用按鈕
    }
});
