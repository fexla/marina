终端字号选择器等组件的箭头没有正确适用主题
UI字体没有生效
新建shell的时候有一闪而过的新建窗口
方形、圆形复选框设计粗糙
“松开鼠标——在该文件夹打开终端”的遮罩有的时候会意外出现，而且无法消去
对Windows中 git bash的路径追踪没有正确实现
Sidebar session item 右键只有五项，重命名不能点
Tab 右键重命名始终灰显
你的托盘图标还不错，就做临时logo了，任务栏图标、程序图标都用这个
考虑到向日葵环境剪贴板不稳定，选中即复制等剪贴板功能功能未测试
考虑到环境问题，开机启动未测试

搜索功能有问题
Uncaught Error: You must set the allowProposedApi option to true to use proposed API
    at d._checkProposedApi (@xterm_xterm.js?v=bad1222f:5930:79)
    at d.registerDecoration (@xterm_xterm.js?v=bad1222f:6050:25)
    at n._createResultDecoration (@xterm_addon-search.js?v=bad1222f:308:27)
    at n._highlightAllMatches (@xterm_addon-search.js?v=bad1222f:131:31)
    at n.findNext (@xterm_addon-search.js?v=bad1222f:119:168)
    at TerminalView.tsx:399:38
    at TerminalView.tsx:651:5
    at commitHookEffectListMount (chunk-PJEEZAML.js?v=bad1222f:16915:34)
    at commitPassiveMountOnFiber (chunk-PJEEZAML.js?v=bad1222f:18156:19)
    at commitPassiveMountEffects_complete (chunk-PJEEZAML.js?v=bad1222f:18129:17)
chunk-PJEEZAML.js?v=bad1222f:14032 The above error occurred in the <TerminalView> component:

    at TerminalView (http://127.0.0.1:5800/components/TerminalView.tsx:202:32)
    at main
    at MainPane (http://127.0.0.1:5800/components/MainPane.tsx:39:17)
    at div
    at div
    at ContextMenuProvider (http://127.0.0.1:5800/components/ContextMenu.tsx:36:39)
    at ToastProvider (http://127.0.0.1:5800/components/Toast.tsx:36:33)
    at ConnectedShell (http://127.0.0.1:5800/App.tsx:123:27)
    at AppStateProvider (http://127.0.0.1:5800/store.tsx:213:3)
    at App (http://127.0.0.1:5800/App.tsx:29:37)

Consider adding an error boundary to your tree to customize error handling behavior.
Visit https://reactjs.org/link/error-boundaries to learn more about error boundaries.
logCapturedError @ chunk-PJEEZAML.js?v=bad1222f:14032
Show 1 more frame
Show less
chunk-PJEEZAML.js?v=bad1222f:9129 Uncaught Error: You must set the allowProposedApi option to true to use proposed API
    at d._checkProposedApi (@xterm_xterm.js?v=bad1222f:5930:79)
    at d.registerDecoration (@xterm_xterm.js?v=bad1222f:6050:25)
    at n._createResultDecoration (@xterm_addon-search.js?v=bad1222f:308:27)
    at n._highlightAllMatches (@xterm_addon-search.js?v=bad1222f:131:31)
    at n.findNext (@xterm_addon-search.js?v=bad1222f:119:168)
    at TerminalView.tsx:399:38
    at TerminalView.tsx:651:5
    at commitHookEffectListMount (chunk-PJEEZAML.js?v=bad1222f:16915:34)
    at commitPassiveMountOnFiber (chunk-PJEEZAML.js?v=bad1222f:18156:19)
    at commitPassiveMountEffects_complete (chunk-PJEEZAML.js?v=bad1222f:18129:17)

数据导入导出按钮长度不一致，这个页面需要重新设计
日志未测试
右键集成在Windows11环境中，仅集成到legacy右键菜单，没有集成到新的的右键菜单
点击之后显示 Error launching app unable to find electron  app at .....
不可达路径没有弹出报错框

MainPane.tsx:201 [MainPane] create-session failed 
Error: Error invoking remote method 'cmd:session:create': SessionManagerError: [SessionManager] PtySpawnFailed: 无法启动 "C:\Program Files\PowerShell\7\pwsh.exe" cwd="C:\Users\liyue\Desktop\新建文件夹". 可能原因: (1) shell 不在 PATH; (2) cwd 不可访问; (3) node-pty 原生模块未为当前 Electron 重编译。原始错误: Cannot create process, error code: 267
handleCreate	@	MainPane.tsx:201
﻿