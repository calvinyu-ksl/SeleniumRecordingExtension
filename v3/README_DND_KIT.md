# DND-Kit Enhanced SeleniumBase Recorder

## 概述

这是一个增强版的SeleniumBase录制器，专门优化了对@dnd-kit拖拽库的支持。它能够准确检测、录制和回放基于DND-Kit的drag-and-drop操作。

## 主要特性

### 🎯 DND-Kit专门支持
- **虚拟拖拽检测**：支持基于pointer events的虚拟拖拽（非原生HTML5 drag）
- **组件识别**：自动识别DND-Kit特有的data属性和ARIA角色
- **多策略回放**：针对DND-Kit优化的多重回放策略
- **Sortable支持**：完整支持sortable列表和插入点检测

### 🛠️ 技术增强
- **精确元素定位**：使用`elementsFromPoint`进行精确的drop target检测
- **DOM变化追踪**：实时追踪DOM变化以提高录制准确性
- **React状态同步**：等待React状态更新完成
- **后帧优化**：在DOM重排后进行目标元素精化

## 文件结构

```
SeleniumRecordingExtension-main/v2.1/
├── manifest.json              # 扩展清单，已更新包含DND-Kit支持
├── content.js                 # 主要内容脚本，增强的DND检测
├── dnd_kit_enhancer.js       # DND-Kit专门检测模块
├── background.js             # 后台脚本，增强的代码生成
├── dnd_kit_support.py        # Python支持库（SeleniumBase扩展）
├── dnd_kit_test.html         # 测试页面
└── README_DND_KIT.md         # 本文档
```

## 安装和使用

### 1. Chrome扩展安装
1. 在Chrome中打开 `chrome://extensions/`
2. 启用"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `v2.1` 文件夹

### 2. 测试DND-Kit功能
1. 在Chrome中打开 `dnd_kit_test.html`
2. 点击扩展图标开始录制
3. 尝试拖拽卡片在不同列之间移动
4. 停止录制并导出Python脚本

### 3. 运行生成的测试脚本

生成的脚本会自动包含DND-Kit支持：

```python
from seleniumbase import BaseCase
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.by import By
import time
import re
BaseCase.main(__name__, __file__)

# --- 自动注入的DND-Kit支持 ---
def perform_dnd_kit_drag(self, source_selector, target_selector, timeout=10):
    """DND-Kit专门的拖拽方法"""
    # ... (完整实现)

class TestRecordedScript(BaseCase):
    def test_recorded_script(self):
        self.open("file:///path/to/dnd_kit_test.html")
        
        # DND-Kit drag and drop operation
        # Source: DND-Kit item with ID 'item-1'
        # Target: DND-Kit droppable with ID 'column-2'
        source_xpath = "//div[@data-dnd-kit-id='item-1']"
        target_xpath = "//div[@data-dnd-kit-droppable='column-2']"
        self.perform_dnd_kit_drag(source_xpath, target_xpath)
```

## DND-Kit检测机制

### 拖拽元素检测模式
扩展会按优先级检测以下属性：

1. **DND-Kit核心属性**：
   - `data-dnd-kit-id`
   - `data-sortable-id` 
   - `data-dnd-kit-draggable`
   - `aria-roledescription="draggable"`

2. **类名模式**：
   - `dnd-kit-*`
   - `sortable-*`
   - `draggable-*`

3. **传统HTML5**：
   - `draggable="true"`
   - `role="button"`

### 放置目标检测模式

1. **DND-Kit放置区**：
   - `data-dnd-kit-droppable`
   - `data-sortable-container`
   - `data-dnd-kit-drop-zone`

2. **容器模式**：
   - Flex-grow容器（看板列）
   - 滚动容器
   - 语义化容器（section, article等）

3. **插入点检测**：
   - 在sortable项目之间的精确位置
   - before/after插入类型

## 高级特性

### 虚拟拖拽支持
DND-Kit经常使用pointer events而非原生HTML5 drag events：

```javascript
// 扩展自动检测这种模式
element.addEventListener('pointerdown', startDrag);
element.addEventListener('pointermove', updateDrag); 
element.addEventListener('pointerup', endDrag);
```

### 多层元素检测
使用`elementsFromPoint(x, y)`获取鼠标位置的完整元素堆栈：

```javascript
const elements = document.elementsFromPoint(clientX, clientY);
// 智能过滤overlay、ghost元素
// 找到真正的drop target
```

### React状态同步
生成的Python代码包含等待React更新：

```python
# 等待DND-Kit动画和React状态更新
time.sleep(0.3)
```

## 故障排除

### 常见问题

1. **拖拽没有被检测到**
   - 检查元素是否有DND-Kit属性
   - 查看浏览器控制台的调试信息
   - 确保没有阻止pointer events的CSS

2. **Drop目标不准确**
   - 检查是否有overlay元素干扰
   - 查看元素的z-index和pointer-events样式
   - 尝试在不同位置释放

3. **生成的脚本失败**
   - 确保安装了SeleniumBase
   - 检查XPath选择器是否稳定
   - 尝试增加等待时间

### 调试模式

在浏览器控制台查看详细日志：

```javascript
// 启用DND-Kit调试
console.log('[DND][dragstart] raw target:', element);
console.log('[DND-KIT] Element analysis:', info);
```

## API参考

### JavaScript扩展API

```javascript
// DND-Kit检测器
window.DND_KIT_ENHANCER = {
    detectDndKitElements(),      // 检测页面所有DND-Kit元素
    enhancedDragStartDetection(event), // 增强拖拽开始检测
    enhancedDropDetection(event),      // 增强放置检测
    generateDndKitPythonCode(action)   // 生成Python代码
};
```

### Python测试API

```python
class BaseCase:
    def perform_dnd_kit_drag(self, source_selector, target_selector, timeout=10):
        """DND-Kit专门拖拽方法"""
        
    def _analyze_dnd_kit_elements(self, source_el, target_el):
        """分析DND-Kit元素属性"""
        
    def _verify_dnd_kit_drag_success(self, source_el, target_el, dnd_kit_info):
        """验证拖拽成功"""
```

## 贡献和开发

### 扩展DND-Kit支持

1. **添加新的检测模式**：
   ```javascript
   // 在dnd_kit_enhancer.js中添加
   DND_KIT_PATTERNS.draggable.push('[new-pattern]');
   ```

2. **增强Python策略**：
   ```python
   # 在dnd_kit_support.py中添加新策略
   def _attempt_custom_strategy(self, source_el, target_el):
       # 自定义实现
   ```

3. **调试和日志**：
   ```javascript
   console.log('[DND-KIT][DEBUG] Custom debug info');
   ```

## 版本历史

- **v2.1+DND-Kit**: 初始DND-Kit支持版本
  - 增加虚拟拖拽检测
  - 优化元素选择策略
  - 增强Python代码生成
  - 添加React状态同步

## 许可证

与原SeleniumBase Recorder保持一致的许可证。

---

**注意**：这是在原有SeleniumBase Recorder基础上的增强版本，完全兼容原有功能，同时大幅提升了DND-Kit应用的支持能力。