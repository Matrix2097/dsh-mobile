package com.matrix.dshmonitor

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * 后台监控服务：常驻前台 + SSE 长连接 + 任务提醒通知。
 * 与 App 是否在前台无关——锁屏/切后台后仍保持连接并推送提醒。
 */
class MonitorService : Service() {

    companion object {
        const val CHANNEL_TASK = "dsh_tasks"
        const val CHANNEL_SERVICE = "dsh_service"
        const val NOTIF_SERVICE_ID = 1001
        // 需要推送系统通知的事件类型（与 PWA 端一致）
        val NOTIFY_KINDS = setOf("job", "approval", "question", "agent-error")
    }

    private var running = false
    private var worker: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        createChannels()
        startForeground(NOTIF_SERVICE_ID, buildServiceNotification())
        if (!running) {
            running = true
            val prefs = getSharedPreferences("config", MODE_PRIVATE)
            val host = prefs.getString("host", "") ?: ""
            val port = prefs.getString("port", "8443") ?: "8443"
            val token = prefs.getString("token", "") ?: ""
            startMonitor(host, port, token)
        }
        return START_STICKY
    }

    private fun startMonitor(host: String, port: String, token: String) {
        if (host.isEmpty()) return
        worker?.interrupt()
        worker = thread(name = "dsh-sse", isDaemon = true) {
            var backoffMs = 2000L
            while (running) {
                try {
                    sseLoop(host, port, token)
                    backoffMs = 2000L
                } catch (e: Exception) {
                    // 断开/错误：指数退避重连
                }
                if (!running) break
                try { Thread.sleep(backoffMs) } catch (e: InterruptedException) { break }
                backoffMs = (backoffMs * 2).coerceAtMost(30000L)
            }
        }
    }

    /** SSE 长连接：读 /api/stream 的事件流，识别任务通知并弹系统通知 */
    private fun sseLoop(host: String, port: String, token: String) {
        val url = URL("http://$host:$port/api/stream?token=$token")
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 10000
            conn.readTimeout = 0 // 长连接，不超时
            conn.setRequestProperty("Accept", "text/event-stream")
            val code = conn.responseCode
            if (code != 200) throw IllegalStateException("SSE HTTP $code")

            val reader = BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8))
            var line: String?
            var pendingData = StringBuilder()
            while (running) {
                line = reader.readLine() ?: break
                if (line.startsWith("data: ")) {
                    pendingData.append(line.substring(6))
                    continue
                }
                if (line.isEmpty() && pendingData.isNotEmpty()) {
                    handleEvent(pendingData.toString())
                    pendingData = StringBuilder()
                }
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun handleEvent(json: String) {
        try {
            val obj = org.json.JSONObject(json)
            if (obj.optString("type") != "notify") return
            val kind = obj.optString("kind")
            if (kind !in NOTIFY_KINDS) return
            val title = obj.optString("title", "DSH 提醒")
            val body = obj.optString("body", "")
            notifyTask(title, body, kind)
        } catch (_: Exception) { }
    }

    private fun notifyTask(title: String, body: String, kind: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
            != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) return
        val n = Notification.Builder(this, CHANNEL_TASK)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setPriority(Notification.PRIORITY_HIGH)
            .build()
        nm.notify(kind.hashCode(), n)
    }

    private fun createChannels() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_SERVICE, "后台监控服务", NotificationManager.IMPORTANCE_LOW)
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_TASK, "任务提醒", NotificationManager.IMPORTANCE_HIGH)
        )
    }

    private fun buildServiceNotification(): Notification =
        Notification.Builder(this, CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("DSH 监控运行中")
            .setContentText("正在监听电脑上的任务状态")
            .setOngoing(true)
            .build()

    override fun onDestroy() {
        running = false
        worker?.interrupt()
        super.onDestroy()
    }
}
