# restore-mika-phone.ps1
# 手机 Mika 操控失效时，用 USB ADB 从母机（本机 Windows）自检并恢复手机控制权。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore-mika-phone.ps1 -Check
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore-mika-phone.ps1 -Restore
#
# 退出码：0 = 健康 / 修复后验收通过；2 = 存在异常 / 修复后仍未就绪；1 = 参数或依赖错误。
#
# 本文件只是薄包装：真正的自检与修复逻辑在 scripts\mika-phone-recovery.js，
# 设备代理（device-agent）派发 Mika 任务时用的是同一份实现（device-agent\lib\mika-recovery.js），
# 不会再出现「脚本一套、代理一套」的漂移。
#
# 本文件必须保存为 UTF-8 with BOM，否则 Windows PowerShell 5.1 会按 ANSI 读取中文而乱码。
# 兼容 Windows PowerShell 5.1 与 PowerShell 7+。无第三方依赖（只需要 Node.js）。
#
# 说明：
#   -Check   默认行为。只读诊断：adb 连接、无障碍（总开关 / 列表 / 崩溃 / 绑定）、手机助手、脚本。
#   -Restore 需要时按 Mika 自己的恢复语义修：唤醒 -> 权限 -> 无障碍（写设置优先，被系统拒绝则走设置界面自动化）
#            -> 拉起 Mika -> 用 usb-start.sh 拉起手机助手；修完再跑 mika connect 刷新连接信息 + doctor 验收。
#            安全锁屏（PIN/密码/图案）无法用 adb 解锁，只能人工解锁或使用 Mika 远程解锁。
#   文档：docs\PHONE-RECOVERY.md

[CmdletBinding()]
param(
    [string]$Adb = '',
    [string]$Serial = $env:MIKA_PHONE_SERIAL,
    [string]$Cli = '',
    [string]$Package = 'com.wangzan101.mika',
    [string]$Service = 'com.wangzan101.mika/com.wangzan101.mika.a11y.MikaAccessibilityService',
    [int]$TimeoutSec = 120,
    [switch]$Check,
    [switch]$Restore
)

$ErrorActionPreference = 'Continue'

# 输出统一按 UTF-8 解码/编码，避免中文在管道和重定向里乱码。
try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $utf8NoBom
    $OutputEncoding = $utf8NoBom
} catch {
    # 某些宿主不允许改编码，忽略。
}

function Fail {
    param([string]$Message)
    Write-Host ('参数错误：' + $Message) -ForegroundColor Red
    exit 1
}

if ($Check -and $Restore) { Fail '-Check 与 -Restore 只能指定一个。' }
if ($TimeoutSec -lt 1) { Fail '-TimeoutSec 必须大于 0。' }
if ([string]::IsNullOrWhiteSpace($Serial)) {
    Fail '请用 -Serial 指定手机序列号（adb devices 第一列），或设置环境变量 MIKA_PHONE_SERIAL。'
}
if ([string]::IsNullOrWhiteSpace($Cli)) {
    $Cli = Join-Path $PSScriptRoot '..\worker-workspace\Mika\tools\mika\scripts\mika_cli.py'
}
if ([string]::IsNullOrWhiteSpace($Package)) { $Package = 'com.wangzan101.mika' }
# -Service 只为兼容旧调用保留：新实现会自己按包名归一化组件名（短形式 / 全名都认）。
$null = $Service

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

# adb 不写死本机路径：-Adb → 环境变量 MIKA_ADB → 本机配置 worker-workspace\phone-mika.json
# 里已经填好的 executor.mika.adb → PATH 里的 adb。这样仓库可以公开，本机又不用每次带参数。
if ([string]::IsNullOrWhiteSpace($Adb)) {
    if (-not [string]::IsNullOrWhiteSpace($env:MIKA_ADB)) {
        $Adb = $env:MIKA_ADB
    } else {
        $localConfig = Join-Path $repoRoot 'worker-workspace\phone-mika.json'
        if (Test-Path -LiteralPath $localConfig) {
            try {
                $localCfg = Get-Content -LiteralPath $localConfig -Raw -Encoding UTF8 | ConvertFrom-Json
                $fromConfig = [string]$localCfg.executor.mika.adb
                if (-not [string]::IsNullOrWhiteSpace($fromConfig) -and $fromConfig -ne 'adb') {
                    $Adb = $fromConfig
                }
            } catch {
                # 配置文件读不了就退回 PATH 里的 adb。
            }
        }
        if ([string]::IsNullOrWhiteSpace($Adb)) { $Adb = 'adb' }
    }
}
if ($Adb -ne 'adb' -and -not (Test-Path -LiteralPath $Adb)) {
    Fail ('找不到 adb：' + $Adb + '。请用 -Adb 指定 platform-tools\adb.exe，或设置环境变量 MIKA_ADB，或把 adb 加进 PATH。')
}

$recoveryCli = Join-Path $repoRoot 'scripts\mika-phone-recovery.js'
if (-not (Test-Path -LiteralPath $recoveryCli)) {
    Write-Host ('找不到自愈脚本：' + $recoveryCli) -ForegroundColor Red
    exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host '找不到 node。请安装 Node.js 18+ 并确保它在 PATH 里。' -ForegroundColor Red
    exit 1
}

$Mode = if ($Restore) { 'Restore' } else { 'Check' }

Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' Mika 手机恢复工具（USB ADB）' -ForegroundColor Cyan
Write-Host (' 模式：' + $Mode + '    时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Cyan
Write-Host (' 序列号：' + $Serial) -ForegroundColor Cyan
Write-Host (' adb：' + $Adb) -ForegroundColor Cyan
Write-Host (' Mika CLI：' + $Cli) -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan

$nodeArgs = @(
    $recoveryCli,
    '--adb', $Adb,
    '--serial', $Serial,
    '--package', $Package,
    # 注意：Node CLI 的 --timeout 单位是秒（不是毫秒）
    '--timeout', [string]$TimeoutSec
)
if ($Restore) { $nodeArgs += '--repair' } else { $nodeArgs += '--check' }

& $node.Source @nodeArgs
$recoveryCode = $LASTEXITCODE

if ($recoveryCode -ne 0) { exit $recoveryCode }

# ---------------------------------------------------------------- 修完再验收
# 恢复手机侧控制之后，Mika 的连接信息（mcp-usb.json）可能还是旧的（例如手机重启过），
# 这里按旧脚本的行为跑一次 mika connect 刷新，再用 doctor 做端到端验收。
if ($Restore) {
    $python = Get-Command py -ErrorAction SilentlyContinue
    $pythonArgs = @('-3')
    if (-not $python) {
        $python = Get-Command python -ErrorAction SilentlyContinue
        $pythonArgs = @()
    }
    if (-not $python) {
        Write-Host ''
        Write-Host '找不到 Python（py -3 / python），跳过 mika connect 与 doctor 验收。' -ForegroundColor Yellow
        exit 2
    }
    if (-not (Test-Path -LiteralPath $Cli)) {
        Write-Host ''
        Write-Host ('找不到 Mika CLI：' + $Cli + '，跳过 connect/doctor 验收。') -ForegroundColor Yellow
        exit 2
    }

    $commonCli = @('--device', $Serial, '--adb', $Adb, '--json')
    Write-Host ''
    Write-Host '== 刷新 Mika 连接信息（mika connect） ==' -ForegroundColor Cyan
    & $python.Source @pythonArgs $Cli @commonCli connect
    $connectCode = $LASTEXITCODE
    if ($connectCode -ne 0) {
        Write-Host ('mika connect 失败（退出码 ' + $connectCode + '）。手机侧已修好，但电脑这边还没接上。') -ForegroundColor Yellow
        exit 2
    }

    Write-Host ''
    Write-Host '== 验收（mika doctor） ==' -ForegroundColor Cyan
    # doctor 的进度提示走 stderr（"mika: contacting the phone..."），这里只要 stdout 的 JSON。
    $doctorText = (& $python.Source @pythonArgs $Cli @commonCli doctor 2>$null | Out-String)
    $doctorCode = $LASTEXITCODE
    Write-Host $doctorText.TrimEnd() -ForegroundColor Gray
    if ($doctorCode -ne 0) {
        Write-Host 'mika doctor 未通过：手机控制链路仍不完整。' -ForegroundColor Yellow
        exit 2
    }
    if ($doctorText -match '"helper_available"\s*:\s*false') {
        Write-Host 'doctor 显示 helper_available=false：手机助手不在，但自检却是通过的，请把这次输出贴到 issue。' -ForegroundColor Yellow
        exit 2
    }
    Write-Host ''
    Write-Host '验收通过：手机控制已恢复（无障碍 + 手机助手），Mika 可以继续被唤起。' -ForegroundColor Green
}

exit 0
