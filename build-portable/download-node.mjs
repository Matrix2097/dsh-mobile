// download-node.mjs — 下载 Node 便携版（npmmirror 国内镜像）
import fs from "node:fs";

const VERSION = "v24.4.0";
const URL = `https://npmmirror.com/mirrors/node/${VERSION}/node-${VERSION}-win-x64.zip`;
const OUT = `node-${VERSION}-win-x64.zip`;

console.log("downloading", URL);
const res = await fetch(URL, { redirect: "follow" });
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
fs.writeFileSync(OUT, buf);
console.log(`done: ${OUT} (${(buf.length / 1048576).toFixed(1)} MB)`);
