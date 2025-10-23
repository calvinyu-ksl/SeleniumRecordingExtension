// dialog_hooks.js - External script for dialog interception
(() => {
    if (window.__SELBAS_DIALOG_HOOKED__) return; 
    window.__SELBAS_DIALOG_HOOKED__ = true;
    
    const DELAY = 500; // ms delay to allow native dialog to render before screenshot
    
    function send(type, message, inputValue, result) {
        try { 
            window.postMessage({ 
                __SELBAS_RECORDER_DIALOG__: true, 
                dialogType: type, 
                message, 
                inputValue, 
                result, 
                timestamp: Date.now(), 
                scheduleDelayMs: DELAY 
            }, '*'); 
        } catch(e) {}
    }
    
    const origAlert = window.alert;
    window.alert = function(msg) { 
        send('alert', String(msg)); 
        return origAlert.apply(this, arguments); 
    };
    
    const origConfirm = window.confirm;
    window.confirm = function(msg) { 
        const r = origConfirm.apply(this, arguments); 
        send('confirm', String(msg), null, r); 
        return r; 
    };
    
    const origPrompt = window.prompt;
    window.prompt = function(msg, def) { 
        const r = origPrompt.apply(this, arguments); 
        send('prompt', String(msg), def !== undefined ? String(def) : undefined, r); 
        return r; 
    };
})();