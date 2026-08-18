# start-gateway.ps1 — 一键启动 DSH 手机监管网关
# 用法：双击 start-gateway.bat，或在终端执行 .\start-gateway.ps1
# 可选参数：-Port 8443 -Root "C:\Users\Lenovo\Desktop" -Token "自定义令牌" -DshPort 55613（手动指定 DSH 端口）
param(
    [int]$Port = 8443,
    [string]$Root = "C:\Users\Lenovo\Desktop",
    [string]$Token = "",
    [int]$DshPort = 0
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $scriptDir "server.js"

# 检查 Node
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "[错误] 未找到 node，请先安装 Node.js 18+（https://nodejs.org）" -ForegroundColor Red
    pause
    exit 1
}

# ---- 端口占用检查：旧网关实例未关闭时阻止启动 ----
$busyPort = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($busyPort) {
    Write-Host ("[错误] 端口 {0} 已被占用：旧网关实例仍在运行！" -f $Port) -ForegroundColor Red
    Write-Host "       请先关闭旧的网关黑色窗口，再重新运行本脚本。" -ForegroundColor Yellow
    pause
    exit 1
}

# ---- Windows 防火墙放行（手机访问电脑需要）----
try {
    $existing = Get-NetFirewallRule -DisplayName "DSH Mobile Gateway" -ErrorAction SilentlyContinue
    if (-not $existing) {
        New-NetFirewallRule -DisplayName "DSH Mobile Gateway" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -ErrorAction Stop | Out-Null
        Write-Host ("  已自动添加防火墙入站规则（TCP {0}）" -f $Port) -ForegroundColor Green
    }
} catch {
    Write-Host "[提示] 未能自动添加防火墙规则（需要管理员权限）" -ForegroundColor Yellow
    Write-Host ("       手机连不上时，请以管理员身份运行: netsh advfirewall firewall add rule name=""DSH Mobile Gateway"" dir=in action=allow protocol=TCP localport={0}" -f $Port) -ForegroundColor Yellow
}

# ---- 探测 DSH 桌面端当前端口（桌面 profile 端口是动态分配的）----
if ($DshPort -gt 0) {
    $dshPort = $DshPort
} else {
    Write-Host "正在探测 DSH 桌面端端口…" -ForegroundColor Gray
    try {
        $dshPids = (Get-Process -Name "DSH Desktop" -ErrorAction SilentlyContinue).Id
        $ports = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.OwningProcess -in $dshPids } |
            ForEach-Object { $_.LocalPort }
        if ($ports) { $dshPort = $ports | Select-Object -First 1 }
    } catch { }
    if (-not $dshPort) {
        try {
            $dshPids = (Get-Process -Name "DSH Desktop" -ErrorAction SilentlyContinue).Id
            $netstat = netstat -ano | Select-String "LISTENING"
            foreach ($line in $netstat) {
                $m = [regex]::Match($line.Trim(), '^TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)$')
                if ($m.Success -and $m.Groups[2].Value -in $dshPids) { $dshPort = [int]$m.Groups[1].Value; break }
            }
        } catch { }
    }
}
if ($dshPort) {
    Write-Host ("  探测到 DSH 端口: {0}" -f $dshPort) -ForegroundColor Green
} else {
    Write-Host "[警告] 未找到 DSH 桌面端监听端口，请确认 DSH Desktop 正在运行" -ForegroundColor Yellow
    Write-Host "       网关会持续自动探测；也可手动指定: .\start-gateway.ps1 -DshPort 55613" -ForegroundColor Yellow
}

# 显示本机局域网 IP（手机连接的地址）
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  DSH 手机监管网关 - 一键启动" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.PrefixOrigin -ne "WellKnown" }
foreach ($ip in $ips) {
    Write-Host ("  手机访问:  http://{0}:{1}/  （网卡: {2}）" -f $ip.IPAddress, $Port, $ip.InterfaceAlias) -ForegroundColor Green
}
Write-Host "  访问令牌:  " -ForegroundColor Yellow -NoNewline
Write-Host "网关启动后显示在下方窗口中，手机连接时填写" -ForegroundColor Yellow
Write-Host "  关闭:      关闭本窗口即可停止网关" -ForegroundColor Yellow
Write-Host "----------------------------------------------" -ForegroundColor Cyan

$nodeArgs = @("$server", "--port", "$Port", "--root", "$Root")
if ($dshPort) { $nodeArgs += @("--dsh-port", "$dshPort") }
if ($Token) { $nodeArgs += @("--token", "$Token") }

# 设置控制台代码页为 UTF-8（保证中文输出不乱码）
$OutputEncoding = [System.Text.UTF8Encoding]::new()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

try {
    & node $nodeArgs
} catch {
    Write-Host "[错误] 网关启动失败: $_" -ForegroundColor Red
}
pause
