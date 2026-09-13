# Marina Android 客户端(`@marina/mobile`)

> ADR-042(v0.3.4):Android 端 Marina 是**纯远程客户端** —— 只能连接某个
> Marina daemon(WS + token,WireGuard/内网前提),无本地 PTY / 无本地 SSH。
> 技术形态 = Capacitor(WebView 壳)复用仓库根的 renderer 源码 + web 版
> `window.api` shim,详见 `docs/方案-安卓远程客户端-20260914.md` 与软件
> 定义书 §14.11。

## 结构

```
apps/mobile/
├── src/
│   ├── main.tsx          # MobileBoot(连接管理)→ 连接成功 → 动态 import 共享 renderer
│   ├── web-api-shim.ts   # window.api 的 web 实现(local-control / backend-data 路由)
│   ├── local-commands.ts # local-control 命令的 localStorage/浏览器 API 实现
│   ├── mobile.css        # boot UI + 窄屏(<900px)适配(与 src/renderer/mobile.ts 断点同源)
│   └── index.html        # #boot + #root 双根节点
├── android/              # Capacitor 生成的 gradle 工程(appId so.marina.app)
└── dist/                 # vite 产物(cap sync 拷进 android 工程,gitignore)
```

## 开发

```bash
# web 层(浏览器直接调试,可连局域网内 daemon)
npm run dev:web           # vite dev server

# 端到端
npm run build:web         # 构建 dist/
npx cap sync android      # 拷贝 dist → android 工程
cd android && gradlew.bat assembleDebug
# 产物: android/app/build/outputs/apk/debug/app-debug.apk
```

## 环境要求(一次性)

- **Android SDK**:`D:\android-sdk`(cmdline-tools + `platform-tools`
  `platforms;android-35` `build-tools;35.0.0`)。`android/local.properties`
  写 `sdk.dir=D:/android-sdk` —— **必须用正斜杠或双反斜杠**:Properties
  格式把单个 `\` 当转义符吞掉,`D:\android-sdk` 会变成相对路径 `D:android-sdk`,
  gradle 报「文件名、目录名或卷标语法不正确」(踩坑实录)。
- **JDK 21**(gradle 8.x / AGP 8.x)。
- 运行时依赖(react/@xterm/lucide-react 等)直接用**仓库根** node_modules,
  本包只额外装 Capacitor 三件套 —— 两端构建永远同版本,不漂移。

## 安全说明

配对密码明文存 localStorage(与 PC 端 safeStorage 的差距,v1 已知降级):
WebView localStorage 在 app 私有沙箱目录,未 root 不可读;后续可换
Android Keystore 加密。网络前提同 ADR-015:仅 WireGuard/内网 + `ws://`。
