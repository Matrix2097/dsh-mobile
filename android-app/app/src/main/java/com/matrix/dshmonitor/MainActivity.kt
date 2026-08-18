package com.matrix.dshmonitor

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject

class MainActivity : Activity() {

    private lateinit var configPanel: LinearLayout
    private lateinit var inputHost: EditText
    private lateinit var inputPort: EditText
    private lateinit var inputToken: EditText
    private lateinit var btnConnect: Button
    private lateinit var txtStatus: TextView
    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        configPanel = findViewById(R.id.configPanel)
        inputHost = findViewById(R.id.inputHost)
        inputPort = findViewById(R.id.inputPort)
        inputToken = findViewById(R.id.inputToken)
        btnConnect = findViewById(R.id.btnConnect)
        txtStatus = findViewById(R.id.txtStatus)
        webView = findViewById(R.id.webView)
        val btnSettings = findViewById<ImageButton>(R.id.btnSettings)

        // 恢复已保存配置
        val prefs = getSharedPreferences("config", MODE_PRIVATE)
        inputHost.setText(prefs.getString("host", ""))
        inputPort.setText(prefs.getString("port", "8443"))
        inputToken.setText(prefs.getString("token", ""))

        // 有已存配置则直接自动连接
        val savedHost = prefs.getString("host", "") ?: ""
        if (savedHost.isNotEmpty()) {
            configPanel.visibility = View.GONE
            connectInternal(savedHost, prefs.getString("port", "8443") ?: "8443", prefs.getString("token", "") ?: "", silent = true)
        }

        // WebView 设置
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = false
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String?) {
                // 把配置注入 PWA（localStorage），一次填写、界面自动连接
                injectConfigToPwa()
            }
        }

        btnConnect.setOnClickListener { connect() }
        btnSettings.setOnClickListener {
            configPanel.visibility = View.VISIBLE
            txtStatus.text = "修改配置后重新连接"
        }
    }

    private fun connect() {
        val host = inputHost.text.toString().trim()
        val port = inputPort.text.toString().trim().ifEmpty { "8443" }
        val token = inputToken.text.toString().trim()
        if (host.isEmpty()) {
            txtStatus.text = "请填写电脑 IP"
            return
        }
        getSharedPreferences("config", MODE_PRIVATE).edit()
            .putString("host", host)
            .putString("port", port)
            .putString("token", token)
            .apply()
        connectInternal(host, port, token, silent = false)
    }

    private fun connectInternal(host: String, port: String, token: String, silent: Boolean) {
        // Android 13+ 通知权限
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100)
        }
        // 启动后台监控服务
        try {
            startForegroundService(Intent(this, MonitorService::class.java))
        } catch (e: Exception) {
            txtStatus.text = "启动服务失败：${e.message}"
            return
        }
        configPanel.visibility = View.GONE
        txtStatus.text = "已连接 $host:$port（后台监控运行中）"
        webView.loadUrl("http://$host:$port/")
    }

    /** 把 App 配置注入 PWA 的 localStorage，PWA 打开后自动连接（幂等，避免 reload 死循环） */
    private fun injectConfigToPwa() {
        val prefs = getSharedPreferences("config", MODE_PRIVATE)
        val host = prefs.getString("host", "") ?: ""
        if (host.isEmpty()) return
        val port = prefs.getString("port", "8443") ?: "8443"
        val token = prefs.getString("token", "") ?: ""
        val target = JSONObject()
            .put("host", host)
            .put("port", port.toIntOrNull() ?: 8443)
            .put("token", token)
            .toString()
        val targetJson = JSONObject.quote(target)
        val js = "(() => { " +
            "try { " +
            "  var cur = localStorage.getItem('dshm.cfg'); " +
            "  if (cur !== $targetJson) { localStorage.setItem('dshm.cfg', $targetJson); location.reload(); } " +
            "} catch (e) {} " +
            "})();"
        webView.evaluateJavascript(js, null)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 100) {
            txtStatus.text = if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED)
                "通知权限已开启" else "通知权限未开启（仍可监控，提醒会静默）"
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
