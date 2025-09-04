/**
 * content.js
 * This script is injected into the webpage to record user interactions.
 * It listens for relevant events (click, change) and sends data
 * back to the background script. It also handles requests to capture HTML.
 * *** Selector Strategy: ID -> Attributes -> Stable Classes -> Structure -> Text XPath -> Absolute XPath -> Tag Name. ***
 */

console.log("Selenium Recorder: Content script injected (v13 - improved class selectors).");

// --- Inject API interceptor into page context (fetch + XHR) ---
(function injectApiInterceptor() {
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

// --- Inject dialog (alert/prompt/confirm) capture ---
(function injectDialogHooks(){
    const script = document.createElement('script');
    script.textContent = `(() => {
        if (window.__SELBAS_DIALOG_HOOKED__) return; window.__SELBAS_DIALOG_HOOKED__=true;
        const DELAY = 400; // ms delay to allow native dialog to render before screenshot
        function send(type, message, inputValue, result){
            try { window.postMessage({ __SELBAS_RECORDER_DIALOG__: true, dialogType: type, message, inputValue, result, timestamp: Date.now(), scheduleDelayMs: DELAY }, '*'); } catch(e) {}
        }
        const origAlert = window.alert;
        window.alert = function(msg){ send('alert', String(msg)); return origAlert.apply(this, arguments); };
        const origConfirm = window.confirm;
        window.confirm = function(msg){ const r = origConfirm.apply(this, arguments); send('confirm', String(msg), null, r); return r; };
        const origPrompt = window.prompt;
        window.prompt = function(msg, def){ const r = origPrompt.apply(this, arguments); send('prompt', String(msg), def !== undefined ? String(def): undefined, r); return r; };
    })();`;
    document.documentElement.appendChild(script);
    script.remove();
})();

// --- State ---
let isListenerAttached = false;
let clickTimeout = null; // Used to debounce rapid click events

// --- Helper Functions ---

/**
 * Generates an Absolute XPath for a given element.
 * @param {Element} element The target HTML element.
 * @returns {string|null} The absolute XPath string or null if input is invalid.
 */
function generateAbsoluteXPath(element) {
    if (!(element instanceof Element)) return null;

    const parts = [];
    let currentElement = element;

    while (currentElement && currentElement.nodeType === Node.ELEMENT_NODE) {
        let index = 0;
        let hasSimilarSiblings = false;
        let sibling = currentElement.previousSibling;

        while (sibling) {
            if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === currentElement.nodeName) {
                index++;
            }
            sibling = sibling.previousSibling;
        }

        // Check if index is necessary
        sibling = currentElement.nextSibling;
        while(sibling) {
             if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === currentElement.nodeName) {
                hasSimilarSiblings = true;
                break;
            }
            sibling = sibling.nextSibling;
        }
        if (index === 0) {
             sibling = currentElement.previousSibling;
             while(sibling) {
                 if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === currentElement.nodeName) {
                    hasSimilarSiblings = true;
                    break;
                }
                sibling = sibling.previousSibling;
             }
        }

        const tagName = currentElement.nodeName.toLowerCase();
        const part = (index > 0 || hasSimilarSiblings) ? `${tagName}[${index + 1}]` : tagName;
        parts.unshift(part);

        if (tagName === 'html') break;

        currentElement = currentElement.parentNode;
        if (!currentElement) {
             console.error("generateAbsoluteXPath: Reached null parent before HTML node!");
             return null;
        }
    }
    return parts.length ? '/' + parts.join('/') : null;
}


/**
 * Generates a CSS or XPath selector for a given HTML element.
 * Prioritization: ID -> Name -> data-testid -> role -> title -> Combined Class + Structure -> Text XPath -> Absolute XPath -> Basic TagName.
 * Returns XPath selectors prefixed with "xpath=".
 * @param {Element} el The target HTML element.
 * @returns {string|null} A selector string (CSS or XPath) or null.
 */
function generateRobustSelector(el) {
    if (!(el instanceof Element)) return null;
    const tagName = el.tagName.toLowerCase();
    // console.log(`generateRobustSelector: Finding selector for <${tagName}>`, el); // Optional debug

    // --- Attribute Selectors (CSS) ---

    // 1. ID
    if (el.id) {
        const id = el.id;
        const unstableIdRegex = /[^a-zA-Z0-9\-_]|^\d+$|^(?:radix-|ember-|data-v-|svelte-|ui-|aria-)/i;
        const looksUnstable = unstableIdRegex.test(id) || id.length > 50;
        if (!looksUnstable) {
            if (/^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(id)) {
                try {
                    const selector = `#${CSS.escape(id)}`;
                    if (document.querySelectorAll(selector).length === 1) return selector;
                } catch (e) { /* ignore */ }
            }
            const idAttrSelector = `${tagName}[id="${CSS.escape(id)}"]`;
             try {
                 if (document.querySelectorAll(idAttrSelector).length === 1) return idAttrSelector;
             } catch(e) { /* ignore */ }
        } else {
             console.warn(`generateRobustSelector: Skipping potentially unstable ID '${id}'.`);
        }
    }

    // 2. Name
    if (el.name) {
         const name = el.name;
         const selector = `${tagName}[name="${CSS.escape(name)}"]`;
         try {
             if (document.querySelectorAll(selector).length === 1) return selector;
         } catch(e) { /* ignore */ }
    }

    // 3. data-testid
    const testId = el.getAttribute('data-testid');
    if (testId) {
        const selector = `${tagName}[data-testid="${CSS.escape(testId)}"]`;
        try {
            if (document.querySelectorAll(selector).length === 1) return selector;
        } catch (e) { /* ignore */ }
    }

     // 4. role
     const role = el.getAttribute('role');
     if (role && role !== 'presentation' && role !== 'none' && role !== 'document' && role !== 'main') {
         const selector = `${tagName}[role="${CSS.escape(role)}"]`;
         try {
             if (document.querySelectorAll(selector).length === 1) return selector;
         } catch (e) { /* ignore */ }
     }

     // 5. title
     const title = el.getAttribute('title');
     if (title) {
         const selector = `${tagName}[title="${CSS.escape(title)}"]`;
         try {
             if (document.querySelectorAll(selector).length === 1) return selector;
         } catch (e) { /* ignore */ }
     }

    // 6. Combined Class & Structure Selector
    let baseSelector = tagName;
    if (el.classList && el.classList.length > 0) {
        const forbiddenClassesRegex = /^(?:active|focus|hover|selected|checked|disabled|visited|focus-within|focus-visible|focusNow|open|opened|closed|collapsed|expanded|js-|ng-|is-|has-|ui-|data-v-|aria-)/i;
        const stableClasses = Array.from(el.classList)
            .map(c => c.trim())
            .filter(c => c && !forbiddenClassesRegex.test(c) && /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(c));

        if (stableClasses.length > 0) {
            baseSelector += `.${stableClasses.map(c => CSS.escape(c)).join('.')}`;
        }
    }

    try {
        // First, try the base selector (tag + classes) on its own. This is the most common and robust case.
        if (document.querySelectorAll(baseSelector).length === 1) {
            return baseSelector;
        }

        // If not unique, try to make it unique with a structural pseudo-class.
        if (el.parentNode) {
            // Try with :nth-of-type
            let siblingOfType = el;
            let typeIndex = 1;
            while ((siblingOfType = siblingOfType.previousElementSibling)) {
                // We only increment the index if the sibling matches the base selector,
                // making it a true "nth-of-type-with-classes"
                if (siblingOfType.matches(baseSelector)) {
                    typeIndex++;
                }
            }
             // Check if this is the only element of its type that matches the base selector
            const parentNthOfTypeSelector = `:scope > ${baseSelector}`;
            if (el.parentNode.querySelectorAll(parentNthOfTypeSelector).length > 1) {
                 const nthOfTypeSelector = `${baseSelector}:nth-of-type(${typeIndex})`;
                 if (document.querySelectorAll(nthOfTypeSelector).length === 1) {
                     return nthOfTypeSelector;
                 }
            }


            // If that fails, try with :nth-child
            let siblingChild = el;
            let childIndex = 1;
            while ((siblingChild = siblingChild.previousElementSibling)) {
                childIndex++;
            }
            const nthChildSelector = `${baseSelector}:nth-child(${childIndex})`;
            if (document.querySelectorAll(nthChildSelector).length === 1) {
                return nthChildSelector;
            }
        }
    } catch(e) { console.warn("Error during combined class/structure selector generation:", e) }


    // 7. Text Content XPath (Fallback)
    const tagsForTextCheck = ['a', 'button', 'span', 'div', 'label', 'legend', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'td', 'th'];
    if (tagsForTextCheck.includes(tagName)) {
        let text = el.textContent?.trim() || '';
        // Normalize whitespace and limit length for practicality
        text = text.replace(/\s+/g, ' ').trim();
        if (text && text.length > 0 && text.length < 100) { // Avoid using very long text
             // Escape quotes for XPath string literal
             let escapedText = text.includes("'") ? `concat('${text.replace(/'/g, "', \"'\", '")}')` : `'${text}'`;
             // Try exact match first using normalize-space()
             let textXPath = `//${tagName}[normalize-space()=${escapedText}]`;
             try {
                 // Use evaluate to count matches accurately
                 if (document.evaluate(`count(${textXPath})`, document, null, XPathResult.NUMBER_TYPE, null).numberValue === 1) {
                      console.warn(`generateRobustSelector: Falling back to Text Content XPath (exact match) for element:`, el);
                      return `xpath=${textXPath}`;
                 }
             } catch (e) { console.warn("Error evaluating text XPath:", e); }
        }
    }

    // 8. Absolute XPath Fallback
    try {
        const absXPath = generateAbsoluteXPath(el);
        if (absXPath) {
             console.warn(`generateRobustSelector: Falling back to Absolute XPath for element:`, el);
             return `xpath=${absXPath}`;
        } else {
             console.error("generateRobustSelector: generateAbsoluteXPath returned null.");
        }
    } catch(e) { console.warn("Error during Absolute XPath generation:", e) }


    // 9. Absolute Fallback: Tag Name (CSS)
    console.error(`generateRobustSelector: CRITICAL FALLBACK to basic tag name for element:`, el);
    return tagName;
}


/**
 * Extracts relevant information from an element for selector generation.
 * @param {Element} element
 * @returns {object} Simplified info { tagName, id, name, className }
 */
function getElementInfo(element) {
    if (!element) return null;
    return {
        tagName: element.tagName,
        id: element.id,
        name: element.getAttribute('name'),
        className: element.className,
    };
}

/**
 * Gets the closest anchor selector for a given element, if available.
 * @param {Element} el The target HTML element.
 * @returns {string|null} The anchor selector string or null if not applicable.
 */
function getClosestAnchorSelector(el) {
    try {
        if (!el || !(el instanceof Element)) return null;
        const anchor = el.closest('a');
        if (!anchor) return null;
        const sel = generateRobustSelector(anchor);
        return sel || null;
    } catch (e) {
        return null;
    }
}

// --- Event Handlers ---

/**
 * Handles click events on the page. Debounces rapid clicks to capture only the most specific one.
 * @param {Event} event
 */
function handleClick(event) {
    try {
        const rawTarget = event.target;
        if (!rawTarget) return;

        const anchorEl = rawTarget.closest ? rawTarget.closest('a') : null;

        const targetForSelector = rawTarget;
        const selector = generateRobustSelector(targetForSelector) || (anchorEl ? generateRobustSelector(anchorEl) : null);
        const anchorSelector = anchorEl ? (generateRobustSelector(anchorEl) || null) : null;

        // anchor attributes
        const anchorTarget = anchorEl ? (anchorEl.getAttribute('target') || null) : null;
        const anchorHref = anchorEl ? (anchorEl.getAttribute('href') || anchorEl.href || null) : null;
        const anchorOnclick = anchorEl ? (anchorEl.getAttribute('onclick') || null) : null;

        const action = {
            type: 'Click',
            selector: selector,
            selectorType: selector && selector.startsWith('xpath=') ? 'XPath' : 'CSS',
            elementInfo: getElementInfo(rawTarget),
            anchorSelector: anchorSelector,
            anchorTarget: anchorTarget,
            anchorHref: anchorHref,
            anchorOnclick: anchorOnclick,
            timestamp: Date.now()
        };

        // If inline onclick contains popupWindow('...') try to extract URL and notify background immediately
        try {
            if (anchorOnclick) {
                const m = anchorOnclick.match(/popupWindow\s*\(\s*['"]([^'"]+)['"]/i);
                if (m && m[1]) {
                    try {
                        chrome.runtime.sendMessage({ command: 'popup_opened', data: { url: m[1], via: 'onclick', timestamp: Date.now() } });
                    } catch (e) { /* ignore */ }
                }
            }
        } catch (e) {
            /* ignore parsing errors */
        }

        try {
            chrome.runtime.sendMessage({ command: 'record_action', data: action });
        } catch (e) {
            console.warn("Content: failed to send click action:", e);
        }
    } catch (e) {
        console.warn("Content: handleClick error:", e);
    }
}


/**
 * Handles change events for <select>, <input>, and <textarea> elements.
 * Captures the final value after modification.
 * @param {Event} event
 */
function handleChange(event) {
    const targetElement = event.target;
    const tagName = targetElement.tagName.toLowerCase();
    let actionData = null;

    // console.log(`handleChange: Detected change on <${tagName}>`, targetElement); // Optional debug
    const selector = generateRobustSelector(targetElement);
    if (!selector) {
        console.warn(`handleChange: Could not generate selector for <${tagName}> element:`, targetElement);
        return;
    }

    // Handle <select> elements
    if (tagName === 'select') {
        actionData = {
            type: 'Select',
            selector: selector,
            value: targetElement.value,
            timestamp: Date.now()
        };
    }
    // Handle <input type="checkbox">
    else if (tagName === 'input' && targetElement.type === 'checkbox') {
        actionData = {
            type: 'Checkbox',
            selector: selector,
            value: targetElement.checked, // The final state (true/false)
            timestamp: Date.now()
        };
    }
    // Handle <input> (text-like) and <textarea> elements
    else if ((tagName === 'input' && /text|password|search|email|url|tel|number/.test(targetElement.type)) || tagName === 'textarea') {
         actionData = {
            type: 'Input',
            selector: selector,
            value: targetElement.value,
            timestamp: Date.now()
         };
    }

    // Send the recorded action if one was created
    if (actionData) {
        console.log("handleChange: Action recorded (Content):", actionData);
        try {
            chrome.runtime.sendMessage({ command: "record_action", data: actionData })
                .catch(error => {
                    if (error.message && !error.message.includes("Extension context invalidated") && !error.message.includes("message port closed")) {
                         console.error("handleChange: Error sending change action message:", error);
                    } else {
                         // console.log("handleChange: Context invalidated during message send."); // Optional debug
                    }
                });
        } catch (error) {
             if (error.message && !error.message.includes("Extension context invalidated")) {
                 console.error("handleChange: Synchronous error sending change action:", error);
             } else {
                  // console.log("handleChange: Context invalidated during message send."); // Optional debug
             }
        }
    }
}

// content script: receive page -> forward API data to background
window.addEventListener('message', (event) => {
    if (!event.data || !event.data.__SELBAS_RECORDER_API__) return;
    try {
        chrome.runtime.sendMessage({ command: 'api_response', data: event.data });
    } catch (e) {
        console.warn("Content: failed to forward API data to background", e);
    }
});

// Forward dialog events
window.addEventListener('message', (event) => {
    if (!event.data || !event.data.__SELBAS_RECORDER_DIALOG__) return;
    try { chrome.runtime.sendMessage({ command: 'dialog_event', data: event.data }); } catch(e) {}
});

// --- MutationObserver: detect newly added elements and notify background ---
let elementMutationObserver = null;
let mutationDebounceTimer = null;
const MUTATION_DEBOUNCE_MS = 300;
const MAX_ELEMENTS_PER_BATCH = 20;

function serializeElementForNotification(el) {
    try {
        return {
            selector: generateRobustSelector(el) || null,
            info: getElementInfo(el),
            tagName: el.tagName ? el.tagName.toLowerCase() : null,
            text: (el.textContent || '').trim().slice(0, 200)
        };
    } catch (e) {
        return { selector: null, info: null, tagName: null, text: null };
    }
}

function handleMutations(mutationsList) {
    // Collect added elements
    const added = [];
    for (const mut of mutationsList) {
        if (mut.addedNodes && mut.addedNodes.length) {
            for (const node of mut.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    added.push(node);
                } else if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
                    // flatten fragments
                    const elems = node.querySelectorAll ? Array.from(node.querySelectorAll('*')) : [];
                    elems.forEach(e => added.push(e));
                }
                if (added.length >= MAX_ELEMENTS_PER_BATCH) break;
            }
        }
        if (added.length >= MAX_ELEMENTS_PER_BATCH) break;
    }

    if (!added.length) return;

    // Debounce to batch rapid mutation bursts
    if (mutationDebounceTimer) clearTimeout(mutationDebounceTimer);
    mutationDebounceTimer = setTimeout(() => {
        mutationDebounceTimer = null;

        // Build payload, avoid sending heavy DOM objects
        const payload = [];
        const seenSelectors = new Set();
        for (const el of added) {
            const item = serializeElementForNotification(el);
            // basic dedupe by selector to reduce noise
            if (item.selector && !seenSelectors.has(item.selector)) {
                seenSelectors.add(item.selector);
                payload.push(item);
            } else if (!item.selector) {
                payload.push(item);
            }
            if (payload.length >= MAX_ELEMENTS_PER_BATCH) break;
        }

        if (payload.length) {
            try {
                chrome.runtime.sendMessage({ command: "new_elements", data: payload });
            } catch (e) {
                // ignore if runtime unavailable
                console.warn("Content: failed to send new_elements message", e);
            }
        }
    }, MUTATION_DEBOUNCE_MS);
}

// Replace/augment attachListeners and detachListeners to control the observer
function attachListeners() {
    if (isListenerAttached) return;
    console.log("Attaching event listeners...");
    document.addEventListener('click', handleClick, true);
    document.addEventListener('change', handleChange, true); // Listen only to 'change' for inputs
    isListenerAttached = true;

    try {
        if (!elementMutationObserver) {
            elementMutationObserver = new MutationObserver(handleMutations);
            elementMutationObserver.observe(document, {
                childList: true,
                subtree: true,
                attributes: false,
                characterData: false
            });
            console.log("Content: MutationObserver attached for new elements.");
        }
    } catch (e) {
        console.warn("Content: Failed to attach MutationObserver:", e);
    }
}

function detachListeners() {
    if (!isListenerAttached) return;
    console.log("Detaching event listeners...");
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('change', handleChange, true);
    isListenerAttached = false;

    try {
        if (elementMutationObserver) {
            elementMutationObserver.disconnect();
            elementMutationObserver = null;
            console.log("Content: MutationObserver disconnected.");
        }
        if (mutationDebounceTimer) {
            clearTimeout(mutationDebounceTimer);
            mutationDebounceTimer = null;
        }
    } catch (e) {
        console.warn("Content: Failed to disconnect MutationObserver:", e);
    }
}

// --- Message Listener ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // console.log("Content script received message:", message.command); // Optional debug
    if (message.command === "get_html") {
        const htmlContent = document.documentElement.outerHTML;
        sendResponse({ success: true, html: htmlContent });
        return true; // Indicate async response
    }
});

// --- Initialization ---
attachListeners();


(function injectPopupWindowAndOpenHook() {
    try {
        const script = document.createElement('script');
        script.textContent = '(' + function() {
            try {
                // Wrap window.open immediately
                const _origOpen = window.open;
                window.open = function(url, name, features) {
                    try {
                        window.postMessage({ __SELBAS_POPUP__: true, url: url || null, name: name || null, features: features || null, via: 'open', timestamp: Date.now() }, '*');
                    } catch (e) { /* ignore */ }
                    return _origOpen.apply(this, arguments);
                };

                // Try to wrap popupWindow if it exists; retry for a short period in case it's defined later
                function tryWrapPopup() {
                    try {
                        if (window.__SELBAS_POPUP_WINDOW_WRAPPED) return;
                        if (typeof window.popupWindow === 'function') {
                            const _origPopup = window.popupWindow;
                            window.popupWindow = function() {
                                try {
                                    // first arg often is URL string like 'eqpress.htm?...'
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
                setTimeout(() => clearInterval(wrapInterval), 10000); // stop retry after 10s
            } catch (e) {
                // nothing
            }
        } + ')();';
        (document.documentElement || document.head || document.body || document).appendChild(script);
        script.parentNode && script.parentNode.removeChild(script);
    } catch (e) {
        console.warn("Content: Failed to inject popup/open hook:", e);
    }
})();

// --- Cleanup: remove any legacy injected screen recorder floating button (from older content.js) ---
(function removeLegacyScreenRecorder(){
    try {
        const legacy = document.getElementById('__selbas_screen_recorder_container');
        if (legacy) {
            legacy.remove();
            console.log('[Cleanup] Removed legacy screen recorder UI.');
        }
    } catch(e) { /* ignore */ }
})();

