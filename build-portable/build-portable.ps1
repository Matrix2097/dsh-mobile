# build-portable.ps1 — 打包 DSH 手机监管网关为便携版（内置 Node，解压即用）
# 用法：powershell -ExecutionPolicy Bypass -File build-portable.ps1
# 产物：dist/dsh-mobile-portable.zip
param(
    [string]$NodeVersion = "v22.20.0"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$proj = Split-Path -Parent $root          # dsh-mobile 项目根
$dist = Join-Path $root "dist"
$nodeZip = Join-Path $root "node-$NodeVersion-win-x64.zip"
$nodeDir = Join-Path $dist "node-runtime"

Write-Host "== 打包 DSH 手机监管网关（便携版）==" -ForegroundColor Cyan

# 0. 确保 Node zip 存在
if (-not (Test-Path $nodeZip)) {
    Write-Host "未找到 $nodeZip，正在下载…"
    & node (Join-Path $root "download-node.mjs")
}

# 1. 清理并创建 dist
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dist | Out-Null

# 2. 解压 Node 便携版
Write-Host "解压 Node 运行时…"
New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
tar -xf $nodeZip -C $dist
# node zip 内含 node-v22.20.0-win-x64/ 一层目录
$inner = Get-ChildItem $dist -Directory | Where-Object { $_.Name -like "node-v*" } | Select-Object -First 1
if ($inner) {
    Get-ChildItem $inner.FullName -Force | Move-Item -Destination $nodeDir -Force
    Remove-Item $inner.FullName -Recurse -Force
}
if (-not (Test-Path (Join-Path $nodeDir "node.exe"))) { throw "node.exe 未找到" }

# 3. 复制项目文件（排除构建产物和 git）
Write-Host "复制项目文件…"
foreach ($f in @("server.js", "dsh.js", "package.json", "README.md", "start-gateway.bat", "start-gateway.ps1")) {
    Copy-Item (Join-Path $proj $f) $dist -Force
}
Copy-Item (Join-Path $proj "public") (Join-Path $dist "public") -Recurse -Force

# 4. 生成便携版启动脚本（优先使用内置 Node）
Write-Host "生成启动脚本…"
$bat = Join-Path $dist "start-gateway.bat"
$portableBat = "@echo off`r`nchcp 65001 >nul`r`nsetlocal`r`nrem 便携模式：优先使用内置 Node 运行时（无需安装 Node.js）`r`nif exist `"%~dp0node-runtime\node.exe`" set `"PATH=%~dp0node-runtime;%PATH%`"`r`ntitle DSH Mobile Gateway`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0start-gateway.ps1`" %*`r`nendlocal`r`n"
[System.IO.File]::WriteAllText($bat, $portableBat, [System.Text.UTF8Encoding]::new($false))
Write-Host "便携版 start-gateway.bat 已生成"

# 5. 打 zip
Write-Host "压缩…"
$zipOut = Join-Path $root "dsh-mobile-portable.zip"
if (Test-Path $zipOut) { Remove-Item $zipOut -Force }
Compress-Archive -Path (Join-Path $dist "*") -DestinationPath $zipOut -CompressionLevel Optimal
$size = [math]::Round((Get-Item $zipOut).Length / 1MB, 1)
Write-Host "==============================================" -ForegroundColor Green
Write-Host "打包完成: $zipOut（$size MB）" -ForegroundColor Green
Write-Host "使用: 解压到任意 Windows 电脑 → 双击 start-gateway.bat 即可（无需装 Node.js）" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Green
