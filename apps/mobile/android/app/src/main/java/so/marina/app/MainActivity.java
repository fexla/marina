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
}
