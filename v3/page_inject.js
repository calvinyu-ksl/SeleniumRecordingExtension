const injectScript = document.createElement('script'); // 建立 <script> 元素
injectScript.src = chrome.runtime.getURL('page_inject.js'); // 指向本擴充檔案的 URL（以便在頁面環境執行）
injectScript.async = false; // 同步載入（確保順序）
(document.head || document.documentElement).appendChild(injectScript); // 插入到 <head> 或 <html>
injectScript.onload = () => injectScript.remove(); // 載入後移除節點（避免重複）

(function(){
    // 本檔案會被 content script 透過 <script src="..."> 注入到頁面環境執行

    // --- API interceptor (fetch + XHR) ---
    function serializeBody(body) { // 將請求 body 序列化，便於傳送/記錄
        try {
            if (!body) return null;
            if (typeof body === 'string') return body;
            if (body instanceof URLSearchParams) return body.toString();
            if (body instanceof Blob) return '[Blob]';
            if (body instanceof ArrayBuffer) return '[ArrayBuffer]';
            return JSON.stringify(body);
        } catch (e) {
            return '[unserializable request body]';
        }
    }

    try {
        (function(){ // 包裝 fetch 以攔截請求/回應
            const __origFetch = window.fetch;
            window.fetch = async function(input, init) {
                const url = (typeof input === 'string') ? input : (input && input.url); // 取得 URL
                const method = (init && init.method) || (typeof input === 'object' && input.method) || 'GET'; // 取得方法
                const requestBody = init && init.body ? serializeBody(init.body) : null; // 序列化 body
                const start = Date.now(); // 記錄開始時間
                try {
                    const response = await __origFetch.apply(this, arguments); // 呼叫原始 fetch
                    const clone = response.clone(); // 複製回應（便於讀取文字）
                    let text = null;
                    try { text = await clone.text(); } catch (e) { text = `[failed to read response body: ${e.message}]`; }
                    let parsed = null;
                    try {
                        const ct = clone.headers.get && clone.headers.get('content-type');
                        if (ct && ct.includes('application/json')) parsed = JSON.parse(text);
                    } catch(e) { parsed = null; }
                    window.postMessage({ // 將請求/回應資訊透過 postMessage 傳給 content script
                        __SELBAS_RECORDER_API__: true,
                        source: 'page',
                        type: 'fetch',
                        url,
                        method,
                        requestBody,
                        status: response.status,
                        responseText: text,
                        responseJson: parsed,
                        timestamp: Date.now(),
                        durationMs: Date.now() - start
                    }, '*');
                    return response; // 回傳原始回應
                } catch (err) {
                    window.postMessage({ // 發生錯誤也通知出去
                        __SELBAS_RECORDER_API__: true,
                        source: 'page',
                        type: 'fetch',
                        url,
                        method,
                        requestBody,
                        error: String(err),
                        timestamp: Date.now()
                    }, '*');
                    throw err;
                }
            };
        })();
    } catch(e) { /* ignore */ }

    try {
        (function(){ // 包裝 XHR 以攔截請求/回應
            const __origXhr = window.XMLHttpRequest;
            function ProxyXHR() {
                const xhr = new __origXhr();
                let _url = null;
                let _method = null;
                let _requestBody = null;
                const origOpen = xhr.open;
                const origSend = xhr.send;
                xhr.open = function(method, url) {
                    _method = method;
                    _url = url;
                    return origOpen.apply(xhr, arguments);
                };
                xhr.send = function(body) {
                    _requestBody = serializeBody(body);
                    this.addEventListener('readystatechange', function() {
                        if (this.readyState === 4) {
                            let responseText = null;
                            try { responseText = this.responseText; } catch(e) { responseText = `[failed to read: ${e.message}]`; }
                            let parsed = null;
                            try {
                                const ct = this.getResponseHeader && this.getResponseHeader('content-type');
                                if (ct && ct.includes('application/json')) parsed = JSON.parse(responseText);
                            } catch(e) { parsed = null; }
                            window.postMessage({ // 將 XHR 請求/回應資訊傳出去
                                __SELBAS_RECORDER_API__: true,
                                source: 'page',
                                type: 'xhr',
                                url: _url,
                                method: _method,
                                requestBody: _requestBody,
                                status: this.status,
                                responseText,
                                responseJson: parsed,
                                timestamp: Date.now()
                            }, '*');
                        }
                    });
                    return origSend.apply(xhr, arguments);
                };
                return xhr;
            }
            try { window.XMLHttpRequest = ProxyXHR; } catch(e) { /* 某些頁面可能禁止覆寫 */ }
        })();
    } catch(e) { /* ignore */ }

    // --- Inject dialog (alert/prompt/confirm) capture ---
    try {
        (function(){ // 注入對話框（alert/confirm/prompt）攔截
            if (window.__SELBAS_DIALOG_HOOKED__) return; window.__SELBAS_DIALOG_HOOKED__=true; // 避免重複掛載
            const attr = document.documentElement.getAttribute('data-selbas-dialog-delay'); // 允許從 DOM 屬性設定延遲
            const DELAY = (attr ? parseInt(attr, 10) : (window.__SELBAS_DIALOG_DELAY_MS || 1000)); // 預設 1000ms
            function send(type, message, inputValue, result){
                try { window.postMessage({ __SELBAS_RECORDER_DIALOG__: true, dialogType: type, message, inputValue, result, timestamp: Date.now(), scheduleDelayMs: DELAY }, '*'); } catch(e) {}
            }
            const origAlert = window.alert;
            window.alert = function(msg){ send('alert', String(msg)); return origAlert.apply(this, arguments); };
            const origConfirm = window.confirm;
            window.confirm = function(msg){ const r = origConfirm.apply(this, arguments); send('confirm', String(msg), null, r); return r; };
            const origPrompt = window.prompt;
            window.prompt = function(msg, def){ const r = origPrompt.apply(this, arguments); send('prompt', String(msg), def !== undefined ? String(def): undefined, r); return r; };
        })();
    } catch(e) { /* ignore */ }

    // --- Inject popup/window open hooks ---
    try {
        (function(){ // 注入 window.open 與 popupWindow 勾點以偵測新視窗/分頁
            try {
                const _origOpen = window.open;
                window.open = function(url, name, features) {
                    try {
                        window.postMessage({ __SELBAS_POPUP__: true, url: url || null, name: name || null, features: features || null, via: 'open', timestamp: Date.now() }, '*'); // 通知已開啟新視窗
                    } catch (e) { /* ignore */ }
                    return _origOpen.apply(this, arguments);
                };

                function tryWrapPopup() { // 嘗試包裝自訂 popupWindow 函式（若存在）
                    try {
                        if (window.__SELBAS_POPUP_WINDOW_WRAPPED) return;
                        if (typeof window.popupWindow === 'function') {
                            const _origPopup = window.popupWindow;
                            window.popupWindow = function() {
                                try {
                                    const url = arguments && arguments[0] ? arguments[0] : null; // 常見為第一個參數 URL
                                    window.postMessage({ __SELBAS_POPUP__: true, url: url, via: 'popupWindow', args: Array.from(arguments || []), timestamp: Date.now() }, '*'); // 通知彈窗
                                } catch (e) { /* ignore */ }
                                return _origPopup.apply(this, arguments);
                            };
                            window.__SELBAS_POPUP_WINDOW_WRAPPED = true;
                        }
                    } catch (e) { /* ignore */ }
                }

                tryWrapPopup(); // 先試包一次
                const wrapInterval = setInterval(tryWrapPopup, 500); // 每 500ms 再試
                setTimeout(() => clearInterval(wrapInterval), 10000); // 10 秒後停止重試
            } catch (e) {
                // nothing
            }
        })();
    } catch(e) { /* ignore */ }
})();
