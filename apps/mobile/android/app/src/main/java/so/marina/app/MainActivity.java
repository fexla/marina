package so.marina.app;

import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * Android 壳的原生入口。WebView 不是浏览器,两处系统性差异在这里补
 * (docs/standards/mobile-interactions.md §3):
 *
 * 1. 系统栏 inset 注入:
 *    targetSdk 35(Android 15+)起默认 edge-to-edge,内容画到状态栏/手势条
 *    下面,而 WebView 里 env(safe-area-inset-*) 恒为空 —— CSS 拿不到避让
 *    量,tab 栏会被状态栏盖住。这里把 systemBars inset 换算成 CSS px 后
 *    注入 :root 的 --android-inset-top / --android-inset-bottom(mobile.css
 *    的 safe-area 位全部消费这两个变量)。
 *    注入走两条路(缺一不可):
 *    a) insets 变化时 evaluateJavascript 主动推(键盘弹出时 bottom 归零,
 *       页面必已加载,可靠);
 *    b) @JavascriptInterface getInsetsCssVars() 让 web 侧在 boot 早期同步拉
 *       —— 首次 attach 时页面可能还没 load,主动推会丢,必须能拉。
 *    注意:不要用 setDecorFitsSystemWindows(true) 回退 —— Android 16 +
 *    targetSdk 35 实测该对抗操作会让 WebView 渲染表面冻结(UI 无响应、
 *    CDP Runtime.evaluate 挂起、CPU 0%),2026-09-14 踩过。
 *
 * 2. 返回键层级化:
 *    Capacitor 默认 back = webView.goBack()(SPA 无历史,等于无效)。转发给
 *    web 层 window.__marinaAndroidBack()(apps/mobile/src/main.tsx 定义,经
 *    'marina-back' cancelable 事件由内层浮层逐层消费:设置子页 → 设置详情
 *    → 设置列表 → 侧栏抽屉 → 面板 dock);web 未消费时 moveTaskToBack 回
 *    后台而不是 finish —— 终端会话在 PC 上跑,杀 app 属误伤。键盘弹出时
 *    back 由 IME 先消费,不会到这里。
 *
 * 3. 方向策略(用户裁决 2026-09-14「平板交互」):手机锁竖屏,平板自由
 *    旋转 —— web 侧按方向选布局(竖屏=三页手势,横屏=PC 三栏),平板两态
 *    都要允许;手机横屏没有对应布局,锁死避免半成品横屏体验。判平板用
 *    smallestScreenWidthDp >= 600(Android 官方平板基线;手机 ~360-430dp)。
 *    USER_PORTRAIT 而不是 SENSOR_PORTRAIT:允许倒持(180°),只是不出横屏。
 */
public class MainActivity extends BridgeActivity {

    /** 最近一次 systemBars inset(CSS px),负值 = 还没拿到。 */
    private float lastInsetTopCss = -1f;
    private float lastInsetBottomCss = -1f;

    /** boot 早期同步拉 inset 用的 JS 桥(只读,无敏感面)。 */
    private class InsetsBridge {
        /** 返回 "topCss,bottomCss"(物理 px 已除 density);未拿到时 ":-1,:-1"。 */
        @JavascriptInterface
        public String getInsets() {
            return lastInsetTopCss + "," + lastInsetBottomCss;
        }
    }

    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Android 13+ 通知运行时权限:KeepAliveService(后台保活)的
        // 「正在保持连接」通知需要它才可见 —— 未授权时服务照常运行,只是
        // 用户看不到通知。系统会记住选择,只弹一次。
        if (android.os.Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                        != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                    new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 1001);
        }
        // 手机锁竖屏(平板不锁,见类注释 3)。必须在首帧前 —— onCreate 里
        // 设定即生效,不影响后续 WebView 渲染。
        if (getResources().getConfiguration().smallestScreenWidthDp < 600) {
            setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT);
        }
        WebView webView = this.bridge != null ? this.bridge.getWebView() : null;
        if (webView == null) return;
        webView.addJavascriptInterface(new InsetsBridge(), "MarinaNative");

        View content = findViewById(android.R.id.content);
        content.setOnApplyWindowInsetsListener((v, insets) -> {
            float density = getResources().getDisplayMetrics().density;
            int topPx;
            int bottomPx;
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars());
                topPx = bars.top;
                bottomPx = bars.bottom;
            } else {
                // API < 30 无 WindowInsets.Type,getSystemWindowInsetTop 覆盖同语义。
                topPx = insets.getSystemWindowInsetTop();
                bottomPx = insets.getSystemWindowInsetBottom();
            }
            lastInsetTopCss = topPx / density;
            lastInsetBottomCss = bottomPx / density;
            // 页面未 load 时 evaluateJavascript 安全 no-op;boot 早期靠
            // MarinaNative.getInsetsCssVars() 兜底(见 main.tsx)。
            webView.evaluateJavascript(buildInsetsJs(), null);
            return insets;
        });
    }

    /** 生成把 inset 变量写到 :root 的 JS 片段;未拿到 inset 时为 no-op。 */
    private String buildInsetsJs() {
        if (lastInsetTopCss < 0) return "void 0";
        return "document.documentElement.style.setProperty('--android-inset-top','"
            + lastInsetTopCss + "px');"
            + "document.documentElement.style.setProperty('--android-inset-bottom','"
            + lastInsetBottomCss + "px');";
    }

    @Override
    public void onBackPressed() {
        WebView webView = this.bridge != null ? this.bridge.getWebView() : null;
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
            "(typeof window.__marinaAndroidBack === 'function') ? !!window.__marinaAndroidBack() : false",
            value -> {
                // evaluateJavascript 回调值是 JSON 字面量("true"/"false")。
                // web 层未消费(无浮层可退)→ 回后台,不杀进程。
                if (!"true".equals(value)) {
                    moveTaskToBack(true);
                }
            }
        );
    }

    // ── 后台保活(用户勘误 2026-09-15 第十批③:切后台断连)──────────────
    //
    // WS 的 ping/pong 由 daemon 发、Chromium 网络栈自动回,不依赖页面 JS;
    // 断连的根因是系统冻结后台进程/限制网络。onPause 时启动 KeepAliveService
    // (前台服务,进程提级不冻结),onResume 停掉 —— 通知只在后台期间存在。
    // 必须在 onPause(onStop 前的最后一个前台回调)里启动:Android 12+ 禁止
    // 后台启动前台服务,onPause 时 app 仍算前台,合法。
    @Override
    public void onPause() {
        super.onPause();
        android.content.Intent keepAlive = new android.content.Intent(this, KeepAliveService.class);
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            startForegroundService(keepAlive);
        } else {
            startService(keepAlive);
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        stopService(new android.content.Intent(this, KeepAliveService.class));
    }
}
