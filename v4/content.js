/**
 * content.js
 * Script injected into the page to record user interactions.
 * Listens to page events (click, change, input, etc.) and sends information back to background script.
 * Also handles HTML extraction requests.
 * Selector Strategy:
 *   ID -> Attributes -> Stable Classes -> Structure -> Text XPath -> Absolute XPath -> Tag Name.
 */

// Prevent multiple execution of this content script
(function () {
  if (window.__SELBAS_CONTENT_SCRIPT_LOADED__) {
    console.log(
      "Selenium Recorder: Content script already loaded, skipping re-execution."
    );
    return;
  }
  window.__SELBAS_CONTENT_SCRIPT_LOADED__ = true;

  console.log(
    "Selenium Recorder: Content script injected (v13 - improved class selectors)."
  ); // Version info for debugging

  // --- Inject API interceptor into page context (fetch + XHR) ---
  (function injectApiInterceptor() {
    // Intercept fetch/XHR and forward API information to background
    function serializeBody(body) {
      // Convert request body to recordable string
      try {
        if (!body) return null;
        if (typeof body === "string") return body;
        if (body instanceof URLSearchParams) return body.toString();
        if (body instanceof Blob) return "[Blob]";
        if (body instanceof ArrayBuffer) return "[ArrayBuffer]";
        return JSON.stringify(body);
      } catch (e) {
        return "[unserializable request body]";
      }
    }

    function shouldIgnoreUrl(url) {
      // Filter out ad domains and tracking URLs to reduce noise
      if (!url || typeof url !== "string") return false;
      const ignoredDomains = [
        "doubleclick.net",
        "googleads.g.doubleclick.net",
        "googlesyndication.com",
        "googleadservices.com",
        "google-analytics.com",
        "googletagmanager.com",
        "facebook.com/tr",
        "connect.facebook.net",
        "ads.yahoo.com",
        "amazon-adsystem.com",
      ];
      return ignoredDomains.some((domain) => url.includes(domain));
    }

    const __origFetch = window.fetch; // Preserve original fetch
    window.fetch = async function (input, init) {
      const url = typeof input === "string" ? input : input && input.url;
      const method =
        (init && init.method) ||
        (typeof input === "object" && input.method) ||
        "GET";
      const requestBody = init && init.body ? serializeBody(init.body) : null;
      const start = Date.now();

      // Skip intercepting ad/tracking requests to reduce noise
      if (shouldIgnoreUrl(url)) {
        return __origFetch.apply(this, arguments);
      }

      try {
        const response = await __origFetch.apply(this, arguments);
        const clone = response.clone();
        let text = null;
        try {
          text = await clone.text();
        } catch (e) {
          text = `[failed to read response body: ${e.message}]`;
        }
        let parsed = null;
        try {
          const ct = clone.headers.get && clone.headers.get("content-type");
          if (ct && ct.includes("application/json")) parsed = JSON.parse(text);
        } catch (e) {
          parsed = null;
        }
        window.postMessage(
          {
            // Send API results back to content script via postMessage
            __SELBAS_RECORDER_API__: true,
            source: "page",
            type: "fetch",
            url,
            method,
            requestBody,
            status: response.status,
            responseText: text,
            responseJson: parsed,
            timestamp: Date.now(),
            durationMs: Date.now() - start,
          },
          "*"
        );
        return response;
      } catch (err) {
        // Don't log errors for blocked requests (ad blockers, etc.)
        const errStr = String(err);
        if (
          !errStr.includes("ERR_BLOCKED_BY_CLIENT") &&
          !errStr.includes("NetworkError") &&
          !shouldIgnoreUrl(url)
        ) {
          window.postMessage(
            {
              __SELBAS_RECORDER_API__: true,
              source: "page",
              type: "fetch",
              url,
              method,
              requestBody,
              error: errStr,
              timestamp: Date.now(),
            },
            "*"
          );
        }
        throw err;
      }
    };

    const __origXhr = window.XMLHttpRequest; // Preserve original XHR
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

        // Skip intercepting ad/tracking requests to reduce noise
        if (shouldIgnoreUrl(_url)) {
          return origSend.apply(xhr, arguments);
        }

        this.addEventListener("readystatechange", function () {
          if (this.readyState === 4) {
            let responseText = null;
            try {
              responseText = this.responseText;
            } catch (e) {
              responseText = `[failed to read: ${e.message}]`;
            }
            let parsed = null;
            try {
              const ct =
                this.getResponseHeader &&
                this.getResponseHeader("content-type");
              if (ct && ct.includes("application/json"))
                parsed = JSON.parse(responseText);
            } catch (e) {
              parsed = null;
            }
            window.postMessage(
              {
                __SELBAS_RECORDER_API__: true,
                source: "page",
                type: "xhr",
                url: _url,
                method: _method,
                requestBody: _requestBody,
                status: this.status,
                responseText,
                responseJson: parsed,
                timestamp: Date.now(),
              },
              "*"
            );
          }
        });
        return origSend.apply(xhr, arguments);
      };
      return xhr;
    }
    try {
      window.XMLHttpRequest = ProxyXHR;
    } catch (e) {
      /* Some pages may prohibit overwriting */
    }
  })();

  // --- Inject dialog (alert/prompt/confirm) capture ---
  (function injectDialogHooks() {
    // Intercept alert/confirm/prompt to record dialog events
    try {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("dialog_hooks.js");
      script.onload = () => script.remove();
      script.onerror = () => {
        console.warn(
          "Failed to load dialog_hooks.js, falling back to direct injection"
        );
        script.remove();
      };
      document.documentElement.appendChild(script);
    } catch (e) {
      console.warn("Dialog hooks injection failed:", e);
    }
  })();

  // --- State ---
  let isListenerAttached = false; // Whether event listeners are attached
  let clickTimeout = null; // Used for debouncing rapid clicks
  let isComposingIME = false; // Whether in IME composition mode, avoid recording intermediate values

  // --- Helper Functions ---

  /**
   * Generates an Absolute XPath for a given element.
   * @param {Element} element The target HTML element.
   * @returns {string|null} The absolute XPath string or null if input is invalid.
   */
  function generateAbsoluteXPath(element) {
    // Generate absolute XPath (final fallback) with enhanced error handling
    if (!(element instanceof Element)) return null;

    // Early check for detached elements
    if (!element.isConnected || !document.contains(element)) {
      return null;
    }

    const parts = [];
    let currentElement = element;
    let iterationCount = 0;
    const MAX_ITERATIONS = 50; // Prevent infinite loops

    while (
      currentElement &&
      currentElement.nodeType === Node.ELEMENT_NODE &&
      iterationCount < MAX_ITERATIONS
    ) {
      iterationCount++;

      let index = 0;
      let hasSimilarSiblings = false;
      let sibling = currentElement.previousSibling;

      while (sibling) {
        if (
          sibling.nodeType === Node.ELEMENT_NODE &&
          sibling.nodeName === currentElement.nodeName
        ) {
          index++;
        }
        sibling = sibling.previousSibling;
      }

      // Check if index is necessary
      sibling = currentElement.nextSibling;
      while (sibling) {
        if (
          sibling.nodeType === Node.ELEMENT_NODE &&
          sibling.nodeName === currentElement.nodeName
        ) {
          hasSimilarSiblings = true;
          break;
        }
        sibling = sibling.nextSibling;
      }
      if (index === 0) {
        sibling = currentElement.previousSibling;
        while (sibling) {
          if (
            sibling.nodeType === Node.ELEMENT_NODE &&
            sibling.nodeName === currentElement.nodeName
          ) {
            hasSimilarSiblings = true;
            break;
          }
          sibling = sibling.previousSibling;
        }
      }

      const tagName = currentElement.nodeName.toLowerCase();
      const part =
        index > 0 || hasSimilarSiblings ? `${tagName}[${index + 1}]` : tagName;
      parts.unshift(part);

      if (tagName === "html") break;

      currentElement = currentElement.parentNode;

      // Safety check: if we reach document or null without finding html, break
      if (!currentElement || currentElement.nodeType === Node.DOCUMENT_NODE) {
        // If we didn't reach html naturally, we might be dealing with a detached node
        // or a shadow DOM element. Return what we have so far.
        if (parts.length === 0 || parts[0] !== "html") {
          // If we have parts but no html, prepend html for validity
          if (parts.length > 0 && parts[0] !== "html") {
            parts.unshift("html");
          }
        }
        break;
      }
    }

    // Handle case where we hit iteration limit
    if (iterationCount >= MAX_ITERATIONS) {
      return null;
    }

    return parts.length ? "/" + parts.join("/") : null;
  }

  // Make a safe XPath string literal from JS string (handles quotes)
  function xpathLiteral(s) {
    // Safely wrap string as XPath literal (handle quotes)
    if (s == null) return "''";
    const str = String(s);
    if (str.indexOf("'") === -1) return `'${str}'`;
    if (str.indexOf('"') === -1) return `"${str}"`;
    // Has both quotes -> build concat('...', '"', '...', "'", ...)
    const parts = str.split("'");
    const concatParts = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] !== "") concatParts.push(`'${parts[i]}'`);
      if (i < parts.length - 1) concatParts.push('"' + "'" + '"');
    }
    return `concat(${concatParts.join(", ")})`;
  }

  // Trim trailing non-interactive nodes from an XPath (e.g., '/svg' or '/path')
  function trimNonInteractiveXPathTail(xp) {
    // Trim non-interactive nodes from XPath tail (like svg/path)
    try {
      if (!xp || typeof xp !== "string") return xp;
      let out = xp;
      for (let i = 0; i < 2; i++) {
        // trim up to two levels just in case '/span/svg'
        const next = out.replace(/\/(?:svg|path)(?:\[\d+\])?$/i, "");
        if (next === out) break;
        out = next;
      }
      return out;
    } catch (e) {
      return xp;
    }
  }

  // Detect very weak selectors we should avoid using
  function isWeakSelector(sel) {
    // Determine if selector is very fragile (to avoid)
    try {
      if (!sel || typeof sel !== "string") return true;
      // Absolute body-level anchors like '/html/body/a' (optionally with index)
      if (/^\/html\/body\/a(?:\[\d+\])?$/i.test(sel)) return true;
      // Bare nth-child on anchor without attributes/classes (e.g., 'a:nth-child(8)')
      if (/^a\:nth-child\(\d+\)$/i.test(sel)) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  /**
   * Generate selector for drag operations - prefers ID-based selectors
   * @param {Element} el The element for which to generate a selector.
   * @returns {string|null} A selector string prioritizing IDs.
   */
  function generateDragSelector(el) {
    if (!(el instanceof Element)) return null;

    const tagName = el.nodeName.toLowerCase();

    // 1. Prefer data-dnd-kit-id attribute
    const dndKitId = el.getAttribute("data-dnd-kit-id");
    if (dndKitId) {
      const selector = `[data-dnd-kit-id="${CSS.escape(dndKitId)}"]`;
      try {
        if (document.querySelectorAll(selector).length === 1) {
          console.log(`✅ DND-Kit ID selector: ${selector}`);
          return selector;
        }
      } catch (e) {
        /* ignore */
      }
    }

    // 2. Use data-dnd-kit-droppable attribute (for droppable containers)
    const dndKitDroppable = el.getAttribute("data-dnd-kit-droppable");
    if (dndKitDroppable) {
      const selector = `[data-dnd-kit-droppable="${CSS.escape(
        dndKitDroppable
      )}"]`;
      try {
        if (document.querySelectorAll(selector).length === 1) {
          console.log(`✅ DND-Kit Droppable selector: ${selector}`);
          return selector;
        }
      } catch (e) {
        /* ignore */
      }
    }

    // 3. Use data-dnd-kit-drop-zone attribute
    const dndKitDropZone = el.getAttribute("data-dnd-kit-drop-zone");
    if (dndKitDropZone) {
      const selector = `[data-dnd-kit-drop-zone="${CSS.escape(
        dndKitDropZone
      )}"]`;
      try {
        if (document.querySelectorAll(selector).length === 1) {
          console.log(`✅ DND-Kit Drop Zone selector: ${selector}`);
          return selector;
        }
      } catch (e) {
        /* ignore */
      }
    }

    // 4. Use regular id attribute
    if (el.id) {
      const id = el.id;
      // Relax stable ID conditions, only exclude obvious framework-generated IDs
      const unstableIdRegex =
        /^(?:radix-|ember-|data-v-|svelte-|ui-id-|aria-|temp-|auto-|react-)/i;
      const looksUnstable =
        unstableIdRegex.test(id) || id.length > 80 || /^\d+$/.test(id);

      if (!looksUnstable) {
        const selector = `#${CSS.escape(id)}`;
        try {
          if (document.querySelectorAll(selector).length === 1) {
            console.log(`✅ Drag ID selector: ${selector}`);
            return selector;
          }
        } catch (e) {
          /* ignore */
        }
      }
    }

    // 5. Check if parent elements have suitable attributes
    let parent = el.parentElement;
    while (parent && parent !== document.body) {
      // Check parent element's droppable attribute
      const parentDroppable = parent.getAttribute("data-dnd-kit-droppable");
      if (parentDroppable) {
        const selector = `[data-dnd-kit-droppable="${CSS.escape(
          parentDroppable
        )}"]`;
        try {
          if (document.querySelectorAll(selector).length === 1) {
            console.log(`✅ Parent Droppable selector: ${selector}`);
            return selector;
          }
        } catch (e) {
          /* ignore */
        }
      }

      // Check parent element's ID
      if (parent.id && !parent.id.match(/^(?:radix-|ember-|data-v-)/i)) {
        // If parent has stable ID, use child selector
        const parentSelector = `#${CSS.escape(parent.id)}`;
        const childSelector = `${parentSelector} ${tagName}`;
        try {
          if (document.querySelectorAll(childSelector).length === 1) {
            console.log(`✅ Child selector: ${childSelector}`);
            return childSelector;
          }
          // If there are multiple children of same type, use nth-child
          const siblings = parent.querySelectorAll(tagName);
          if (siblings.length > 1) {
            for (let i = 0; i < siblings.length; i++) {
              if (siblings[i] === el) {
                const nthSelector = `${parentSelector} ${tagName}:nth-child(${
                  i + 1
                })`;
                console.log(`✅ nth-child selector: ${nthSelector}`);
                return nthSelector;
              }
            }
          }
        } catch (e) {
          /* ignore */
        }
      }
      parent = parent.parentElement;
    }

    // 6. Fallback to regular robust selector
    console.log(`⚠️ Drag selector falling back to regular selector`);
    return generateRobustSelector(el);
  }

  /**
   * Generates multiple fallback selectors for a given HTML element.
   * Returns an array of selectors in priority order for use in findWorkingSelector.
   * @param {Element} el The target HTML element.
   * @returns {Array<string>} Array of selector strings (CSS and XPath)
   */
  function generateSelectorList(el) {
    if (!(el instanceof Element)) return [];
    
    const selectors = [];
    const tagName = el.tagName.toLowerCase();

    // 1. ID-based selectors (if element has id)
    if (el.id) {
      const id = el.id;
      
      // CSS ID selector
      try {
        const cssSelector = `#${CSS.escape(id)}`;
        if (document.querySelectorAll(cssSelector).length === 1) {
          selectors.push(cssSelector);
        }
      } catch (e) { /* ignore */ }
      
      // XPath ID selector
      try {
        const xpathSelector = `//*[@id="${id}"]`;
        if (document.evaluate(xpathSelector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength === 1) {
          selectors.push(xpathSelector);
        }
      } catch (e) { /* ignore */ }
    }

    // 2. data-testid selectors (if exists)
    const testId = el.getAttribute("data-testid");
    if (testId) {
      try {
        const cssSelector = `[data-testid="${CSS.escape(testId)}"]`;
        if (document.querySelectorAll(cssSelector).length === 1) {
          selectors.push(cssSelector);
        }
      } catch (e) { /* ignore */ }
      
      try {
        const xpathSelector = `//*[@data-testid="${testId}"]`;
        if (document.evaluate(xpathSelector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength === 1) {
          selectors.push(xpathSelector);
        }
      } catch (e) { /* ignore */ }
    }

    // 3. Class-based CSS selector (if has stable classes)
    if (el.classList && el.classList.length > 0) {
      const forbiddenClassesRegex = /^(?:active|focus|hover|selected|checked|disabled|visited|focus-within|focus-visible|focusNow|open|opened|closed|collapsed|expanded|js-|ng-|is-|has-|ui-|data-v-|aria-|css-|__recording_highlight__|__recording_)/i;
      const stableClasses = Array.from(el.classList)
        .map((c) => c.trim())
        .filter((c) => c && !forbiddenClassesRegex.test(c) && /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(c));

      if (stableClasses.length > 0) {
        let baseSelector = `${tagName}.${stableClasses.map((c) => CSS.escape(c)).join(".")}`;
        try {
          if (document.querySelectorAll(baseSelector).length === 1) {
            selectors.push(baseSelector);
          }
        } catch (e) { /* ignore */ }
      }
    }

    // 4. Absolute XPath (always add as final fallback)
    try {
      const absXPath = generateAbsoluteXPath(el);
      if (absXPath) {
        selectors.push(trimNonInteractiveXPathTail(absXPath));
      }
    } catch (e) { /* ignore */ }

    // If no selectors generated, add tagName as last resort
    if (selectors.length === 0) {
      selectors.push(tagName);
    }

    return selectors;
  }

  /**
   * Generates a CSS or XPath selector for a given HTML element.
   * Prioritization: ID -> Name -> data-testid -> role -> title -> Combined Class + Structure -> Text XPath -> Absolute XPath -> Basic TagName.
   * Returns XPath selectors (now WITHOUT the historical 'xpath=' prefix; backward compatible handling kept elsewhere).
   * @param {Element} el The target HTML element.
   * @returns {string|null} A selector string (CSS or XPath) or null.
   */
  function generateRobustSelector(el) {
    // Generate more robust selector (prioritize stable attributes/classes, then fallback to XPath)
    if (!(el instanceof Element)) return null;
    const originalEl = el;
    // If target is an icon or non-interactive, promote to closest clickable ancestor
    let promotedToAncestor = false;
    try {
      const nonInteractiveTags = ["svg", "path", "i", "span"];
      const initialTag = el.tagName ? el.tagName.toLowerCase() : "";
      if (nonInteractiveTags.includes(initialTag)) {
        const ancestor = el.closest(
          'button, a[href], [role="button"], .ant-btn, [onclick], [tabindex]:not([tabindex="-1"])'
        );
        if (ancestor && ancestor !== el) {
          el = ancestor;
          promotedToAncestor = true;
        }
      }
    } catch (e) {
      /* ignore */
    }
    const tagName = el.tagName.toLowerCase();
    // Special case: Ant Design Select search input, prefer visible combobox wrapper
    try {
      if (tagName === "input") {
        const t = (el.getAttribute("type") || "").toLowerCase();
        if (t === "search") {
          const isAntdSearch =
            (el.classList &&
              el.classList.contains("ant-select-selection-search-input")) ||
            (typeof el.id === "string" && /^rc_select_/i.test(el.id)) ||
            (typeof el.getAttribute === "function" &&
              /^rc_select_/i.test(el.getAttribute("aria-controls") || ""));
          if (isAntdSearch) {
            // Prefer closest role=combobox (visible clickable wrapper)
            const combo =
              el.closest('[role="combobox"]') ||
              el.closest(".ant-select") ||
              el.parentElement;
            if (combo && combo !== el && combo instanceof Element) {
              const comboAbs = generateAbsoluteXPath(combo);
              if (comboAbs) return comboAbs;
            }
            // Fallback to the input itself if no wrapper found
            const abs = generateAbsoluteXPath(el);
            if (abs) return abs;
          }
        }
        // Special case: Many UI libraries (MUI Autocomplete, react-select) have very narrow internal input boxes
        // When aria-autocomplete is list/both and input width is very small, prefer visible wrapper
        try {
          const ariaAuto = (
            el.getAttribute("aria-autocomplete") || ""
          ).toLowerCase();
          if (ariaAuto === "list" || ariaAuto === "both") {
            let widthPx = 0;
            try {
              widthPx =
                (el.getBoundingClientRect &&
                  el.getBoundingClientRect().width) ||
                0;
            } catch (e) {}
            if (!widthPx) {
              try {
                const cs = getComputedStyle(el);
                widthPx =
                  parseFloat(
                    cs && cs.width ? cs.width.replace("px", "") : "0"
                  ) || 0;
              } catch (e) {
                /* ignore */
              }
            }
            if (!widthPx) {
              try {
                const m = (el.getAttribute("style") || "").match(
                  /width\s*:\s*(\d+(?:\.\d+)?)px/i
                );
                if (m) widthPx = parseFloat(m[1]);
              } catch (e) {
                /* ignore */
              }
            }
            if (widthPx > 0 && widthPx <= 6) {
              const combo = el.closest(
                '[role="combobox"], [aria-haspopup="listbox"], [class*="__control"], [class*="__value-container"], .MuiAutocomplete-root, .react-select__control, [class*="auto-complete"]'
              );
              if (combo && combo !== el && combo instanceof Element) {
                const comboAbs = generateAbsoluteXPath(combo);
                if (comboAbs) return comboAbs;
              }
            }
          }
        } catch (e) {
          /* ignore tiny autocomplete handling */
        }
      }
    } catch (e) {
      /* ignore */
    }
    // console.log(`generateRobustSelector: Finding selector for <${tagName}>`, el); // Optional debug

    // --- Simplified Priority: ID XPath ONLY, then Absolute XPath ---

    // 1. ID XPath (ONLY if element has id attribute)
    if (el.id) {
      const id = el.id;
      console.log(`[ID Check] Element has ID: "${id}"`);
      // Use ID XPath directly without stability checks
      try {
        const xpathSelector = `//*[@id="${id}"]`;
        const snapshotLength = document.evaluate(
          xpathSelector,
          document,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null
        ).snapshotLength;
        console.log(
          `[ID Check] XPath selector "${xpathSelector}" matches: ${snapshotLength}`
        );
        if (snapshotLength === 1) {
          console.log(
            `✅ Priority 1: Using ID XPath selector: ${xpathSelector}`
          );
          return xpathSelector;
        }
      } catch (e) {
        console.error(`[ID Check] XPath selector failed:`, e);
      }
    } else {
      console.log(`[ID Check] Element has NO ID`);
    }

    // 2. Absolute XPath (fallback for all cases without ID)
    console.log("✅ Priority 2: Using Absolute XPath...");
    try {
      let absXPath = generateAbsoluteXPath(el);
      if (absXPath) {
        console.log(`✅ Priority 2: Using Absolute XPath: ${absXPath}`);
        return trimNonInteractiveXPathTail(absXPath);
      } else {
        console.error(
          "generateRobustSelector: generateAbsoluteXPath returned null."
        );
      }
    } catch (e) {
      console.warn("Error during Absolute XPath generation:", e);
    }

    // 3. Final fallback: use tagName only (strongly discouraged, only when everything else fails)
    console.error(
      `generateRobustSelector: CRITICAL FALLBACK to basic tag name for element:`,
      el
    );
    return tagName;
  }

  /**
   * Extracts relevant information from an element for selector generation.
   * @param {Element} element
   * @returns {object} Simplified info { tagName, id, name, className }
   */
  function getElementInfo(element) {
    // Extract basic element information (for UI display and debugging)
    if (!element) return null;
    return {
      tagName: element.tagName,
      id: element.id,
      name: element.getAttribute("name"),
      className: element.className,
    };
  }

  /**
   * 將錄製的 action 數據發送到用戶的 API
   * @param {Element} element - 被操作的 HTML 元素
   * @param {string} actionType - 操作類型 (click, input, select 等)
   * @param {Object} actionData - 完整的 action 數據
   */
  async function sendActionToAPI(element, actionType, actionData) {
    try {
      // 只有在錄製進行中時才發送到 API
      if (!isListenerAttached) {
        console.log("[API] Recording not active, skipping API call");
        return;
      }

      if (!element || !actionData) {
        console.log("[API] Missing element or action data, skipping API call");
        return;
      }

      // 獲取當前頁面 URL
      const pageUrl = window.location.href;
      //create page if not exists
      if(pageUrl!==window.location.href){
        const createPageAPIPayload = {
          pages: [
            {
              pageName: document.title || "",
              pageUrl: window.location.href,
              content: document.documentElement.outerHTML,
            },
          ],
        };
        console.log("[API] Sending new page data to API:", createPageAPIPayload);
        const createPageResponse = await fetch("http://127.0.0.1:5000/api/create_pages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(createPageAPIPayload),
        });
        if (createPageResponse.ok) {
          const createPageResult = await createPageResponse.json();
          console.log("[API] ✅ Page data sent successfully:", createPageResult);
        } else {
          console.log(
            "[API] ❌ Failed to send page data:",
            createPageResponse.status,
            createPageResponse.statusText
          );
        }
      }

      // 提取元素基本信息
      const tagName = element.tagName
        ? element.tagName.toLowerCase()
        : "unknown";

      // 根據 actionType 和 tagName 確定 type
      let type = actionType;
      if (tagName === "a") {
        type = "link";
      } else if (
        tagName === "button" ||
        (tagName === "input" && element.type === "submit")
      ) {
        type = "button";
      } else if (tagName === "input") {
        type = element.type || "text";
      } else if (tagName === "select") {
        type = "select";
      } else if (tagName === "textarea") {
        type = "textarea";
      }

      // 提取元素文字內容
      const text = element.textContent
        ? element.textContent.trim()
        : element.value ||
          element.getAttribute("placeholder") ||
          element.getAttribute("title") ||
          element.getAttribute("alt") ||
          `${tagName} element`;

      // 生成 locators
      const locators = {};

      // ID - 被操作元素的 ID 屬性
      if (element.id) {
        locators.id = element.id;
      }

      // Name - name 屬性
      if (element.name || element.getAttribute("name")) {
        locators.name = element.name || element.getAttribute("name");
      }

      // CSS Selector - 生成 CSS 定位器
      try {
        let cssSelector = tagName;
        if (element.id) {
          cssSelector = `#${element.id}`;
        } else if (element.className) {
          const classes = element.className
            .split(" ")
            .filter((c) => c.trim())
            .slice(0, 2);
          if (classes.length > 0) {
            cssSelector = `${tagName}.${classes.join(".")}`;
          }
        }
        locators.css = cssSelector;
      } catch (e) {
        locators.css = tagName;
      }

      // XPath - 使用 action 中的 selector 或生成新的
      if (actionData.selector && actionData.selectorType === "XPath") {
        locators.xpath = actionData.selector;
      } else {
        try {
          const xpath = generateAbsoluteXPath(element);
          if (xpath) {
            locators.xpath = xpath;
          }
        } catch (e) {
          console.log("[API] Error generating XPath:", e);
        }
      }

      // CSS 樣式屬性 (attributes)
      const attributes = {};

      // 提取 CSS 相關的樣式屬性
      if (element.style && element.style.cssText) {
        // 解析 inline style
        const styleText = element.style.cssText;
        if (styleText) {
          attributes.style = styleText;
        }
      }

      // 提取 computed styles 的重要屬性
      try {
        const computedStyle = window.getComputedStyle(element);
        if (computedStyle) {
          // 選取重要的 CSS 屬性
          const importantStyleProps = [
            "color",
            "background-color",
            "font-size",
            "font-weight",
            "width",
            "height",
            "margin",
            "padding",
            "border",
            "display",
            "position",
            "z-index",
          ];

          importantStyleProps.forEach((prop) => {
            const value = computedStyle.getPropertyValue(prop);
            if (
              value &&
              value !== "auto" &&
              value !== "normal" &&
              value !== "inherit"
            ) {
              attributes[prop] = value;
            }
          });
        }
      } catch (e) {
        console.log("[API] Error getting computed styles:", e);
      }

      // 也包含一些重要的 HTML 屬性作為參考
      if (element.className) {
        attributes.class = element.className;
      }
      if (element.getAttribute("href")) {
        attributes.href = element.getAttribute("href");
      }
      if (element.getAttribute("src")) {
        attributes.src = element.getAttribute("src");
      }

      // 構建發送到 API 的 payload - 按照用戶指定的格式
      const payload = {
        pageUrl: pageUrl, // Mandatory field
        tagName: tagName, // Mandatory field
        type: type,
        text: text.substring(0, 200), // 限制文字長度
        locators: locators,
        attributes: attributes,
      };

      console.log("[API] Sending action data to API:", payload);

      // 發送到用戶的 API 端點
      const response = await fetch(
        "http://127.0.0.1:5000/api/create_new_element",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      );

      if (response.ok) {
        const result = await response.json();
        console.log("[API] ✅ Action data sent successfully:", result);
      } else {
        console.log(
          "[API] ❌ Failed to send action data:",
          response.status,
          response.statusText
        );
      }
    } catch (error) {
      console.log("[API] ❌ Error sending action data to API:", error);
      // 不要讓 API 錯誤影響正常的錄製功能
    }
  }

  /**
   * Gets the closest anchor selector for a given element, if available.
   * @param {Element} el The target HTML element.
   * @returns {string|null} The anchor selector string or null if not applicable.
   */
  function getClosestAnchorSelector(el) {
    // Try to find nearest anchor tag and generate selector
    try {
      console.log(
        "getClosestAnchorSelector: Finding closest anchor for element:",
        el
      ); // Optional debug
      if (!el || !(el instanceof Element)) return null;
      const anchor = el.closest("a");
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
  function handleClick(event) {
    // Handle click events; if hitting icon/svg, find clickable ancestor (using absolute XPath)
    try {
      const rawTarget = event.target;
      if (!rawTarget) return;

      // CRITICAL FIX: If there's a currently focused input element, trigger its blur event first
      // This ensures the input action is recorded before the click action
      const activeElement = document.activeElement;
      if (
        activeElement &&
        activeElement !== rawTarget &&
        activeElement !== document.body
      ) {
        const isTextInput =
          (activeElement.tagName === "INPUT" &&
            /^(text|password|search|email|url|tel|number)$/i.test(
              activeElement.type || "text"
            )) ||
          activeElement.tagName === "TEXTAREA";

        if (isTextInput) {
          console.log(
            "[CLICK] Triggering blur on previously focused input before handling click"
          );
          // Trigger blur event synchronously to ensure proper ordering
          activeElement.blur();
          // Give a tiny delay to let the blur event handler complete
          // This is processed synchronously in the same call stack
        }
      }

      // ENHANCED PRECISION: Always use coordinates to find the most accurate target
      const clickX = event.clientX;
      const clickY = event.clientY;
      const elementAtPoint = document.elementFromPoint(clickX, clickY);

      console.log(
        `[CLICK-DEBUG] Raw target: ${rawTarget.tagName} (${rawTarget.className})`
      );
      console.log(
        `[CLICK-DEBUG] Element at point: ${
          elementAtPoint ? elementAtPoint.tagName : "null"
        } (${elementAtPoint ? elementAtPoint.className : "null"})`
      );

      let actualTarget = rawTarget;

      // PRIORITY 0: Ant Design Select options - use data-* attributes and text content
      if (elementAtPoint) {
        const antSelectItem = elementAtPoint.closest(
          '.ant-select-item, .ant-select-item-option, [class*="rc-select-item"]'
        );
        if (antSelectItem) {
          console.log(
            `[CLICK] 🎯 ANT DESIGN SELECT ITEM detected:`,
            antSelectItem
          );
          console.log(`[CLICK] Item text:`, antSelectItem.textContent);
          console.log(`[CLICK] Item classes:`, antSelectItem.className);
          actualTarget = antSelectItem;
        }

        // PRIORITY 0.5: Ant Design Radio Button - find the actual radio input
        const antRadioWrapper = elementAtPoint.closest(
          ".ant-radio-button-wrapper, .ant-radio-wrapper"
        );
        if (antRadioWrapper) {
          // Find the actual radio input inside the wrapper
          const radioInput = antRadioWrapper.querySelector(
            'input[type="radio"]'
          );
          if (radioInput) {
            console.log(
              `[CLICK] 🎯 ANT DESIGN RADIO BUTTON detected:`,
              radioInput
            );
            console.log(`[CLICK] Radio value:`, radioInput.value);
            console.log(
              `[CLICK] Radio wrapper text:`,
              antRadioWrapper.textContent.trim()
            );
            actualTarget = radioInput;
          } else {
            console.log(
              `[CLICK] ⚠️ ANT DESIGN RADIO WRAPPER found but no input:`,
              antRadioWrapper
            );
            actualTarget = antRadioWrapper;
          }
        }
      }

      // PRIORITY 1: If elementAtPoint is an LI inside a UL/OL, ALWAYS prefer the LI
      if (
        elementAtPoint &&
        elementAtPoint.tagName &&
        elementAtPoint.tagName.toLowerCase() === "li"
      ) {
        const parentList = elementAtPoint.closest("ul, ol");
        if (
          parentList &&
          (rawTarget === parentList || parentList.contains(rawTarget))
        ) {
          console.log(
            `[CLICK] 🎯 FORCE using LI instead of container:`,
            elementAtPoint
          );
          actualTarget = elementAtPoint;
        }
      }
      // PRIORITY 1.5: If rawTarget is inside an LI, use the LI instead
      else if (rawTarget.closest && rawTarget.closest("li")) {
        const liElement = rawTarget.closest("li");
        console.log(
          `[CLICK] 🎯 FOUND LI ancestor for ${rawTarget.tagName}:`,
          liElement
        );
        actualTarget = liElement;
      }
      // PRIORITY 2: If rawTarget is UL/OL and elementAtPoint is different, prefer elementAtPoint
      else if (
        rawTarget.tagName &&
        ["ul", "ol"].includes(rawTarget.tagName.toLowerCase()) &&
        elementAtPoint &&
        elementAtPoint !== rawTarget &&
        rawTarget.contains(elementAtPoint)
      ) {
        console.log(
          `[CLICK] 🎯 REPLACING ${rawTarget.tagName} with ${elementAtPoint.tagName}:`,
          elementAtPoint
        );
        actualTarget = elementAtPoint;
      }
      // PRIORITY 3: General container replacement logic
      else if (elementAtPoint && elementAtPoint !== rawTarget) {
        // Check if rawTarget is a container element
        const isContainerElement =
          rawTarget.tagName &&
          [
            "ul",
            "ol",
            "nav",
            "menu",
            "section",
            "article",
            "header",
            "footer",
            "aside",
          ].includes(rawTarget.tagName.toLowerCase());

        // Check if elementAtPoint is a more specific interactive element
        const isMoreSpecific =
          elementAtPoint.tagName &&
          [
            "li",
            "a",
            "button",
            "span",
            "div",
            "p",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "label",
            "td",
            "th",
          ].includes(elementAtPoint.tagName.toLowerCase());

        if (
          isContainerElement &&
          isMoreSpecific &&
          rawTarget.contains(elementAtPoint)
        ) {
          console.log(
            `[CLICK] ✅ Refining container ${rawTarget.tagName} to ${elementAtPoint.tagName}:`,
            elementAtPoint
          );
          actualTarget = elementAtPoint;
        }
      }

      console.log(
        `[CLICK-FINAL] Using target: ${actualTarget.tagName} (${actualTarget.className})`
      );

      // Store if we deliberately chose a specific target (like LI over UL)
      const wasTargetRefined = actualTarget !== rawTarget;

      const clickableAncestor =
        actualTarget.closest &&
        actualTarget.closest(
          'button, a[href], [role="button"], .ant-btn, [onclick], [tabindex]:not([tabindex="-1"]), [role="combobox"], [aria-haspopup="listbox"], [class*="__control"], [class*="__value-container"], [class*="auto-complete"]'
        );
      const anchorEl = clickableAncestor
        ? clickableAncestor.closest && clickableAncestor.closest("a")
        : actualTarget.closest
        ? actualTarget.closest("a")
        : null;

      // CRITICAL: If we refined the target (e.g., LI from UL), don't let clickableAncestor override it
      let targetForSelector;
      if (
        wasTargetRefined &&
        clickableAncestor &&
        ["ul", "ol", "nav", "menu"].includes(
          clickableAncestor.tagName.toLowerCase()
        )
      ) {
        console.log(
          `[CLICK] 🚫 Preventing clickableAncestor override: keeping ${actualTarget.tagName} instead of ${clickableAncestor.tagName}`
        );
        targetForSelector = actualTarget; // Keep our refined target
      } else {
        targetForSelector = clickableAncestor || anchorEl || actualTarget;
      }

      // Generate multiple fallback selectors
      let selector = null;
      let selectorList = [];
      try {
        // Special handling for Ant Design Select items
        if (
          targetForSelector.matches &&
          targetForSelector.matches(
            '.ant-select-item, .ant-select-item-option, [class*="rc-select-item"]'
          )
        ) {
          const optionText = targetForSelector.textContent.trim();
          const titleAttr = targetForSelector.getAttribute("title");
          const dataValue = targetForSelector.getAttribute("data-value");

          console.log(
            `[CLICK] 🎯 Generating selector for Ant Design Select option:`,
            optionText
          );

          // Build a more reliable XPath using text content
          if (optionText) {
            // Use text-based XPath that is more stable
            selector = `//*[contains(@class, 'ant-select-item') and normalize-space(text())='${optionText}']`;
            console.log(`[CLICK] ✅ Using text-based selector: ${selector}`);
          } else if (titleAttr) {
            selector = `//*[contains(@class, 'ant-select-item') and @title='${titleAttr}']`;
            console.log(`[CLICK] ✅ Using title-based selector: ${selector}`);
          } else if (dataValue) {
            selector = `//*[contains(@class, 'ant-select-item') and @data-value='${dataValue}']`;
            console.log(`[CLICK] ✅ Using data-value selector: ${selector}`);
          } else {
            // Fallback to absolute XPath
            const abs = generateAbsoluteXPath(targetForSelector);
            selector = abs ? trimNonInteractiveXPathTail(abs) : null;
          }
          selectorList = selector ? [selector] : [];
        }
        // Special handling for Ant Design Radio buttons
        else if (
          targetForSelector.matches &&
          targetForSelector.matches('input[type="radio"]') &&
          targetForSelector.closest &&
          targetForSelector.closest(
            ".ant-radio-button-wrapper, .ant-radio-wrapper"
          )
        ) {
          const radioValue = targetForSelector.value;
          const wrapper = targetForSelector.closest(
            ".ant-radio-button-wrapper, .ant-radio-wrapper"
          );
          const labelText = wrapper ? wrapper.textContent.trim() : "";

          console.log(
            `[CLICK] 🎯 Generating selector for Ant Design Radio button:`,
            radioValue,
            labelText
          );

          // Build a reliable XPath using value attribute
          if (radioValue !== undefined && radioValue !== "") {
            selector = `//input[@type='radio' and @value='${radioValue}']`;
            console.log(`[CLICK] ✅ Using value-based selector: ${selector}`);
          } else if (labelText) {
            // Use label text if no value
            selector = `//*[contains(@class, 'ant-radio-button-wrapper') and normalize-space(text())='${labelText}']//input[@type='radio']`;
            console.log(
              `[CLICK] ✅ Using label-text-based selector: ${selector}`
            );
          } else {
            // Fallback to absolute XPath
            const abs = generateAbsoluteXPath(targetForSelector);
            selector = abs ? trimNonInteractiveXPathTail(abs) : null;
          }
          selectorList = selector ? [selector] : [];
        } else {
          // Normal selector generation - generate multiple fallback selectors
          selectorList = generateSelectorList(targetForSelector);
          selector = selectorList.length > 0 ? selectorList[0] : null;
        }
        console.log(
          `Content: Generated click selectors for element:`,
          targetForSelector,
          `primary: ${selector}`,
          `list: [${selectorList.join(', ')}]`
        );
      } catch (e) {
        console.error("Content: Error generating selector:", e);
        selector = null;
        selectorList = [];
      }
      if (!selector) return; // Skip if unable to generate XPath
      const anchorSelector = anchorEl
        ? (function () {
            const a = generateAbsoluteXPath(anchorEl);
            return a ? trimNonInteractiveXPathTail(a) : null;
          })()
        : null;

      // anchor attributes
      const anchorTarget = anchorEl
        ? anchorEl.getAttribute("target") || null
        : null;
      const anchorHref = anchorEl
        ? anchorEl.getAttribute("href") || anchorEl.href || null
        : null;
      const anchorOnclick = anchorEl
        ? anchorEl.getAttribute("onclick") || null
        : null;

      const action = {
        type: "Click",
        selector: selector,
        selectorList: selectorList, // Array of fallback selectors
        selectorType:
          selector &&
          (selector.startsWith("xpath=") || selector.startsWith("/"))
            ? "XPath"
            : "CSS",
        elementInfo: getElementInfo(actualTarget), // Use the actual target for element info
        anchorSelector: anchorSelector,
        anchorTarget: anchorTarget,
        anchorHref: anchorHref,
        anchorOnclick: anchorOnclick,
        timestamp: Date.now(),
      };

      // If inline onclick contains popupWindow('...'), try to parse URL and notify background early
      try {
        if (anchorOnclick) {
          const m = anchorOnclick.match(/popupWindow\s*\(\s*['"]([^'"]+)['"]/i);
          if (m && m[1]) {
            try {
              chrome.runtime.sendMessage({
                command: "popup_opened",
                data: { url: m[1], via: "onclick", timestamp: Date.now() },
              });
            } catch (e) {
              /* ignore */
            }
          }
        }
      } catch (e) {
        /* ignore parsing errors */
      }

      try {
        chrome.runtime.sendMessage({ command: "record_action", data: action });

        // 將 action 數據發送到用戶的 API
        sendActionToAPI(targetForSelector, "click", action);
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
    // Listen to change: handle select/file/checkbox (using robust selector with ID priority)
    const targetElement = event.target;
    const tagName = targetElement.tagName.toLowerCase();
    let actionData = null;

    // console.log(`handleChange: Detected change on <${tagName}>`, targetElement); // Optional debug
    let selector = null;
    let selectorList = [];
    try {
      selectorList = generateSelectorList(targetElement);
      selector = selectorList.length > 0 ? selectorList[0] : null;
    } catch (e) {
      selector = null;
      selectorList = [];
    }
    if (!selector) {
      console.warn(
        `handleChange: Could not generate selector for <${tagName}> element:`,
        targetElement
      );
      return;
    }

    // <select>: record selected value
    if (tagName === "select") {
      actionData = {
        type: "Select",
        selector: selector,
        selectorList: selectorList,
        value: targetElement.value,
        selectorType: "XPath",
        timestamp: Date.now(),
      };
    }
    // <input type="range"> (slider): record final value (horizontal/vertical both supported; mainly handling horizontal sliders here)
    else if (tagName === "input" && targetElement.type === "range") {
      try {
        const currentValue = targetElement.value;
        const min = targetElement.getAttribute("min");
        const max = targetElement.getAttribute("max");
        const step = targetElement.getAttribute("step");
        actionData = {
          type: "Slider",
          selector: selector,
          selectorList: selectorList,
          value: String(targetElement.value),
          min: min != null ? String(min) : null,
          max: max != null ? String(max) : null,
          step: step != null ? String(step) : null,
          sliderKind: "native", // Native input[type=range]
          selectorType: "XPath",
          timestamp: Date.now(),
        };
      } catch (e) {
        console.warn(
          "handleChange: Failed to collect input[type=range] data:",
          e
        );
      }
    }
    // <input type="file"> (upload): read file names and try to embed files in zip
    else if (tagName === "input" && targetElement.type === "file") {
      try {
        const files = Array.from(targetElement.files || []);
        const fileNames = files
          .map((f) => (f && f.name ? f.name : ""))
          .filter(Boolean);
        actionData = {
          type: "Upload",
          method: "click", // Distinguish from drag-drop file upload
          selector: selector,
          selectorList: selectorList,
          value: fileNames.join(", "), // Display in side panel
          fileNames: fileNames, // Extra metadata for generator
          fileCount: fileNames.length,
          selectorType: "XPath",
          timestamp: Date.now(),
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
              if (typeof dataUrl === "string") {
                try {
                  chrome.runtime.sendMessage({
                    command: "upload_file",
                    data: { name: f.name, dataUrl },
                  });
                } catch (e) {}
              }
            };
            reader.onerror = () => {
              /* ignore */
            };
            reader.readAsDataURL(f);
          } catch (e) {
            /* ignore per-file */
          }
        });
      } catch (e) {
        console.warn(
          "handleChange: Failed to read files from input[type=file]:",
          e
        );
      }
    }
    // <input type="checkbox">: record final checked state
    else if (tagName === "input" && targetElement.type === "checkbox") {
      // Check if this checkbox was previously disabled and might require scroll-to-enable
      let needsScrollToEnable = false;
      let scrollArea = null;

      try {
        // Look for specific scroll areas that might control this checkbox
        // 1. First try by CSS classes and IDs that indicate scrollable content
        const specificScrollAreas = document.querySelectorAll(
          '.scroll-area, #scrollArea, [class*="scroll"], .scroll-container'
        );
        for (const container of specificScrollAreas) {
          if (container.scrollHeight > container.clientHeight) {
            const containerRect = container.getBoundingClientRect();
            const checkboxRect = targetElement.getBoundingClientRect();

            // Check if checkbox is below this scroll container (typical pattern)
            const isBelow =
              checkboxRect.top > containerRect.bottom &&
              checkboxRect.top < containerRect.bottom + 200;
            const horizontalOverlap = !(
              containerRect.right < checkboxRect.left ||
              containerRect.left > checkboxRect.right
            );

            if (isBelow && horizontalOverlap) {
              needsScrollToEnable = true;
              scrollArea = container;
              console.log(
                "[CHECKBOX] Detected scroll-to-enable pattern with specific scroll area:",
                container
              );
              break;
            }
          }
        }

        // 2. If not found, look for general containers with overflow styles
        if (!needsScrollToEnable) {
          const scrollContainers = document.querySelectorAll(
            '[style*="overflow"], [style*="scroll"]'
          );
          for (const container of scrollContainers) {
            const style = getComputedStyle(container);
            if (style.overflowY === "auto" || style.overflowY === "scroll") {
              const containerRect = container.getBoundingClientRect();
              const checkboxRect = targetElement.getBoundingClientRect();

              // Check if checkbox is visually near this scroll container
              const verticalDistance = Math.abs(
                containerRect.bottom - checkboxRect.top
              );
              const horizontalOverlap = !(
                containerRect.right < checkboxRect.left ||
                containerRect.left > checkboxRect.right
              );

              if (verticalDistance < 100 && horizontalOverlap) {
                needsScrollToEnable = true;
                scrollArea = container;
                console.log(
                  "[CHECKBOX] Detected scroll-to-enable pattern with overflow container:",
                  container
                );
                break;
              }
            }
          }
        }
      } catch (e) {
        console.warn("[CHECKBOX] Error detecting scroll pattern:", e);
      }

      actionData = {
        type: "Checkbox",
        selector: selector,
        selectorList: selectorList,
        value: targetElement.checked, // The final state (true/false)
        selectorType: "XPath",
        timestamp: Date.now(),
        // Add metadata for scroll-to-enable pattern
        needsScrollToEnable: needsScrollToEnable,
        scrollAreaSelector: scrollArea
          ? (() => {
              try {
                const scrollAbs = generateAbsoluteXPath(scrollArea);
                return scrollAbs
                  ? trimNonInteractiveXPathTail(scrollAbs)
                  : null;
              } catch (e) {
                return null;
              }
            })()
          : null,
      };
    }
    // <input type="radio">: record radio button selected state
    else if (tagName === "input" && targetElement.type === "radio") {
      actionData = {
        type: "Radio",
        selector: selector,
        selectorList: selectorList,
        value: targetElement.checked, // Should be true when selected
        radioValue: targetElement.value, // The value attribute of the radio button
        radioName: targetElement.name, // The name attribute (group identifier)
        selectorType: "XPath",
        timestamp: Date.now(),
      };
    }
    // Note: Regular text input not recorded in change events to avoid duplication; handled by input events below in real-time.

    // Send the recorded action if one was created
    if (actionData) {
      console.log("handleChange: Action recorded (Content):", actionData);
      try {
        chrome.runtime
          .sendMessage({ command: "record_action", data: actionData })
          .catch((error) => {
            if (
              error.message &&
              !error.message.includes("Extension context invalidated") &&
              !error.message.includes("message port closed")
            ) {
              console.error(
                "handleChange: Error sending change action message:",
                error
              );
            } else {
              // console.log("handleChange: Context invalidated during message send."); // Optional debug
            }
          });

        // 將 action 數據發送到用戶的 API
        const actionType = actionData.type === "Select" ? "select" : "change";
        sendActionToAPI(event.target, actionType, actionData);
      } catch (error) {
        if (
          error.message &&
          !error.message.includes("Extension context invalidated")
        ) {
          console.error(
            "handleChange: Synchronous error sending change action:",
            error
          );
        } else {
          // console.log("handleChange: Context invalidated during message send."); // Optional debug
        }
      }
    }
  }

  // Custom component slider (role="slider"): record current value when releasing (pointerup/mouseup)
  function handleSliderPointerUp(event) {
    // Handle custom ARIA sliders (common in UI libraries)
    try {
      const el =
        event.target && event.target.closest
          ? event.target.closest('[role="slider"]')
          : null;
      if (!el) return;
      // Only record when element is visible and interactive in viewport (simple check)
      try {
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) {
          /* invisible */
        }
      } catch (e) {
        /* ignore */
      }

      let selector = null;
      let selectorList = [];
      try {
        selectorList = generateSelectorList(el);
        selector = selectorList.length > 0 ? selectorList[0] : null;
      } catch (e) {
        selector = null;
        selectorList = [];
      }
      if (!selector) return;

      const ariaNow = el.getAttribute("aria-valuenow");
      const ariaMin = el.getAttribute("aria-valuemin");
      const ariaMax = el.getAttribute("aria-valuemax");
      const ariaStep = el.getAttribute("aria-valuestep");
      const displayVal =
        ariaNow != null ? String(ariaNow) : (el.textContent || "").trim();
      const action = {
        type: "Slider",
        selector,
        selectorList: selectorList,
        value: displayVal,
        min: ariaMin != null ? String(ariaMin) : null,
        max: ariaMax != null ? String(ariaMax) : null,
        step: ariaStep != null ? String(ariaStep) : null,
        sliderKind: "aria", // Custom ARIA slider
        selectorType: "XPath",
        timestamp: Date.now(),
      };
      chrome.runtime
        .sendMessage({ command: "record_action", data: action })
        .catch(() => {});

      // 將 action 數據發送到用戶的 API
      sendActionToAPI(el, "slider", action);
    } catch (e) {
      // ignore
    }
  }

  /**
   * Handles real-time input events for autocomplete inputs only.
   * Regular inputs will be handled by blur/outfocus events instead.
   */
  function handleInputEvent(event) {
    // Only handle real-time input for autocomplete inputs, regular inputs use blur events
    try {
      const el = event.target;
      if (!(el instanceof Element)) return;
      // If user is composing with IME, skip intermediate input events to avoid noisy partial values
      if (isComposingIME) return;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      const role = (el.getAttribute("role") || "").toLowerCase();
      const isTextLikeInput =
        (tag === "input" &&
          /^(text|password|search|email|url|tel|number)$/i.test(type)) ||
        tag === "textarea" ||
        (tag === "input" && role === "spinbutton") ||
        (tag === "input" && el.classList.contains("ant-input-number-input"));
      if (!isTextLikeInput) return;

      // Check if it's an autocomplete input
      const isAutocomplete = isAutocompleteInput(el);

      // If not autocomplete input, don't record real-time input
      if (!isAutocomplete) {
        console.log(
          "[Input] Skipping non-autocomplete input:",
          el,
          "type:",
          type,
          "tag:",
          tag
        );
        return;
      }

      console.log("[Input] Processing autocomplete input:", el);

      // For tiny autocomplete internal input, prefer outer wrapper XPath; otherwise use its own absolute XPath
      let selector = null;
      let selectorList = [];
      if (tag === "input") {
        try {
          const ariaAuto = (
            el.getAttribute("aria-autocomplete") || ""
          ).toLowerCase();
          let widthPx = 0;
          try {
            widthPx =
              (el.getBoundingClientRect && el.getBoundingClientRect().width) ||
              0;
          } catch (e) {}
          if (!widthPx) {
            try {
              const cs = getComputedStyle(el);
              widthPx =
                parseFloat(cs && cs.width ? cs.width.replace("px", "") : "0") ||
                0;
            } catch (e) {}
          }
          if (
            (ariaAuto === "list" || ariaAuto === "both") &&
            widthPx > 0 &&
            widthPx <= 6
          ) {
            const wrapper = el.closest(
              '[role="combobox"], [aria-haspopup="listbox"], [class*="__control"], [class*="__value-container"], .MuiAutocomplete-root, .react-select__control, [class*="auto-complete"]'
            );
            if (wrapper && wrapper instanceof Element) {
              selectorList = generateSelectorList(wrapper);
              selector = selectorList.length > 0 ? selectorList[0] : null;
            }
          }
        } catch (e) {
          /* ignore */
        }
      }
      if (!selector) {
        selectorList = generateSelectorList(el);
        selector = selectorList.length > 0 ? selectorList[0] : null;
      }
      if (!selector) return;

      const action = {
        // Send to background page, ask it to integrate final value with debounce
        type: "Input",
        selector, // Absolute XPath or wrapper XPath
        selectorList: selectorList,
        value: el.value != null ? String(el.value) : "",
        inputType: type || tag,
        selectorType: "XPath",
        forceDebounce: true, // Ask background to debounce so we capture after user finishes typing
        timestamp: Date.now(),
        source: "autocomplete-input", // Mark source for debugging
      };
      console.log("[Input] Recording autocomplete input action:", action);
      chrome.runtime
        .sendMessage({ command: "record_action", data: action })
        .catch(() => {});

      // 將 action 數據發送到用戶的 API
      sendActionToAPI(el, "input", action);
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * Checks if an input element is an autocomplete/search input
   * @param {Element} el The input element to check
   * @returns {boolean} True if it's an autocomplete input
   */
  function isAutocompleteInput(el) {
    // Determine if it's an autocomplete input
    try {
      if (!(el instanceof Element)) return false;

      // Check aria-autocomplete attribute (most reliable indicator)
      const ariaAuto = (
        el.getAttribute("aria-autocomplete") || ""
      ).toLowerCase();
      if (ariaAuto === "list" || ariaAuto === "both") return true;

      // Check role attribute
      const role = (el.getAttribute("role") || "").toLowerCase();
      if (role === "combobox") return true;

      // Check type attribute - only explicit search type counts
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "search") {
        // Further check for related containers or attributes
        const hasRelatedAttrs =
          el.hasAttribute("aria-controls") ||
          el.hasAttribute("aria-expanded") ||
          el.closest(
            '[class*="select"], [class*="autocomplete"], [class*="combobox"]'
          );
        if (hasRelatedAttrs) return true;
      }

      // Check class names - only very explicit patterns count
      const className = el.className || "";
      if (
        /(?:ant-select.*input|react-select.*input|autocomplete.*input|combobox.*input)/i.test(
          className
        )
      )
        return true;

      // Check for aria-haspopup attribute
      const hasPopup = el.getAttribute("aria-haspopup");
      if (hasPopup === "listbox" || hasPopup === "menu") return true;

      return false;
    } catch (e) {
      return false;
    }
  }

  // Track last recorded input values to prevent duplicates from auto-capitalization
  const lastRecordedInputs = new Map(); // selector -> {value, timestamp}
  const INPUT_DEDUP_WINDOW_MS = 1000; // 1 second window for deduplication

  // Periodically clean up old entries from the deduplication map
  setInterval(() => {
    const now = Date.now();
    const threshold = now - INPUT_DEDUP_WINDOW_MS * 2; // Keep entries for 2x the window
    for (const [selector, record] of lastRecordedInputs.entries()) {
      if (record.timestamp < threshold) {
        lastRecordedInputs.delete(selector);
      }
    }
  }, 30000); // Clean up every 30 seconds

  /**
   * Handles blur events for regular input fields to record final value
   * @param {Event} event
   */
  function handleBlurEvent(event) {
    // Handle blur events for regular input fields, record final value
    try {
      const el = event.target;
      if (!(el instanceof Element)) return;

      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      // Add support for number, spinbutton types and elements with role="spinbutton"
      const role = (el.getAttribute("role") || "").toLowerCase();
      const isTextLikeInput =
        (tag === "input" &&
          /^(text|password|email|url|tel|number)$/i.test(type)) ||
        tag === "textarea" ||
        (tag === "input" && role === "spinbutton") ||
        (tag === "input" && el.classList.contains("ant-input-number-input"));

      if (!isTextLikeInput) {
        console.log("[Input] Not text-like input:", tag, type, role);
        return;
      }

      // If autocomplete input, don't handle here (already handled in input events)
      if (isAutocompleteInput(el)) {
        console.log("[Input] Skipping blur for autocomplete input:", el);
        return;
      }

      // Get element's absolute XPath
      // For Ant Design InputNumber, use the wrapper's XPath for better stability
      let selector = null;
      try {
        if (
          el.classList.contains("ant-input-number-input") ||
          role === "spinbutton"
        ) {
          // Try to find Ant Design InputNumber wrapper
          const wrapper = el.closest(
            ".ant-input-number, .ant-input-number-input-wrap"
          );
          if (wrapper && wrapper.parentElement) {
            selector = generateAbsoluteXPath(wrapper.parentElement);
            console.log(
              "[Input] Using Ant InputNumber wrapper for selector:",
              selector
            );
          } else {
            selector = generateRobustSelector(el);
          }
        } else {
          selector = generateRobustSelector(el);
        }
      } catch (e) {
        selector = null;
      }
      if (!selector) return;

      // Prevent meaningless recording of empty or very short values
      const value = el.value != null ? String(el.value) : "";
      if (value.length === 0) {
        console.log("[Input] Skipping empty input value");
        return;
      }

      // Check for duplicate input (e.g., from auto-capitalization)
      const now = Date.now();
      const lastRecord = lastRecordedInputs.get(selector);
      if (lastRecord) {
        const timeDiff = now - lastRecord.timestamp;
        // If same value recorded within dedup window, skip
        if (lastRecord.value === value && timeDiff < INPUT_DEDUP_WINDOW_MS) {
          console.log(
            `[Input] Skipping duplicate input for ${selector}: "${value}" (${timeDiff}ms ago)`
          );
          return;
        }
        // If different value but both are case-variants (e.g., "Surname" vs "SURNAME")
        if (
          lastRecord.value.toLowerCase() === value.toLowerCase() &&
          lastRecord.value !== value &&
          timeDiff < INPUT_DEDUP_WINDOW_MS
        ) {
          console.log(
            `[Input] Auto-capitalization detected for ${selector}: "${lastRecord.value}" → "${value}"`
          );
          // Update to final value and skip duplicate
          lastRecordedInputs.set(selector, { value, timestamp: now });
          return;
        }
      }

      // Record the input
      lastRecordedInputs.set(selector, { value, timestamp: now });

      const action = {
        type: "Input",
        selector,
        value: value,
        inputType: type || tag,
        selectorType: "XPath",
        timestamp: Date.now(),
        source: "blur", // Mark source for debugging
      };
      console.log("[Input] Recording blur input action:", action);
      chrome.runtime
        .sendMessage({ command: "record_action", data: action })
        .catch(() => {});

      // 將 action 數據發送到用戶的 API
      sendActionToAPI(el, "input", action);
    } catch (e) {
      console.warn("handleBlurEvent error:", e);
    }
  }

  // Handle IME composition: start -> suppress input events; end -> send one final value
  function handleCompositionStart(event) {
    // IME composition start: mark state, pause recording intermediate input
    try {
      const el = event.target;
      if (!(el instanceof Element)) return;
      isComposingIME = true;
    } catch (e) {
      /* ignore */
    }
  }

  function handleCompositionEnd(event) {
    // IME composition end: send final value
    try {
      const el = event.target;
      if (!(el instanceof Element)) {
        isComposingIME = false;
        return;
      }
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      const isTextLikeInput =
        (tag === "input" &&
          /^(text|password|search|email|url|tel|number)$/i.test(type)) ||
        tag === "textarea";
      if (!isTextLikeInput) {
        isComposingIME = false;
        return;
      }

      // Check if it's an autocomplete input
      const isAutocomplete = isAutocompleteInput(el);

      // Only autocomplete inputs record on composition end, regular inputs record on blur
      if (!isAutocomplete) {
        console.log(
          "[IME] Skipping composition end for non-autocomplete input:",
          el
        );
        isComposingIME = false;
        return;
      }

      console.log(
        "[IME] Processing composition end for autocomplete input:",
        el
      );

      // Autocomplete inputs use debounce, regular inputs record directly
      let selector = null;
      if (isAutocomplete && tag === "input") {
        try {
          const ariaAuto = (
            el.getAttribute("aria-autocomplete") || ""
          ).toLowerCase();
          let widthPx = 0;
          try {
            widthPx =
              (el.getBoundingClientRect && el.getBoundingClientRect().width) ||
              0;
          } catch (e) {}
          if (!widthPx) {
            try {
              const cs = getComputedStyle(el);
              widthPx =
                parseFloat(cs && cs.width ? cs.width.replace("px", "") : "0") ||
                0;
            } catch (e) {}
          }
          if (
            (ariaAuto === "list" || ariaAuto === "both") &&
            widthPx > 0 &&
            widthPx <= 6
          ) {
            const wrapper = el.closest(
              '[role="combobox"], [aria-haspopup="listbox"], [class*="__control"], [class*="__value-container"], .MuiAutocomplete-root, .react-select__control, [class*="auto-complete"]'
            );
            if (wrapper && wrapper instanceof Element) {
              selector = generateAbsoluteXPath(wrapper);
            }
          }
        } catch (e) {
          /* ignore */
        }
      }
      if (!selector) selector = generateAbsoluteXPath(el);

      if (selector) {
        const action = {
          type: "Input",
          selector,
          value: el.value != null ? String(el.value) : "",
          inputType: type || tag,
          selectorType: "XPath",
          forceDebounce: isAutocomplete, // Only autocomplete inputs use debounce
          timestamp: Date.now(),
          source: "composition-end", // Mark source for debugging
        };
        console.log("[IME] Recording composition end input action:", action);
        chrome.runtime
          .sendMessage({ command: "record_action", data: action })
          .catch(() => {});

        // 將 action 數據發送到用戶的 API
        sendActionToAPI(el, "input", action);
      }
    } catch (e) {
      /* ignore */
    } finally {
      isComposingIME = false;
    }
  }

  // content script: receive page -> forward API data to background
  window.addEventListener("message", (event) => {
    // Forward API interception info to background page
    if (!event.data || !event.data.__SELBAS_RECORDER_API__) return;
    try {
      chrome.runtime.sendMessage({ command: "api_response", data: event.data });
    } catch (e) {
      console.warn("Content: failed to forward API data to background", e);
    }
  });

  // Forward dialog events
  window.addEventListener("message", (event) => {
    // Forward dialog events to background page
    if (!event.data || !event.data.__SELBAS_RECORDER_DIALOG__) return;
    try {
      chrome.runtime.sendMessage({ command: "dialog_event", data: event.data });
    } catch (e) {}
  });

  // --- MutationObserver: detect newly added elements and notify background ---
  let elementMutationObserver = null; // Monitor newly added nodes
  let mutationDebounceTimer = null; // Debounce timer
  const MUTATION_DEBOUNCE_MS = 300; // Batch interval
  const MAX_ELEMENTS_PER_BATCH = 20; // Maximum 20 elements per batch

  //function serializeElementForNotification(el) { // Serialize new elements to lightweight information
  function serializeElementForNotification(el) {
    // Use absolute XPath for consistency with better error handling
    try {
      // Skip if element is not properly connected to the document
      if (!el || !el.isConnected || !document.contains(el)) {
        return { selector: null, info: null, tagName: null, text: null };
      }

      // Skip certain elements that are likely to be problematic
      const tagName = el.tagName ? el.tagName.toLowerCase() : null;
      if (
        !tagName ||
        ["script", "style", "meta", "link", "noscript"].includes(tagName)
      ) {
        return { selector: null, info: null, tagName, text: null };
      }

      // Skip elements with no meaningful content and no interactive properties
      const hasText = el.textContent && el.textContent.trim().length > 0;
      const hasAttributes = el.attributes && el.attributes.length > 0;
      const isInteractive = [
        "button",
        "a",
        "input",
        "select",
        "textarea",
      ].includes(tagName);

      if (!hasText && !hasAttributes && !isInteractive) {
        return { selector: null, info: null, tagName, text: null };
      }

      return {
        selector: (function () {
          try {
            const a = generateAbsoluteXPath(el);
            return a ? trimNonInteractiveXPathTail(a) : null;
          } catch (e) {
            // Silently handle XPath generation errors for mutation observer
            return null;
          }
        })(),
        info: getElementInfo(el),
        tagName: tagName,
        text: (el.textContent || "").trim().slice(0, 200),
      };
    } catch (e) {
      return { selector: null, info: null, tagName: null, text: null };
    }
  }

  function handleMutations(mutationsList) {
    // Batch collect new elements and notify background with better filtering
    // Collect added elements with filtering
    const added = [];
    for (const mut of mutationsList) {
      if (mut.addedNodes && mut.addedNodes.length) {
        for (const node of mut.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Filter out problematic elements early
            if (node.isConnected && document.contains(node)) {
              const tagName = node.tagName ? node.tagName.toLowerCase() : null;
              // Skip elements that are unlikely to be useful for automation
              if (
                tagName &&
                ![
                  "script",
                  "style",
                  "meta",
                  "link",
                  "noscript",
                  "head",
                ].includes(tagName)
              ) {
                added.push(node);
              }
            }
          } else if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
            // flatten fragments with filtering
            try {
              const elems = node.querySelectorAll
                ? Array.from(node.querySelectorAll("*"))
                : [];
              elems.forEach((e) => {
                if (e.isConnected && document.contains(e)) {
                  const tagName = e.tagName ? e.tagName.toLowerCase() : null;
                  if (
                    tagName &&
                    ![
                      "script",
                      "style",
                      "meta",
                      "link",
                      "noscript",
                      "head",
                    ].includes(tagName)
                  ) {
                    added.push(e);
                  }
                }
              });
            } catch (e) {
              // Ignore errors when processing document fragments
            }
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
          chrome.runtime.sendMessage({
            command: "new_elements",
            data: payload,
          });
        } catch (e) {
          // Silently ignore runtime errors for mutation observer messages
          // These are not critical for core functionality
          if (
            e.message &&
            !e.message.includes("Extension context invalidated")
          ) {
            console.warn("Content: failed to send new_elements message", e);
          }
        }
      }
    }, MUTATION_DEBOUNCE_MS);
  }

  // Replace/augment attachListeners and detachListeners to control the observer
  let recordingHighlightedElement = null; // Track currently highlighted element during recording

  function attachListeners() {
    // Attach various event listeners and MutationObserver
    if (isListenerAttached) return;
    console.log("Attaching event listeners...");

    // Enable recording highlight mode
    enableRecordingHighlight();

    document.addEventListener("click", handleClick, true);
    document.addEventListener("change", handleChange, true); // Listen only to 'change' for inputs
    // Input event for autocomplete inputs only
    document.addEventListener("input", handleInputEvent, true);
    // Blur event for regular input fields to capture final values
    document.addEventListener("blur", handleBlurEvent, true);
    // Slider (custom role=slider): record on release
    document.addEventListener("pointerup", handleSliderPointerUp, true);
    document.addEventListener("mouseup", handleSliderPointerUp, true);
    // IME composition handling to avoid noisy partial inputs
    document.addEventListener("compositionstart", handleCompositionStart, true);
    document.addEventListener("compositionend", handleCompositionEnd, true);
    // drag and drop listeners
    document.addEventListener("dragstart", handleDragStart, true);
    document.addEventListener("dragenter", handleDragEnter, true);
    document.addEventListener("dragover", handleDragOver, true);
    document.addEventListener("dragleave", handleDragLeave, true);
    document.addEventListener("drop", handleDrop, true);
    document.addEventListener("dragend", handleDragEnd, true);
    // Synthetic drag detection listeners
    document.addEventListener("pointerdown", synthPointerDown, true);
    document.addEventListener("pointermove", synthPointerMove, true);
    document.addEventListener("pointerup", synthPointerUp, true);
    document.addEventListener("mouseleave", synthPointerUp, true);
    isListenerAttached = true;

    try {
      if (!elementMutationObserver) {
        elementMutationObserver = new MutationObserver(handleMutations);
        elementMutationObserver.observe(document, {
          childList: true,
          subtree: true,
          attributes: false,
          characterData: false,
        });
        console.log("Content: MutationObserver attached for new elements.");
      }
    } catch (e) {
      console.warn("Content: Failed to attach MutationObserver:", e);
    }
  }

  function detachListeners() {
    // Remove event listeners and observer
    if (!isListenerAttached) return;
    console.log("Detaching event listeners...");

    // Disable recording highlight mode
    disableRecordingHighlight();

    document.removeEventListener("click", handleClick, true);
    document.removeEventListener("change", handleChange, true);
    document.removeEventListener("input", handleInputEvent, true);
    document.removeEventListener("blur", handleBlurEvent, true);
    document.removeEventListener("pointerup", handleSliderPointerUp, true);
    document.removeEventListener("mouseup", handleSliderPointerUp, true);
    document.removeEventListener(
      "compositionstart",
      handleCompositionStart,
      true
    );
    document.removeEventListener("compositionend", handleCompositionEnd, true);
    // Remove drag-and-drop listeners
    document.removeEventListener("dragstart", handleDragStart, true);
    document.removeEventListener("dragenter", handleDragEnter, true);
    document.removeEventListener("dragover", handleDragOver, true);
    document.removeEventListener("dragleave", handleDragLeave, true);
    document.removeEventListener("drop", handleDrop, true);
    document.removeEventListener("dragend", handleDragEnd, true);
    document.removeEventListener("pointerdown", synthPointerDown, true);
    document.removeEventListener("pointermove", synthPointerMove, true);
    document.removeEventListener("pointerup", synthPointerUp, true);
    document.removeEventListener("mouseleave", synthPointerUp, true);
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

  // --- Recording Highlight Mode ---
  function enableRecordingHighlight() {
    // Add visual styles for recording highlight (subtle, non-intrusive)
    if (!document.getElementById("__recording_highlight_styles__")) {
      const style = document.createElement("style");
      style.id = "__recording_highlight_styles__";
      style.textContent = `
            .__recording_highlight__ {
                outline: 2px solid #4CAF50 !important;
                outline-offset: 1px !important;
                box-shadow: 0 0 8px rgba(76, 175, 80, 0.3) !important;
                transition: outline 0.15s ease, box-shadow 0.15s ease !important;
            }
        `;
      document.head.appendChild(style);
    }

    // Add mousemove listener for highlighting
    document.addEventListener("mousemove", handleRecordingHighlight, true);
    console.log("[Recording Highlight] Enabled");
  }

  function disableRecordingHighlight() {
    // Remove highlight from current element
    if (recordingHighlightedElement) {
      recordingHighlightedElement.classList.remove("__recording_highlight__");
      recordingHighlightedElement = null;
    }

    // Extra safety: remove highlight class from all elements (in case any were missed)
    try {
      const highlightedElements = document.querySelectorAll(
        ".__recording_highlight__"
      );
      highlightedElements.forEach((el) => {
        el.classList.remove("__recording_highlight__");
      });
    } catch (e) {
      console.warn(
        "[Recording Highlight] Failed to clean up all highlights:",
        e
      );
    }

    // Remove mousemove listener
    document.removeEventListener("mousemove", handleRecordingHighlight, true);

    // Remove the style element if it exists
    try {
      const styleElement = document.getElementById(
        "__recording_highlight_styles__"
      );
      if (styleElement) {
        styleElement.remove();
      }
    } catch (e) {
      console.warn("[Recording Highlight] Failed to remove style element:", e);
    }

    console.log("[Recording Highlight] Disabled");
  }

  function handleRecordingHighlight(e) {
    // Don't highlight if element picker is active
    if (elementPickerActive) return;

    const targetElement = e.target;

    // Skip if it's the same element
    if (targetElement === recordingHighlightedElement) return;

    // Remove previous highlight
    if (recordingHighlightedElement) {
      recordingHighlightedElement.classList.remove("__recording_highlight__");
    }

    // Add highlight to new element (skip body and html)
    if (
      targetElement &&
      targetElement !== document.body &&
      targetElement !== document.documentElement &&
      targetElement.nodeType === 1
    ) {
      // Element node

      targetElement.classList.add("__recording_highlight__");
      recordingHighlightedElement = targetElement;
    } else {
      recordingHighlightedElement = null;
    }
  }

  // --- Element Picker Mode ---
  let elementPickerActive = false;
  let elementPickerCallback = null;
  let highlightedElement = null;

  function startElementPicker(responseCallback) {
    if (elementPickerActive) {
      console.log("[ElementPicker] Already active");
      return;
    }

    elementPickerActive = true;
    elementPickerCallback = responseCallback;

    // Add visual styles for highlighting
    if (!document.getElementById("__element_picker_styles__")) {
      const style = document.createElement("style");
      style.id = "__element_picker_styles__";
      style.textContent = `
            .__element_picker_highlight__ {
                outline: 3px solid #ff6b00 !important;
                outline-offset: 2px !important;
                background-color: rgba(255, 107, 0, 0.1) !important;
                cursor: crosshair !important;
                position: relative !important;
            }
            .__element_picker_overlay__ {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.05);
                z-index: 999998;
                cursor: crosshair;
                pointer-events: all;
            }
            .__element_picker_tooltip__ {
                position: fixed;
                background: #333;
                color: #fff;
                padding: 8px 12px;
                border-radius: 4px;
                font-size: 12px;
                z-index: 999999;
                pointer-events: none;
                max-width: 400px;
                word-break: break-all;
            }
        `;
      document.head.appendChild(style);
    }

    // Create overlay
    const overlay = document.createElement("div");
    overlay.className = "__element_picker_overlay__";
    overlay.id = "__element_picker_overlay__";
    document.body.appendChild(overlay);

    // Create tooltip
    const tooltip = document.createElement("div");
    tooltip.className = "__element_picker_tooltip__";
    tooltip.id = "__element_picker_tooltip__";
    tooltip.textContent =
      "Click on an element to select it, or press ESC to cancel";
    document.body.appendChild(tooltip);

    // Event handlers
    const handleMouseMove = (e) => {
      e.stopPropagation();
      e.preventDefault();

      // Update tooltip position
      tooltip.style.left = e.clientX + 10 + "px";
      tooltip.style.top = e.clientY + 10 + "px";

      // Get element under cursor (excluding overlay and tooltip)
      const elementsAtPoint = document.elementsFromPoint(e.clientX, e.clientY);
      const targetElement = elementsAtPoint.find(
        (el) =>
          !el.classList.contains("__element_picker_overlay__") &&
          !el.classList.contains("__element_picker_tooltip__") &&
          el !== overlay &&
          el !== tooltip
      );

      // Remove previous highlight
      if (highlightedElement) {
        highlightedElement.classList.remove("__element_picker_highlight__");
      }

      // Highlight new element
      if (
        targetElement &&
        targetElement !== document.body &&
        targetElement !== document.documentElement
      ) {
        targetElement.classList.add("__element_picker_highlight__");
        highlightedElement = targetElement;

        // Show element info in tooltip
        const tagName = targetElement.tagName.toLowerCase();
        const id = targetElement.id ? `#${targetElement.id}` : "";
        const classes = targetElement.className
          ? `.${targetElement.className.trim().split(/\s+/).join(".")}`
          : "";
        tooltip.textContent = `${tagName}${id}${classes}`;
      } else {
        highlightedElement = null;
        tooltip.textContent =
          "Click on an element to select it, or press ESC to cancel";
      }
    };

    const handleClick = (e) => {
      e.stopPropagation();
      e.preventDefault();

      if (highlightedElement) {
        // Generate selector for the selected element
        const selector = generateAbsoluteXPath(highlightedElement);

        // Send response back
        if (elementPickerCallback) {
          elementPickerCallback({
            success: true,
            selector: selector,
            tagName: highlightedElement.tagName.toLowerCase(),
            id: highlightedElement.id || null,
            className: highlightedElement.className || null,
          });
        }

        // Stop picker mode
        stopElementPicker();
      }
    };

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();

        // Send cancel response
        if (elementPickerCallback) {
          elementPickerCallback({ success: false, cancelled: true });
        }

        stopElementPicker();
      }
    };

    // Attach event listeners
    overlay.addEventListener("mousemove", handleMouseMove, true);
    overlay.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKeyDown, true);

    // Store references for cleanup
    overlay._pickerthHandlers = { handleMouseMove, handleClick, handleKeyDown };

    console.log("[ElementPicker] Element picker mode activated");
  }

  function stopElementPicker() {
    if (!elementPickerActive) return;

    elementPickerActive = false;
    elementPickerCallback = null;

    // Remove highlight
    if (highlightedElement) {
      highlightedElement.classList.remove("__element_picker_highlight__");
      highlightedElement = null;
    }

    // Remove overlay and tooltip
    const overlay = document.getElementById("__element_picker_overlay__");
    const tooltip = document.getElementById("__element_picker_tooltip__");

    if (overlay) {
      const handlers = overlay._pickerHandlers;
      if (handlers) {
        overlay.removeEventListener(
          "mousemove",
          handlers.handleMouseMove,
          true
        );
        overlay.removeEventListener("click", handlers.handleClick, true);
        document.removeEventListener("keydown", handlers.handleKeyDown, true);
      }
      overlay.remove();
    }

    if (tooltip) {
      tooltip.remove();
    }

    console.log("[ElementPicker] Element picker mode deactivated");
  }

  // --- Message Listener ---
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Receive background requests and respond (extract HTML, check selectors, etc.)
    // console.log("Content script received message:", message.command); // Optional debug

    if (message.command === "start_recording") {
      console.log(
        "[Content] Received start_recording command, attaching listeners..."
      );
      attachListeners();
      sendResponse({ success: true });
      return true;
    }

    if (message.command === "stop_recording") {
      console.log(
        "[Content] Received stop_recording command, detaching listeners..."
      );
      detachListeners();
      sendResponse({ success: true });
      return true;
    }

    // Element picker mode for replacing selectors
    if (message.command === "start_element_picker") {
      console.log("[Content] Starting element picker mode...");
      startElementPicker(sendResponse);
      return true; // Async response
    }

    if (message.command === "get_html") {
      const htmlContent = document.documentElement.outerHTML;
      const pageUrl =
        typeof location !== "undefined" && location.href ? location.href : null;
      sendResponse({ success: true, html: htmlContent, url: pageUrl });
      return true; // Indicate async response
    }

    if (message.command === "check_selector_exists") {
      try {
        const selector = message.selector || "";
        if (!selector) {
          sendResponse({ exists: false });
          return true;
        }
        let exists = false;
        try {
          let expr = null;
          if (selector.startsWith("xpath=")) expr = selector.slice(6);
          else if (selector.startsWith("/")) expr = selector; // raw absolute or // relative XPath
          if (expr) {
            const res = document.evaluate(
              expr,
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null
            );
            exists = !!res && !!res.singleNodeValue;
          } else {
            exists = !!document.querySelector(selector);
          }
        } catch (e) {
          exists = false;
        }
        sendResponse({ exists });
      } catch (e) {
        sendResponse({
          exists: false,
          message: e && e.message ? e.message : String(e),
        });
      }
      return true;
    }
  });

  // --- Initialization ---
  // Inject CSS for drag-and-drop file upload visual feedback
  (function injectDragDropStyles() {
    try {
      const style = document.createElement("style");
      style.id = "__selbas_drag_drop_styles__";
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
      console.log("Selenium Recorder: Drag-drop styles injected");
    } catch (e) {
      console.warn("Failed to inject drag-drop styles:", e);
    }
  })();

  // attachListeners(); // 不要自動啟動，等待用戶明確開始錄製

  (function injectPopupWindowAndOpenHook() {
    // Inject window.open and popupWindow hooks to help detect new tabs/popups
    try {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("popup_hooks.js");
      script.onload = () => script.remove();
      script.onerror = () => {
        console.warn(
          "Failed to load popup_hooks.js, falling back to direct injection"
        );
        script.remove();
      };
      (
        document.documentElement ||
        document.head ||
        document.body ||
        document
      ).appendChild(script);
    } catch (e) {
      console.warn("Content: Failed to inject popup/open hook:", e);
    }
  })();

  // --- Cleanup: remove any legacy injected screen recorder floating button (from older content.js) ---
  (function removeLegacyScreenRecorder() {
    // Clean up legacy floating screen recorder button from older versions
    try {
      const legacy = document.getElementById(
        "__selbas_screen_recorder_container"
      );
      if (legacy) {
        legacy.remove();
        console.log("[Cleanup] Removed legacy screen recorder UI."); // Log cleanup message
      }
    } catch (e) {
      /* ignore */
    }
  })();
  /**
   * Handles dragstart events to capture the start of a drag action.
   * @param {Event} event
   */
  function handleDragStart(event) {
    try {
      const rawTarget = event.target;
      if (!(rawTarget instanceof Element)) return;
      console.log("[DND][dragstart] raw target:", rawTarget);

      // Use DND-Kit enhancer if available for better detection
      let dndKitDetection = null;
      if (window.DND_KIT_ENHANCER) {
        dndKitDetection =
          window.DND_KIT_ENHANCER.enhancedDragStartDetection(event);
      }

      // Enhanced draggable detection for various drag libraries including dnd-kit
      const sourceEl =
        (dndKitDetection && dndKitDetection.element) ||
        rawTarget.closest(
          '[role="button"][aria-roledescription="draggable"], [aria-roledescription="draggable"], [draggable="true"], [data-rbd-draggable-id], [data-dnd-kit-id], [data-sortable-id]'
        ) ||
        rawTarget.closest(
          '[class*="draggable"], [class*="sortable"], [class*="dnd"], [class*="drag"]'
        ) ||
        rawTarget;

      let sourceSelector = null;
      try {
        // For drag operations, prefer ID-based selectors
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
        } catch (e) {
          /* ignore */
        }
      }

      window.__SELBAS_DRAG_SOURCE__ = {
        selector: sourceSelector,
        rawSelector,
        elementInfo: getElementInfo(sourceEl),
        elRef: sourceEl,
        timestamp: Date.now(),
        isDndKit: dndKitDetection ? dndKitDetection.isDndKit : false,
        dndKitId: dndKitDetection ? dndKitDetection.id : null,
        dndKitType: dndKitDetection ? dndKitDetection.type : null,
      };
      // Reset drag tracking helpers
      window.__SELBAS_DRAG_LAST_HIT__ = null; // { selector, kind, rawSelector, elementInfo }
      window.__SELBAS_DRAG_COMPLETED__ = false;
      console.log(
        "handleDragStart: Recorded drag start (normalized to draggable card):",
        window.__SELBAS_DRAG_SOURCE__
      );
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
    const push = (elem, kind, priority = 0) => {
      if (elem && elem instanceof Element)
        tried.push({ el: elem, kind, priority });
    };

    try {
      // Enhanced detection for dnd-kit drop zones and containers (highest priority)
      // First check if current element and parent elements have stable IDs
      let current = el;
      while (current && current !== document.body) {
        if (
          current.id &&
          !current.id.match(
            /^(?:radix-|ember-|data-v-|svelte-|ui-|aria-|temp-|auto-)/i
          )
        ) {
          // Check if this ID is stable and unique
          try {
            const selector = `#${CSS.escape(current.id)}`;
            if (document.querySelectorAll(selector).length === 1) {
              console.log(
                `[DND][resolveContainer] Found stable ID container: ${selector}`
              );
              return {
                selector: selector,
                kind: "stable-id-container",
                element: current,
              };
            }
          } catch (e) {
            /* ignore */
          }
        }
        current = current.parentElement;
      }

      push(
        el.closest(
          "[data-rbd-droppable-id], [data-dnd-kit-droppable], [data-sortable-container], #target-zone, #source-zone"
        ),
        "dnd-droppable",
        10
      );
      push(
        el.closest(
          '[class*="droppable"], [class*="drop-zone"], [class*="sortable-container"], [class*="drag-zone"]'
        ),
        "dnd-container",
        9
      );

      // Look for containers with multiple draggable children (high priority)
      // Also look for column-like containers (flex-grow, min-height patterns from Ant Design)
      let parent = el.parentElement;
      while (parent && parent !== document.body) {
        const draggableCount = parent.querySelectorAll(
          '[data-rbd-draggable-id], [data-dnd-kit-id], [data-sortable-id], [draggable="true"], [class*="draggable"]'
        ).length;
        if (draggableCount >= 2) {
          push(parent, "multi-draggable-container", 8);
          break;
        }
        // Check for kanban column patterns (flex-grow with min-height, typically empty space)
        const style = getComputedStyle(parent);
        if (
          style &&
          style.flexGrow === "1" &&
          style.minHeight !== "0px" &&
          style.minHeight !== "auto"
        ) {
          push(parent, "kanban-column", 9); // High priority for column containers
        }
        parent = parent.parentElement;
      }

      // Semantic containers with medium priority
      push(
        el.closest('[style*="flex-grow: 1"][style*="min-height"]'),
        "flex-grow",
        6
      );
      push(
        el.closest(
          '[style*="overflow-y: auto"],[style*="overflow: auto"],[style*="overflow-y:auto"]'
        ),
        "scroll",
        5
      );
      push(
        el.closest('[role="list"], [aria-roledescription="list"]'),
        "aria-list",
        7
      );
      push(el.closest("ul, ol, section, main, article"), "semantic", 4);

      // Avoid overly generic containers (lower priority)
      push(
        el.closest('div[class*="content"], div[class*="container"]'),
        "content-container",
        3
      );
      push(el, "raw-target", 1);

      // Sort by priority and validate each candidate
      tried.sort((a, b) => b.priority - a.priority);

      for (const c of tried) {
        try {
          // For drag containers, prefer ID selectors
          let selector = generateDragSelector(c.el);
          if (!selector) {
            const abs = generateAbsoluteXPath(c.el);
            selector = abs ? trimNonInteractiveXPathTail(abs) : null;
          }
          if (!selector || selector === sourceSelector) continue;

          // Skip overly generic paths (too high in DOM tree)
          const pathDepth = (selector.match(/\//g) || []).length;
          if (pathDepth < 4) continue;

          console.log(
            "[DND][resolveContainer] Selected container:",
            c.el,
            "kind:",
            c.kind,
            "priority:",
            c.priority,
            "depth:",
            pathDepth
          );
          return { selector: selector, kind: c.kind, element: c.el };
        } catch (e) {
          console.log(
            "[DND][resolveContainer] Error validating candidate:",
            c.kind,
            e
          );
        }
      }
    } catch (e) {
      console.log("[DND][resolveContainer] Error in resolution:", e);
    }
    return null;
  }

  // Resolve a specific draggable item (card) distinct from source for more precise target
  function __selbasResolveDropItem(el, sourceSelector) {
    try {
      if (!el || !(el instanceof Element)) return null;
      // Enhanced detection for dnd-kit and other virtual drag libraries
      const item =
        el.closest(
          '[role="button"][aria-roledescription="draggable"], [aria-roledescription="draggable"], [draggable="true"], [data-rbd-draggable-id], [data-dnd-kit-id], [data-sortable-id]'
        ) ||
        el.closest(
          '[class*="draggable"], [class*="sortable"], [class*="dnd"], [class*="drag"]'
        );
      if (!item) return null;

      // For drag items, prefer ID selectors
      let selector = generateDragSelector(item);
      if (!selector) {
        const abs = generateAbsoluteXPath(item);
        selector = abs ? trimNonInteractiveXPathTail(abs) : null;
      }

      if (selector && selector !== sourceSelector) {
        return { selector: selector, element: item };
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  // Helper: Check if pointer is in end-of-list area (below last draggable item)
  function __selbasCheckEndOfListHeuristic(clientX, clientY, container) {
    try {
      if (!container) return false;

      // Find all draggable items within this container
      const draggables = container.querySelectorAll(
        '[role="button"][aria-roledescription="draggable"], [data-rbd-draggable-id], [data-dnd-kit-id], [data-sortable-id], [class*="draggable"]'
      );
      if (draggables.length === 0) return true; // Empty container = end of list

      // Find the bottom-most draggable item
      let bottomMostY = 0;
      for (const draggable of draggables) {
        try {
          const rect = draggable.getBoundingClientRect();
          if (rect.bottom > bottomMostY) {
            bottomMostY = rect.bottom;
          }
        } catch (e) {
          /* ignore */
        }
      }

      // If pointer is below the last item with some margin, consider it end-of-list
      const MARGIN = 20; // pixels
      return clientY > bottomMostY + MARGIN;
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
      console.log(
        "[DND][elementsFromPoint] Stack at",
        clientX,
        clientY,
        ":",
        arr
          .map(
            (el) =>
              el.tagName +
              (el.className ? "." + el.className.split(" ").join(".") : "") +
              (el.id ? "#" + el.id : "")
          )
          .slice(0, 5)
      );

      // First pass: look for specific drop targets/containers
      for (const el of arr) {
        if (!(el instanceof Element)) continue;
        if (el === document.documentElement || el === document.body) continue; // skip html/body

        // Enhanced ghost/overlay detection for dnd-kit and other libraries
        try {
          const style = getComputedStyle(el);
          if (
            style &&
            (parseFloat(style.opacity) < 0.2 ||
              style.pointerEvents === "none" ||
              style.transform.includes("translate"))
          )
            continue;

          // Skip dnd-kit overlay or preview elements (common class patterns)
          if (
            el.classList &&
            (el.classList.contains("drag-overlay") ||
              el.classList.contains("dnd-overlay") ||
              el.classList.contains("drag-preview") ||
              el.matches(
                '[class*="overlay"], [class*="preview"], [class*="ghost"]'
              ))
          )
            continue;

          // Skip ant-design blur/loading containers (too generic)
          if (
            el.classList &&
            (el.classList.contains("ant-spin-container") ||
              el.classList.contains("ant-spin-blur"))
          )
            continue;
        } catch (_) {
          /* ignore style issues */
        }

        let abs = null;
        let trimmed = null;
        try {
          trimmed = generateDragSelector(el);
          if (!trimmed) {
            abs = generateAbsoluteXPath(el);
            trimmed = abs ? trimNonInteractiveXPathTail(abs) : null;
          }
        } catch (_) {
          trimmed = null;
        }
        if (!trimmed) continue;
        if (trimmed === sourceSelector) continue; // don't target the source itself

        // Skip overly generic paths (too high in DOM tree)
        const pathDepth = (trimmed.match(/\//g) || []).length;
        if (pathDepth < 4) continue; // Skip very shallow paths like /html/body/div/div

        // Prefer elements that look like drop targets or containers
        const isDndTarget = el.matches(
          '[data-rbd-droppable-id], [data-dnd-kit-droppable], [data-sortable-container], [class*="droppable"], [class*="drop-zone"], #target-zone, #source-zone, [class*="drag-zone"]'
        );
        const isSpecificContainer = el.matches(
          'article, section, main, [role="main"], [class*="content"], [class*="card"], [class*="item"], [class*="list"]'
        );

        // End-of-list heuristic: if this element contains draggables and pointer is below them, prefer the container
        let shouldPreferContainer = false;
        if (isSpecificContainer) {
          const parentContainer = el.closest(
            'div[style*="flex-grow"], div[style*="min-height"], [class*="drop-zone"], [class*="droppable"]'
          );
          if (
            parentContainer &&
            __selbasCheckEndOfListHeuristic(clientX, clientY, parentContainer)
          ) {
            shouldPreferContainer = true;
            console.log(
              "[DND][elementsFromPoint] End-of-list detected, preferring container over card"
            );
          }
        }

        if (isDndTarget || (isSpecificContainer && !shouldPreferContainer)) {
          console.log(
            "[DND][elementsFromPoint] Found specific target:",
            el,
            trimmed,
            "isDndTarget:",
            isDndTarget,
            "isSpecific:",
            isSpecificContainer
          );
          return {
            element: el,
            selector: trimmed,
            isDndTarget: isDndTarget || isSpecificContainer,
          };
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
          if (
            style &&
            (parseFloat(style.opacity) < 0.2 ||
              style.pointerEvents === "none" ||
              style.transform.includes("translate"))
          )
            continue;
          if (
            el.classList &&
            (el.classList.contains("ant-spin-container") ||
              el.classList.contains("ant-spin-blur"))
          )
            continue;
        } catch (_) {
          /* ignore style issues */
        }

        let abs = null;
        let trimmed = null;
        try {
          trimmed = generateDragSelector(el);
          if (!trimmed) {
            abs = generateAbsoluteXPath(el);
            trimmed = abs ? trimNonInteractiveXPathTail(abs) : null;
          }
        } catch (_) {
          trimmed = null;
        }
        if (!trimmed) continue;
        if (trimmed === sourceSelector) continue; // don't target the source itself

        const pathDepth = (trimmed.match(/\//g) || []).length;
        if (pathDepth >= 6) {
          // Prefer deeper, more specific elements
          console.log(
            "[DND][elementsFromPoint] Using fallback target:",
            el,
            trimmed
          );
          return { element: el, selector: trimmed };
        }
      }
    } catch (e) {
      console.warn("[DND][elementsFromPoint] Error:", e);
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
          const cx =
            refineCtx && refineCtx.clientX != null ? refineCtx.clientX : 0;
          const cy =
            refineCtx && refineCtx.clientY != null ? refineCtx.clientY : 0;
          const precisePoint = __selbasResolvePrecisePointTarget(
            cx,
            cy,
            srcSelector
          );
          let newTargetSelector = null;
          let newTargetElement = null;
          if (
            precisePoint &&
            precisePoint.selector &&
            precisePoint.selector !== action.targetSelector &&
            precisePoint.selector !== srcSelector
          ) {
            newTargetSelector = precisePoint.selector;
            newTargetElement = precisePoint.element;
          }
          // If new point element is a draggable item distinct from source, prefer that
          if (newTargetElement) {
            try {
              const refinedItem = __selbasResolveDropItem(
                newTargetElement,
                srcSelector
              );
              if (
                refinedItem &&
                refinedItem.selector !== srcSelector &&
                refinedItem.selector !== action.targetSelector
              ) {
                newTargetSelector = refinedItem.selector;
                newTargetElement = refinedItem.element;
                action.preciseTargetWasItem = true;
                action.targetSource = "item";
              }
            } catch (_) {
              /* ignore item refine errors */
            }
          }
          if (
            newTargetSelector &&
            newTargetSelector !== action.targetSelector
          ) {
            action.originalTargetSelector = action.targetSelector;
            action.targetSelector = newTargetSelector;
            action.targetElementInfo =
              getElementInfo(newTargetElement) ||
              action.targetElementInfo ||
              null;
            action.reasonCode = "post-frame-refined";
            action.postFrameRefined = true;
          } else {
            action.postFrameRefined = false;
          }
        } catch (refErr) {
          /* ignore refine errors */
        }
        try {
          chrome.runtime.sendMessage({
            command: "record_action",
            data: action,
          });
        } catch (sendErr) {
          console.warn("[DND] post-frame send failed:", sendErr);
          // If extension context is invalidated, try to store locally or skip gracefully
          if (
            sendErr.message &&
            sendErr.message.includes("Extension context invalidated")
          ) {
            console.warn(
              "[DND] Extension reloaded during drag operation, action lost:",
              action
            );
          }
        }
        console.log("[DND][post-frame-commit]", {
          chosenTarget: action.targetSelector,
          reasonCode: action.reasonCode,
          postFrameRefined: action.postFrameRefined || false,
          originalTargetSelector: action.originalTargetSelector || null,
        });
        delete window.__SELBAS_DRAG_SOURCE__;
        delete window.__SELBAS_DRAG_LAST_HIT__;
        delete window.__SELBAS_DRAG_COMPLETED__;
        delete window.__SELBAS_PENDING_DND__;
      };
      requestAnimationFrame(doRefine);
    } catch (e) {
      // Fallback: send immediately if something unexpected occurs
      try {
        chrome.runtime.sendMessage({ command: "record_action", data: action });
      } catch (_) {
        /* ignore */
      }
      delete window.__SELBAS_PENDING_DND__;
    }
  }

  function synthPointerDown(e) {
    try {
      if (!(e.target instanceof Element)) return;
      // Ignore right/middle clicks
      if (e.button !== 0) return;

      // Enhanced detection for dnd-kit elements
      const isDndElement =
        e.target.matches(
          "[data-rbd-draggable-id], [data-dnd-kit-id], [data-sortable-id]"
        ) ||
        e.target.closest(
          '[class*="draggable"], [class*="sortable"], [class*="dnd"], [class*="drag"]'
        ) ||
        e.target.matches('[draggable], [aria-roledescription="draggable"]');

      console.log(
        "[DND][pointerdown] Target:",
        e.target,
        "isDndElement:",
        isDndElement
      );

      __SELBAS_SYNTH_DRAG_STATE = {
        downEl: e.target,
        downX: e.clientX,
        downY: e.clientY,
        started: false,
        sourceSelector: null,
        pointerId: e.pointerId,
        downButtons: e.buttons,
        isDndElement, // Flag for enhanced processing
      };
    } catch (err) {
      /* ignore */
    }
  }

  function synthPointerMove(e) {
    try {
      if (!__SELBAS_SYNTH_DRAG_STATE || __SELBAS_SYNTH_DRAG_STATE.started)
        return;
      const dx = Math.abs(e.clientX - __SELBAS_SYNTH_DRAG_STATE.downX);
      const dy = Math.abs(e.clientY - __SELBAS_SYNTH_DRAG_STATE.downY);
      // Lower threshold for dnd-kit elements (more sensitive detection)
      const DIST = __SELBAS_SYNTH_DRAG_STATE.isDndElement ? 3 : 5;
      if (dx < DIST && dy < DIST) return;
      // Movement exceeded threshold, treat as drag start if no native dragstart occurred
      if (!window.__SELBAS_DRAG_SOURCE__) {
        const candidate =
          __SELBAS_SYNTH_DRAG_STATE.downEl instanceof Element
            ? __SELBAS_SYNTH_DRAG_STATE.downEl
            : null;
        if (candidate) {
          const sourceEl =
            candidate.closest(
              '[role="button"][aria-roledescription="draggable"], [aria-roledescription="draggable"], [draggable="true"], [data-rbd-draggable-id], [data-dnd-kit-id], [data-sortable-id]'
            ) ||
            candidate.closest(
              '[class*="draggable"], [class*="sortable"], [class*="dnd"], [class*="drag"]'
            ) ||
            candidate;
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
                  } catch (e) {
                    return null;
                  }
                })(),
                elementInfo: getElementInfo(sourceEl),
                elRef: sourceEl,
                timestamp: Date.now(),
                synthetic: true,
              };
              window.__SELBAS_DRAG_LAST_HIT__ = null;
              window.__SELBAS_DRAG_COMPLETED__ = false;
              console.log(
                "[DND][synthetic-dragstart] Created synthetic drag source:",
                window.__SELBAS_DRAG_SOURCE__
              );
              __SELBAS_SYNTH_DRAG_STATE.started = true;
              __SELBAS_SYNTH_LAST_TRACK__ = 0; // reset tracking throttle
            }
          } catch (err) {
            /* ignore */
          }
        }
      } else {
        // Native drag started meanwhile; mark synthetic state consumed
        __SELBAS_SYNTH_DRAG_STATE.started = true;
      }
    } catch (err) {
      /* ignore */
    }
  }

  // While synthetic drag is active (after we flagged started), we still want to track target candidates via pointer moves
  document.addEventListener(
    "pointermove",
    function (e) {
      try {
        if (
          !window.__SELBAS_DRAG_SOURCE__ ||
          !window.__SELBAS_DRAG_SOURCE__.synthetic
        )
          return; // only for synthetic drags
        if (!__SELBAS_SYNTH_DRAG_STATE || !__SELBAS_SYNTH_DRAG_STATE.started)
          return; // haven't started
        // Throttle to every ~120ms
        if (
          __SELBAS_SYNTH_LAST_TRACK__ &&
          Date.now() - __SELBAS_SYNTH_LAST_TRACK__ < 120
        )
          return;
        __SELBAS_SYNTH_LAST_TRACK__ = Date.now();
        const tgt = e.target instanceof Element ? e.target : null;
        if (!tgt) return;
        const dragSource = window.__SELBAS_DRAG_SOURCE__;
        const resolved = __selbasResolveDropContainerFrom(
          tgt,
          dragSource.selector
        );
        if (resolved && resolved.selector) {
          // Cache raw selector for debugging
          let rawSel = generateDragSelector(tgt);
          if (!rawSel) {
            try {
              const absRaw = generateAbsoluteXPath(tgt);
              rawSel = absRaw ? trimNonInteractiveXPathTail(absRaw) : null;
            } catch (err) {
              rawSel = null;
            }
          }
          window.__SELBAS_DRAG_LAST_HIT__ = {
            selector: resolved.selector,
            kind: resolved.kind,
            rawSelector: rawSel,
            elementInfo: getElementInfo(resolved.element),
          };
          // Light debug
          // console.log('[DND][synthetic-tracking] last hit =>', window.__SELBAS_DRAG_LAST_HIT__);
        }
      } catch (err) {
        /* ignore */
      }
    },
    true
  );

  function synthPointerUp(e) {
    try {
      // Only end if we have synthetic drag started AND pointerup matches initiating pointerId
      if (
        window.__SELBAS_DRAG_SOURCE__ &&
        window.__SELBAS_DRAG_SOURCE__.synthetic &&
        !window.__SELBAS_DRAG_COMPLETED__ &&
        __SELBAS_SYNTH_DRAG_STATE
      ) {
        if (
          e &&
          __SELBAS_SYNTH_DRAG_STATE.pointerId != null &&
          e.pointerId != null &&
          e.pointerId !== __SELBAS_SYNTH_DRAG_STATE.pointerId
        ) {
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
                } catch (err) {
                  return null;
                }
              })(),
              elementInfo: getElementInfo(r.element),
            };
          } else {
            // Fallback: use elementsFromPoint for better dnd-kit detection
            console.log(
              "[DND][synthetic-up] No container found via normal method, trying elementsFromPoint"
            );
            const preciseTarget = __selbasResolvePrecisePointTarget(
              e.clientX,
              e.clientY,
              src.selector
            );
            if (preciseTarget) {
              last = {
                selector: preciseTarget.selector,
                kind: "elementsFromPoint-fallback",
                rawSelector: preciseTarget.selector,
                elementInfo: getElementInfo(preciseTarget.element),
              };
            }
          }
        }
        if (last && last.selector && last.selector !== src.selector) {
          // Attempt precise item under pointerup target
          let preciseItem = null;
          try {
            const pointerEl =
              e && e.target instanceof Element ? e.target : null;
            // Prefer elementFromPoint for final accuracy
            let pointEl = null;
            let pointerElementSelector = null;
            try {
              const cx = e.clientX != null ? e.clientX : e.pageX || 0;
              const cy = e.clientY != null ? e.clientY : e.pageY || 0;
              pointEl = document.elementFromPoint(cx, cy) || pointerEl;
              if (pointEl) {
                pointerElementSelector = generateDragSelector(pointEl);
                if (!pointerElementSelector) {
                  const absP = generateAbsoluteXPath(pointEl);
                  pointerElementSelector = absP
                    ? trimNonInteractiveXPathTail(absP)
                    : null;
                }
              }
              // New: attempt multi-layer precision resolution
              const precisePoint = __selbasResolvePrecisePointTarget(
                cx,
                cy,
                src.selector
              );
              if (
                precisePoint &&
                precisePoint.selector &&
                precisePoint.selector !== pointerElementSelector
              ) {
                // Use more precise layer for pointer element if available
                pointerElementSelector = precisePoint.selector;
                pointEl = precisePoint.element;
              }
            } catch (err) {
              pointEl = pointerEl;
            }
            preciseItem = pointEl
              ? __selbasResolveDropItem(pointEl, src.selector)
              : null;
            if (!preciseItem && pointerEl && pointEl !== pointerEl) {
              preciseItem =
                __selbasResolveDropItem(pointerEl, src.selector) || preciseItem;
            }
            // attach pointerElementSelector into closure scope for later use
            e.__selbasPointerElementSelector = pointerElementSelector;
          } catch (err) {
            /* ignore */
          }
          // Descendant guard: if pointer element lies inside source (and not a distinct item) fallback to container last.selector
          let reasonCode = "ok";
          try {
            if (
              !preciseItem &&
              src.elRef &&
              e &&
              e.target instanceof Element &&
              src.elRef.contains(e.target)
            ) {
              if (e.__selbasPointerElementSelector) {
                reasonCode = "pointer-inside-source";
              }
              if (e.__selbasPointerElementSelector === src.selector) {
                reasonCode = "pointer-equals-source";
              }
              if (e.__selbasPointerElementSelector) {
                // neutralize pointer element so container becomes target
                e.__selbasPointerElementSelector = null;
              }
            }
          } catch (_) {}
          let targetSelector = preciseItem
            ? preciseItem.selector
            : e.__selbasPointerElementSelector &&
              e.__selbasPointerElementSelector !== src.selector
            ? e.__selbasPointerElementSelector
            : last.selector;
          if (targetSelector === src.selector) {
            reasonCode = "target-equals-source-skip";
          }
          if (targetSelector !== src.selector) {
            const sourceElement = src.element || null;
            const targetElement = (preciseItem && preciseItem.element) || null;
            
            const action = {
              type: "DragAndDrop",
              sourceSelector: src.selector,
              targetSelector: targetSelector,
              sourceSelectorList: sourceElement ? generateSelectorList(sourceElement) : [src.selector],
              targetSelectorList: targetElement ? generateSelectorList(targetElement) : [targetSelector],
              sourceElementInfo: src.elementInfo,
              targetElementInfo:
                getElementInfo(targetElement) ||
                last.elementInfo ||
                null,
              containerKind: last.kind || "synthetic-pointer",
              containerSelector: last.selector,
              pointerElementSelector: e.__selbasPointerElementSelector || null,
              rawTargetSelector: last.rawSelector || null,
              preciseTargetWasItem: !!preciseItem,
              targetSource: preciseItem
                ? "item"
                : e.__selbasPointerElementSelector &&
                  e.__selbasPointerElementSelector !== last.selector
                ? "pointer-element"
                : "container",
              reasonCode,
              selectorType: "XPath",
              timestamp: Date.now(),
            };
            // Enhanced debug for dnd-kit troubleshooting
            console.log("[DND][synthetic-up] Recording action:", {
              sourceSelector: action.sourceSelector,
              targetSelector: action.targetSelector,
              targetSource: action.targetSource,
              reasonCode: action.reasonCode,
              pointerCoords: { x: e.clientX, y: e.clientY },
              targetElement: targetElement,
            });

            // Post-frame refinement commit instead of immediate send
            window.__SELBAS_DRAG_COMPLETED__ = true; // mark to block other synthetic fallbacks
            __selbasPostFrameRefineAndSend(action, {
              clientX: e.clientX,
              clientY: e.clientY,
            });
          } else {
            console.log(
              "[DND] Synthetic pointerup target same as source; skip."
            );
          }
        } else {
          console.log(
            "[DND] Synthetic pointerup had no distinct target to record."
          );
        }
        // Cleanup will occur after post-frame refinement commit
      }
    } catch (err) {
      /* ignore */
    }
    __SELBAS_SYNTH_DRAG_STATE = null;
  }

  /**
   * Handles dragenter events for file drag operations
   * @param {Event} event
   */
  function handleDragEnter(event) {
    try {
      // More precise check for external file drag vs internal element drag
      // Only treat as file drag if:
      // 1. dataTransfer.types includes 'Files' AND
      // 2. No recorded drag source (meaning it's from outside browser) OR
      // 3. The drag source is not a DOM element we're tracking
      const hasFileTypes =
        event.dataTransfer &&
        event.dataTransfer.types &&
        event.dataTransfer.types.includes("Files");
      const hasRecordedSource =
        window.__SELBAS_DRAG_SOURCE__ && window.__SELBAS_DRAG_SOURCE__.selector;
      const isExternalFileDrag = hasFileTypes && !hasRecordedSource;

      if (isExternalFileDrag) {
        event.preventDefault();
        console.log(
          "[DND][dragenter] External file drag entering:",
          event.target
        );

        // Add visual feedback if the target looks like a drop zone
        const dropZone = event.target.closest(
          '[data-drop-zone], [class*="drop"], [class*="upload"], [accept], .upload-area, .dropzone, .file-drop, [data-testid*="upload"], [data-testid*="drop"]'
        );
        if (dropZone && dropZone.classList) {
          dropZone.classList.add("drag-over");
        }
      } else if (hasFileTypes && hasRecordedSource) {
        // This is an internal element drag that happens to include 'Files' in types
        // (common with img elements) - don't treat as file upload
        console.log(
          "[DND][dragenter] Internal element drag with Files type detected, not treating as file upload"
        );
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
    console.log("[DND][handleFileDrop] ========== START ==========");
    try {
      event.preventDefault(); // Prevent browser's default file handling

      const rawDropTarget = event.target;
      console.log("[DND][handleFileDrop] Raw drop target:", rawDropTarget);
      if (!(rawDropTarget instanceof Element)) {
        console.warn(
          "[DND][handleFileDrop] Drop target is not an Element, aborting"
        );
        return;
      }

      const files = Array.from(event.dataTransfer.files || []);
      console.log("[DND][handleFileDrop] Files count:", files.length);
      if (files.length === 0) {
        console.warn("[DND][handleFileDrop] No files in drop event, aborting");
        return;
      }

      // Additional check: If we have a recorded drag source, this might be an internal element drag
      // that was mistakenly identified as a file drop. Only proceed if we can find an actual
      // file input element that this drop should be associated with.
      const hasRecordedSource =
        window.__SELBAS_DRAG_SOURCE__ && window.__SELBAS_DRAG_SOURCE__.selector;

      if (hasRecordedSource) {
        // For internal element drags, we need to be extra sure this is actually a file upload
        // Look for explicit file upload indicators
        const hasFileInput =
          document.querySelector('input[type="file"]') !== null;
        const hasUploadForm =
          rawDropTarget.closest("form") &&
          rawDropTarget.closest("form").querySelector('input[type="file"]');
        const hasExplicitUploadIndicators =
          rawDropTarget.closest(
            '[data-file-upload], [data-upload], input[type="file"]'
          ) ||
          /file.*upload|upload.*file|file.*input/i.test(
            rawDropTarget.textContent || ""
          ) ||
          rawDropTarget.hasAttribute("accept");

        if (!hasFileInput && !hasUploadForm && !hasExplicitUploadIndicators) {
          console.log(
            "[DND][file-drop] Skipping file drop handling - appears to be internal element drag with phantom files"
          );
          return;
        }

        console.log(
          "[DND][file-drop] Confirmed file upload context despite recorded drag source"
        );
      }

      const fileNames = files
        .map((f) => (f && f.name ? f.name : ""))
        .filter(Boolean);
      console.log("[DND][file-drop] Files dropped:", fileNames);

      // Clean up visual feedback first
      const dropZones = document.querySelectorAll(".drag-over");
      dropZones.forEach((zone) => zone.classList.remove("drag-over"));

      // Generate selector for the actual file input element (not the drop zone)
      let selector = null;
      try {
        let fileInput = null;

        // Strategy 1: Check if the drop target itself is a file input
        if (
          rawDropTarget.matches &&
          rawDropTarget.matches('input[type="file"]')
        ) {
          fileInput = rawDropTarget;
          console.log("[DND][file-drop] Strategy 1: Drop target is file input");
        }

        // Strategy 2: Check within the drop target (including hidden inputs)
        if (!fileInput) {
          fileInput = rawDropTarget.querySelector('input[type="file"]');
          if (fileInput) {
            console.log(
              "[DND][file-drop] Strategy 2: Found file input within drop target"
            );
          }
        }

        // Strategy 3: Check in parent and siblings (for hidden inputs)
        if (!fileInput) {
          let parent = rawDropTarget.parentElement;
          while (parent && parent !== document.body) {
            const inputs = parent.querySelectorAll('input[type="file"]');
            if (inputs.length > 0) {
              // Prefer visible inputs, but accept hidden ones
              for (const input of inputs) {
                if (input.offsetParent !== null) {
                  fileInput = input;
                  break;
                }
              }
              // If no visible input, use first hidden one
              if (!fileInput) {
                fileInput = inputs[0];
              }
              if (fileInput) {
                console.log(
                  "[DND][file-drop] Strategy 3: Found file input in parent:",
                  parent
                );
                break;
              }
            }
            parent = parent.parentElement;
          }
        }

        // Strategy 4: Look for inputs with data attributes
        if (!fileInput) {
          const uploadElements = document.querySelectorAll(
            "[data-file-upload], [data-upload], [data-drop-zone]"
          );
          for (const elem of uploadElements) {
            if (elem.contains(rawDropTarget) || rawDropTarget.contains(elem)) {
              const input =
                elem.querySelector('input[type="file"]') ||
                (elem.matches('input[type="file"]') ? elem : null);
              if (input) {
                fileInput = input;
                console.log(
                  "[DND][file-drop] Strategy 4: Found file input via data attributes"
                );
                break;
              }
            }
          }
        }

        // Strategy 5: Search nearby file inputs (last resort)
        if (!fileInput) {
          const allFileInputs = document.querySelectorAll('input[type="file"]');
          if (allFileInputs.length > 0) {
            // Find the closest file input to the drop point
            let closestInput = null;
            let minDistance = Infinity;

            for (const input of allFileInputs) {
              const rect = input.getBoundingClientRect();
              const distance = Math.sqrt(
                Math.pow(event.clientX - (rect.left + rect.width / 2), 2) +
                  Math.pow(event.clientY - (rect.top + rect.height / 2), 2)
              );
              if (distance < minDistance) {
                minDistance = distance;
                closestInput = input;
              }
            }

            // Only use if reasonably close (within 500px)
            if (closestInput && minDistance < 500) {
              fileInput = closestInput;
              console.log(
                "[DND][file-drop] Strategy 5: Found closest file input (distance:",
                minDistance,
                ")"
              );
            }
          }
        }

        // Only if we found a real file input, proceed with upload recording
        if (!fileInput) {
          console.warn(
            "[DND][file-drop] No file input found - not recording as upload"
          );
          console.warn("[DND][file-drop] Drop target:", rawDropTarget);
          console.warn(
            "[DND][file-drop] Available file inputs:",
            document.querySelectorAll('input[type="file"]')
          );
          return;
        }

        console.log("[DND][file-drop] ✅ Found valid file input:", fileInput);

        // Use the file input element for the selector
        console.log("[DND][file-drop] Generating selector...");
        selector = generateRobustSelector(fileInput);
        console.log(
          "[DND][file-drop] generateRobustSelector result:",
          selector
        );

        if (!selector) {
          console.log(
            "[DND][file-drop] No selector from generateRobustSelector, trying generateAbsoluteXPath..."
          );
          const absXPath = generateAbsoluteXPath(fileInput);
          console.log(
            "[DND][file-drop] generateAbsoluteXPath result:",
            absXPath
          );
          selector = absXPath ? trimNonInteractiveXPathTail(absXPath) : null;
          console.log(
            "[DND][file-drop] After trimNonInteractiveXPathTail:",
            selector
          );
        }

        console.log("[DND][file-drop] 🎯 Final selector:", selector);
      } catch (e) {
        console.error(
          "[DND][file-drop] ❌ Exception during selector generation:",
          e
        );
        console.warn("handleFileDrop: Could not generate selector:", e);
        return;
      }

      console.log("[DND][file-drop] Checking if selector exists...");
      if (!selector) {
        console.error(
          "[DND][file-drop] ❌ Could not generate selector for drop target"
        );
        console.warn(
          "handleFileDrop: Could not generate selector for drop target"
        );
        return;
      }

      console.log(
        "[DND][file-drop] ✅ Selector validated, creating action data..."
      );

      // Create the action data
      const actionData = {
        type: "Upload", // Use same type as click upload for consistency
        method: "drag-drop", // Distinguish from click-based file upload
        selector: selector,
        value: fileNames.join(", "), // Display in side panel
        fileNames: fileNames, // Extra metadata for generator
        fileCount: fileNames.length,
        selectorType:
          selector &&
          (selector.startsWith("xpath=") || selector.startsWith("/"))
            ? "XPath"
            : "CSS",
        timestamp: Date.now(),
        dropCoordinates: {
          clientX: event.clientX,
          clientY: event.clientY,
          pageX: event.pageX,
          pageY: event.pageY,
        },
      };

      console.log("handleFileDrop: Action recorded (Content):", actionData);

      // Send the recorded action
      console.log(
        "[DND][handleFileDrop] 📤 Sending record_action message to background..."
      );
      try {
        chrome.runtime
          .sendMessage({ command: "record_action", data: actionData })
          .then(() => {
            console.log("[DND][handleFileDrop] ✅ Message sent successfully!");
          })
          .catch((error) => {
            if (
              error.message &&
              !error.message.includes("Extension context invalidated") &&
              !error.message.includes("message port closed")
            ) {
              console.error(
                "handleFileDrop: ❌ Error sending file drop action message:",
                error
              );
            } else {
              console.warn(
                "handleFileDrop: Extension context issue (expected during reload)"
              );
            }
          });
      } catch (error) {
        if (
          error.message &&
          !error.message.includes("Extension context invalidated")
        ) {
          console.error(
            "handleFileDrop: ❌ Synchronous error sending file drop action:",
            error
          );
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
            if (typeof dataUrl === "string") {
              try {
                chrome.runtime.sendMessage({
                  command: "upload_file",
                  data: {
                    name: f.name,
                    dataUrl,
                    method: "drag-drop",
                    dropTarget: selector, // Include drop target info
                  },
                });
              } catch (e) {}
            }
          };
          reader.onerror = () => {
            /* ignore */
          };
          reader.readAsDataURL(f);
        } catch (e) {
          /* ignore per-file */
        }
      });

      console.log("[DND][handleFileDrop] ========== END ==========");
    } catch (e) {
      console.error("[DND][handleFileDrop] ❌ EXCEPTION:", e);
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
      console.log("[DND][drop] raw drop target:", rawDropTarget);

      // Better distinction between file drops and element drags
      // Only treat as file drop if:
      // 1. Has actual files in dataTransfer.files AND
      // 2. No recorded drag source (external files) OR
      // 3. The files are actually from file system (not empty FileList from element drag)
      const hasFiles =
        event.dataTransfer &&
        event.dataTransfer.files &&
        event.dataTransfer.files.length > 0;
      const hasRecordedSource =
        window.__SELBAS_DRAG_SOURCE__ && window.__SELBAS_DRAG_SOURCE__.selector;
      const isRealFileDropFromOutside = hasFiles && !hasRecordedSource;

      // Additional check: if we have a recorded source but also files,
      // verify these are actual external files, not phantom files from element drag
      let isActualFileUpload = isRealFileDropFromOutside;
      if (hasFiles && hasRecordedSource) {
        // Check if any file has actual content/size (real files have size > 0)
        const realFiles = Array.from(event.dataTransfer.files).filter(
          (f) => f && f.size >= 0
        );
        isActualFileUpload =
          realFiles.length > 0 && realFiles.some((f) => f.size > 0 || f.type);
      }

      console.log("[DND][drop] Analysis:", {
        hasFiles,
        hasRecordedSource,
        isRealFileDropFromOutside,
        isActualFileUpload,
        fileCount: hasFiles ? event.dataTransfer.files.length : 0,
      });

      if (isActualFileUpload) {
        console.log(
          "[DND][file-drop] ✅ Detected actual file drop with",
          event.dataTransfer.files.length,
          "files - calling handleFileDrop()"
        );
        handleFileDrop(event);
        return; // File drop is handled separately from element drag-and-drop
      } else if (hasFiles && hasRecordedSource) {
        console.log(
          "[DND][element-drag] ❌ Detected element drag with phantom files, treating as element drag"
        );
      } else if (hasFiles) {
        console.log(
          "[DND][drop] ⚠️ Has files but not detected as actual file upload"
        );
      } else {
        console.log(
          "[DND][drop] No files in drop event, treating as element drag"
        );
      }

      // Use DND-Kit enhancer for better drop detection
      let dndKitDropDetection = null;
      if (window.DND_KIT_ENHANCER) {
        dndKitDropDetection =
          window.DND_KIT_ENHANCER.enhancedDropDetection(event);
      }

      // Use elementFromPoint to capture exact element under cursor at release
      let pointEl = null;
      let pointerElementSelector = null;
      try {
        const cx = event.clientX != null ? event.clientX : event.pageX || 0;
        const cy = event.clientY != null ? event.clientY : event.pageY || 0;
        pointEl = document.elementFromPoint(cx, cy) || rawDropTarget;
        if (pointEl) {
          pointerElementSelector = generateDragSelector(pointEl);
          if (!pointerElementSelector) {
            const absPt = generateAbsoluteXPath(pointEl);
            pointerElementSelector = absPt
              ? trimNonInteractiveXPathTail(absPt)
              : null;
          }
        }
        // New precision resolution using full stacking order
        const precisePoint = __selbasResolvePrecisePointTarget(
          cx,
          cy,
          (window.__SELBAS_DRAG_SOURCE__ &&
            window.__SELBAS_DRAG_SOURCE__.selector) ||
            null
        );
        if (
          precisePoint &&
          precisePoint.selector &&
          precisePoint.selector !== pointerElementSelector
        ) {
          pointEl = precisePoint.element;
          pointerElementSelector = precisePoint.selector;
        }
      } catch (err) {
        pointEl = rawDropTarget;
      }
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
        const flexGrow = el.closest(
          '[style*="flex-grow: 1"][style*="min-height"]'
        );
        if (flexGrow) candidates.push({ el: flexGrow, kind: "flex-grow" });
        // Priority 2: scroll container
        const scroll = el.closest(
          '[style*="overflow-y: auto"],[style*="overflow: auto"],[style*="overflow-y:auto"]'
        );
        if (scroll) candidates.push({ el: scroll, kind: "scroll" });
        // Priority 3: any draggable list semantics
        const ariaList = el.closest(
          '[role="list"], [aria-roledescription="list"]'
        );
        if (ariaList) candidates.push({ el: ariaList, kind: "aria-list" });
        // Fallback: original target
        candidates.push({ el, kind: "raw-target" });
        // Choose first whose XPath differs from source
        for (const c of candidates) {
          try {
            let trimmed = generateDragSelector(c.el);
            if (!trimmed) {
              const abs = generateAbsoluteXPath(c.el);
              trimmed = abs ? trimNonInteractiveXPathTail(abs) : null;
            }
            if (trimmed && trimmed !== dragSource.selector)
              return { selector: trimmed, kind: c.kind, element: c.el };
          } catch (e) {
            /* ignore */
          }
        }
        return null;
      }

      const foundContainer = findDropContainer(rawDropTarget);
      if (!foundContainer) {
        console.warn(
          "handleDrop: Could not resolve a stable drop container; aborting."
        );
        console.warn(
          "[DND] raw target absolute XPath for diagnostics:",
          (function () {
            try {
              const a = generateAbsoluteXPath(rawDropTarget);
              return a;
            } catch (e) {
              return null;
            }
          })()
        );
        delete window.__SELBAS_DRAG_SOURCE__;
        return;
      }
      // Resolve precise item from elementFromPoint first, fallback to rawDropTarget
      const foundItem =
        __selbasResolveDropItem(pointEl, dragSource.selector) ||
        __selbasResolveDropItem(rawDropTarget, dragSource.selector);
      // Priority: specific draggable item > precise pointer element > generic pointerElementSelector > container
      let reasonCode = "ok";
      let primaryTargetSelector =
        foundItem && foundItem.selector
          ? foundItem.selector
          : pointerElementSelector &&
            pointerElementSelector !== dragSource.selector
          ? pointerElementSelector
          : foundContainer.selector;
      // Guard: if pointer element ended inside the source (and not a distinct item) force container
      try {
        if (
          !foundItem &&
          dragSource.elRef &&
          pointEl &&
          dragSource.elRef.contains(pointEl) &&
          primaryTargetSelector !== foundContainer.selector
        ) {
          reasonCode = "pointer-inside-source";
          primaryTargetSelector = foundContainer.selector;
        }
      } catch (_) {}
      if (primaryTargetSelector === dragSource.selector) {
        console.log(
          "handleDrop: Source and target resolved to same element; ignoring."
        );
        delete window.__SELBAS_DRAG_SOURCE__;
        return;
      }

      // Additional raw target selector (for debug / potential future refinement)
      let rawTargetSelector = null;
      try {
        // For drag operations, prefer ID selectors
        rawTargetSelector = generateDragSelector(rawDropTarget);
        if (!rawTargetSelector) {
          const absRaw = generateAbsoluteXPath(rawDropTarget);
          rawTargetSelector = absRaw
            ? trimNonInteractiveXPathTail(absRaw)
            : null;
        }
      } catch (e) {
        /* ignore */
      }

      const sourceElement = dragSource.element || null;
      const targetElement = (foundItem && foundItem.element) || pointEl || foundContainer.element;

      const action = {
        type: "DragAndDrop",
        sourceSelector: dragSource.selector,
        targetSelector: primaryTargetSelector,
        sourceSelectorList: sourceElement ? generateSelectorList(sourceElement) : [dragSource.selector],
        targetSelectorList: targetElement ? generateSelectorList(targetElement) : [primaryTargetSelector],
        sourceElementInfo: dragSource.elementInfo,
        targetElementInfo: getElementInfo(targetElement),
        containerKind: foundContainer.kind,
        containerSelector: foundContainer.selector,
        pointerElementSelector,
        rawTargetSelector,
        preciseTargetWasItem: !!foundItem,
        targetSource: foundItem
          ? "item"
          : pointerElementSelector &&
            pointerElementSelector !== foundContainer.selector
          ? "pointer-element"
          : "container",
        reasonCode,
        selectorType: "XPath",
        timestamp: Date.now(),
        // DND-Kit specific properties
        isDndKit:
          dragSource.isDndKit ||
          (dndKitDropDetection && dndKitDropDetection.isDndKit),
        dndKitSourceId: dragSource.dndKitId,
        dndKitTargetId: dndKitDropDetection ? dndKitDropDetection.id : null,
        dndKitSourceType: dragSource.dndKitType,
        dndKitTargetType: dndKitDropDetection ? dndKitDropDetection.type : null,
        insertionType: dndKitDropDetection
          ? dndKitDropDetection.insertionType
          : null,
      };
      window.__SELBAS_DRAG_COMPLETED__ = true; // prevent synthetic fallbacks
      // Defer sending to allow DOM to settle and refine final target
      __selbasPostFrameRefineAndSend(action, {
        clientX: event.clientX,
        clientY: event.clientY,
      });
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
      console.log("[DND][dragend] fired");
      // Skip synthetic fallback if a post-frame commit is pending
      if (window.__SELBAS_PENDING_DND__) {
        return; // refinement path will handle cleanup
      }
      if (window.__SELBAS_DRAG_SOURCE__ && !window.__SELBAS_DRAG_COMPLETED__) {
        // No native drop captured; attempt a synthetic recording using last known hit element
        const src = window.__SELBAS_DRAG_SOURCE__;
        const last = window.__SELBAS_DRAG_LAST_HIT__;
        if (last && last.selector && last.selector !== src.selector) {
          console.log(
            "[DND] Synthesizing DragAndDrop action from dragend using last pointer hit:",
            last
          );
          const sourceElement = src.element || null;
          const targetElement = last.element || null;
          
          const action = {
            type: "DragAndDrop",
            sourceSelector: src.selector,
            targetSelector: last.selector,
            sourceSelectorList: sourceElement ? generateSelectorList(sourceElement) : [src.selector],
            targetSelectorList: targetElement ? generateSelectorList(targetElement) : [last.selector],
            sourceElementInfo: src.elementInfo,
            targetElementInfo: last.elementInfo || null,
            containerKind: last.kind || "synthetic-end",
            rawTargetSelector: last.rawSelector || null,
            selectorType: "XPath",
            timestamp: Date.now(),
          };
          try {
            chrome.runtime.sendMessage({
              command: "record_action",
              data: action,
            });
          } catch (e) {
            console.warn("[DND] Failed to send synthetic drag action:", e);
          }
        } else {
          console.log(
            "[DND] dragend produced no usable target to synthesize action."
          );
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
      if (
        event.dataTransfer &&
        event.dataTransfer.types &&
        event.dataTransfer.types.includes("Files")
      ) {
        console.log("[DND][dragleave] File drag leaving:", event.target);

        // Remove visual feedback
        const dropZone = event.target.closest(
          '[data-drop-zone], [class*="drop"], [class*="upload"], [accept], .upload-area, .dropzone, .file-drop, [data-testid*="upload"], [data-testid*="drop"]'
        );
        if (dropZone && dropZone.classList) {
          dropZone.classList.remove("drag-over");
        }
      }
    } catch (e) {
      console.warn("Content: handleDragLeave error:", e);
    }
  }

  // Additional dragover logging to ensure drag sequence progression
  function handleDragOver(event) {
    try {
      // More precise file drag detection
      const hasFileTypes =
        event.dataTransfer &&
        event.dataTransfer.types &&
        event.dataTransfer.types.includes("Files");
      const hasRecordedSource =
        window.__SELBAS_DRAG_SOURCE__ && window.__SELBAS_DRAG_SOURCE__.selector;
      const isExternalFileDrag = hasFileTypes && !hasRecordedSource;

      if (isExternalFileDrag) {
        event.preventDefault(); // Allow file drop
        console.log("[DND][dragover] External file drag over:", event.target);
        // Allow file drop by setting dropEffect
        event.dataTransfer.dropEffect = "copy";
        return;
      } else if (hasFileTypes && hasRecordedSource) {
        // Internal element drag - still prevent default to allow drop
        console.log(
          "[DND][dragover] Internal element drag over (with Files type):",
          event.target
        );
      }

      // Prevent default to allow drop events for element drags
      event.preventDefault();

      // Only log intermittently to avoid flooding: every ~300ms
      if (
        !window.__SELBAS_LAST_DRAGOVER_LOG__ ||
        Date.now() - window.__SELBAS_LAST_DRAGOVER_LOG__ > 300
      ) {
        window.__SELBAS_LAST_DRAGOVER_LOG__ = Date.now();
        const tgt = event.target instanceof Element ? event.target : null;
        console.log("[DND][dragover] over:", tgt);
      }
      // Track last viable drop container continuously
      try {
        if (
          window.__SELBAS_DRAG_SOURCE__ &&
          !window.__SELBAS_DRAG_COMPLETED__ &&
          event.target instanceof Element
        ) {
          const tgtEl = event.target;
          // Reuse same heuristic logic as in handleDrop (duplicated minimally to avoid function refactor)
          const candidates = [];
          const flexGrow = tgtEl.closest(
            '[style*="flex-grow: 1"][style*="min-height"]'
          );
          if (flexGrow) candidates.push({ el: flexGrow, kind: "flex-grow" });
          const scroll = tgtEl.closest(
            '[style*="overflow-y: auto"],[style*="overflow: auto"],[style*="overflow-y:auto"]'
          );
          if (scroll) candidates.push({ el: scroll, kind: "scroll" });
          const ariaList = tgtEl.closest(
            '[role="list"], [aria-roledescription="list"]'
          );
          if (ariaList) candidates.push({ el: ariaList, kind: "aria-list" });
          candidates.push({ el: tgtEl, kind: "raw-target" });
          for (const c of candidates) {
            try {
              const abs = generateAbsoluteXPath(c.el);
              const trimmed = abs ? trimNonInteractiveXPathTail(abs) : null;
              if (
                trimmed &&
                trimmed !== window.__SELBAS_DRAG_SOURCE__.selector
              ) {
                window.__SELBAS_DRAG_LAST_HIT__ = {
                  selector: trimmed,
                  kind: c.kind,
                  rawSelector: (function () {
                    try {
                      const a = generateAbsoluteXPath(event.target);
                      return a ? trimNonInteractiveXPathTail(a) : null;
                    } catch (e) {
                      return null;
                    }
                  })(),
                  elementInfo: getElementInfo(c.el),
                };
                break;
              }
            } catch (e) {
              /* ignore candidate calc */
            }
          }
        }
      } catch (e) {
        /* ignore tracking errors */
      }
    } catch (e) {
      /* ignore */
    }
  }
  // --- Hover Detection (record after 500ms over the same element; absolute XPath) ---
  (function attachHoverDetection() {
    const HOVER_THRESHOLD_MS = 500;
    const hoverTimers = new WeakMap(); // Element -> timeoutId
    const lastHoverBySelector = new Map(); // selector -> timestamp (dedupe window)
    const DEDUPE_MS = 1000;

    function clearTimer(el) {
      const t = hoverTimers.get(el);
      if (t) {
        try {
          clearTimeout(t);
        } catch (e) {}
        hoverTimers.delete(el);
      }
    }

    document.addEventListener(
      "mouseover",
      (event) => {
        try {
          const target = event.target;
          //console.log('[HOVER-DEBUG] Mouseover detected on:', target.tagName, target.id, target.className);

          if (!(target instanceof Element)) {
            //console.log('[HOVER-DEBUG] ❌ Target is not an Element');
            return;
          }

          // Check if element is interactive or has hover behavior
          const isInteractive = target.matches(
            'a, button, [role="button"], [role="combobox"], [aria-haspopup], [data-testid*="trigger"], [class*="dropdown"], [class*="menu"], [onclick], [onmouseover], [onmouseenter]'
          );
          // console.log('[HOVER-DEBUG] Is interactive?', isInteractive, '| Matches:', {
          //     isLink: target.matches('a'),
          //     isButton: target.matches('button'),
          //     hasRoleButton: target.matches('[role="button"]'),
          //     hasRoleCombobox: target.matches('[role="combobox"]'),
          //     hasAriaHaspopup: target.matches('[aria-haspopup]'),
          //     hasDropdownClass: target.matches('[class*="dropdown"]'),
          //     hasMenuClass: target.matches('[class*="menu"]'),
          //     hasOnclick: target.matches('[onclick]'),
          //     hasOnmouseover: target.matches('[onmouseover]'),
          //     hasOnmouseenter: target.matches('[onmouseenter]')
          // });

          if (!isInteractive) {
            //console.log('[HOVER-DEBUG] ❌ Element is not interactive, skipping');
            return;
          }

          // If there's already a timer for this target, ignore re-entry
          if (hoverTimers.has(target)) {
            //console.log('[HOVER-DEBUG] ⏰ Timer already exists for this element, skipping');
            return;
          }

          //console.log('[HOVER-DEBUG] ✅ Starting hover timer...');
          const timerId = setTimeout(() => {
            //console.log('[HOVER-DEBUG] ⏰ Hover timer fired!');
            hoverTimers.delete(target);
            // Build absolute XPath for target
            let selector = null;
            try {
              const abs = generateAbsoluteXPath(target);
              selector = abs ? trimNonInteractiveXPathTail(abs) : null;
              console.log("[HOVER-DEBUG] Generated selector:", selector);
              if (abs === "/html") {
                console.log("[HOVER-DEBUG] ❌ Selector is /html, skipping");
                return;
              }
            } catch (e) {
              console.log("[HOVER-DEBUG] ❌ Error generating selector:", e);
              selector = null;
            }
            if (!selector) {
              console.log("[HOVER-DEBUG] ❌ No valid selector generated");
              return;
            }

            // Dedupe rapid repeated hovers on the same selector
            const now = Date.now();
            const lastTs = lastHoverBySelector.get(selector) || 0;
            if (now - lastTs < DEDUPE_MS) {
              console.log(
                "[HOVER-DEBUG] ❌ Duplicate hover detected (within dedupe window), skipping"
              );
              return;
            }
            lastHoverBySelector.set(selector, now);

            console.log(
              "[HOVER-DEBUG] ✅ Recording hover action, sending to background..."
            );
            try {
              chrome.runtime.sendMessage({
                command: "record_action",
                data: {
                  type: "Hover",
                  selector,
                  selectorType: "XPath",
                  timestamp: now,
                  value: `Hovered on <${target.tagName.toLowerCase()}>`,
                  elementInfo: getElementInfo(target),
                },
              });
              console.log(
                "[HOVER-DEBUG] ✅ Message sent to background successfully!"
              );
            } catch (e) {
              console.log(
                "[HOVER-DEBUG] ❌ Error sending message to background:",
                e
              );
            }
          }, HOVER_THRESHOLD_MS);

          hoverTimers.set(target, timerId);
          //console.log('[HOVER-DEBUG] Timer set with ID:', timerId, '| Threshold:', HOVER_THRESHOLD_MS, 'ms');

          const onMouseOut = () => {
            //console.log('[HOVER-DEBUG] Mouse out detected, clearing timer');
            clearTimer(target);
            target.removeEventListener("mouseout", onMouseOut);
          };
          target.addEventListener("mouseout", onMouseOut, { once: true });
        } catch (e) {
          console.log("[HOVER-DEBUG] ❌ Fatal error in mouseover handler:", e);
        }
      },
      { passive: true }
    );
  })();
})(); // End of content script IIFE
