# CP-Search(v0.3.1 面板搜索)自测 + 用户测试指南

**范围**：右 dock 全部面板 Ctrl+F 搜索(C1-C4)+ 终端既有搜索(不动)。
**实现**：4 commits(C1 骨架/C2 列表过滤/C3 text+diff 查找/C4 markdown 查找)。

---

## 自测(已跑过)

- [x] typecheck / lint / lint:css 全绿
- [x] test 833/833(+22:text-search 17 + find-line-matches 5)
- [x] build 产物生成正常(包体积 +~12KB)
- [x] 人工推理各路径事件流(SearchBar ↔ useContentSearch ↔ FileViewer)

## 用户测试指南

### 测试 1:列表过滤(Files/Git/Opened,预计 2 分钟)

1. 在有变更的 git 仓库 session,点「文件」tab → Ctrl+F
2. **预期**:dock header 下方弹出搜索框(无命中数/上/下按钮 = 过滤型)
3. 输入 `readme`(小写):
   - **预期**:文件树收窄到含 readme 的文件 + 祖先目录自动展开,匹配文字高亮
   - 切「Git」tab → 同样的过滤对变更文件生效(树形 + 平铺都试)
   - 切「已打开」tab(先打开几个文件)→ tab 列表按名过滤
4. 点 Aa 切大小写 → 输入 `README` → 大小写敏感时小写文件不匹配
5. Esc 关闭搜索框,列表恢复

### 测试 2:文件内查找 text/diff(预计 3 分钟)★ 核心

1. 在「已打开」打开一个代码文件(如 .ts)
2. Ctrl+F → **预期**:搜索框带命中数 `—` + 上/下按钮(查找型)
3. 输入 `function`:
   - **预期**:命中数变 `1/N`,所有匹配处的 `function` 加亮黄底 mark,当前匹配行整行蓝绿底
4. Enter → 跳下一个匹配(scrollIntoView smooth center)/ Shift+Enter 上一个
5. 点一个 git diff 文件(.diff):
   - **预期**:diff 也支持查找,跳转到匹配的变更行(行内不 mark,整行高亮)
6. Esc 关闭,matches/current 清零

### 测试 3:markdown 查找(预计 2 分钟)★ CSS Highlight

1. 打开一个 .md 文件
2. Ctrl+F + 输入关键词
3. **预期**:渲染后的 markdown 里所有匹配处高亮(蓝绿底),当前匹配深色底
4. Enter 跳转,命中数 `x/N` 正确
5. 关闭后高亮消失

### 测试 4:快捷键边界(预计 1 分钟)

1. 焦点在终端 → Ctrl+F → **预期**:走终端搜索(xterm 拦截,不是 dock 搜索)
2. 焦点在某个 input(如设置页)→ Ctrl+F → **预期**:不触发 dock 搜索(不干扰输入)
3. dock 折叠 → Ctrl+F → **预期**:不触发(无 dock 可搜)

### 测试 5:跨面板/大小写(预计 1 分钟)

1. 在 Files 搜了 `foo`,切到 Git → query 保留(共享),Git 也按 foo 过滤
2. Aa 按钮切换,aria-pressed 反映,7 套主题下视觉一致

---

## 已知限制(BACKLOG)

- **Files 过滤依赖懒加载**:未展开的目录无数据可过滤(用户需先展开;VS Code Explorer 同约束)。搜索时自动展开已加载目录缓解。
- **DiffViewer 不做行内 mark**:hljs 输出 HTML span 嵌套,叠加 mark 复杂度高收益低;diff 查找主要诉求是"跳到哪一行变了",行级足够。
- **不支持正则**:对齐终端搜索。
- **无替换(Replace)**:Marina 是只读查看器,无编辑语义。

---

## 全部通过后

回复 agent:"CP-Search 通过" 或 "看 docs/cp-search勘误.md"。
