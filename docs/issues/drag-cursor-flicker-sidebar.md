# DROP-1 · Sidebar 拖文件夹时光标在 copy / 禁止 之间闪烁

**状态**:**未解决**(F11 后用户复现仍闪烁)
**优先级**:P2(功能可用 — drop 仍能成功落地;影响交互观感)
**首次报告**:2026-05-16,beta 勘误第二轮 F9/F10/F11 落地后
**当前 workaround**:无;接受闪烁,功能性 drop 不受影响

---

## 现象

从 Windows Explorer 拖一个文件夹进 Marina 窗口,沿 sidebar 区域**快速移动**时:

- 鼠标光标在 "copy 复制角标" 与 "禁止 ⊘" 两个状态之间高频跳动
- sidebar 的背景洗涤 / 居中浮卡也跟着闪烁(出现 → 消失 → 出现 …)

慢速移动时不那么明显;快速划过最易复现。Drop 本身仍能成功(落到收藏)。

## 已尝试过的修法(都不彻底)

| Commit | 改动 | 仍闪烁? |
|---|---|---|
| `ac0a852` F9 | 加 `isFileDrag` 过滤 + dropEffect='copy' + dashed outline 改 inset shadow | ✗ |
| `e452fdf` F10 | drag handlers 提到整个 `.sidebar`;`App.tsx` window-level dragover 加 `defaultPrevented` 兜底,否则 dropEffect='none' | ✗ |
| `7d77a14` F11 | 撤回 overlay 边框,改纯背景洗涤 + 浮卡 | ✗(用户当前报告基于此版本) |

## 已确认 *不是* 这些原因

1. **dropEffect 没在 sidebar 内设置** — F10 后 `.sidebar` 整体的 React `onDragOver` 无条件 `e.dataTransfer.dropEffect = 'copy'`,只要事件到达就设。
2. **window 级 dragover 覆盖了 dropEffect** — `App.tsx` 已加 `if (e.defaultPrevented) return;` 在 window handler 顶部,理论上 React 调过 preventDefault 后这里就直接放过,不会覆盖子组件设的 dropEffect。
3. **dragleave 子元素时机问题** — F8 已撤掉 dragleave 处理,改 dragover 心跳超时(150ms),状态不再依赖 leave。
4. **绝对元素被窗口圆角裁剪** — F11 撤掉了所有依赖 inset:0 边沿渲染的方案。

## 怀疑的根因(待续查)

### 假说 A:React 的 dragover 事件并不是每像素都派发,快速移动有空帧

Chromium 的 `dragover` 频率约每 50-100ms 一次(`HTML5 Drag and Drop` 规范允许节流)。快速移动时,光标可能在两次 dragover 事件之间穿过 sidebar 边界外/内,期间 dropEffect 状态来自上次事件,与当前光标位置不匹配。

可验证手段:在 handleDragOver 里加 `console.log(performance.now(), e.clientX, e.clientY)`,观察事件间隔与光标速度的关系。如果 100px/事件 间距 + 280px sidebar 宽 → 每 dragover 跨 sidebar 边界几次,就符合。

### 假说 B:`e.defaultPrevented` 在 React 17+ 合成事件 → native 路径上不可靠

React 的 `e.preventDefault()` 内部调 `nativeEvent.preventDefault()`,但**调用时机**:React 批处理可能让 native preventDefault 延迟到所有 React handler 完成后。如果 window-level native listener 在 React 派发**期间**就被触发(unlikely 但需验证),`defaultPrevented` 仍是 false → window handler 覆写 dropEffect 为 'none' → 光标变禁止。

可验证手段:在 window blockDragOver 里 `console.log('defaultPrevented?', e.defaultPrevented, 'target:', e.target)`,统计 false 出现的比例和 target 元素位置。

### 假说 C:Electron / Chromium 在 contextIsolation + frame:false + Windows 11 下对 dragover 的 dropEffect 处理有 bug

Marina 的窗口配置:`frame: false` + `contextIsolation: true` + sandbox 关。Win11 DWM 还有 Mica/Acrylic 等可能干扰指针 hit testing 的复合层。值得在 Linux / macOS / 标准 frame 上对照测试。

可验证手段:临时给 main 端窗口创建加 `frame: true`,看闪烁是否消失。如果消失 → DWM/frameless 干扰;不消失 → Electron 层。

### 假说 D:lucide-react 的 SVG icon 元素吃掉了 pointer events 但不传 drag events

`.sidebar` 内有大量 `<Icon>` (lucide SVG) 和 `<AlertTriangle>` 等。SVG 元素的 dragover 事件冒泡机制在某些边界情况下会丢失(尤其是 `pointer-events` 与 `fill` 交互)。光标穿过这些子元素时 dragover 可能短暂不冒泡到 .sidebar。

可验证手段:全 sidebar 内的 SVG 加 `style={{ pointerEvents: 'none' }}`,看是否消除闪烁。

## 优先级判断

功能性不受影响 — drop 最终能落到收藏。属于视觉打磨范畴。
不是 beta 用户主流抱怨(主流是 F1-F7 那批);这是 F9 引入新交互后的二次问题。
可放到 0.1.0 GA 之后处理,或留作 known issue。

## 续查动作建议

1. 先做假说 A 的事件频率统计 — 最便宜
2. 再试假说 D 的 SVG pointer-events:none — 改一个 CSS rule,试错最快
3. 假说 B 需要在 React DevTools 里抓事件流,工时较长
4. 假说 C 需要切构建配置,放最后

## 相关文件

- `src/renderer/components/Sidebar.tsx` — handleDragOver / handleDrop / isFileDrag / 心跳超时
- `src/renderer/App.tsx` — window-level dragover/drop 兜底 + defaultPrevented 检查
- `src/renderer/styles/global.css` — `.sidebar.drag-over`、`.sidebar-drop-hint`(F11)

## 相关 commit

- `ac0a852` F9 — isFileDrag 过滤 + 浮卡引入
- `e452fdf` F10 — drag handlers 提到 .sidebar;window-level defaultPrevented
- `7d77a14` F11 — 撤回边框,纯背景洗涤
