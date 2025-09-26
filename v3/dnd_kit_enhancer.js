/**
 * DND-Kit Enhanced Detection and Recording
 * 
 * This module provides specialized detection and recording for @dnd-kit library
 * including virtual drag operations, sortable lists, and complex drop zones.
 */

// DND-Kit specific selectors and patterns
const DND_KIT_PATTERNS = {
    // Core DND-Kit attributes
    draggable: [
        '[data-dnd-kit-id]',
        '[data-sortable-id]', 
        '[data-dnd-kit-draggable]',
        '[aria-roledescription="draggable"]'
    ],
    
    droppable: [
        '[data-dnd-kit-droppable]',
        '[data-sortable-container]',
        '[data-dnd-kit-drop-zone]'
    ],
    
    // Common class patterns for DND-Kit
    classPatterns: [
        'dnd-kit',
        'sortable',
        'draggable',
        'droppable',
        'drag-overlay',
        'drop-zone'
    ],
    
    // Sensors and interaction patterns
    sensors: [
        'pointer-sensor',
        'keyboard-sensor',
        'mouse-sensor',
        'touch-sensor'
    ]
};

/**
 * Enhanced DND-Kit element detection
 */
function detectDndKitElements() {
    const elements = {
        draggables: [],
        droppables: [], 
        containers: [],
        overlays: []
    };
    
    // Find all DND-Kit draggable elements
    DND_KIT_PATTERNS.draggable.forEach(selector => {
        try {
            const found = document.querySelectorAll(selector);
            found.forEach(el => {
                if (!elements.draggables.some(item => item.element === el)) {
                    elements.draggables.push({
                        element: el,
                        selector: generateAbsoluteXPath(el),
                        id: el.getAttribute('data-dnd-kit-id') || el.getAttribute('data-sortable-id'),
                        type: 'dnd-kit-draggable'
                    });
                }
            });
        } catch(e) {
            console.warn('Error detecting draggables with selector:', selector, e);
        }
    });
    
    // Find droppable zones
    DND_KIT_PATTERNS.droppable.forEach(selector => {
        try {
            const found = document.querySelectorAll(selector);
            found.forEach(el => {
                if (!elements.droppables.some(item => item.element === el)) {
                    elements.droppables.push({
                        element: el,
                        selector: generateAbsoluteXPath(el),
                        id: el.getAttribute('data-dnd-kit-droppable') || el.getAttribute('data-sortable-container'),
                        type: 'dnd-kit-droppable'
                    });
                }
            });
        } catch(e) {
            console.warn('Error detecting droppables with selector:', selector, e);
        }
    });
    
    // Detect class-based elements
    DND_KIT_PATTERNS.classPatterns.forEach(pattern => {
        try {
            const classSelector = `[class*="${pattern}"]`;
            const found = document.querySelectorAll(classSelector);
            found.forEach(el => {
                const className = el.className || '';
                if (className.includes('overlay') || className.includes('ghost')) {
                    elements.overlays.push({
                        element: el,
                        selector: generateAbsoluteXPath(el),
                        type: 'dnd-kit-overlay'
                    });
                } else if (className.includes('container') || className.includes('droppable')) {
                    if (!elements.containers.some(item => item.element === el)) {
                        elements.containers.push({
                            element: el,
                            selector: generateAbsoluteXPath(el),
                            type: 'dnd-kit-container'
                        });
                    }
                }
            });
        } catch(e) {
            console.warn('Error detecting class-based elements for pattern:', pattern, e);
        }
    });
    
    return elements;
}

/**
 * Enhanced drag start detection for DND-Kit
 */
function enhancedDragStartDetection(event) {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    
    // Check for DND-Kit specific attributes
    const dndKitId = target.getAttribute('data-dnd-kit-id') || 
                     target.getAttribute('data-sortable-id');
    
    if (dndKitId) {
        return {
            isDndKit: true,
            id: dndKitId,
            element: target,
            type: 'dnd-kit-item'
        };
    }
    
    // Check parent elements for DND-Kit patterns
    const dndKitParent = target.closest('[data-dnd-kit-id], [data-sortable-id], [data-dnd-kit-draggable]');
    if (dndKitParent) {
        const parentId = dndKitParent.getAttribute('data-dnd-kit-id') || 
                        dndKitParent.getAttribute('data-sortable-id');
        return {
            isDndKit: true,
            id: parentId,
            element: dndKitParent,
            type: 'dnd-kit-parent'
        };
    }
    
    return null;
}

/**
 * Enhanced drop zone detection for DND-Kit
 */
function enhancedDropDetection(event) {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    
    const elements = document.elementsFromPoint(event.clientX, event.clientY);
    
    for (const el of elements) {
        if (!(el instanceof Element)) continue;
        
        // Skip overlay elements
        const style = getComputedStyle(el);
        if (style.pointerEvents === 'none' || parseFloat(style.opacity) < 0.5) continue;
        
        // Check for DND-Kit drop zones
        const dropId = el.getAttribute('data-dnd-kit-droppable') || 
                      el.getAttribute('data-sortable-container');
        
        if (dropId) {
            return {
                isDndKit: true,
                id: dropId,
                element: el,
                type: 'dnd-kit-droppable'
            };
        }
        
        // Check for sortable items (drop between items)
        const sortableItem = el.closest('[data-sortable-id]');
        if (sortableItem) {
            const itemId = sortableItem.getAttribute('data-sortable-id');
            return {
                isDndKit: true,
                id: itemId,
                element: sortableItem,
                type: 'dnd-kit-sortable-item',
                insertionType: determineInsertionType(event, sortableItem)
            };
        }
    }
    
    return null;
}

/**
 * Determine insertion type (before/after) for sortable items
 */
function determineInsertionType(event, element) {
    try {
        const rect = element.getBoundingClientRect();
        const centerY = rect.top + rect.height / 2;
        return event.clientY < centerY ? 'before' : 'after';
    } catch(e) {
        return 'after';
    }
}

/**
 * Generate enhanced Python code for DND-Kit operations
 */
function generateDndKitPythonCode(action) {
    if (action.type !== 'DragAndDrop') return null;
    
    const sourceId = extractDndKitId(action.sourceSelector);
    const targetId = extractDndKitId(action.targetSelector);
    
    if (!sourceId && !targetId) {
        // Fallback to existing drag and drop implementation
        return generateStandardDragCode(action);
    }
    
    // Generate DND-Kit specific code
    let code = `# DND-Kit drag and drop operation\n`;
    
    if (sourceId) {
        code += `# Source: DND-Kit item with ID '${sourceId}'\n`;
    }
    if (targetId) {
        code += `# Target: DND-Kit drop zone with ID '${targetId}'\n`;
    }
    
    code += `source_xpath = "${action.sourceSelector}"\n`;
    code += `target_xpath = "${action.targetSelector}"\n`;
    
    // Add DND-Kit specific verification
    code += `\n# Verify DND-Kit elements are present\n`;
    code += `self.wait_for_element_present(source_xpath, timeout=10)\n`;
    code += `self.wait_for_element_present(target_xpath, timeout=10)\n`;
    
    // Add specialized DND-Kit drag implementation
    code += `\n# Perform DND-Kit drag and drop with enhanced strategies\n`;
    code += `self.perform_dnd_kit_drag(source_xpath, target_xpath)\n`;
    
    return code;
}

/**
 * Extract DND-Kit ID from selector
 */
function extractDndKitId(selector) {
    if (!selector) return null;
    
    // Try to find DND-Kit attributes in the selector
    const dndKitMatch = selector.match(/data-dnd-kit-id=['"]([^'"]+)['"]/);
    if (dndKitMatch) return dndKitMatch[1];
    
    const sortableMatch = selector.match(/data-sortable-id=['"]([^'"]+)['"]/);
    if (sortableMatch) return sortableMatch[1];
    
    return null;
}

/**
 * Generate standard drag code fallback
 */
function generateStandardDragCode(action) {
    return `# Standard drag and drop operation
source_xpath = "${action.sourceSelector}"
target_xpath = "${action.targetSelector}"
self.perform_drag_with_fallback(source_xpath, target_xpath)`;
}

// Export for use in content.js
if (typeof window !== 'undefined') {
    window.DND_KIT_ENHANCER = {
        detectDndKitElements,
        enhancedDragStartDetection,
        enhancedDropDetection,
        generateDndKitPythonCode,
        DND_KIT_PATTERNS
    };
}