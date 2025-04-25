/**
 * content.js
 * This script is injected into the webpage to record user interactions.
 * It listens for relevant events (click, change) and sends data
 * back to the background script. It also handles requests to capture HTML.
 * *** Selector Strategy: ID -> Attributes -> Stable Classes -> Structure -> Text XPath -> Absolute XPath -> Tag Name. ***
 */

console.log("Selenium Recorder: Content script injected (v12 - text content xpath).");

// --- State ---
let isListenerAttached = false;

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
 * Prioritization: ID -> Name -> data-testid -> role -> title -> Stable Class(es) -> Simple Structure -> Text Content XPath -> Absolute XPath -> Basic TagName.
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

    // 6. Stable Class names
    if (el.classList && el.classList.length > 0) {
        const forbiddenClassesRegex = /^(?:active|focus|hover|selected|checked|disabled|visited|focus-within|focus-visible|focusNow|open|opened|closed|collapsed|expanded|js-|ng-|is-|has-|ui-|data-v-|aria-)/i;
        const stableClasses = Array.from(el.classList)
            .map(c => c.trim())
            .filter(c => c && !forbiddenClassesRegex.test(c) && /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(c));

        if (stableClasses.length > 0) {
            const fullClassSelector = `${tagName}.${stableClasses.map(c => CSS.escape(c)).join('.')}`;
            try {
                if (document.querySelectorAll(fullClassSelector).length === 1) return fullClassSelector;
            } catch (e) { /* ignore */ }

             stableClasses.sort((a, b) => a.length - b.length);
             for (const stableClass of stableClasses) {
                  const singleClassSelector = `${tagName}.${CSS.escape(stableClass)}`;
                  try {
                      if (document.querySelectorAll(singleClassSelector).length === 1) return singleClassSelector;
                  } catch(e) { /* ignore */ }
             }
        }
    }

    // 7. Simplified Structure (CSS: nth-of-type / nth-child)
    try {
        if (el.parentNode) {
            let siblingOfType = el;
            let typeIndex = 1;
            while ((siblingOfType = siblingOfType.previousElementSibling)) {
                if (siblingOfType.tagName === el.tagName) typeIndex++;
            }
            const nthOfTypeSelector = `${tagName}:nth-of-type(${typeIndex})`;
            if (document.querySelectorAll(nthOfTypeSelector).length === 1) return nthOfTypeSelector;

            let siblingChild = el;
            let childIndex = 1;
            while ((siblingChild = siblingChild.previousElementSibling)) {
                childIndex++;
            }
            const nthChildSelector = `${tagName}:nth-child(${childIndex})`;
             if (document.querySelectorAll(nthChildSelector).length === 1) return nthChildSelector;
        }
    } catch(e) { console.warn("Error during simplified structure generation:", e) }

    // *** NEW Step 8: Text Content XPath ***
    // Only attempt for specific tags likely to have meaningful text
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

                 // If exact match fails, try contains() - more lenient but less precise
                 // textXPath = `//${tagName}[contains(normalize-space(), ${escapedText})]`;
                 // if (document.evaluate(`count(${textXPath})`, document, null, XPathResult.NUMBER_TYPE, null).numberValue === 1) {
                 //      console.warn(`generateRobustSelector: Falling back to Text Content XPath (contains match) for element:`, el);
                 //      return `xpath=${textXPath}`;
                 // }
                 // Self-correction: contains() is often too broad, stick to exact match for now.

             } catch (e) { console.warn("Error evaluating text XPath:", e); }
        }
    }

    // 9. Absolute XPath Fallback
    try {
        const absXPath = generateAbsoluteXPath(el);
        if (absXPath) {
             console.warn(`generateRobustSelector: Falling back to Absolute XPath for element:`, el);
             return `xpath=${absXPath}`;
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


// --- Event Handlers ---

/**
 * Handles click events on the page.
 * @param {Event} event
 */
function handleClick(event) {
    const targetElement = event.target;
    // console.log("handleClick: Click detected on element:", targetElement); // Optional debug
    const selector = generateRobustSelector(targetElement);

    if (!selector) {
        console.error("handleClick: Could not generate any selector for clicked element:", targetElement);
        return;
    }

    const actionData = {
        type: 'Click',
        selector: selector,
        timestamp: Date.now()
    };

    console.log("handleClick: Action recorded (Content):", actionData);
    try {
        chrome.runtime.sendMessage({ command: "record_action", data: actionData })
            .catch(error => {
                if (error.message && !error.message.includes("Extension context invalidated") && !error.message.includes("message port closed")) {
                    console.error("handleClick: Error sending click action message:", error);
                } else {
                    // console.log("handleClick: Context invalidated during message send (expected on navigation click)."); // Optional debug
                }
            });
    } catch (error) {
         if (error.message && !error.message.includes("Extension context invalidated")) {
            console.error("handleClick: Synchronous error sending click action:", error);
         } else {
             // console.log("handleClick: Context invalidated during message send (expected on navigation click)."); // Optional debug
         }
    }
}


/**
 * Handles change events for <select>, <input>, and <textarea> elements.
 * Captures the final value after modification and blur (usually).
 * @param {Event} event
 */
function handleChange(event) {
    const targetElement = event.target;
    const tagName = targetElement.tagName.toLowerCase();
    let actionData = null;

    // console.log(`handleChange: Detected change on <${tagName}>`, targetElement); // Optional debug

    // Handle <select> elements
    if (tagName === 'select') {
        const selector = generateRobustSelector(targetElement);
        if (!selector) {
            console.warn("handleChange: Could not generate selector for select element:", targetElement);
            return;
        }
        actionData = {
            type: 'Select',
            selector: selector,
            value: targetElement.value,
            timestamp: Date.now()
        };
    }
    // Handle <input> (text-like) and <textarea> elements
    else if ((tagName === 'input' && /text|password|search|email|url|tel|number/.test(targetElement.type)) || tagName === 'textarea') {
         const selector = generateRobustSelector(targetElement);
         if (!selector) {
            console.warn("handleChange: Could not generate selector for input/textarea element:", targetElement);
            return;
         }
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


// --- Attach/Detach Listeners ---
function attachListeners() {
    if (isListenerAttached) return;
    console.log("Attaching event listeners...");
    document.addEventListener('click', handleClick, true);
    document.addEventListener('change', handleChange, true); // Listen only to 'change' for inputs
    isListenerAttached = true;
}

function detachListeners() {
    if (!isListenerAttached) return;
    console.log("Detaching event listeners...");
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('change', handleChange, true);
    isListenerAttached = false;
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
