const injectScript = document.createElement('script');
injectScript.src = chrome.runtime.getURL('page_inject.js');
injectScript.async = false;
(document.head || document.documentElement).appendChild(injectScript);
injectScript.onload = () => injectScript.remove();

(function(){
    // This file is injected into the page context by the content script via a <script src="..."> element

    // --- API interceptor (fetch + XHR) ---
    function serializeBody(body) {
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
                const url = (typeof input === 'string') ? input : (input && input.url);
                const method = (init && init.method) || (typeof input === 'object' && input.method) || 'GET';
                const requestBody = init && init.body ? serializeBody(init.body) : null;
                const start = Date.now();
                try {
                    const response = await __origFetch.apply(this, arguments);
                    const clone = response.clone();
                    let text = null;
                    try { text = await clone.text(); } catch (e) { text = `[failed to read response body: ${e.message}]`; }
                    let parsed = null;
                    try {
                        const ct = clone.headers.get && clone.headers.get('content-type');
                        if (ct && ct.includes('application/json')) parsed = JSON.parse(text);
                    } catch(e) { parsed = null; }
                    window.postMessage({
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
                    return response;
                } catch (err) {
                    window.postMessage({
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
        (function(){
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
                            window.postMessage({
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
            try { window.XMLHttpRequest = ProxyXHR; } catch(e) { /* some pages may forbid */ }
        })();
    } catch(e) { /* ignore */ }

    // --- Inject dialog (alert/prompt/confirm) capture ---
    try {
        (function(){
            if (window.__SELBAS_DIALOG_HOOKED__) return; window.__SELBAS_DIALOG_HOOKED__=true;
            const attr = document.documentElement.getAttribute('data-selbas-dialog-delay');
            const DELAY = (attr ? parseInt(attr, 10) : (window.__SELBAS_DIALOG_DELAY_MS || 1000));
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
        (function(){
            try {
                const _origOpen = window.open;
                window.open = function(url, name, features) {
                    try {
                        window.postMessage({ __SELBAS_POPUP__: true, url: url || null, name: name || null, features: features || null, via: 'open', timestamp: Date.now() }, '*');
                    } catch (e) { /* ignore */ }
                    return _origOpen.apply(this, arguments);
                };

                function tryWrapPopup() {
                    try {
                        if (window.__SELBAS_POPUP_WINDOW_WRAPPED) return;
                        if (typeof window.popupWindow === 'function') {
                            const _origPopup = window.popupWindow;
                            window.popupWindow = function() {
                                try {
                                    const url = arguments && arguments[0] ? arguments[0] : null;
                                    window.postMessage({ __SELBAS_POPUP__: true, url: url, via: 'popupWindow', args: Array.from(arguments || []), timestamp: Date.now() }, '*');
                                } catch (e) { /* ignore */ }
                                return _origPopup.apply(this, arguments);
                            };
                            window.__SELBAS_POPUP_WINDOW_WRAPPED = true;
                        }
                    } catch (e) { /* ignore */ }
                }

                tryWrapPopup();
                const wrapInterval = setInterval(tryWrapPopup, 500);
                setTimeout(() => clearInterval(wrapInterval), 10000);
            } catch (e) {
                // nothing
            }
        })();
    } catch(e) { /* ignore */ }
})();
