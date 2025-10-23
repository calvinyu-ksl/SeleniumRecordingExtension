const injectScript = doc        (function(){ // Wrap fetch to intercept requests/responsesment.createElement('script'); // Create <script> element        (function(){ // Wrap XHR to intercept requests/responsesinjectScript.src = chrome.runtime.getURL('page_i        (function(){ // Inject dialog (alert/confirm/prompt) interception
            if (window.__SELBAS_DIALOG_HOOKED__) return; window.__SELBAS_DIALOG_HOOKED__=true; // Avoid duplicate mounting
            const attr = document.documentElement.getAttribute('data-selbas-dialog-delay'); // Allow delay setting from DOM attribute
            const DELAY = (attr ? parseInt(attr, 10) : (window.__SELBAS_DIALOG_DELAY_MS || 1000)); // Default 1000mst.js'); // Point to extension file URL (for execution in page environment)
injectScript.async = false; // Synchronous loading (ensure order)
(document.head || document.documentElement).appendChild(injectScript); // Insert into <head> or <html>
injectScript.onload = () => injectScript.remove(); // Remove node after loading (avoid duplication)

(function(){
    // This file will be injected into page environment by content script via <script src="...">

    // --- API interceptor (fetch + XHR) ---
    function serializeBody(body) { // Serialize request body for sending/logging
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
        (function(){ 
            const __origFetch = window.fetch;
            window.fetch = async function(input, init) {
                const url = (typeof input === 'string') ? input : (input && input.url); // Get URL
                const method = (init && init.method) || (typeof input === 'object' && input.method) || 'GET'; // Get method
                const requestBody = init && init.body ? serializeBody(init.body) : null; // Serialize body
                const start = Date.now(); // Record start time
                try {
                    const response = await __origFetch.apply(this, arguments); // Call original fetch
                    const clone = response.clone(); // Clone response (for reading text)
                    let text = null;
                    try { text = await clone.text(); } catch (e) { text = `[failed to read response body: ${e.message}]`; }
                    let parsed = null;
                    try {
                        const ct = clone.headers.get && clone.headers.get('content-type');
                        if (ct && ct.includes('application/json')) parsed = JSON.parse(text);
                    } catch(e) { parsed = null; }
                    window.postMessage({ // Send request/response info to content script via postMessage
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
                    return response; // Return original response
                } catch (err) {
                    window.postMessage({ // Notify errors as well
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
        (function(){ // Wrap XHR to intercept requests/responses
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
                            window.postMessage({ // Send XHR request/response info
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
            try { window.XMLHttpRequest = ProxyXHR; } catch(e) { /* Some pages may prevent override */ }
        })();
    } catch(e) { /* ignore */ }

    // --- Inject dialog (alert/prompt/confirm) capture ---
    try {
        (function(){ // Inject dialog (alert/confirm/prompt) interception
            if (window.__SELBAS_DIALOG_HOOKED__) return; window.__SELBAS_DIALOG_HOOKED__=true; // Avoid duplicate mounting
            const attr = document.documentElement.getAttribute('data-selbas-dialog-delay'); // Allow delay setting from DOM attribute
            const DELAY = (attr ? parseInt(attr, 10) : (window.__SELBAS_DIALOG_DELAY_MS || 1000)); // Default 1000ms
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
        (function(){ // Inject window.open and popupWindow hooks to detect new windows/tabs
            try {
                const _origOpen = window.open;
                window.open = function(url, name, features) {
                    try {
                        window.postMessage({ __SELBAS_POPUP__: true, url: url || null, name: name || null, features: features || null, via: 'open', timestamp: Date.now() }, '*'); // Notify new window opened
                    } catch (e) { /* ignore */ }
                    return _origOpen.apply(this, arguments);
                };

                function tryWrapPopup() { // Try to wrap custom popupWindow function (if exists)
                    try {
                        if (window.__SELBAS_POPUP_WINDOW_WRAPPED) return;
                        if (typeof window.popupWindow === 'function') {
                            const _origPopup = window.popupWindow;
                            window.popupWindow = function() {
                                try {
                                    const url = arguments && arguments[0] ? arguments[0] : null; // Commonly first parameter is URL
                                    window.postMessage({ __SELBAS_POPUP__: true, url: url, via: 'popupWindow', args: Array.from(arguments || []), timestamp: Date.now() }, '*'); // Notify popup
                                } catch (e) { /* ignore */ }
                                return _origPopup.apply(this, arguments);
                            };
                            window.__SELBAS_POPUP_WINDOW_WRAPPED = true;
                        }
                    } catch (e) { /* ignore */ }
                }

                tryWrapPopup(); // Try wrapping once first
                const wrapInterval = setInterval(tryWrapPopup, 500); // Try again every 500ms
                setTimeout(() => clearInterval(wrapInterval), 10000); // Stop retrying after 10 seconds
            } catch (e) {
                // nothing
            }
        })();
    } catch(e) { /* ignore */ }
})();});
