// popup_hooks.js - External script for popup/window.open interception
(() => {
    try {
        // Wrap window.open immediately
        const _origOpen = window.open;
        window.open = function (url, name, features) {
            try {
                window.postMessage({ 
                    __SELBAS_POPUP__: true, 
                    url: url || null, 
                    name: name || null, 
                    features: features || null, 
                    via: 'open', 
                    timestamp: Date.now() 
                }, '*');
            } catch (e) { /* ignore */ }
            return _origOpen.apply(this, arguments);
        };

        // Try to wrap popupWindow if it exists; retry for a short period in case it's defined later
        function tryWrapPopup() {
            try {
                if (window.__SELBAS_POPUP_WINDOW_WRAPPED) return;
                if (typeof window.popupWindow === 'function') {
                    const _origPopup = window.popupWindow;
                    window.popupWindow = function () {
                        try {
                            // first arg often is URL string like 'eqpress.htm?...'
                            const url = arguments && arguments[0] ? arguments[0] : null;
                            window.postMessage({ 
                                __SELBAS_POPUP__: true, 
                                url: url, 
                                via: 'popupWindow', 
                                args: Array.from(arguments || []), 
                                timestamp: Date.now() 
                            }, '*');
                        } catch (e) { /* ignore */ }
                        return _origPopup.apply(this, arguments);
                    };
                    window.__SELBAS_POPUP_WINDOW_WRAPPED = true;
                }
            } catch (e) { /* ignore */ }
        }

        tryWrapPopup();
        const wrapInterval = setInterval(tryWrapPopup, 500);
        setTimeout(() => clearInterval(wrapInterval), 10000); // stop retry after 10s
    } catch (e) {
        // nothing
    }
})();