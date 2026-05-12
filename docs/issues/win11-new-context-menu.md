# Windows 11 新右键菜单未集成

**状态**:已知限制 / 已规划 / **公测前必做**
**优先级**:P1(发布阻塞,但不阻塞 alpha 内测)
**首次提出**:2026-05-12,alpha.3 发布前勘误 #15
**目标实施窗口**:v0.2 公测前
**对应里程碑**:与代码签名证书采购合并办理

---

## 现象

Windows 11 默认右键菜单(圆角、紧凑、用户首先看到的那个)里**看不到** "在 Marina 终端中打开"。用户必须:

- 点击菜单底部的 **"显示更多选项"** 展开经典菜单,或
- 直接按 `Shift+F10` 调出经典菜单

才能看到 Marina 入口。Marina 主打 "path-centric,从 Explorer 一键进终端",这个落差稀释了核心入口的价值主张。

## 根因

Microsoft 在 Win11 重新设计 shell context menu,故意切断了与 Win95-Win10 沿用的"写注册表 `HKCU\Software\Classes\Directory\shell\<Name>` 就能加菜单项"的旧模型,改用 **`IExplorerCommand` COM 接口** + **MSIX/Sparse Package 包模型**。

我们当前用的是注册表方案,只命中**经典菜单**(老模型仍然支持以做向后兼容,但仅放在"显示更多选项"二级菜单)。

**对比业界现状**:
| 工具 | 新菜单 | 经典菜单 |
|---|---|---|
| Windows Terminal | ✅(Microsoft Store / MSIX 出货) | ✅ |
| Visual Studio Code | ❌ | ✅ |
| 7-Zip | ❌(2024 才支持,需 v24+) | ✅ |
| Notepad++ | ❌ | ✅ |
| Git for Windows | ❌ | ✅ |
| **Marina(当前)** | ❌ | ✅ |

业界标准是"暂未支持",但我们既然主打 Explorer 集成入口,这是一个**核心体验缺口**。

## 实施方案(已选定)

**Sparse Package + Rust 写 IExplorerCommand DLL**。理由:

- **不动主体打包**:NSIS 主安装器照常,Sparse Package 是旁路;失败也不影响 Marina 本体
- **Rust over C++**:`windows-rs` crate 封装 COM 接口很干净,内存安全,工具链比 MSVC 干净
- **DLL 极小**(预计 < 1MB),进程内载入 Explorer.exe 风险可控

**不选 MSIX 全打包的原因**:MSIX 沙箱限制写文件 / 起子进程,终端这类应用塞进去需要 deferred uninstall 等折腾,而我们核心是 `node-pty + ConPTY` spawn PowerShell,与沙箱模型冲突。

## 工作量拆解

| 任务 | 估时 |
|---|---|
| Rust DLL with `windows-rs` 实现 `IExplorerCommand`(GetTitle/GetIcon/Invoke/GetState/GetFlags) | 2-3 天 |
| Sparse Package `package.appxmanifest` 编写 + 验证 | 1 天 |
| NSIS install hook:`Add-AppxPackage`;uninstall hook:`Remove-AppxPackage` | 1 天 |
| Explorer 不崩防御性测试(异常 / 中文路径 / 极长路径) | 2-3 天 |
| 跨 Win11 版本兼容(22H2 / 23H2 / 24H2) | 1 天 |
| 文档 + 工作记录 | 1 天 |
| **合计** | **1.5-2 周** |

## 硬依赖:代码签名

Sparse Package **强制要签名**才能 sideload(`Add-AppxPackage` 拒绝未签名包,除非用户启用开发者模式 + import 受信证书,这对终端用户太不友好)。

- **OV 证书** ~$100-200/年(适合 CI 自动化签名,但 SmartScreen 仍会拦截首次下载者)
- **EV 证书** ~$400+/年 + 硬件 token + 真实身份认证(需要 ~2-4 周走完认证流程),SmartScreen 默认信任,体验最佳

**决议**:与签名证书采购捆绑办理。若购买 EV,这是与公测一起做的事;若购买 OV,可在 alpha → beta 过渡时做。

## 风险

1. **Explorer 崩溃**:DLL 是进程内载入 Explorer.exe,我们的 bug 会让用户整个 explorer 崩(重启 explorer 解决,但体验断裂)。需要 panic 保护 + 早期返回 + 详尽的 try-catch
2. **跨 Win11 版本差异**:23H2 加了 GetFlags 一些新枚举,24H2 又改。需要在多个 Win11 实机 / 多个虚拟机验证
3. **代码签名续费**:证书过期后旧版还能用,但新发版无法签名 → 必须续费连续性
4. **Microsoft 政策变更**:Microsoft 历史上多次调整 shell 扩展策略(Win11 24H2 加了若干限制),长期看可能强制走 Store

## 验收标准

- [ ] 在 Win11 22H2+ 上,Explorer 文件夹右键(默认菜单,非"显示更多选项")**直接**看到 "在 Marina 终端中打开"(图标 = Marina app icon)
- [ ] 在文件夹背景空白处右键同样可达
- [ ] 点击 → 与现有经典菜单行为完全一致(`Marina.exe --open-here "<path>"`)
- [ ] 设置页 "Explorer 右键集成" 开关同时控制新 + 经典两套菜单
- [ ] 卸载 Marina 后,新菜单条目消失(NSIS 卸载脚本调 `Remove-AppxPackage`)
- [ ] 一次诱导性测试:让 DLL 在 Invoke 时主动 throw,Explorer 不应崩

## 参考资料

- [IExplorerCommand interface (Microsoft Docs)](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-iexplorercommand)
- [Sparse Package: identity for unpackaged Win32 apps](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/grant-identity-to-nonpackaged-apps)
- [Implementing IExplorerCommand for Win11 menu](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/context-menu-integration)
- [windows-rs crate](https://github.com/microsoft/windows-rs) — Rust bindings for Win32 / COM
- [7-Zip Win11 menu impl (24.05+)](https://www.7-zip.org/history.txt) — 业界参考

## 当前 mitigation

- 经典菜单功能完整可用,用户多点一次"显示更多选项"或按 `Shift+F10` 即可
- 推荐使用 `Windows 11 Classic Context Menu` / `ExplorerPatcher` 等第三方工具的用户**不需要**任何额外操作,因为这类工具已禁用新菜单

## 关联

- `docs/prelease前勘误.md` 条目 #15(原始报告)
- `docs/prelease前勘误-修复-20260512.md`(2026-05-12 工作记录)
- `docs/known-issues.md` 的 KI-002(自动更新)同样卡在签名证书 — 两者可共用证书采购流程
