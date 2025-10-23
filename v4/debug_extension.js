// Extension diagnostic tool
// Run this code in browser console to check Extension status

console.log('=== Extension Diagnostic Tool ===');

// Check target area ID
const targetZone = document.querySelector('#target-zone');
if (targetZone) {
    console.log('✅ 找到 #target-zone:', targetZone);
    console.log('   - ID:', targetZone.id);
    console.log('   - tagName:', targetZone.tagName);
    console.log('   - className:', targetZone.className);
} else {
    console.log('❌ 沒有找到 #target-zone');
    // Look for possible target elements
    const possibleTargets = document.querySelectorAll('[class*="drop"], [class*="target"], [id*="target"], [id*="drop"]');
    console.log('🔍 可能的目標元素:', possibleTargets);
    possibleTargets.forEach((el, i) => {
        console.log(`   ${i+1}. ID: "${el.id}", Class: "${el.className}", Tag: ${el.tagName}`);
    });
}

// Check drag items
['item1', 'item2', 'item3'].forEach(itemId => {
    const item = document.querySelector(`[data-dnd-kit-id="${itemId}"]`);
    if (item) {
        console.log(`✅ 找到 [data-dnd-kit-id="${itemId}"]:`, item);
    } else {
        console.log(`❌ 沒有找到 [data-dnd-kit-id="${itemId}"]`);
    }
});

// Check Extension functions
if (typeof generateDragSelector !== 'undefined') {
    console.log('✅ generateDragSelector 函數存在');
    if (targetZone) {
        const dragSelector = generateDragSelector(targetZone);
        console.log('   - generateDragSelector(#target-zone) =', dragSelector);
    }
} else {
    console.log('❌ generateDragSelector 函數不存在 - Extension需要重新載入');
}

if (typeof generateRobustSelector !== 'undefined') {
    console.log('✅ generateRobustSelector 函數存在');
    if (targetZone) {
        const robustSelector = generateRobustSelector(targetZone);
        console.log('   - generateRobustSelector(#target-zone) =', robustSelector);
    }
} else {
    console.log('❌ generateRobustSelector 函數不存在');
}

console.log('=== 診斷完成 ===');