// release.mjs — 创建 GitHub Release 并上传 APK + 便携 zip
import fs from "node:fs";

const TOKEN = process.env.GH_TOKEN;
const OWNER = "Matrix2097";
const REPO = "dsh-mobile";
const TAG = "v1.0.0";
const API = "https://api.github.com";
const H = {
  Authorization: `token ${TOKEN}`,
  "User-Agent": "dsh-release",
  Accept: "application/vnd.github+json",
};

async function api(path, opts = {}) {
  const res = await fetch(API + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path}: HTTP ${res.status} ${json.message || json.raw}`);
  return json;
}

const BODY = `# DSH 手机监管 v1.0.0

在手机上实时监管电脑上的 **DeepSeek Harness**：任务进度实时监控、流式对话、模型/权限切换、任务完成/审批/出错提醒、只读文件浏览。支持 PWA 与 Android App（常驻后台）两种形态。

## 📦 下载

- **Android App**（常驻后台 + 任务提醒）：\`app-debug.apk\`（Android 8.0+）
- **电脑端便携版**（免装 Node.js）：\`dsh-mobile-portable.zip\`（解压 → 双击 \`start-gateway.bat\` 即用）

## ✨ 功能

- 实时监控：会话/任务进度秒级实时（SSE 推送）
- 流式对话：思考/回复逐字流式，思考与工具折叠
- Slash 命令：输入框 \`/\` 开头自动走命令通道
- 模型切换 / 权限切换（只读/工作区/完全访问）
- 审批应答、任务提醒、只读文件浏览
- Android 前台服务：锁屏/后台也能推送提醒
- 深色/浅色主题

> 完整使用教程见仓库 README：https://github.com/Matrix2097/dsh-mobile
`;

// 1. 创建 release（若已存在则删除重建）
try {
  await api(`/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, { method: "GET" });
  console.log("release exists, deleting...");
  const existing = await api(`/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, { method: "GET" });
  await api(`/repos/${OWNER}/${REPO}/releases/${existing.id}`, { method: "DELETE" });
} catch { /* not exists, ok */ }

const release = await api(`/repos/${OWNER}/${REPO}/releases`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ tag_name: TAG, name: TAG + " - DSH 手机监管", body: BODY, draft: false, prerelease: false }),
});
console.log("release created:", release.html_url);

// 2. 上传 assets（GitHub upload_url: /repos/.../releases/{id}/assets{?name,label}）
const uploadBase = release.upload_url.replace(/\{[^}]*\}/, "");
for (const file of ["app-debug.apk", "dsh-mobile-portable.zip"]) {
  const buf = fs.readFileSync(`build-portable/${file}`);
  const res = await fetch(`${uploadBase}?name=${encodeURIComponent(file)}`, {
    method: "POST",
    headers: {
      Authorization: `token ${TOKEN}`,
      "User-Agent": "dsh-release",
      Accept: "application/vnd.github+json",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(buf.length),
    },
    body: buf,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`upload ${file}: HTTP ${res.status} ${text.slice(0, 200)}`);
  console.log(`uploaded: ${file} (${(buf.length / 1048576).toFixed(1)} MB)`);
}
console.log("RELEASE COMPLETE");
