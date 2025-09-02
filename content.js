/**
 * content.js
 * This script is injected into the webpage to record user interactions.
 * It listens for relevant events (click, change) and sends data
 * back to the background script. It also handles requests to capture HTML.
 * *** Selector Strategy: ID -> Attributes -> Stable Classes -> Structure -> Text XPath -> Absolute XPath -> Tag Name. ***
 */

console.log("Selenium Recorder: Content script injected (v13 - improved class selectors).");

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


// --- Event Handlers ---

/**
 * Handles click events on the page. Debounces rapid clicks to capture only the most specific one.
 * @param {Event} event
 */
function handleClick(event) {
    // If a click is already scheduled to be recorded, ignore this one.
    // This handles event bubbling or synthetic events where a single user
    // action triggers clicks on both a child and a parent element.
    // We assume the first event's target is the most specific element the user intended to click.
    if (clickTimeout) {
        return;
    }

    let targetElement = event.target;

    // If the user clicks on an element inside a button or link (like a span or icon),
    // we should record the action on the parent button/link, as that's the actionable element.
    const actionableParent = targetElement.closest('button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"]');
    if (actionableParent && actionableParent.contains(targetElement)) {
        console.log("handleClick: Click target is inside an actionable parent. Using parent.", actionableParent);
        targetElement = actionableParent;
    }


    // Set a timeout to record this action. If another click happens on a parent element
    // due to bubbling, the `if (clickTimeout)` check above will prevent it from being recorded.
    clickTimeout = setTimeout(() => {
        try {
            // Clicks on checkboxes are handled by the 'change' event to capture the state correctly.
            if (targetElement.tagName.toLowerCase() === 'input' && targetElement.type === 'checkbox') {
                return;
            }
            
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
            chrome.runtime.sendMessage({ command: "record_action", data: actionData })
                .catch(error => {
                    if (error.message && !error.message.includes("Extension context invalidated") && !error.message.includes("message port closed")) {
                        console.error("handleClick: Error sending click action message:", error);
                    }
                });
        } catch (error) {
             if (error.message && !error.message.includes("Extension context invalidated")) {
                console.error("handleClick: Synchronous error sending click action:", error);
             }
        } finally {
            clickTimeout = null; // Reset timeout after processing
        }
    }, 50); // A 50ms debounce window is usually sufficient
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
