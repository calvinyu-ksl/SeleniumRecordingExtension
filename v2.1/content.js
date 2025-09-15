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
        const DELAY = 500; // ms delay to allow native dialog to render before screenshot
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

// Make a safe XPath string literal from JS string (handles quotes)
function xpathLiteral(s) {
    if (s == null) return "''";
    const str = String(s);
    if (str.indexOf("'") === -1) return `'${str}'`;
    if (str.indexOf('"') === -1) return `"${str}"`;
    // Has both quotes -> build concat('...', '"', '...', "'", ...)
    const parts = str.split("'");
    const concatParts = [];
    for (let i = 0; i < parts.length; i++) {
        if (parts[i] !== '') concatParts.push(`'${parts[i]}'`);
        if (i < parts.length - 1) concatParts.push('"' + "'" + '"');
    }
    return `concat(${concatParts.join(', ')})`;
}

// Trim trailing non-interactive nodes from an XPath (e.g., '/svg' or '/path')
function trimNonInteractiveXPathTail(xp) {
    try {
        if (!xp || typeof xp !== 'string') return xp;
        let out = xp;
        for (let i = 0; i < 2; i++) { // trim up to two levels just in case '/span/svg'
            const next = out.replace(/\/(?:svg|path)(?:\[\d+\])?$/i, '');
            if (next === out) break;
            out = next;
        }
        return out;
    } catch(e) { return xp; }
}

// Detect very weak selectors we should avoid using
function isWeakSelector(sel) {
    try {
        if (!sel || typeof sel !== 'string') return true;
        // Absolute body-level anchors like '/html/body/a' (optionally with index)
        if (/^\/html\/body\/a(?:\[\d+\])?$/i.test(sel)) return true;
        // Bare nth-child on anchor without attributes/classes (e.g., 'a:nth-child(8)')
        if (/^a\:nth-child\(\d+\)$/i.test(sel)) return true;
        return false;
    } catch(e) { return false; }
}


/**
 * Generates a CSS or XPath selector for a given HTML element.
 * Prioritization: ID -> Name -> data-testid -> role -> title -> Combined Class + Structure -> Text XPath -> Absolute XPath -> Basic TagName.
 * Returns XPath selectors (now WITHOUT the historical 'xpath=' prefix; backward compatible handling kept elsewhere).
 * @param {Element} el The target HTML element.
 * @returns {string|null} A selector string (CSS or XPath) or null.
 */
function generateRobustSelector(el) {
    if (!(el instanceof Element)) return null;
    const originalEl = el;
    // If target is an icon or non-interactive, promote to closest clickable ancestor
    let promotedToAncestor = false;
    try {
        const nonInteractiveTags = ['svg','path','i','span'];
        const initialTag = el.tagName ? el.tagName.toLowerCase() : '';
        if (nonInteractiveTags.includes(initialTag)) {
            const ancestor = el.closest('button, a[href], [role="button"], .ant-btn, [onclick], [tabindex]:not([tabindex="-1"])');
            if (ancestor && ancestor !== el) { el = ancestor; promotedToAncestor = true; }
        }
    } catch(e) { /* ignore */ }
    const tagName = el.tagName.toLowerCase();
    // Special case: For Ant Design Select search (identified by class/id/aria-controls), prefer the visible combobox wrapper.
    try {
        if (tagName === 'input') {
            const t = (el.getAttribute('type') || '').toLowerCase();
            if (t === 'search') {
                const isAntdSearch = (
                    (el.classList && el.classList.contains('ant-select-selection-search-input')) ||
                    (typeof el.id === 'string' && /^rc_select_/i.test(el.id)) ||
                    (typeof el.getAttribute === 'function' && /^rc_select_/i.test(el.getAttribute('aria-controls') || ''))
                );
                if (isAntdSearch) {
                // Prefer closest role=combobox (visible clickable wrapper)
                    const combo = el.closest('[role="combobox"]') || el.closest('.ant-select') || el.parentElement;
                    if (combo && combo !== el && combo instanceof Element) {
                        const comboAbs = generateAbsoluteXPath(combo);
                        if (comboAbs) return comboAbs;
                    }
                    // Fallback to the input itself if no wrapper found
                    const abs = generateAbsoluteXPath(el);
                    if (abs) return abs;
                }
            }
        }
    } catch(e) { /* ignore */ }
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

    // 6. Anchor-specific selectors (prefer href/title/aria-label)
    if (tagName === 'a') {
        try {
            const href = el.getAttribute('href');
            if (href && href.length < 300) {
                const exactSel = `a[href="${CSS.escape(href)}"]`;
                if (document.querySelectorAll(exactSel).length === 1) return exactSel;
                // Try filename tail if URL has a file name
                const tail = href.split('?')[0].split('#')[0].split('/').filter(Boolean).pop();
                if (tail && tail.length < 120) {
                    const endsSel = `a[href$="${CSS.escape(tail)}"]`;
                    if (document.querySelectorAll(endsSel).length === 1) return endsSel;
                }
            }
            const aTitle = el.getAttribute('title');
            if (aTitle) {
                const s = `a[title="${CSS.escape(aTitle)}"]`;
                if (document.querySelectorAll(s).length === 1) return s;
            }
            const aria = el.getAttribute('aria-label');
            if (aria) {
                const s = `a[aria-label="${CSS.escape(aria)}"]`;
                if (document.querySelectorAll(s).length === 1) return s;
            }
        } catch(e) { /* ignore */ }
    }

    // 7. Combined Class & Structure Selector
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

            // If that fails, try with :nth-child (but avoid for anchors/buttons as it's brittle)
            if (tagName !== 'a' && tagName !== 'button') {
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
        }
    } catch(e) { console.warn("Error during combined class/structure selector generation:", e) }


    // 6.5 For promoted clickable ancestors, try an ancestor selector that contains a descendant with title/aria-icon
    try {
        if (promotedToAncestor && originalEl && originalEl !== el) {
            const clickTag = tagName; // ancestor tag name lower-cased
            const origTitle = originalEl.getAttribute && originalEl.getAttribute('title');
            const origAria = originalEl.getAttribute && originalEl.getAttribute('aria-label');
            const origDataIcon = originalEl.getAttribute && originalEl.getAttribute('data-icon');
            const origHasAntIcon = originalEl.classList && originalEl.classList.contains('anticon-download');
            function evalUniqueXPath(xpath){
                try { return document.evaluate(`count(${xpath})`, document, null, XPathResult.NUMBER_TYPE, null).numberValue === 1; } catch(e){ return false; }
            }
            function buildAndReturn(xpath){ if (evalUniqueXPath(xpath)) return xpath; return null; }
            if (origTitle) {
                const xp = `//${clickTag}[.//*[@title=${xpathLiteral(origTitle)}]]`;
                const r = buildAndReturn(xp); if (r) return r;
            }
            if (origAria) {
                const xp = `//${clickTag}[.//*[@aria-label=${xpathLiteral(origAria)}]]`;
                const r = buildAndReturn(xp); if (r) return r;
            }
            if (origDataIcon) {
                const xp = `//${clickTag}[.//*[@data-icon=${xpathLiteral(origDataIcon)}]]`;
                const r = buildAndReturn(xp); if (r) return r;
            }
            if (origHasAntIcon) {
                const xp = `//${clickTag}[.//*[contains(concat(' ', normalize-space(@class), ' '), ' anticon-download ')]]`;
                const r = buildAndReturn(xp); if (r) return r;
            }
        }
    } catch(e) { /* ignore ancestor-descendant xpath fallback errors */ }

    // As a last resort, avoid returning fragile 'a:nth-child(n)' or 'button:nth-child(n)'
    try {
        if ((tagName === 'a' || tagName === 'button') && baseSelector && /\:nth-child\(\d+\)/.test(baseSelector)) {
            const abs = generateAbsoluteXPath(el);
            if (abs) return abs;
        }
    } catch(e) { /* ignore */ }


    // 8. Text Content XPath (Fallback)
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
                  return trimNonInteractiveXPathTail(`${textXPath}`);
                 }
             } catch (e) { console.warn("Error evaluating text XPath:", e); }
        }
    }

    // 9. Absolute XPath Fallback
    try {
    let absXPath = generateAbsoluteXPath(el);
        if (absXPath) {
             console.warn(`generateRobustSelector: Falling back to Absolute XPath for element:`, el);
         return trimNonInteractiveXPathTail(absXPath);
        } else {
             console.error("generateRobustSelector: generateAbsoluteXPath returned null.");
        }
    } catch(e) { console.warn("Error during Absolute XPath generation:", e) }


    // 10. Absolute Fallback: Tag Name (CSS)
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

    const clickableAncestor = rawTarget.closest && rawTarget.closest('button, a[href], [role="button"], .ant-btn, [onclick], [tabindex]:not([tabindex="-1"])');
    const anchorEl = clickableAncestor ? (clickableAncestor.closest && clickableAncestor.closest('a')) : (rawTarget.closest ? rawTarget.closest('a') : null);
    const targetForSelector = clickableAncestor || anchorEl || rawTarget;
        let selector = generateRobustSelector(targetForSelector) || (anchorEl ? generateRobustSelector(anchorEl) : null);
        // If selector is weak, try improving it using anchor-only strategy or absolute XPath of clickable ancestor
        if (!selector || isWeakSelector(selector)) {
            if (anchorEl) {
                const tryAnchor = generateRobustSelector(anchorEl);
                if (tryAnchor && !isWeakSelector(tryAnchor)) selector = tryAnchor;
            }
            if ((!selector || isWeakSelector(selector)) && clickableAncestor) {
                // Force absolute XPath on clickable ancestor and trim svg/path tails
                try {
                    const abs = generateAbsoluteXPath(clickableAncestor);
                    if (abs) {
                        const trimmed = trimNonInteractiveXPathTail(abs);
                        if (trimmed && !isWeakSelector(trimmed)) selector = trimmed;
                    }
                } catch(e) { /* ignore */ }
            }
        }
        // If still weak, skip recording this click to avoid generating unusable selectors
        if (!selector || isWeakSelector(selector)) return;
        const anchorSelector = anchorEl ? (generateRobustSelector(anchorEl) || null) : null;

        // anchor attributes
        const anchorTarget = anchorEl ? (anchorEl.getAttribute('target') || null) : null;
        const anchorHref = anchorEl ? (anchorEl.getAttribute('href') || anchorEl.href || null) : null;
        const anchorOnclick = anchorEl ? (anchorEl.getAttribute('onclick') || null) : null;

        const action = {
            type: 'Click',
            selector: selector,
            selectorType: selector && (selector.startsWith('xpath=') || selector.startsWith('/')) ? 'XPath' : 'CSS',
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
            selectorType: selector && (selector.startsWith('xpath=') || selector.startsWith('/')) ? 'XPath' : 'CSS',
            timestamp: Date.now()
        };
    }
    // Handle <input type="file"> (Upload)
    else if (tagName === 'input' && targetElement.type === 'file') {
        try {
            const files = Array.from(targetElement.files || []);
            const fileNames = files.map(f => (f && f.name) ? f.name : '').filter(Boolean);
            actionData = {
                type: 'Upload',
                selector: selector,
                value: fileNames.join(', '), // Display in side panel
                fileNames: fileNames,        // Extra metadata for generator
                fileCount: fileNames.length,
                selectorType: selector && (selector.startsWith('xpath=') || selector.startsWith('/')) ? 'XPath' : 'CSS',
                timestamp: Date.now()
            };
            // Also read the file contents to embed in export (so script can use a relative uploads folder)
            // Limit to reasonable count/size to avoid performance issues
            const MAX_FILES = 5;
            const toSend = files.slice(0, MAX_FILES);
            toSend.forEach((f) => {
                try {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const dataUrl = reader.result; // data:*;base64,....
                        if (typeof dataUrl === 'string') {
                            try { chrome.runtime.sendMessage({ command: 'upload_file', data: { name: f.name, dataUrl } }); } catch(e) {}
                        }
                    };
                    reader.onerror = () => { /* ignore */ };
                    reader.readAsDataURL(f);
                } catch(e) { /* ignore per-file */ }
            });
        } catch (e) {
            console.warn('handleChange: Failed to read files from input[type=file]:', e);
        }
    }
    // Handle <input type="checkbox">
    else if (tagName === 'input' && targetElement.type === 'checkbox') {
        actionData = {
            type: 'Checkbox',
            selector: selector,
            value: targetElement.checked, // The final state (true/false)
            selectorType: selector && (selector.startsWith('xpath=') || selector.startsWith('/')) ? 'XPath' : 'CSS',
            timestamp: Date.now()
        };
    }
     // Handle <input> (text-like) and <textarea> elements, including type="search"
     else if ((tagName === 'input' && (/text|password|search|email|url|tel|number/.test(targetElement.type) || targetElement.type === 'search')) || tagName === 'textarea') {
        actionData = {
            type: 'Input',
            selector: selector,
            value: targetElement.value,
            inputType: targetElement.type,
            selectorType: selector && (selector.startsWith('xpath=') || selector.startsWith('/')) ? 'XPath' : 'CSS',
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

/**
 * Handles real-time input events for search inputs to ensure they are captured (change may not always fire).
 * Debounce will still occur in background for non-XPath selectors; for search we force XPath so it's immediate.
 */
function handleInputEvent(event) {
    try {
        const el = event.target;
        if (!(el instanceof Element)) return;
        if (el.tagName.toLowerCase() !== 'input') return; // only inputs
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (type !== 'search') return; // restrict to search inputs to avoid noise
        // Only capture Ant Design Select search input to avoid changing behavior of other combos
        const isAntdSearch = (
            (el.classList && el.classList.contains('ant-select-selection-search-input')) ||
            (typeof el.id === 'string' && /^rc_select_/i.test(el.id)) ||
            (typeof el.getAttribute === 'function' && /^rc_select_/i.test(el.getAttribute('aria-controls') || ''))
        );
        if (!isAntdSearch) return;
    const selector = generateRobustSelector(el);
        if (!selector) return;
        const action = {
            type: 'Input',
            selector,
            value: el.value,
            inputType: type,
            selectorType: selector.startsWith('xpath=') || selector.startsWith('/') ? 'XPath' : 'CSS',
            timestamp: Date.now()
        };
        chrome.runtime.sendMessage({ command: 'record_action', data: action }).catch(()=>{});
    } catch(e) { /* ignore */ }
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
    // Additional listener for immediate capture of search input typing
    document.addEventListener('input', handleInputEvent, true);
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
    document.removeEventListener('input', handleInputEvent, true);
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
        const pageUrl = (typeof location !== 'undefined' && location.href) ? location.href : null;
        sendResponse({ success: true, html: htmlContent, url: pageUrl });
        return true; // Indicate async response
    }

    if (message.command === 'check_selector_exists') {
        try {
            const selector = message.selector || '';
            if (!selector) { sendResponse({ exists: false }); return true; }
            let exists = false;
            try {
                let expr = null;
                if (selector.startsWith('xpath=')) expr = selector.slice(6);
                else if (selector.startsWith('/')) expr = selector; // raw absolute or // relative XPath
                if (expr) {
                    const res = document.evaluate(expr, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    exists = !!res && !!res.singleNodeValue;
                } else {
                    exists = !!document.querySelector(selector);
                }
            } catch (e) {
                exists = false;
            }
            sendResponse({ exists });
        } catch (e) {
            sendResponse({ exists: false, message: e && e.message ? e.message : String(e) });
        }
        return true;
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

