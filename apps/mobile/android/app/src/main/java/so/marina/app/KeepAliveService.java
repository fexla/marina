package so.marina.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * 后台保活前台服务(用户勘误 2026-09-15 第十批③:手机切后台即断连)。
 *
 * 机制:renderer 与 daemon 的 WS 保活是协议层 ping/pong(daemon 侧
 * transport-ws.ts 每 30s ping,Chromium 网络栈自动回 pong,不需要页面 JS
 * 参与),所以断连的根因不在心跳逻辑 —— 而是 app 退后台后系统冻结缓存
 * 进程 / 限制网络(CachedAppFreezer、Doze),WebView 进程一停 WS 就被
 * daemon 判死(连续 3 次无 pong ≈ 90s terminate)或直接被网络层切断。
 * 本服务在后台期间把进程提到前台服务级别:不冻结、网络豁免,连接得以
 * 保持。Termux 等终端 app 保活同款做法。
 *
 * 生命周期由 MainActivity 驱动:onPause 时 startForegroundService(此刻
 * app 仍算前台,满足 Android 12+ 「后台不得启动 FGS」的限制),onResume
 * 时 stopService —— 「Marina 正在保持连接」通知只在后台期间存在,回到
 * 前台即消失,不做常驻通知。
 *
 * dataSync 类型(Android 14+ 强制声明 FGS 类型):注意 Android 15 对
 * dataSync 类型有 6 小时/天的累计限时,超时系统会停服务 —— 被停后兜底是
 * renderer 的指数退避自动重连(remote-transport scheduleReconnect,回前台
 * JS 恢复后立即续上),且下次退后台服务会重新启动。对「切后台一会儿」
 * 的主场景(分钟~小时级)完全够用。
 */
public class KeepAliveService extends Service {

    private static final String CHANNEL_ID = "marina_keepalive";
    private static final int NOTIFICATION_ID = 1;

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm != null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "后台连接",
                    NotificationManager.IMPORTANCE_LOW); // LOW:不响铃、不弹横幅
            channel.setDescription("Marina 在后台保持与电脑的连接");
            nm.createNotificationChannel(channel);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Intent tapIntent = new Intent(this, MainActivity.class);
        tapIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this, 0, tapIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= 26) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            // minSdk 23:API<26 无 channel 构造器,deprecated 的无 channel 路径。
            builder = new Notification.Builder(this);
        }
        Notification notification = builder
                .setContentTitle("Marina")
                .setContentText("正在后台保持连接,点按返回")
                .setSmallIcon(android.R.drawable.ic_menu_manage)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .build();

        // API 29+ 的三参 startForeground 必须带 FGS type;API<29 无 type 概念。
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        // START_STICKY:进程被低内存回收后系统择机重启服务,回前台路径还有
        // renderer 重连兜底,这里只是尽量减少「后台被杀」的窗口。
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null; // started service,不提供绑定
    }
}
