/**
 * content.js
 * 注入到頁面（Page）的腳本，用於錄製使用者互動。
 * 監聽頁面上的事件（click、change、input 等），並將資訊送回背景腳本。
 * 也負責處理擷取 HTML 的請求。
 * 選擇器策略（Selector Strategy）：
 *   ID -> Attributes -> Stable Classes -> Structure -> Text XPath -> Absolute XPath -> Tag Name。
 */

console.log("Selenium Recorder: Content script injected (v13 - improved class selectors)."); // 版本訊息（方便除錯）

// --- Inject API interceptor into page context (fetch + XHR) ---
(function injectApiInterceptor() { // 攔截 fetch/XHR，將 API 進出資訊轉送到背景
    function serializeBody(body) { // 將 request body 轉為可記錄字串
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

    const __origFetch = window.fetch; // 保留原生 fetch
    window.fetch = async function (input, init) {
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
            } catch (e) { parsed = null; }
            window.postMessage({ // 將 API 結果以 postMessage 方式丟回 content script
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

    const __origXhr = window.XMLHttpRequest; // 保留原生 XHR
    function ProxyXHR() {
        const xhr = new __origXhr();
        let _url = null;
        let _method = null;
        let _requestBody = null;
        const origOpen = xhr.open;
        const origSend = xhr.send;
        xhr.open = function (method, url) {
            _method = method;
            _url = url;
            return origOpen.apply(xhr, arguments);
        };
        xhr.send = function (body) {
            _requestBody = serializeBody(body);
            this.addEventListener('readystatechange', function () {
                if (this.readyState === 4) {
                    let responseText = null;
                    try { responseText = this.responseText; } catch (e) { responseText = `[failed to read: ${e.message}]`; }
                    let parsed = null;
                    try {
                        const ct = this.getResponseHeader && this.getResponseHeader('content-type');
                        if (ct && ct.includes('application/json')) parsed = JSON.parse(responseText);
                    } catch (e) { parsed = null; }
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
    try { window.XMLHttpRequest = ProxyXHR; } catch (e) { /* 某些頁面可能禁止覆寫 */ }
})();

// --- Inject dialog (alert/prompt/confirm) capture ---
(function injectDialogHooks() { // 攔截 alert/confirm/prompt 以便錄製對話框事件
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
    document.documentElement.appendChild(script); // 以 <script> 注入至頁面 context
    script.remove();
})();

// --- State ---
let isListenerAttached = false; // 是否已綁定事件監聽
let clickTimeout = null; // 用於防抖快速點擊
let isComposingIME = false; // 是否處於輸入法組字中（IME），避免記錄中間值

// --- Helper Functions ---

/**
 * Generates an Absolute XPath for a given element.
 * @param {Element} element The target HTML element.
 * @returns {string|null} The absolute XPath string or null if input is invalid.
 */
function generateAbsoluteXPath(element) { // 產生絕對 XPath（最終備援）
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
        while (sibling) {
            if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === currentElement.nodeName) {
                hasSimilarSiblings = true;
                break;
            }
            sibling = sibling.nextSibling;
        }
        if (index === 0) {
            sibling = currentElement.previousSibling;
            while (sibling) {
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
function xpathLiteral(s) { // 安全包裝字串為 XPath 字面值（處理引號）
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
function trimNonInteractiveXPathTail(xp) { // 修剪 XPath 尾端非互動節點（如 svg/path）
    try {
        if (!xp || typeof xp !== 'string') return xp;
        let out = xp;
        for (let i = 0; i < 2; i++) { // trim up to two levels just in case '/span/svg'
            const next = out.replace(/\/(?:svg|path)(?:\[\d+\])?$/i, '');
            if (next === out) break;
            out = next;
        }
        return out;
    } catch (e) { return xp; }
}

// Detect very weak selectors we should avoid using
function isWeakSelector(sel) { // 判斷是否為非常脆弱的選擇器（避免）
    try {
        if (!sel || typeof sel !== 'string') return true;
        // Absolute body-level anchors like '/html/body/a' (optionally with index)
        if (/^\/html\/body\/a(?:\[\d+\])?$/i.test(sel)) return true;
        // Bare nth-child on anchor without attributes/classes (e.g., 'a:nth-child(8)')
        if (/^a\:nth-child\(\d+\)$/i.test(sel)) return true;
        return false;
    } catch (e) { return false; }
}

/**
 * Generate selector for drag operations - prefers ID-based selectors
 * @param {Element} el The element for which to generate a selector.
 * @returns {string|null} A selector string prioritizing IDs.
 */
function generateDragSelector(el) {
    if (!(el instanceof Element)) return null;

    const tagName = el.nodeName.toLowerCase();

    // 1. 優先使用 data-dnd-kit-id 屬性
    const dndKitId = el.getAttribute('data-dnd-kit-id');
    if (dndKitId) {
        const selector = `[data-dnd-kit-id="${CSS.escape(dndKitId)}"]`;
        try {
            if (document.querySelectorAll(selector).length === 1) {
                console.log(`✅ DND-Kit ID選擇器: ${selector}`);
                return selector;
            }
        } catch (e) { /* ignore */ }
    }

    // 2. 使用 data-dnd-kit-droppable 屬性（對於droppable容器）
    const dndKitDroppable = el.getAttribute('data-dnd-kit-droppable');
    if (dndKitDroppable) {
        const selector = `[data-dnd-kit-droppable="${CSS.escape(dndKitDroppable)}"]`;
        try {
            if (document.querySelectorAll(selector).length === 1) {
                console.log(`✅ DND-Kit Droppable選擇器: ${selector}`);
                return selector;
            }
        } catch (e) { /* ignore */ }
    }

    // 3. 使用 data-dnd-kit-drop-zone 屬性
    const dndKitDropZone = el.getAttribute('data-dnd-kit-drop-zone');
    if (dndKitDropZone) {
        const selector = `[data-dnd-kit-drop-zone="${CSS.escape(dndKitDropZone)}"]`;
        try {
            if (document.querySelectorAll(selector).length === 1) {
                console.log(`✅ DND-Kit Drop Zone選擇器: ${selector}`);
                return selector;
            }
        } catch (e) { /* ignore */ }
    }

    // 4. 使用普通 id 屬性
    if (el.id) {
        const id = el.id;
        // 放寬穩定ID的條件，只排除明顯的框架生成ID
        const unstableIdRegex = /^(?:radix-|ember-|data-v-|svelte-|ui-id-|aria-|temp-|auto-|react-)/i;
        const looksUnstable = unstableIdRegex.test(id) || id.length > 80 || /^\d+$/.test(id);

        if (!looksUnstable) {
            const selector = `#${CSS.escape(id)}`;
            try {
                if (document.querySelectorAll(selector).length === 1) {
                    console.log(`✅ 拖拽ID選擇器: ${selector}`);
                    return selector;
                }
            } catch (e) { /* ignore */ }
        }
    }

    // 5. 檢查父元素是否有合適的屬性
    let parent = el.parentElement;
    while (parent && parent !== document.body) {
        // 檢查父元素的droppable屬性
        const parentDroppable = parent.getAttribute('data-dnd-kit-droppable');
        if (parentDroppable) {
            const selector = `[data-dnd-kit-droppable="${CSS.escape(parentDroppable)}"]`;
            try {
                if (document.querySelectorAll(selector).length === 1) {
                    console.log(`✅ 父元素Droppable選擇器: ${selector}`);
                    return selector;
                }
            } catch (e) { /* ignore */ }
        }

        // 檢查父元素的ID
        if (parent.id && !parent.id.match(/^(?:radix-|ember-|data-v-)/i)) {
            // 如果父元素有穩定ID，使用子選擇器
            const parentSelector = `#${CSS.escape(parent.id)}`;
            const childSelector = `${parentSelector} ${tagName}`;
            try {
                if (document.querySelectorAll(childSelector).length === 1) {
                    console.log(`✅ 子選擇器: ${childSelector}`);
                    return childSelector;
                }
                // 如果有多個同類型子元素，使用nth-child
                const siblings = parent.querySelectorAll(tagName);
                if (siblings.length > 1) {
                    for (let i = 0; i < siblings.length; i++) {
                        if (siblings[i] === el) {
                            const nthSelector = `${parentSelector} ${tagName}:nth-child(${i + 1})`;
                            console.log(`✅ nth-child選擇器: ${nthSelector}`);
                            return nthSelector;
                        }
                    }
                }
            } catch (e) { /* ignore */ }
        }
        parent = parent.parentElement;
    }

    // 6. 退back到普通的robust selector
    console.log(`⚠️ 拖拽選擇器退回到普通選擇器`);
    return generateRobustSelector(el);
}


/**
 * Generates a CSS or XPath selector for a given HTML element.
 * Prioritization: ID -> Name -> data-testid -> role -> title -> Combined Class + Structure -> Text XPath -> Absolute XPath -> Basic TagName.
 * Returns XPath selectors (now WITHOUT the historical 'xpath=' prefix; backward compatible handling kept elsewhere).
 * @param {Element} el The target HTML element.
 * @returns {string|null} A selector string (CSS or XPath) or null.
 */
function generateRobustSelector(el) { // 生成較穩健的選擇器（優先考慮穩定屬性/類名，再退回 XPath）
    if (!(el instanceof Element)) return null;
    const originalEl = el;
    // If target is an icon or non-interactive, promote to closest clickable ancestor
    let promotedToAncestor = false;
    try {
        const nonInteractiveTags = ['svg', 'path', 'i', 'span'];
        const initialTag = el.tagName ? el.tagName.toLowerCase() : '';
        if (nonInteractiveTags.includes(initialTag)) {
            const ancestor = el.closest('button, a[href], [role="button"], .ant-btn, [onclick], [tabindex]:not([tabindex="-1"])');
            if (ancestor && ancestor !== el) { el = ancestor; promotedToAncestor = true; }
        }
    } catch (e) { /* ignore */ }
    const tagName = el.tagName.toLowerCase();
    // 特例：Ant Design Select 搜尋輸入，優先選擇可見的 combobox 外層（wrapper）
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
            // 特例：許多 UI 套件（MUI Autocomplete, react-select）內部藏有極窄的輸入框
            // 當 aria-autocomplete 為 list/both 且 input 宽度極小時，優先抓可見 wrapper
            try {
                const ariaAuto = (el.getAttribute('aria-autocomplete') || '').toLowerCase();
                if (ariaAuto === 'list' || ariaAuto === 'both') {
                    let widthPx = 0;
                    try { widthPx = (el.getBoundingClientRect && el.getBoundingClientRect().width) || 0; } catch (e) { }
                    if (!widthPx) {
                        try {
                            const cs = getComputedStyle(el);
                            widthPx = parseFloat((cs && cs.width) ? cs.width.replace('px', '') : '0') || 0;
                        } catch (e) { /* ignore */ }
                    }
                    if (!widthPx) {
                        try {
                            const m = (el.getAttribute('style') || '').match(/width\s*:\s*(\d+(?:\.\d+)?)px/i);
                            if (m) widthPx = parseFloat(m[1]);
                        } catch (e) { /* ignore */ }
                    }
                    if (widthPx > 0 && widthPx <= 6) {
                        const combo = el.closest('[role="combobox"], [aria-haspopup="listbox"], [class*="__control"], [class*="__value-container"], .MuiAutocomplete-root, .react-select__control, [class*="auto-complete"]');
                        if (combo && combo !== el && combo instanceof Element) {
                            const comboAbs = generateAbsoluteXPath(combo);
                            if (comboAbs) return comboAbs;
                        }
                    }
                }
            } catch (e) { /* ignore tiny autocomplete handling */ }
        }
    } catch (e) { /* ignore */ }
    // console.log(`generateRobustSelector: Finding selector for <${tagName}>`, el); // Optional debug

    // --- 屬性選擇器（CSS） ---

    // 1. ID（若穩定且唯一，首選）
    if (el.id) {
        const id = el.id;
        // 放寬穩定ID的條件，只排除明顯的框架生成ID
        const unstableIdRegex = /^(?:radix-|ember-|data-v-|svelte-|ui-id-|aria-|temp-|auto-|react-)/i;
        const looksUnstable = unstableIdRegex.test(id) || id.length > 80 || /^\d+$/.test(id);
        if (!looksUnstable) {
            try {
                const cssSelector = `#${CSS.escape(id)}`;
                if (document.querySelectorAll(cssSelector).length === 1) {
                    console.log(`✅ 使用穩定ID選擇器: ${cssSelector}`);
                    return cssSelector;
                }
            } catch (e) { /* ignore */ }

            // XPath版本作為備選
            try {
                const xpathSelector = `//*[@id="${id}"]`;
                if (document.evaluate(xpathSelector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength === 1) {
                    console.log(`✅ 使用ID XPath選擇器: ${xpathSelector}`);
                    return xpathSelector;
                }
            } catch (e) { /* ignore */ }

            const idAttrSelector = `${tagName}[id="${CSS.escape(id)}"]`;
            try {
                if (document.querySelectorAll(idAttrSelector).length === 1) return idAttrSelector;
            } catch (e) { /* ignore */ }
        } else {
            console.warn(`generateRobustSelector: Skipping potentially unstable ID '${id}'.`);
        }
    }

    // 2. Name（常見於表單欄位）
    if (el.name) {
        const name = el.name;
        const selector = `${tagName}[name="${CSS.escape(name)}"]`;
        try {
            if (document.querySelectorAll(selector).length === 1) return selector;
        } catch (e) { /* ignore */ }
    }

    // 3. data-testid（測試用屬性，通常穩定）
    const testId = el.getAttribute('data-testid');
    if (testId) {
        const selector = `${tagName}[data-testid="${CSS.escape(testId)}"]`;
        try {
            if (document.querySelectorAll(selector).length === 1) return selector;
        } catch (e) { /* ignore */ }
    }

    // 4. data-dnd-kit-id（DND-Kit拖拽庫的穩定ID）
    const dndKitId = el.getAttribute('data-dnd-kit-id');
    if (dndKitId) {
        // 優先返回CSS選擇器
        const cssSelector = `[data-dnd-kit-id="${CSS.escape(dndKitId)}"]`;
        try {
            if (document.querySelectorAll(cssSelector).length === 1) return cssSelector;
        } catch (e) { /* ignore */ }

        // 也提供XPath版本作為備選
        const xpathSelector = `//div[@data-dnd-kit-id="${dndKitId}"]`;
        try {
            if (document.evaluate(xpathSelector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength === 1) {
                console.log(`DND-Kit XPath選擇器: ${xpathSelector}`);
                return xpathSelector;
            }
        } catch (e) { /* ignore */ }
    }

    // 5. role（ARIA 角色）
    const role = el.getAttribute('role');
    if (role && role !== 'presentation' && role !== 'none' && role !== 'document' && role !== 'main') {
        const selector = `${tagName}[role="${CSS.escape(role)}"]`;
        try {
            if (document.querySelectorAll(selector).length === 1) return selector;
        } catch (e) { /* ignore */ }
    }

    // 6. title（提示文字）
    const title = el.getAttribute('title');
    if (title) {
        const selector = `${tagName}[title="${CSS.escape(title)}"]`;
        try {
            if (document.querySelectorAll(selector).length === 1) return selector;
        } catch (e) { /* ignore */ }
    }

    // 7. 超連結專屬：優先 href/title/aria-label
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
        } catch (e) { /* ignore */ }
    }

    // 8. 合併穩定 class 與結構（nth-of-type 等）
    let baseSelector = tagName;
    if (el.classList && el.classList.length > 0) {
        const forbiddenClassesRegex = /^(?:active|focus|hover|selected|checked|disabled|visited|focus-within|focus-visible|focusNow|open|opened|closed|collapsed|expanded|js-|ng-|is-|has-|ui-|data-v-|aria-|css-)/i;
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
    } catch (e) { console.warn("Error during combined class/structure selector generation:", e) }


    // 6.5 若提升至可點擊祖先，嘗試祖先-後代關聯 XPath（例如內含 title/aria 的圖示）
    try {
        if (promotedToAncestor && originalEl && originalEl !== el) {
            const clickTag = tagName; // ancestor tag name lower-cased
            const origTitle = originalEl.getAttribute && originalEl.getAttribute('title');
            const origAria = originalEl.getAttribute && originalEl.getAttribute('aria-label');
            const origDataIcon = originalEl.getAttribute && originalEl.getAttribute('data-icon');
            const origHasAntIcon = originalEl.classList && originalEl.classList.contains('anticon-download');
            function evalUniqueXPath(xpath) {
                try { return document.evaluate(`count(${xpath})`, document, null, XPathResult.NUMBER_TYPE, null).numberValue === 1; } catch (e) { return false; }
            }
            function buildAndReturn(xpath) { if (evalUniqueXPath(xpath)) return xpath; return null; }
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
    } catch (e) { /* ignore ancestor-descendant xpath fallback errors */ }

    // 最後一搏：避免回傳過度脆弱的 a/button nth-child
    try {
        if ((tagName === 'a' || tagName === 'button') && baseSelector && /\:nth-child\(\d+\)/.test(baseSelector)) {
            const abs = generateAbsoluteXPath(el);
            if (abs) return abs;
        }
    } catch (e) { /* ignore */ }


    // 8. 文字內容 XPath（備援）
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

    // 9. 絕對 XPath 備援
    try {
        let absXPath = generateAbsoluteXPath(el);
        if (absXPath) {
            console.warn(`generateRobustSelector: Falling back to Absolute XPath for element:`, el);
            return trimNonInteractiveXPathTail(absXPath);
        } else {
            console.error("generateRobustSelector: generateAbsoluteXPath returned null.");
        }
    } catch (e) { console.warn("Error during Absolute XPath generation:", e) }


    // 10. 最終備援：僅用 tagName（極不建議，僅在完全失敗時使用）
    console.error(`generateRobustSelector: CRITICAL FALLBACK to basic tag name for element:`, el);
    return tagName;
}


/**
 * Extracts relevant information from an element for selector generation.
 * @param {Element} element
 * @returns {object} Simplified info { tagName, id, name, className }
 */
function getElementInfo(element) { // 提取元素基本資訊（用於 UI 顯示與除錯）
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
function getClosestAnchorSelector(el) { // 嘗試找到最近的 a 標籤並產生選擇器
    try {
        console.log("getClosestAnchorSelector: Finding closest anchor for element:", el); // Optional debug
        if (!el || !(el instanceof Element)) return null;
        const anchor = el.closest('a');
        if (!anchor) return null;
        const abs = generateAbsoluteXPath(anchor);
        return abs ? trimNonInteractiveXPathTail(abs) : null;
    } catch (e) {
        return null;
    }
}

// --- Event Handlers ---

/**
 * Handles click events on the page. Debounces rapid clicks to capture only the most specific one.
 * @param {Event} event
 */
//function handleClick(event) { // 處理點擊事件；若命中 icon/svg 會往上找可點擊祖先
function handleClick(event) { // 處理點擊事件；若命中 icon/svg 會往上找可點擊祖先（使用絕對 XPath）
    try {
        const rawTarget = event.target;
        if (!rawTarget) return;

        const clickableAncestor = rawTarget.closest && rawTarget.closest('button, a[href], [role="button"], .ant-btn, [onclick], [tabindex]:not([tabindex="-1"]), [role="combobox"], [aria-haspopup="listbox"], [class*="__control"], [class*="__value-container"], [class*="auto-complete"]');
        const anchorEl = clickableAncestor ? (clickableAncestor.closest && clickableAncestor.closest('a')) : (rawTarget.closest ? rawTarget.closest('a') : null);
        const targetForSelector = clickableAncestor || anchorEl || rawTarget;
        // 一律採用『目標元素』的絕對 XPath（必要時修剪 svg/path 尾端）
        let selector = null;
        try {
            const abs = generateAbsoluteXPath(targetForSelector);
            selector = abs ? trimNonInteractiveXPathTail(abs) : null;
            console.log(`Content: Generated click selector for element:`, targetForSelector, `selector: ${selector}`);
        } catch (e) { selector = null; }
        if (!selector) return; // 無法產生 XPath 就略過
        const anchorSelector = anchorEl ? (function () { const a = generateAbsoluteXPath(anchorEl); return a ? trimNonInteractiveXPathTail(a) : null; })() : null;

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

        // 若 inline onclick 含 popupWindow('...')，嘗試解析 URL 提早通知背景頁
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
function handleChange(event) { // 監聽 change：處理 select / file / checkbox（使用絕對 XPath；文字輸入改由 input 事件處理）
    const targetElement = event.target;
    const tagName = targetElement.tagName.toLowerCase();
    let actionData = null;

    // console.log(`handleChange: Detected change on <${tagName}>`, targetElement); // Optional debug
    let selector = null;
    try {
        const abs = generateAbsoluteXPath(targetElement);
        selector = abs ? trimNonInteractiveXPathTail(abs) : null;
    } catch (e) { selector = null; }
    if (!selector) {
        console.warn(`handleChange: Could not generate selector for <${tagName}> element:`, targetElement);
        return;
    }

    // <select>：記錄被選取的值
    if (tagName === 'select') {
        actionData = {
            type: 'Select',
            selector: selector,
            value: targetElement.value,
            selectorType: 'XPath',
            timestamp: Date.now()
        };
    }
    // <input type="range">（滑桿）：記錄最終值（水平/垂直皆可；此處主要處理水平滑桿）
    else if (tagName === 'input' && targetElement.type === 'range') {
        try {
            const currentValue = targetElement.value;
            const min = targetElement.getAttribute('min');
            const max = targetElement.getAttribute('max');
            const step = targetElement.getAttribute('step');
            actionData = {
                type: 'Slider',
                selector: selector,
                value: String(targetElement.value),
                min: (min != null ? String(min) : null),
                max: (max != null ? String(max) : null),
                step: (step != null ? String(step) : null),
                sliderKind: 'native', // 原生 input[type=range]
                selectorType: 'XPath',
                timestamp: Date.now()
            };
        } catch (e) {
            console.warn('handleChange: Failed to collect input[type=range] data:', e);
        }
    }
    // <input type="file">（上傳）：讀檔案名稱，並嘗試將檔案嵌入 zip
    else if (tagName === 'input' && targetElement.type === 'file') {
        try {
            const files = Array.from(targetElement.files || []);
            const fileNames = files.map(f => (f && f.name) ? f.name : '').filter(Boolean);
            actionData = {
                type: 'Upload',
                method: 'click', // Distinguish from drag-drop file upload
                selector: selector,
                value: fileNames.join(', '), // Display in side panel
                fileNames: fileNames,        // Extra metadata for generator
                fileCount: fileNames.length,
                selectorType: 'XPath',
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
                            try { chrome.runtime.sendMessage({ command: 'upload_file', data: { name: f.name, dataUrl } }); } catch (e) { }
                        }
                    };
                    reader.onerror = () => { /* ignore */ };
                    reader.readAsDataURL(f);
                } catch (e) { /* ignore per-file */ }
            });
        } catch (e) {
            console.warn('handleChange: Failed to read files from input[type=file]:', e);
        }
    }
    // <input type="checkbox">：記錄最終勾選狀態
    else if (tagName === 'input' && targetElement.type === 'checkbox') {
        actionData = {
            type: 'Checkbox',
            selector: selector,
            value: targetElement.checked, // The final state (true/false)
            selectorType: 'XPath',
            timestamp: Date.now()
        };
    }
    // <input type="radio">：記錄單選按鈕選中狀態
    else if (tagName === 'input' && targetElement.type === 'radio') {
        actionData = {
            type: 'Radio',
            selector: selector,
            value: targetElement.checked, // Should be true when selected
            radioValue: targetElement.value, // The value attribute of the radio button
            radioName: targetElement.name,   // The name attribute (group identifier)
            selectorType: 'XPath',
            timestamp: Date.now()
        };
    }
    // 注意：一般文字輸入不在 change 事件記錄，避免重複；改由下方 input 事件即時處理。

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

// 自訂元件滑桿（role="slider"）：在放開滑動（pointerup/mouseup）時記錄當前值
function handleSliderPointerUp(event) { // 處理自訂 ARIA 滑桿（常見於 UI 套件）
    try {
        const el = event.target && event.target.closest ? event.target.closest('[role="slider"]') : null;
        if (!el) return;
        // 僅在元素在視窗中可見且可互動時記錄（簡單檢查）
        try {
            const rect = el.getBoundingClientRect();
            if (!rect || rect.width === 0 || rect.height === 0) { /* invisible */ }
        } catch (e) { /* ignore */ }

        let selector = null;
        try { selector = generateAbsoluteXPath(el); } catch (e) { selector = null; }
        if (!selector) return;

        const ariaNow = el.getAttribute('aria-valuenow');
        const ariaMin = el.getAttribute('aria-valuemin');
        const ariaMax = el.getAttribute('aria-valuemax');
        const ariaStep = el.getAttribute('aria-valuestep');
        const displayVal = (ariaNow != null ? String(ariaNow) : (el.textContent || '').trim());
        const action = {
            type: 'Slider',
            selector,
            value: displayVal,
            min: (ariaMin != null ? String(ariaMin) : null),
            max: (ariaMax != null ? String(ariaMax) : null),
            step: (ariaStep != null ? String(ariaStep) : null),
            sliderKind: 'aria', // 自訂 ARIA 滑桿
            selectorType: 'XPath',
            timestamp: Date.now()
        };
        chrome.runtime.sendMessage({ command: 'record_action', data: action }).catch(() => { });
    } catch (e) {
        // ignore
    }
}

/**
 * Handles real-time input events for autocomplete inputs only.
 * Regular inputs will be handled by blur/outfocus events instead.
 */
function handleInputEvent(event) { // 只處理自動完成輸入框的即時輸入，普通輸入框改用 blur 事件
    try {
        const el = event.target;
        if (!(el instanceof Element)) return;
        // If user is composing with IME, skip intermediate input events to avoid noisy partial values
        if (isComposingIME) return;
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        const isTextLikeInput = (tag === 'input' && (/^(text|password|search|email|url|tel|number)$/i.test(type))) || (tag === 'textarea');
        if (!isTextLikeInput) return;

        // 檢查是否為自動完成輸入框
        const isAutocomplete = isAutocompleteInput(el);

        // 如果不是自動完成輸入框，則不記錄即時輸入
        if (!isAutocomplete) {
            console.log('[Input] Skipping non-autocomplete input:', el, 'type:', type, 'tag:', tag);
            return;
        }

        console.log('[Input] Processing autocomplete input:', el);

        // 若為極小的 autocomplete 內部 input，優先使用外層 wrapper 的 XPath；否則用自身的絕對 XPath
        let selector = null;
        if (tag === 'input') {
            try {
                const ariaAuto = (el.getAttribute('aria-autocomplete') || '').toLowerCase();
                let widthPx = 0;
                try { widthPx = (el.getBoundingClientRect && el.getBoundingClientRect().width) || 0; } catch (e) { }
                if (!widthPx) {
                    try { const cs = getComputedStyle(el); widthPx = parseFloat((cs && cs.width) ? cs.width.replace('px', '') : '0') || 0; } catch (e) { }
                }
                if ((ariaAuto === 'list' || ariaAuto === 'both') && widthPx > 0 && widthPx <= 6) {
                    const wrapper = el.closest('[role="combobox"], [aria-haspopup="listbox"], [class*="__control"], [class*="__value-container"], .MuiAutocomplete-root, .react-select__control, [class*="auto-complete"]');
                    if (wrapper && wrapper instanceof Element) {
                        selector = generateAbsoluteXPath(wrapper);
                    }
                }
            } catch (e) { /* ignore */ }
        }
        if (!selector) {
            selector = generateAbsoluteXPath(el);
        }
        if (!selector) return;

        const action = { // 傳給背景頁，請其以 debounce 方式整合最終值
            type: 'Input',
            selector,          // Absolute XPath or wrapper XPath
            value: (el.value != null ? String(el.value) : ''),
            inputType: type || tag,
            selectorType: 'XPath',
            forceDebounce: true,   // Ask background to debounce so we capture after user finishes typing
            timestamp: Date.now(),
            source: 'autocomplete-input' // 標記來源以便調試
        };
        console.log('[Input] Recording autocomplete input action:', action);
        chrome.runtime.sendMessage({ command: 'record_action', data: action }).catch(() => { });
    } catch (e) { /* ignore */ }
}

/**
 * Checks if an input element is an autocomplete/search input
 * @param {Element} el The input element to check
 * @returns {boolean} True if it's an autocomplete input
 */
function isAutocompleteInput(el) { // 判斷是否為自動完成輸入框
    try {
        if (!(el instanceof Element)) return false;

        // 檢查 aria-autocomplete 屬性 (最可靠的指標)
        const ariaAuto = (el.getAttribute('aria-autocomplete') || '').toLowerCase();
        if (ariaAuto === 'list' || ariaAuto === 'both') return true;

        // 檢查 role 屬性
        const role = (el.getAttribute('role') || '').toLowerCase();
        if (role === 'combobox') return true;

        // 檢查 type 屬性 - 只有明確的 search 類型才算
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (type === 'search') {
            // 進一步檢查是否有相關的容器或屬性
            const hasRelatedAttrs = el.hasAttribute('aria-controls') ||
                el.hasAttribute('aria-expanded') ||
                el.closest('[class*="select"], [class*="autocomplete"], [class*="combobox"]');
            if (hasRelatedAttrs) return true;
        }

        // 檢查 class 名稱 - 只有非常明確的模式才算
        const className = el.className || '';
        if (/(?:ant-select.*input|react-select.*input|autocomplete.*input|combobox.*input)/i.test(className)) return true;

        // 檢查是否有 aria-haspopup 屬性
        const hasPopup = el.getAttribute('aria-haspopup');
        if (hasPopup === 'listbox' || hasPopup === 'menu') return true;

        return false;
    } catch (e) {
        return false;
    }
}

/**
 * Handles blur events for regular input fields to record final value
 * @param {Event} event
 */
function handleBlurEvent(event) { // 處理普通輸入框的 blur 事件，記錄最終值
    try {
        const el = event.target;
        if (!(el instanceof Element)) return;

        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        const isTextLikeInput = (tag === 'input' && (/^(text|password|email|url|tel|number)$/i.test(type))) || (tag === 'textarea');

        if (!isTextLikeInput) return;

        // 如果是自動完成輸入框，則不在此處理（已在 input 事件中處理）
        if (isAutocompleteInput(el)) {
            console.log('[Input] Skipping blur for autocomplete input:', el);
            return;
        }

        // 獲取元素的絕對 XPath
        let selector = null;
        try {
            selector = generateAbsoluteXPath(el);
        } catch (e) {
            selector = null;
        }
        if (!selector) return;

        // 防止空值或極短值的無意義記錄
        const value = el.value != null ? String(el.value) : '';
        if (value.length === 0) {
            console.log('[Input] Skipping empty input value');
            return;
        }

        const action = {
            type: 'Input',
            selector,
            value: value,
            inputType: type || tag,
            selectorType: 'XPath',
            timestamp: Date.now(),
            source: 'blur' // 標記來源以便調試
        };
        console.log('[Input] Recording blur input action:', action);
        chrome.runtime.sendMessage({ command: 'record_action', data: action }).catch(() => { });
    } catch (e) {
        console.warn('handleBlurEvent error:', e);
    }
}

// Handle IME composition: start -> suppress input events; end -> send one final value
function handleCompositionStart(event) { // IME 組字開始：標記狀態，暫停記錄中間 input
    try {
        const el = event.target;
        if (!(el instanceof Element)) return;
        isComposingIME = true;
    } catch (e) { /* ignore */ }
}

function handleCompositionEnd(event) { // IME 組字結束：送出最後一次的最終值
    try {
        const el = event.target;
        if (!(el instanceof Element)) { isComposingIME = false; return; }
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        const isTextLikeInput = (tag === 'input' && (/^(text|password|search|email|url|tel|number)$/i.test(type))) || (tag === 'textarea');
        if (!isTextLikeInput) { isComposingIME = false; return; }

        // 檢查是否為自動完成輸入框
        const isAutocomplete = isAutocompleteInput(el);

        // 只有自動完成輸入框才在組字結束時記錄，普通輸入框在blur時記錄
        if (!isAutocomplete) {
            console.log('[IME] Skipping composition end for non-autocomplete input:', el);
            isComposingIME = false;
            return;
        }

        console.log('[IME] Processing composition end for autocomplete input:', el);

        // 自動完成輸入框使用 debounce，普通輸入框直接記錄
        let selector = null;
        if (isAutocomplete && tag === 'input') {
            try {
                const ariaAuto = (el.getAttribute('aria-autocomplete') || '').toLowerCase();
                let widthPx = 0;
                try { widthPx = (el.getBoundingClientRect && el.getBoundingClientRect().width) || 0; } catch (e) { }
                if (!widthPx) {
                    try { const cs = getComputedStyle(el); widthPx = parseFloat((cs && cs.width) ? cs.width.replace('px', '') : '0') || 0; } catch (e) { }
                }
                if ((ariaAuto === 'list' || ariaAuto === 'both') && widthPx > 0 && widthPx <= 6) {
                    const wrapper = el.closest('[role="combobox"], [aria-haspopup="listbox"], [class*="__control"], [class*="__value-container"], .MuiAutocomplete-root, .react-select__control, [class*="auto-complete"]');
                    if (wrapper && wrapper instanceof Element) {
                        selector = generateAbsoluteXPath(wrapper);
                    }
                }
            } catch (e) { /* ignore */ }
        }
        if (!selector) selector = generateAbsoluteXPath(el);

        if (selector) {
            const action = {
                type: 'Input',
                selector,
                value: (el.value != null ? String(el.value) : ''),
                inputType: type || tag,
                selectorType: 'XPath',
                forceDebounce: isAutocomplete, // 只有自動完成輸入框才使用 debounce
                timestamp: Date.now(),
                source: 'composition-end' // 標記來源以便調試
            };
            console.log('[IME] Recording composition end input action:', action);
            chrome.runtime.sendMessage({ command: 'record_action', data: action }).catch(() => { });
        }
    } catch (e) { /* ignore */ }
    finally { isComposingIME = false; }
}

// content script: receive page -> forward API data to background
window.addEventListener('message', (event) => { // 轉送 API 攔截資訊給背景頁
    if (!event.data || !event.data.__SELBAS_RECORDER_API__) return;
    try {
        chrome.runtime.sendMessage({ command: 'api_response', data: event.data });
    } catch (e) {
        console.warn("Content: failed to forward API data to background", e);
    }
});

// Forward dialog events
window.addEventListener('message', (event) => { // 轉送對話框事件給背景頁
    if (!event.data || !event.data.__SELBAS_RECORDER_DIALOG__) return;
    try { chrome.runtime.sendMessage({ command: 'dialog_event', data: event.data }); } catch (e) { }
});

// --- MutationObserver: detect newly added elements and notify background ---
let elementMutationObserver = null;   // 監聽新增節點
let mutationDebounceTimer = null;     // 去抖計時器
const MUTATION_DEBOUNCE_MS = 300;     // 批次間隔
const MAX_ELEMENTS_PER_BATCH = 20;    // 每批最多 20 個

//function serializeElementForNotification(el) { // 將新增元素序列化為輕量資訊
function serializeElementForNotification(el) { // 使用絕對 XPath，以保持一致
    try {
        return {
            selector: (function () { try { const a = generateAbsoluteXPath(el); return a ? trimNonInteractiveXPathTail(a) : null; } catch (e) { return null; } })(),
            info: getElementInfo(el),
            tagName: el.tagName ? el.tagName.toLowerCase() : null,
            text: (el.textContent || '').trim().slice(0, 200)
        };
    } catch (e) {
        return { selector: null, info: null, tagName: null, text: null };
    }
}

function handleMutations(mutationsList) { // 批次收集新增元素並通知背景
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
function attachListeners() { // 綁定各項事件監聽與 MutationObserver
    if (isListenerAttached) return;
    console.log("Attaching event listeners...");
    document.addEventListener('click', handleClick, true);
    document.addEventListener('change', handleChange, true); // Listen only to 'change' for inputs
    // Input event for autocomplete inputs only
    document.addEventListener('input', handleInputEvent, true);
    // Blur event for regular input fields to capture final values
    document.addEventListener('blur', handleBlurEvent, true);
    // Slider（自訂 role=slider）：在放開時記錄
    document.addEventListener('pointerup', handleSliderPointerUp, true);
    document.addEventListener('mouseup', handleSliderPointerUp, true);
    // IME composition handling to avoid noisy partial inputs
    document.addEventListener('compositionstart', handleCompositionStart, true);
    document.addEventListener('compositionend', handleCompositionEnd, true);
    // drag -g drop listenners
    document.addEventListener('dragstart', handleDragStart, true);
    document.addEventListener('dragenter', handleDragEnter, true);
    document.addEventListener('dragover', handleDragOver, true);
    document.addEventListener('dragleave', handleDragLeave, true);
    document.addEventListener('drop', handleDrop, true);
    document.addEventListener('dragend', handleDragEnd, true);
    // Synthetic drag detection listeners
    document.addEventListener('pointerdown', synthPointerDown, true);
    document.addEventListener('pointermove', synthPointerMove, true);
    document.addEventListener('pointerup', synthPointerUp, true);
    document.addEventListener('mouseleave', synthPointerUp, true);
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

function detachListeners() { // 移除事件監聽與觀察器
    if (!isListenerAttached) return;
    console.log("Detaching event listeners...");
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('change', handleChange, true);
    document.removeEventListener('input', handleInputEvent, true);
    document.removeEventListener('blur', handleBlurEvent, true);
    document.removeEventListener('pointerup', handleSliderPointerUp, true);
    document.removeEventListener('mouseup', handleSliderPointerUp, true);
    document.removeEventListener('compositionstart', handleCompositionStart, true);
    document.removeEventListener('compositionend', handleCompositionEnd, true);
    // Remove drag-and-drop listeners
    document.removeEventListener('dragstart', handleDragStart, true);
    document.removeEventListener('dragenter', handleDragEnter, true);
    document.removeEventListener('dragover', handleDragOver, true);
    document.removeEventListener('dragleave', handleDragLeave, true);
    document.removeEventListener('drop', handleDrop, true);
    document.removeEventListener('dragend', handleDragEnd, true);
    document.removeEventListener('pointerdown', synthPointerDown, true);
    document.removeEventListener('pointermove', synthPointerMove, true);
    document.removeEventListener('pointerup', synthPointerUp, true);
    document.removeEventListener('mouseleave', synthPointerUp, true);
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => { // 接收背景頁請求並回應（擷取 HTML、檢查選擇器等）
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
// Inject CSS for drag-and-drop file upload visual feedback
(function injectDragDropStyles() {
    try {
        const style = document.createElement('style');
        style.id = '__selbas_drag_drop_styles__';
        style.textContent = `
            .drag-over {
                outline: 2px dashed #007bff !important;
                outline-offset: -2px !important;
                background-color: rgba(0, 123, 255, 0.1) !important;
                transition: all 0.2s ease !important;
            }
            [data-drop-zone].drag-over,
            [class*="drop"].drag-over,
            [class*="upload"].drag-over,
            .upload-area.drag-over,
            .dropzone.drag-over,
            .file-drop.drag-over {
                outline-color: #28a745 !important;
                background-color: rgba(40, 167, 69, 0.1) !important;
            }
        `;
        document.head.appendChild(style);
        console.log('Selenium Recorder: Drag-drop styles injected');
    } catch (e) {
        console.warn('Failed to inject drag-drop styles:', e);
    }
})();

attachListeners(); // 預設啟用事件監聽


(function injectPopupWindowAndOpenHook() { // 注入 window.open 與 popupWindow 勾點，協助偵測新分頁/彈窗
    try {
        const script = document.createElement('script');
        script.textContent = '(' + function () {
            try {
                // Wrap window.open immediately
                const _origOpen = window.open;
                window.open = function (url, name, features) {
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
                            window.popupWindow = function () {
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
        (document.documentElement || document.head || document.body || document).appendChild(script); // 注入頁面 context
        script.parentNode && script.parentNode.removeChild(script);
    } catch (e) {
        console.warn("Content: Failed to inject popup/open hook:", e);
    }
})();

// --- Cleanup: remove any legacy injected screen recorder floating button (from older content.js) ---
(function removeLegacyScreenRecorder() { // 清理舊版本遺留的浮動螢幕錄影按鈕
    try {
        const legacy = document.getElementById('__selbas_screen_recorder_container');
        if (legacy) {
            legacy.remove();
            console.log('[Cleanup] Removed legacy screen recorder UI.'); // 記錄清理訊息
        }
    } catch (e) { /* ignore */ }
})();
/**
 * Handles dragstart events to capture the start of a drag action.
 * @param {Event} event
 */
function handleDragStart(event) {
    try {
        const rawTarget = event.target;
        if (!(rawTarget instanceof Element)) return;
        console.log('[DND][dragstart] raw target:', rawTarget);

        // Use DND-Kit enhancer if available for better detection
        let dndKitDetection = null;
        if (window.DND_KIT_ENHANCER) {
            dndKitDetection = window.DND_KIT_ENHANCER.enhancedDragStartDetection(event);
        }

        // Enhanced draggable detection for various drag libraries including dnd-kit
        const sourceEl = (dndKitDetection && dndKitDetection.element) ||
            rawTarget.closest('[role="button"][aria-roledescription="draggable"], [aria-roledescription="draggable"], [draggable="true"], [data-rbd-draggable-id], [data-dnd-kit-id], [data-sortable-id]') ||
            rawTarget.closest('[class*="draggable"], [class*="sortable"], [class*="dnd"], [class*="drag"]') || rawTarget;

        let sourceSelector = null;
        try {
            // 對於拖拽操作，優先使用ID選擇器
            sourceSelector = generateDragSelector(sourceEl);
            if (!sourceSelector) {
                const abs = generateAbsoluteXPath(sourceEl);
                sourceSelector = abs ? trimNonInteractiveXPathTail(abs) : null;
            }
        } catch (e) {
            console.warn("handleDragStart: Could not generate source selector:", e);
            return;
        }
        if (!sourceSelector) return;

        // Cache additional raw selector (for debugging) if different
        let rawSelector = null;
        if (sourceEl !== rawTarget) {
            try {
                rawSelector = generateDragSelector(rawTarget);
                if (!rawSelector) {
                    const absRaw = generateAbsoluteXPath(rawTarget);
                    rawSelector = absRaw ? trimNonInteractiveXPathTail(absRaw) : null;
                }
            } catch (e) { /* ignore */ }
        }

        window.__SELBAS_DRAG_SOURCE__ = {
            selector: sourceSelector,
            rawSelector,
            elementInfo: getElementInfo(sourceEl),
            elRef: sourceEl,
            timestamp: Date.now(),
            isDndKit: dndKitDetection ? dndKitDetection.isDndKit : false,
            dndKitId: dndKitDetection ? dndKitDetection.id : null,
            dndKitType: dndKitDetection ? dndKitDetection.type : null
        };
        // Reset drag tracking helpers
        window.__SELBAS_DRAG_LAST_HIT__ = null; // { selector, kind, rawSelector, elementInfo }
        window.__SELBAS_DRAG_COMPLETED__ = false;
        console.log("handleDragStart: Recorded drag start (normalized to draggable card):", window.__SELBAS_DRAG_SOURCE__);
    } catch (e) {
        console.warn("Content: handleDragStart error:", e);
    }
}

// --- Synthetic Drag Detection (for cases where native dragstart doesn't fire) ---
// Some frameworks (or draggable libs) use pointer/mouse events without native HTML5 drag events.
// We detect a pointerdown then movement beyond a threshold to synthesize a drag start.
let __SELBAS_SYNTH_DRAG_STATE = null; // { downEl, downX, downY, started, sourceSelector }
// Throttle timestamp for synthetic pointer move target tracking
let __SELBAS_SYNTH_LAST_TRACK__ = 0;

// Reusable helper (mirrors heuristics in handleDrop / handleDragOver) to resolve a plausible drop container
function __selbasResolveDropContainerFrom(el, sourceSelector) {
    if (!el || !(el instanceof Element)) return null;
    const tried = [];
    const push = (elem, kind, priority = 0) => { if (elem && elem instanceof Element) tried.push({ el: elem, kind, priority }); };

    try {
        // Enhanced detection for dnd-kit drop zones and containers (highest priority)
        // 首先檢查當前元素及父元素是否有穩定的ID
        let current = el;
        while (current && current !== document.body) {
            if (current.id && !current.id.match(/^(?:radix-|ember-|data-v-|svelte-|ui-|aria-|temp-|auto-)/i)) {
                // 檢查這個ID是否穩定且唯一
                try {
                    const selector = `#${CSS.escape(current.id)}`;
                    if (document.querySelectorAll(selector).length === 1) {
                        console.log(`[DND][resolveContainer] 找到穩定ID容器: ${selector}`);
                        return { selector: selector, kind: 'stable-id-container', element: current };
                    }
                } catch (e) { /* ignore */ }
            }
            current = current.parentElement;
        }

        push(el.closest('[data-rbd-droppable-id], [data-dnd-kit-droppable], [data-sortable-container], #target-zone, #source-zone'), 'dnd-droppable', 10);
        push(el.closest('[class*="droppable"], [class*="drop-zone"], [class*="sortable-container"], [class*="drag-zone"]'), 'dnd-container', 9);

        // Look for containers with multiple draggable children (high priority)
        // Also look for column-like containers (flex-grow, min-height patterns from Ant Design)
        let parent = el.parentElement;
        while (parent && parent !== document.body) {
            const draggableCount = parent.querySelectorAll('[data-rbd-draggable-id], [data-dnd-kit-id], [data-sortable-id], [draggable="true"], [class*="draggable"]').length;
            if (draggableCount >= 2) {
                push(parent, 'multi-draggable-container', 8);
                break;
            }
            // Check for kanban column patterns (flex-grow with min-height, typically empty space)
            const style = getComputedStyle(parent);
            if (style && style.flexGrow === '1' && (style.minHeight !== '0px' && style.minHeight !== 'auto')) {
                push(parent, 'kanban-column', 9); // High priority for column containers
            }
            parent = parent.parentElement;
        }

        // Semantic containers with medium priority
        push(el.closest('[style*="flex-grow: 1"][style*="min-height"]'), 'flex-grow', 6);
        push(el.closest('[style*="overflow-y: auto"],[style*="overflow: auto"],[style*="overflow-y:auto"]'), 'scroll', 5);
        push(el.closest('[role="list"], [aria-roledescription="list"]'), 'aria-list', 7);
        push(el.closest('ul, ol, section, main, article'), 'semantic', 4);

        // Avoid overly generic containers (lower priority)
        push(el.closest('div[class*="content"], div[class*="container"]'), 'content-container', 3);
        push(el, 'raw-target', 1);

        // Sort by priority and validate each candidate
        tried.sort((a, b) => b.priority - a.priority);

        for (const c of tried) {
            try {
                // 對於拖拽容器，優先使用ID選擇器
                let selector = generateDragSelector(c.el);
                if (!selector) {
                    const abs = generateAbsoluteXPath(c.el);
                    selector = abs ? trimNonInteractiveXPathTail(abs) : null;
                }
                if (!selector || selector === sourceSelector) continue;

                // Skip overly generic paths (too high in DOM tree)
                const pathDepth = (selector.match(/\//g) || []).length;
                if (pathDepth < 4) continue;

                console.log('[DND][resolveContainer] Selected container:', c.el, 'kind:', c.kind, 'priority:', c.priority, 'depth:', pathDepth);
                return { selector: selector, kind: c.kind, element: c.el };
            } catch (e) {
                console.log('[DND][resolveContainer] Error validating candidate:', c.kind, e);
            }
        }
    } catch (e) {
        console.log('[DND][resolveContainer] Error in resolution:', e);
    }
    return null;
}

// Resolve a specific draggable item (card) distinct from source for more precise target
function __selbasResolveDropItem(el, sourceSelector) {
    try {
        if (!el || !(el instanceof Element)) return null;
        // Enhanced detection for dnd-kit and other virtual drag libraries
        const item = el.closest('[role="button"][aria-roledescription="draggable"], [aria-roledescription="draggable"], [draggable="true"], [data-rbd-draggable-id], [data-dnd-kit-id], [data-sortable-id]') ||
            el.closest('[class*="draggable"], [class*="sortable"], [class*="dnd"], [class*="drag"]');
        if (!item) return null;

        // 對於拖拽項目，優先使用ID選擇器
        let selector = generateDragSelector(item);
        if (!selector) {
            const abs = generateAbsoluteXPath(item);
            selector = abs ? trimNonInteractiveXPathTail(abs) : null;
        }

        if (selector && selector !== sourceSelector) {
            return { selector: selector, element: item };
        }
    } catch (e) { /* ignore */ }
    return null;
}

// Helper: Check if pointer is in end-of-list area (below last draggable item)
function __selbasCheckEndOfListHeuristic(clientX, clientY, container) {
    try {
        if (!container) return false;

        // Find all draggable items within this container
        const draggables = container.querySelectorAll('[role="button"][aria-roledescription="draggable"], [data-rbd-draggable-id], [data-dnd-kit-id], [data-sortable-id], [class*="draggable"]');
        if (draggables.length === 0) return true; // Empty container = end of list

        // Find the bottom-most draggable item
        let bottomMostY = 0;
        for (const draggable of draggables) {
            try {
                const rect = draggable.getBoundingClientRect();
                if (rect.bottom > bottomMostY) {
                    bottomMostY = rect.bottom;
                }
            } catch (e) { /* ignore */ }
        }

        // If pointer is below the last item with some margin, consider it end-of-list
        const MARGIN = 20; // pixels
        return clientY > (bottomMostY + MARGIN);
    } catch (e) {
        return false;
    }
}

// Resolve the most precise element under a point that differs from source (uses elementsFromPoint stack)
function __selbasResolvePrecisePointTarget(clientX, clientY, sourceSelector) {
    try {
        const arr = document.elementsFromPoint(clientX, clientY);
        if (!arr || !arr.length) return null;

        // Debug: Log all elements under pointer for dnd-kit troubleshooting
        console.log('[DND][elementsFromPoint] Stack at', clientX, clientY, ':', arr.map(el => el.tagName + (el.className ? '.' + el.className.split(' ').join('.') : '') + (el.id ? '#' + el.id : '')).slice(0, 5));

        // First pass: look for specific drop targets/containers
        for (const el of arr) {
            if (!(el instanceof Element)) continue;
            if (el === document.documentElement || el === document.body) continue; // skip html/body

            // Enhanced ghost/overlay detection for dnd-kit and other libraries
            try {
                const style = getComputedStyle(el);
                if (style && ((parseFloat(style.opacity) < 0.2) || style.pointerEvents === 'none' || style.transform.includes('translate'))) continue;

                // Skip dnd-kit overlay or preview elements (common class patterns)
                if (el.classList && (el.classList.contains('drag-overlay') || el.classList.contains('dnd-overlay') ||
                    el.classList.contains('drag-preview') || el.matches('[class*="overlay"], [class*="preview"], [class*="ghost"]'))) continue;

                // Skip ant-design blur/loading containers (too generic)
                if (el.classList && (el.classList.contains('ant-spin-container') || el.classList.contains('ant-spin-blur'))) continue;
            } catch (_) { /* ignore style issues */ }

            let abs = null; let trimmed = null;
            try {
                trimmed = generateDragSelector(el);
                if (!trimmed) {
                    abs = generateAbsoluteXPath(el);
                    trimmed = abs ? trimNonInteractiveXPathTail(abs) : null;
                }
            } catch (_) { trimmed = null; }
            if (!trimmed) continue;
            if (trimmed === sourceSelector) continue; // don't target the source itself

            // Skip overly generic paths (too high in DOM tree)
            const pathDepth = (trimmed.match(/\//g) || []).length;
            if (pathDepth < 4) continue; // Skip very shallow paths like /html/body/div/div

            // Prefer elements that look like drop targets or containers
            const isDndTarget = el.matches('[data-rbd-droppable-id], [data-dnd-kit-droppable], [data-sortable-container], [class*="droppable"], [class*="drop-zone"], #target-zone, #source-zone, [class*="drag-zone"]');
            const isSpecificContainer = el.matches('article, section, main, [role="main"], [class*="content"], [class*="card"], [class*="item"], [class*="list"]');

            // End-of-list heuristic: if this element contains draggables and pointer is below them, prefer the container
            let shouldPreferContainer = false;
            if (isSpecificContainer) {
                const parentContainer = el.closest('div[style*="flex-grow"], div[style*="min-height"], [class*="drop-zone"], [class*="droppable"]');
                if (parentContainer && __selbasCheckEndOfListHeuristic(clientX, clientY, parentContainer)) {
                    shouldPreferContainer = true;
                    console.log('[DND][elementsFromPoint] End-of-list detected, preferring container over card');
                }
            }

            if (isDndTarget || (isSpecificContainer && !shouldPreferContainer)) {
                console.log('[DND][elementsFromPoint] Found specific target:', el, trimmed, 'isDndTarget:', isDndTarget, 'isSpecific:', isSpecificContainer);
                return { element: el, selector: trimmed, isDndTarget: isDndTarget || isSpecificContainer };
            } else if (shouldPreferContainer) {
                // Skip this card, let it fall through to find the container
                continue;
            }
        }

        // Second pass: fallback to any reasonable element (with depth filter)
        for (const el of arr) {
            if (!(el instanceof Element)) continue;
            if (el === document.documentElement || el === document.body) continue; // skip html/body

            try {
                const style = getComputedStyle(el);
                if (style && ((parseFloat(style.opacity) < 0.2) || style.pointerEvents === 'none' || style.transform.includes('translate'))) continue;
                if (el.classList && (el.classList.contains('ant-spin-container') || el.classList.contains('ant-spin-blur'))) continue;
            } catch (_) { /* ignore style issues */ }

            let abs = null; let trimmed = null;
            try {
                trimmed = generateDragSelector(el);
                if (!trimmed) {
                    abs = generateAbsoluteXPath(el);
                    trimmed = abs ? trimNonInteractiveXPathTail(abs) : null;
                }
            } catch (_) { trimmed = null; }
            if (!trimmed) continue;
            if (trimmed === sourceSelector) continue; // don't target the source itself

            const pathDepth = (trimmed.match(/\//g) || []).length;
            if (pathDepth >= 6) { // Prefer deeper, more specific elements
                console.log('[DND][elementsFromPoint] Using fallback target:', el, trimmed);
                return { element: el, selector: trimmed };
            }
        }
    } catch (e) {
        console.warn('[DND][elementsFromPoint] Error:', e);
        return null;
    }
    return null;
}

// Post-frame refinement: after DOM reflow (common in kanban libraries) the element under the cursor may change.
// We wait 2 rAF frames (~32ms) then re-evaluate elementsFromPoint stack and, if a better distinct target appears,
// update the action before sending. This reduces cases where we capture an interim placeholder/ghost.
function __selbasPostFrameRefineAndSend(action, refineCtx) {
    try {
        window.__SELBAS_PENDING_DND__ = true; // signal to dragend cleanup to skip synthetic fallback
        let frames = 0;
        const MAX_FRAMES = 2; // two frames to allow layout & animations to settle minimally
        const srcSelector = action.sourceSelector;
        const doRefine = () => {
            if (frames < MAX_FRAMES) {
                frames++;
                requestAnimationFrame(doRefine);
                return;
            }
            try {
                const cx = refineCtx && refineCtx.clientX != null ? refineCtx.clientX : 0;
                const cy = refineCtx && refineCtx.clientY != null ? refineCtx.clientY : 0;
                const precisePoint = __selbasResolvePrecisePointTarget(cx, cy, srcSelector);
                let newTargetSelector = null;
                let newTargetElement = null;
                if (precisePoint && precisePoint.selector && precisePoint.selector !== action.targetSelector && precisePoint.selector !== srcSelector) {
                    newTargetSelector = precisePoint.selector;
                    newTargetElement = precisePoint.element;
                }
                // If new point element is a draggable item distinct from source, prefer that
                if (newTargetElement) {
                    try {
                        const refinedItem = __selbasResolveDropItem(newTargetElement, srcSelector);
                        if (refinedItem && refinedItem.selector !== srcSelector && refinedItem.selector !== action.targetSelector) {
                            newTargetSelector = refinedItem.selector;
                            newTargetElement = refinedItem.element;
                            action.preciseTargetWasItem = true;
                            action.targetSource = 'item';
                        }
                    } catch (_) { /* ignore item refine errors */ }
                }
                if (newTargetSelector && newTargetSelector !== action.targetSelector) {
                    action.originalTargetSelector = action.targetSelector;
                    action.targetSelector = newTargetSelector;
                    action.targetElementInfo = getElementInfo(newTargetElement) || action.targetElementInfo || null;
                    action.reasonCode = 'post-frame-refined';
                    action.postFrameRefined = true;
                } else {
                    action.postFrameRefined = false;
                }
            } catch (refErr) { /* ignore refine errors */ }
            try {
                chrome.runtime.sendMessage({ command: 'record_action', data: action });
            } catch (sendErr) {
                console.warn('[DND] post-frame send failed:', sendErr);
                // If extension context is invalidated, try to store locally or skip gracefully
                if (sendErr.message && sendErr.message.includes('Extension context invalidated')) {
                    console.warn('[DND] Extension reloaded during drag operation, action lost:', action);
                }
            }
            console.log('[DND][post-frame-commit]', {
                chosenTarget: action.targetSelector,
                reasonCode: action.reasonCode,
                postFrameRefined: action.postFrameRefined || false,
                originalTargetSelector: action.originalTargetSelector || null
            });
            delete window.__SELBAS_DRAG_SOURCE__;
            delete window.__SELBAS_DRAG_LAST_HIT__;
            delete window.__SELBAS_DRAG_COMPLETED__;
            delete window.__SELBAS_PENDING_DND__;
        };
        requestAnimationFrame(doRefine);
    } catch (e) {
        // Fallback: send immediately if something unexpected occurs
        try { chrome.runtime.sendMessage({ command: 'record_action', data: action }); } catch (_) { /* ignore */ }
        delete window.__SELBAS_PENDING_DND__;
    }
}

function synthPointerDown(e) {
    try {
        if (!(e.target instanceof Element)) return;
        // Ignore right/middle clicks
        if (e.button !== 0) return;

        // Enhanced detection for dnd-kit elements
        const isDndElement = e.target.matches('[data-rbd-draggable-id], [data-dnd-kit-id], [data-sortable-id]') ||
            e.target.closest('[class*="draggable"], [class*="sortable"], [class*="dnd"], [class*="drag"]') ||
            e.target.matches('[draggable], [aria-roledescription="draggable"]');

        console.log('[DND][pointerdown] Target:', e.target, 'isDndElement:', isDndElement);

        __SELBAS_SYNTH_DRAG_STATE = {
            downEl: e.target,
            downX: e.clientX,
            downY: e.clientY,
            started: false,
            sourceSelector: null,
            pointerId: e.pointerId,
            downButtons: e.buttons,
            isDndElement // Flag for enhanced processing
        };
    } catch (err) { /* ignore */ }
}

function synthPointerMove(e) {
    try {
        if (!__SELBAS_SYNTH_DRAG_STATE || __SELBAS_SYNTH_DRAG_STATE.started) return;
        const dx = Math.abs(e.clientX - __SELBAS_SYNTH_DRAG_STATE.downX);
        const dy = Math.abs(e.clientY - __SELBAS_SYNTH_DRAG_STATE.downY);
        // Lower threshold for dnd-kit elements (more sensitive detection)
        const DIST = __SELBAS_SYNTH_DRAG_STATE.isDndElement ? 3 : 5;
        if (dx < DIST && dy < DIST) return;
        // Movement exceeded threshold, treat as drag start if no native dragstart occurred
        if (!window.__SELBAS_DRAG_SOURCE__) {
            const candidate = (__SELBAS_SYNTH_DRAG_STATE.downEl instanceof Element) ? __SELBAS_SYNTH_DRAG_STATE.downEl : null;
            if (candidate) {
                const sourceEl = candidate.closest('[role="button"][aria-roledescription="draggable"], [aria-roledescription="draggable"], [draggable="true"], [data-rbd-draggable-id], [data-dnd-kit-id], [data-sortable-id]') ||
                    candidate.closest('[class*="draggable"], [class*="sortable"], [class*="dnd"], [class*="drag"]') || candidate;
                try {
                    let selector = generateDragSelector(sourceEl);
                    if (!selector) {
                        const abs = generateAbsoluteXPath(sourceEl);
                        selector = abs ? trimNonInteractiveXPathTail(abs) : null;
                    }
                    if (selector) {
                        window.__SELBAS_DRAG_SOURCE__ = {
                            selector,
                            rawSelector: (function () {
                                try {
                                    let rawSel = generateDragSelector(candidate);
                                    if (!rawSel) {
                                        const a = generateAbsoluteXPath(candidate);
                                        rawSel = a ? trimNonInteractiveXPathTail(a) : null;
                                    }
                                    return rawSel;
                                } catch (e) { return null; }
                            })(),
                            elementInfo: getElementInfo(sourceEl),
                            elRef: sourceEl,
                            timestamp: Date.now(),
                            synthetic: true
                        };
                        window.__SELBAS_DRAG_LAST_HIT__ = null;
                        window.__SELBAS_DRAG_COMPLETED__ = false;
                        console.log('[DND][synthetic-dragstart] Created synthetic drag source:', window.__SELBAS_DRAG_SOURCE__);
                        __SELBAS_SYNTH_DRAG_STATE.started = true;
                        __SELBAS_SYNTH_LAST_TRACK__ = 0; // reset tracking throttle
                    }
                } catch (err) { /* ignore */ }
            }
        } else {
            // Native drag started meanwhile; mark synthetic state consumed
            __SELBAS_SYNTH_DRAG_STATE.started = true;
        }
    } catch (err) { /* ignore */ }
}

// While synthetic drag is active (after we flagged started), we still want to track target candidates via pointer moves
document.addEventListener('pointermove', function (e) {
    try {
        if (!window.__SELBAS_DRAG_SOURCE__ || !window.__SELBAS_DRAG_SOURCE__.synthetic) return; // only for synthetic drags
        if (!__SELBAS_SYNTH_DRAG_STATE || !__SELBAS_SYNTH_DRAG_STATE.started) return; // haven't started
        // Throttle to every ~120ms
        if (__SELBAS_SYNTH_LAST_TRACK__ && (Date.now() - __SELBAS_SYNTH_LAST_TRACK__) < 120) return;
        __SELBAS_SYNTH_LAST_TRACK__ = Date.now();
        const tgt = e.target instanceof Element ? e.target : null;
        if (!tgt) return;
        const dragSource = window.__SELBAS_DRAG_SOURCE__;
        const resolved = __selbasResolveDropContainerFrom(tgt, dragSource.selector);
        if (resolved && resolved.selector) {
            // Cache raw selector for debugging
            let rawSel = generateDragSelector(tgt);
            if (!rawSel) {
                try { const absRaw = generateAbsoluteXPath(tgt); rawSel = absRaw ? trimNonInteractiveXPathTail(absRaw) : null; } catch (err) { rawSel = null; }
            }
            window.__SELBAS_DRAG_LAST_HIT__ = {
                selector: resolved.selector,
                kind: resolved.kind,
                rawSelector: rawSel,
                elementInfo: getElementInfo(resolved.element)
            };
            // Light debug
            // console.log('[DND][synthetic-tracking] last hit =>', window.__SELBAS_DRAG_LAST_HIT__);
        }
    } catch (err) { /* ignore */ }
}, true);

function synthPointerUp(e) {
    try {
        // Only end if we have synthetic drag started AND pointerup matches initiating pointerId
        if (window.__SELBAS_DRAG_SOURCE__ && window.__SELBAS_DRAG_SOURCE__.synthetic && !window.__SELBAS_DRAG_COMPLETED__ && __SELBAS_SYNTH_DRAG_STATE) {
            if (e && __SELBAS_SYNTH_DRAG_STATE.pointerId != null && e.pointerId != null && e.pointerId !== __SELBAS_SYNTH_DRAG_STATE.pointerId) {
                return; // different pointer, ignore
            }
            // Ensure this is actually a release of left button (buttons becomes 0)
            if (e && e.buttons && e.buttons !== 0) {
                return; // still holding some buttons (e.g., intermediate pointer events)
            }
            const src = window.__SELBAS_DRAG_SOURCE__;
            let last = window.__SELBAS_DRAG_LAST_HIT__;
            if (!last && e && e.target instanceof Element) {
                const r = __selbasResolveDropContainerFrom(e.target, src.selector);
                if (r) {
                    last = {
                        selector: r.selector,
                        kind: r.kind,
                        rawSelector: (function () {
                            try {
                                let rawSel = generateDragSelector(e.target);
                                if (!rawSel) {
                                    const absR = generateAbsoluteXPath(e.target);
                                    rawSel = absR ? trimNonInteractiveXPathTail(absR) : null;
                                }
                                return rawSel;
                            } catch (err) { return null; }
                        })(),
                        elementInfo: getElementInfo(r.element)
                    };
                } else {
                    // Fallback: use elementsFromPoint for better dnd-kit detection
                    console.log('[DND][synthetic-up] No container found via normal method, trying elementsFromPoint');
                    const preciseTarget = __selbasResolvePrecisePointTarget(e.clientX, e.clientY, src.selector);
                    if (preciseTarget) {
                        last = {
                            selector: preciseTarget.selector,
                            kind: 'elementsFromPoint-fallback',
                            rawSelector: preciseTarget.selector,
                            elementInfo: getElementInfo(preciseTarget.element)
                        };
                    }
                }
            }
            if (last && last.selector && last.selector !== src.selector) {
                // Attempt precise item under pointerup target
                let preciseItem = null;
                try {
                    const pointerEl = (e && e.target instanceof Element) ? e.target : null;
                    // Prefer elementFromPoint for final accuracy
                    let pointEl = null;
                    let pointerElementSelector = null;
                    try {
                        const cx = (e.clientX != null ? e.clientX : (e.pageX || 0));
                        const cy = (e.clientY != null ? e.clientY : (e.pageY || 0));
                        pointEl = document.elementFromPoint(cx, cy) || pointerEl;
                        if (pointEl) {
                            pointerElementSelector = generateDragSelector(pointEl);
                            if (!pointerElementSelector) {
                                const absP = generateAbsoluteXPath(pointEl);
                                pointerElementSelector = absP ? trimNonInteractiveXPathTail(absP) : null;
                            }
                        }
                        // New: attempt multi-layer precision resolution
                        const precisePoint = __selbasResolvePrecisePointTarget(cx, cy, src.selector);
                        if (precisePoint && precisePoint.selector && precisePoint.selector !== pointerElementSelector) {
                            // Use more precise layer for pointer element if available
                            pointerElementSelector = precisePoint.selector;
                            pointEl = precisePoint.element;
                        }
                    } catch (err) { pointEl = pointerEl; }
                    preciseItem = pointEl ? __selbasResolveDropItem(pointEl, src.selector) : null;
                    if (!preciseItem && pointerEl && pointEl !== pointerEl) {
                        preciseItem = __selbasResolveDropItem(pointerEl, src.selector) || preciseItem;
                    }
                    // attach pointerElementSelector into closure scope for later use
                    e.__selbasPointerElementSelector = pointerElementSelector;
                } catch (err) { /* ignore */ }
                // Descendant guard: if pointer element lies inside source (and not a distinct item) fallback to container last.selector
                let reasonCode = 'ok';
                try {
                    if (!preciseItem && src.elRef && e && e.target instanceof Element && src.elRef.contains(e.target)) {
                        if (e.__selbasPointerElementSelector) {
                            reasonCode = 'pointer-inside-source';
                        }
                        if (e.__selbasPointerElementSelector === src.selector) {
                            reasonCode = 'pointer-equals-source';
                        }
                        if (e.__selbasPointerElementSelector) {
                            // neutralize pointer element so container becomes target
                            e.__selbasPointerElementSelector = null;
                        }
                    }
                } catch (_) { }
                let targetSelector = preciseItem ? preciseItem.selector : (e.__selbasPointerElementSelector && e.__selbasPointerElementSelector !== src.selector ? e.__selbasPointerElementSelector : last.selector);
                if (targetSelector === src.selector) {
                    reasonCode = 'target-equals-source-skip';
                }
                if (targetSelector !== src.selector) {
                    const action = {
                        type: 'DragAndDrop',
                        sourceSelector: src.selector,
                        targetSelector: targetSelector,
                        sourceElementInfo: src.elementInfo,
                        targetElementInfo: getElementInfo((preciseItem && preciseItem.element) || null) || last.elementInfo || null,
                        containerKind: (last.kind || 'synthetic-pointer'),
                        containerSelector: last.selector,
                        pointerElementSelector: (e.__selbasPointerElementSelector || null),
                        rawTargetSelector: last.rawSelector || null,
                        preciseTargetWasItem: !!preciseItem,
                        targetSource: preciseItem ? 'item' : (e.__selbasPointerElementSelector && e.__selbasPointerElementSelector !== last.selector ? 'pointer-element' : 'container'),
                        reasonCode,
                        selectorType: 'XPath',
                        timestamp: Date.now()
                    };
                    // Enhanced debug for dnd-kit troubleshooting
                    console.log('[DND][synthetic-up] Recording action:', {
                        sourceSelector: action.sourceSelector,
                        targetSelector: action.targetSelector,
                        targetSource: action.targetSource,
                        reasonCode: action.reasonCode,
                        pointerCoords: { x: e.clientX, y: e.clientY },
                        targetElement: (preciseItem && preciseItem.element) || null
                    });

                    // Post-frame refinement commit instead of immediate send
                    window.__SELBAS_DRAG_COMPLETED__ = true; // mark to block other synthetic fallbacks
                    __selbasPostFrameRefineAndSend(action, { clientX: e.clientX, clientY: e.clientY });
                } else {
                    console.log('[DND] Synthetic pointerup target same as source; skip.');
                }
            } else {
                console.log('[DND] Synthetic pointerup had no distinct target to record.');
            }
            // Cleanup will occur after post-frame refinement commit
        }
    } catch (err) { /* ignore */ }
    __SELBAS_SYNTH_DRAG_STATE = null;
}

/**
 * Handles dragenter events for file drag operations
 * @param {Event} event
 */
function handleDragEnter(event) {
    try {
        // Check if this is a file drag from outside the browser
        if (event.dataTransfer && event.dataTransfer.types && event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
            console.log('[DND][dragenter] File drag entering:', event.target);

            // Add visual feedback if the target looks like a drop zone
            const dropZone = event.target.closest('[data-drop-zone], [class*="drop"], [class*="upload"], [accept], .upload-area, .dropzone, .file-drop, [data-testid*="upload"], [data-testid*="drop"]');
            if (dropZone && dropZone.classList) {
                dropZone.classList.add('drag-over');
            }
        }
    } catch (e) {
        console.warn("Content: handleDragEnter error:", e);
    }
}

/**
 * Handles file drop events for drag-and-drop file uploads
 * @param {Event} event
 */
function handleFileDrop(event) {
    try {
        event.preventDefault(); // Prevent browser's default file handling

        const rawDropTarget = event.target;
        if (!(rawDropTarget instanceof Element)) return;

        // Clean up visual feedback
        const dropZone = rawDropTarget.closest('[data-drop-zone], [class*="drop"], [class*="upload"], [accept], input[type="file"], .upload-area, .dropzone, .file-drop, [data-testid*="upload"], [data-testid*="drop"]');
        if (dropZone && dropZone.classList) {
            dropZone.classList.remove('drag-over');
        }

        const files = Array.from(event.dataTransfer.files || []);
        if (files.length === 0) return;

        const fileNames = files.map(f => (f && f.name) ? f.name : '').filter(Boolean);
        console.log('[DND][file-drop] Files dropped:', fileNames);

        // Generate selector for the actual file input element (not the drop zone)
        let selector = null;
        try {
            // First try to find the drop zone
            const dropZone = rawDropTarget.closest('[data-drop-zone], [class*="drop"], [class*="upload"], [accept], input[type="file"], .upload-area, .dropzone, .file-drop, [data-testid*="upload"], [data-testid*="drop"]') || rawDropTarget;
            console.log('handleFileDrop: Drop zone element:', dropZone);

            // Then look for the actual file input element associated with this drop zone
            let fileInput = null;

            // Method 1: Look for input[type="file"] within the drop zone
            fileInput = dropZone.querySelector('input[type="file"]');
            console.log('handleFileDrop: Method 1 (within drop zone):', fileInput);

            // Method 2: If not found, look in siblings or nearby elements
            if (!fileInput && dropZone.parentElement) {
                fileInput = dropZone.parentElement.querySelector('input[type="file"]');
                console.log('handleFileDrop: Method 2 (parent element):', fileInput);
            }

            // Method 3: Look in the entire form/container if still not found
            if (!fileInput) {
                const form = dropZone.closest('form, [class*="upload"], [class*="form"]');
                if (form) {
                    fileInput = form.querySelector('input[type="file"]');
                    console.log('handleFileDrop: Method 3 (form container):', fileInput);
                }
            }

            // Method 4: Search nearby in the DOM tree (table cell, row, etc.)
            if (!fileInput) {
                const container = dropZone.closest('td, tr, div[class*="cell"], div[class*="row"], div[class*="container"]');
                if (container) {
                    fileInput = container.querySelector('input[type="file"]');
                    console.log('handleFileDrop: Method 4 (table cell/row):', fileInput);
                }
            }

            // Method 5: Broader search in the same table or section
            if (!fileInput) {
                const section = dropZone.closest('table, section, main, [class*="table"], [class*="grid"]');
                if (section) {
                    fileInput = section.querySelector('input[type="file"]');
                    console.log('handleFileDrop: Method 5 (broader container):', fileInput);
                }
            }

            // Method 6: Look for hidden inputs in the same area using XPath patterns
            if (!fileInput) {
                // Based on your comment, the correct path should end with /input instead of /div/div
                try {
                    const dropZoneXPath = generateAbsoluteXPath(dropZone);
                    if (dropZoneXPath && dropZoneXPath.includes('/div/div')) {
                        // Try to construct the input path by replacing the last /div/div with /input
                        const possibleInputXPath = dropZoneXPath.replace(/\/div\/div$/, '/input');
                        console.log('handleFileDrop: Trying constructed XPath:', possibleInputXPath);

                        // Use XPath to find the element
                        const result = document.evaluate(possibleInputXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                        if (result.singleNodeValue && result.singleNodeValue.tagName === 'INPUT') {
                            fileInput = result.singleNodeValue;
                            console.log('handleFileDrop: Method 6 (XPath construction) found:', fileInput);
                        }
                    }
                } catch (e) {
                    console.warn('handleFileDrop: XPath construction failed:', e);
                }
            }

            // Use the file input if found, otherwise fall back to drop zone
            const targetElement = fileInput || dropZone;
            console.log('handleFileDrop: Final target element:', targetElement, 'tagName:', targetElement.tagName);

            // Generate XPath for the target element
            const abs = generateAbsoluteXPath(targetElement);
            selector = abs ? trimNonInteractiveXPathTail(abs) : null;

            // Fallback to CSS selector if XPath fails
            if (!selector) {
                selector = generateDragSelector(targetElement);
            }

            console.log(`handleFileDrop: Using ${fileInput ? 'file input' : 'drop zone'} element for selector:`, selector);
        } catch (e) {
            console.warn("handleFileDrop: Could not generate selector:", e);
            return;
        }

        if (!selector) {
            console.warn("handleFileDrop: Could not generate selector for drop target");
            return;
        }

        // Create the action data
        const actionData = {
            type: 'Upload', // Use same type as click upload for consistency
            method: 'drag-drop', // Distinguish from click-based file upload
            selector: selector,
            value: fileNames.join(', '), // Display in side panel
            fileNames: fileNames,        // Extra metadata for generator
            fileCount: fileNames.length,
            selectorType: selector && (selector.startsWith('xpath=') || selector.startsWith('/')) ? 'XPath' : 'CSS',
            timestamp: Date.now(),
            dropCoordinates: {
                clientX: event.clientX,
                clientY: event.clientY,
                pageX: event.pageX,
                pageY: event.pageY
            }
        };

        console.log("handleFileDrop: Action recorded (Content):", actionData);

        // Send the recorded action
        try {
            chrome.runtime.sendMessage({ command: "record_action", data: actionData })
                .catch(error => {
                    if (error.message && !error.message.includes("Extension context invalidated") && !error.message.includes("message port closed")) {
                        console.error("handleFileDrop: Error sending file drop action message:", error);
                    }
                });
        } catch (error) {
            if (error.message && !error.message.includes("Extension context invalidated")) {
                console.error("handleFileDrop: Synchronous error sending file drop action:", error);
            }
        }

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
                        try {
                            chrome.runtime.sendMessage({
                                command: 'upload_file',
                                data: {
                                    name: f.name,
                                    dataUrl,
                                    method: 'drag-drop',
                                    dropTarget: selector // Include drop target info
                                }
                            });
                        } catch (e) { }
                    }
                };
                reader.onerror = () => { /* ignore */ };
                reader.readAsDataURL(f);
            } catch (e) { /* ignore per-file */ }
        });

    } catch (e) {
        console.warn("Content: handleFileDrop error:", e);
    }
}

/**
 * Handles drop events to capture the completion of a drag-and-drop action.
 * @param {Event} event
 */
function handleDrop(event) {
    try {
        const rawDropTarget = event.target;
        if (!(rawDropTarget instanceof Element)) return;
        console.log('[DND][drop] raw drop target:', rawDropTarget);

        // Check if this is a file drop from outside the browser
        if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length > 0) {
            console.log('[DND][file-drop] Detected file drop with', event.dataTransfer.files.length, 'files');
            handleFileDrop(event);
            return; // File drop is handled separately from element drag-and-drop
        }

        // Use DND-Kit enhancer for better drop detection
        let dndKitDropDetection = null;
        if (window.DND_KIT_ENHANCER) {
            dndKitDropDetection = window.DND_KIT_ENHANCER.enhancedDropDetection(event);
        }

        // Use elementFromPoint to capture exact element under cursor at release
        let pointEl = null;
        let pointerElementSelector = null;
        try {
            const cx = (event.clientX != null ? event.clientX : (event.pageX || 0));
            const cy = (event.clientY != null ? event.clientY : (event.pageY || 0));
            pointEl = document.elementFromPoint(cx, cy) || rawDropTarget;
            if (pointEl) {
                pointerElementSelector = generateDragSelector(pointEl);
                if (!pointerElementSelector) {
                    const absPt = generateAbsoluteXPath(pointEl);
                    pointerElementSelector = absPt ? trimNonInteractiveXPathTail(absPt) : null;
                }
            }
            // New precision resolution using full stacking order
            const precisePoint = __selbasResolvePrecisePointTarget(cx, cy, (window.__SELBAS_DRAG_SOURCE__ && window.__SELBAS_DRAG_SOURCE__.selector) || null);
            if (precisePoint && precisePoint.selector && precisePoint.selector !== pointerElementSelector) {
                pointEl = precisePoint.element;
                pointerElementSelector = precisePoint.selector;
            }
        } catch (err) { pointEl = rawDropTarget; }
        // NOTE: Drag source (window.__SELBAS_DRAG_SOURCE__) and resolved drop container
        // are captured here using absolute XPath. Background script now injects a
        // multi-strategy Python helper (perform_drag_with_fallback) automatically
        // when exporting if any DragAndDrop actions exist, so no additional logic
        // is required in the content script for fallback strategies.

        // Retrieve source first
        const dragSource = window.__SELBAS_DRAG_SOURCE__ || {};
        if (!dragSource.selector) {
            console.warn("handleDrop: No drag source recorded.");
            return;
        }

        // Heuristic to find the list / container receiving the drop
        function findDropContainer(el) {
            if (!el || !(el instanceof Element)) return null;
            const candidates = [];
            // Priority 1: flex-grow container (inner list body)
            const flexGrow = el.closest('[style*="flex-grow: 1"][style*="min-height"]');
            if (flexGrow) candidates.push({ el: flexGrow, kind: 'flex-grow' });
            // Priority 2: scroll container
            const scroll = el.closest('[style*="overflow-y: auto"],[style*="overflow: auto"],[style*="overflow-y:auto"]');
            if (scroll) candidates.push({ el: scroll, kind: 'scroll' });
            // Priority 3: any draggable list semantics
            const ariaList = el.closest('[role="list"], [aria-roledescription="list"]');
            if (ariaList) candidates.push({ el: ariaList, kind: 'aria-list' });
            // Fallback: original target
            candidates.push({ el, kind: 'raw-target' });
            // Choose first whose XPath differs from source
            for (const c of candidates) {
                try {
                    let trimmed = generateDragSelector(c.el);
                    if (!trimmed) {
                        const abs = generateAbsoluteXPath(c.el);
                        trimmed = abs ? trimNonInteractiveXPathTail(abs) : null;
                    }
                    if (trimmed && trimmed !== dragSource.selector) return { selector: trimmed, kind: c.kind, element: c.el };
                } catch (e) { /* ignore */ }
            }
            return null;
        }

        const foundContainer = findDropContainer(rawDropTarget);
        if (!foundContainer) {
            console.warn("handleDrop: Could not resolve a stable drop container; aborting.");
            console.warn('[DND] raw target absolute XPath for diagnostics:', (function () { try { const a = generateAbsoluteXPath(rawDropTarget); return a; } catch (e) { return null; } })());
            delete window.__SELBAS_DRAG_SOURCE__;
            return;
        }
        // Resolve precise item from elementFromPoint first, fallback to rawDropTarget
        const foundItem = __selbasResolveDropItem(pointEl, dragSource.selector) || __selbasResolveDropItem(rawDropTarget, dragSource.selector);
        // Priority: specific draggable item > precise pointer element > generic pointerElementSelector > container
        let reasonCode = 'ok';
        let primaryTargetSelector = (foundItem && foundItem.selector)
            ? foundItem.selector
            : (pointerElementSelector && pointerElementSelector !== dragSource.selector ? pointerElementSelector : foundContainer.selector);
        // Guard: if pointer element ended inside the source (and not a distinct item) force container
        try {
            if (!foundItem && dragSource.elRef && pointEl && dragSource.elRef.contains(pointEl) && primaryTargetSelector !== foundContainer.selector) {
                reasonCode = 'pointer-inside-source';
                primaryTargetSelector = foundContainer.selector;
            }
        } catch (_) { }
        if (primaryTargetSelector === dragSource.selector) {
            console.log("handleDrop: Source and target resolved to same element; ignoring.");
            delete window.__SELBAS_DRAG_SOURCE__;
            return;
        }

        // Additional raw target selector (for debug / potential future refinement)
        let rawTargetSelector = null;
        try {
            // 對於拖拽操作，優先使用ID選擇器
            rawTargetSelector = generateDragSelector(rawDropTarget);
            if (!rawTargetSelector) {
                const absRaw = generateAbsoluteXPath(rawDropTarget);
                rawTargetSelector = absRaw ? trimNonInteractiveXPathTail(absRaw) : null;
            }
        } catch (e) { /* ignore */ }

        const action = {
            type: 'DragAndDrop',
            sourceSelector: dragSource.selector,
            targetSelector: primaryTargetSelector,
            sourceElementInfo: dragSource.elementInfo,
            targetElementInfo: getElementInfo((foundItem && foundItem.element) || pointEl || foundContainer.element),
            containerKind: foundContainer.kind,
            containerSelector: foundContainer.selector,
            pointerElementSelector,
            rawTargetSelector,
            preciseTargetWasItem: !!foundItem,
            targetSource: foundItem ? 'item' : (pointerElementSelector && pointerElementSelector !== foundContainer.selector ? 'pointer-element' : 'container'),
            reasonCode,
            selectorType: 'XPath',
            timestamp: Date.now(),
            // DND-Kit specific properties
            isDndKit: dragSource.isDndKit || (dndKitDropDetection && dndKitDropDetection.isDndKit),
            dndKitSourceId: dragSource.dndKitId,
            dndKitTargetId: dndKitDropDetection ? dndKitDropDetection.id : null,
            dndKitSourceType: dragSource.dndKitType,
            dndKitTargetType: dndKitDropDetection ? dndKitDropDetection.type : null,
            insertionType: dndKitDropDetection ? dndKitDropDetection.insertionType : null
        };
        window.__SELBAS_DRAG_COMPLETED__ = true; // prevent synthetic fallbacks
        // Defer sending to allow DOM to settle and refine final target
        __selbasPostFrameRefineAndSend(action, { clientX: event.clientX, clientY: event.clientY });
    } catch (e) {
        console.warn("Content: handleDrop error:", e);
    }
}

/**
 * Handles dragend events to clean up if the drag is canceled.
 * @param {Event} event
 */
function handleDragEnd(event) {
    try {
        // Clean up drag source if the drag is canceled
        console.log('[DND][dragend] fired');
        // Skip synthetic fallback if a post-frame commit is pending
        if (window.__SELBAS_PENDING_DND__) {
            return; // refinement path will handle cleanup
        }
        if (window.__SELBAS_DRAG_SOURCE__ && !window.__SELBAS_DRAG_COMPLETED__) {
            // No native drop captured; attempt a synthetic recording using last known hit element
            const src = window.__SELBAS_DRAG_SOURCE__;
            const last = window.__SELBAS_DRAG_LAST_HIT__;
            if (last && last.selector && last.selector !== src.selector) {
                console.log('[DND] Synthesizing DragAndDrop action from dragend using last pointer hit:', last);
                const action = {
                    type: 'DragAndDrop',
                    sourceSelector: src.selector,
                    targetSelector: last.selector,
                    sourceElementInfo: src.elementInfo,
                    targetElementInfo: last.elementInfo || null,
                    containerKind: last.kind || 'synthetic-end',
                    rawTargetSelector: last.rawSelector || null,
                    selectorType: 'XPath',
                    timestamp: Date.now()
                };
                try { chrome.runtime.sendMessage({ command: 'record_action', data: action }); } catch (e) { console.warn('[DND] Failed to send synthetic drag action:', e); }
            } else {
                console.log('[DND] dragend produced no usable target to synthesize action.');
            }
        }
        delete window.__SELBAS_DRAG_SOURCE__;
        delete window.__SELBAS_DRAG_LAST_HIT__;
        delete window.__SELBAS_DRAG_COMPLETED__;
    } catch (e) {
        console.warn("Content: handleDragEnd error:", e);
    }
}
/**
 * Handles dragleave events to clean up visual feedback
 * @param {Event} event
 */
function handleDragLeave(event) {
    try {
        // Check if this is a file drag from outside the browser
        if (event.dataTransfer && event.dataTransfer.types && event.dataTransfer.types.includes('Files')) {
            console.log('[DND][dragleave] File drag leaving:', event.target);

            // Remove visual feedback
            const dropZone = event.target.closest('[data-drop-zone], [class*="drop"], [class*="upload"], [accept], .upload-area, .dropzone, .file-drop, [data-testid*="upload"], [data-testid*="drop"]');
            if (dropZone && dropZone.classList) {
                dropZone.classList.remove('drag-over');
            }
        }
    } catch (e) {
        console.warn("Content: handleDragLeave error:", e);
    }
}

// Additional dragover logging to ensure drag sequence progression
function handleDragOver(event) {
    try {
        // Check if this is a file drag from outside the browser
        if (event.dataTransfer && event.dataTransfer.types && event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
            console.log('[DND][dragover] File drag over:', event.target);
            // Allow file drop by setting dropEffect
            event.dataTransfer.dropEffect = 'copy';
            return;
        }

        // Prevent default to allow drop events for element drags
        event.preventDefault();

        // Only log intermittently to avoid flooding: every ~300ms
        if (!window.__SELBAS_LAST_DRAGOVER_LOG__ || Date.now() - window.__SELBAS_LAST_DRAGOVER_LOG__ > 300) {
            window.__SELBAS_LAST_DRAGOVER_LOG__ = Date.now();
            const tgt = event.target instanceof Element ? event.target : null;
            console.log('[DND][dragover] over:', tgt);
        }
        // Track last viable drop container continuously
        try {
            if (window.__SELBAS_DRAG_SOURCE__ && !window.__SELBAS_DRAG_COMPLETED__ && event.target instanceof Element) {
                const tgtEl = event.target;
                // Reuse same heuristic logic as in handleDrop (duplicated minimally to avoid function refactor)
                const candidates = [];
                const flexGrow = tgtEl.closest('[style*="flex-grow: 1"][style*="min-height"]');
                if (flexGrow) candidates.push({ el: flexGrow, kind: 'flex-grow' });
                const scroll = tgtEl.closest('[style*="overflow-y: auto"],[style*="overflow: auto"],[style*="overflow-y:auto"]');
                if (scroll) candidates.push({ el: scroll, kind: 'scroll' });
                const ariaList = tgtEl.closest('[role="list"], [aria-roledescription="list"]');
                if (ariaList) candidates.push({ el: ariaList, kind: 'aria-list' });
                candidates.push({ el: tgtEl, kind: 'raw-target' });
                for (const c of candidates) {
                    try {
                        const abs = generateAbsoluteXPath(c.el);
                        const trimmed = abs ? trimNonInteractiveXPathTail(abs) : null;
                        if (trimmed && trimmed !== window.__SELBAS_DRAG_SOURCE__.selector) {
                            window.__SELBAS_DRAG_LAST_HIT__ = {
                                selector: trimmed,
                                kind: c.kind,
                                rawSelector: (function () { try { const a = generateAbsoluteXPath(event.target); return a ? trimNonInteractiveXPathTail(a) : null; } catch (e) { return null; } })(),
                                elementInfo: getElementInfo(c.el)
                            };
                            break;
                        }
                    } catch (e) { /* ignore candidate calc */ }
                }
            }
        } catch (e) { /* ignore tracking errors */ }
    } catch (e) { /* ignore */ }
}
// --- Hover Detection (record after 500ms over the same element; absolute XPath) ---
(function attachHoverDetection() {
    const HOVER_THRESHOLD_MS = 500;
    const hoverTimers = new WeakMap(); // Element -> timeoutId
    const lastHoverBySelector = new Map(); // selector -> timestamp (dedupe window)
    const DEDUPE_MS = 1000;

    function clearTimer(el) {
        const t = hoverTimers.get(el);
        if (t) { try { clearTimeout(t); } catch (e) { } hoverTimers.delete(el); }
    }

    document.addEventListener('mouseover', (event) => {
        try {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const isInteractive = target.matches('a, button, [role="button"], [role="combobox"], [aria-haspopup], [data-testid*="trigger"], [class*="dropdown"], [class*="menu"]');
            if (!isInteractive) return;
            // If there's already a timer for this target, ignore re-entry
            if (hoverTimers.has(target)) return;

            const timerId = setTimeout(() => {
                hoverTimers.delete(target);
                // Build absolute XPath for target
                let selector = null;
                try {
                    const abs = generateAbsoluteXPath(target);
                    selector = abs ? trimNonInteractiveXPathTail(abs) : null;
                    if (abs === '/html') {
                        return;
                    }
                } catch (e) { selector = null; }
                if (!selector) return;

                // Dedupe rapid repeated hovers on the same selector
                const now = Date.now();
                const lastTs = lastHoverBySelector.get(selector) || 0;
                if (now - lastTs < DEDUPE_MS) return;
                lastHoverBySelector.set(selector, now);

                try {
                    chrome.runtime.sendMessage({
                        command: 'record_action',
                        data: {
                            type: 'Hover',
                            selector,
                            selectorType: 'XPath',
                            timestamp: now,
                            value: `Hovered on <${target.tagName.toLowerCase()}>`,
                            elementInfo: getElementInfo(target)
                        }
                    });
                } catch (e) { /* ignore */ }
            }, HOVER_THRESHOLD_MS);

            hoverTimers.set(target, timerId);

            const onMouseOut = () => { clearTimer(target); target.removeEventListener('mouseout', onMouseOut); };
            target.addEventListener('mouseout', onMouseOut, { once: true });
        } catch (e) { /* ignore */ }
    }, { passive: true });
})();