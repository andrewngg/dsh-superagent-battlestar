# restore-mika-phone.ps1
# 手机 Mika 操控失效时，用 USB ADB 从母机（本机 Windows）恢复操作控制权。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore-mika-phone.ps1 -Check
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore-mika-phone.ps1 -Restore
#
# 退出码：0 = 健康/修复后验收通过；2 = 存在异常/修复后仍未就绪；1 = 参数错误。
#
# 兼容 Windows PowerShell 5.1 与 PowerShell 7+。本文件必须保存为 UTF-8 with BOM，
# 否则 Windows PowerShell 5.1 会按 ANSI 读取中文而乱码。无第三方依赖。
#
# 说明：
#   -Check   默认行为。只读诊断：工具路径、adb 设备状态、无障碍服务、Mika 进程、mika doctor。
#   -Restore 诊断后按需唤醒屏幕、拉起 Mika、补齐无障碍服务、重跑 mika connect，最后 doctor 验证。
#            安全锁屏（PIN/密码/图案）无法用 adb 解锁，只能人工解锁或使用 Mika 远程解锁。
#   文档：docs\PHONE-RECOVERY.md

[CmdletBinding()]
param(
    [string]$Adb = (Join-Path $env:USERPROFILE 'Documents\doubao\phone_adb\platform-tools\adb.exe'),
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

$script:CheckResults = @()

if ($Check -and $Restore) {
    Write-Host '参数错误：-Check 与 -Restore 只能指定一个。' -ForegroundColor Red
    exit 1
}
if ($TimeoutSec -lt 1) {
    Write-Host '参数错误：-TimeoutSec 必须大于 0。' -ForegroundColor Red
    exit 1
}
if ([string]::IsNullOrWhiteSpace($Serial)) {
    Write-Host '参数错误：请用 -Serial 指定手机序列号（adb devices 第一列），或设置环境变量 MIKA_PHONE_SERIAL。' -ForegroundColor Red
    exit 1
}
if ([string]::IsNullOrWhiteSpace($Cli)) {
    $Cli = Join-Path $PSScriptRoot '..\worker-workspace\Mika\tools\mika\scripts\mika_cli.py'
}

$Mode = 'Check'
if ($Restore) { $Mode = 'Restore' }

# mika CLI 的 --request-timeout 取值范围是 1-120 秒，这里做同样的收敛。
$RequestTimeout = $TimeoutSec
if ($RequestTimeout -gt 120) { $RequestTimeout = 120 }
if ($RequestTimeout -lt 1) { $RequestTimeout = 1 }

# ---------------------------------------------------------------- 输出辅助

function Write-Header {
    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Cyan
    Write-Host ' Mika 手机恢复工具（USB ADB）' -ForegroundColor Cyan
    Write-Host (' 模式：' + $Mode + '    时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Cyan
    Write-Host (' 序列号：' + $Serial) -ForegroundColor Cyan
    Write-Host (' adb：' + $Adb) -ForegroundColor Cyan
    Write-Host (' Mika CLI：' + $Cli) -ForegroundColor Cyan
    Write-Host '============================================================' -ForegroundColor Cyan
}

function Write-Step {
    param([string]$Text)
    Write-Host ''
    Write-Host ('== ' + $Text + ' ==') -ForegroundColor Cyan
}

function Show-Output {
    param($Lines)
    $shown = $false
    foreach ($line in $Lines) {
        $text = ([string]$line).TrimEnd()
        if ($text.Trim() -ne '') {
            Write-Host ('      ' + $text) -ForegroundColor DarkGray
            $shown = $true
        }
    }
    if (-not $shown) {
        Write-Host '      （无输出）' -ForegroundColor DarkGray
    }
}

function Get-FirstLine {
    param($Lines)
    foreach ($line in $Lines) {
        $text = ([string]$line).Trim()
        if ($text -ne '') { return $text }
    }
    return ''
}

function Format-Field {
    param($Value)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) {
        if ($Value) { return 'true' }
        return 'false'
    }
    return [string]$Value
}

function Report-Item {
    param(
        [string]$Name,
        [bool]$Ok,
        [string]$Detail,
        [switch]$Record
    )
    if ($Ok) {
        Write-Host ('  [OK]   ' + $Name + '：' + $Detail) -ForegroundColor Green
    } else {
        Write-Host ('  [FAIL] ' + $Name + '：' + $Detail) -ForegroundColor Red
    }
    if ($Record) {
        $item = [pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail }
        $script:CheckResults += $item
    }
}

function Write-Summary {
    $total = 0
    $okCount = 0
    $failCount = 0
    foreach ($item in $script:CheckResults) {
        $total = $total + 1
        if ($item.Ok) { $okCount = $okCount + 1 } else { $failCount = $failCount + 1 }
    }
    Write-Host ''
    Write-Host ('---------------- 汇总：' + $okCount + ' / ' + $total + ' 项通过，' + $failCount + ' 项失败 ----------------')
    if ($failCount -eq 0) {
        Write-Host '结论：手机桥在线且手机可控（doctor ready=true）。' -ForegroundColor Green
        return $true
    }
    Write-Host '结论：存在异常，手机操控可能失败。按 docs\PHONE-RECOVERY.md 的「症状速查」处理，或运行 -Restore。' -ForegroundColor Red
    return $false
}

# ---------------------------------------------------------------- 命令封装

function Get-PythonCommand {
    $cmd = Get-Command py -ErrorAction SilentlyContinue
    if ($cmd) {
        return [pscustomobject]@{ Exe = 'py'; Prefix = @('-3') }
    }
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) {
        return [pscustomobject]@{ Exe = 'python'; Prefix = @() }
    }
    $cmd = Get-Command python3 -ErrorAction SilentlyContinue
    if ($cmd) {
        return [pscustomobject]@{ Exe = 'python3'; Prefix = @() }
    }
    return $null
}

# 运行 adb，返回 Code / Lines / Text。adb 的输出（含 stderr 提示）一起展示。
function Run-Adb {
    param([string[]]$Arguments = @())
    Write-Host ('    > adb ' + ($Arguments -join ' ')) -ForegroundColor Yellow
    $code = -1
    $lines = @()
    try {
        $lines = @(& $Adb @Arguments 2>&1 | ForEach-Object { [string]$_ })
        if ($null -ne $LASTEXITCODE) {
            $code = [int]$LASTEXITCODE
        } else {
            $code = 0
        }
    } catch {
        $code = 127
        $lines = @([string]$_.Exception.Message)
    }
    Show-Output $lines
    $kept = @()
    foreach ($line in $lines) {
        if (([string]$line).Trim() -ne '') { $kept += ([string]$line) }
    }
    return [pscustomobject]@{
        Code  = $code
        Lines = $lines
        Text  = ($kept -join "`n")
    }
}

# 运行 Mika CLI（py -3 <cli> --device ... --adb ... --json --request-timeout ... <子命令>）。
# 返回 Code / Lines / Json（最后一行 JSON 解析结果，失败为 $null）/ Raw。
function Run-Mika {
    param(
        [string]$Subcommand,
        [string[]]$ExtraArguments = @()
    )
    $py = Get-PythonCommand
    if ($null -eq $py) {
        return [pscustomobject]@{
            Code  = 127
            Lines = @('未找到 Python 3 启动器（py / python / python3）。')
            Json  = $null
            Raw   = ''
        }
    }

    $cliArgs = @($py.Prefix) + @(
        $Cli,
        '--device', $Serial,
        '--adb', $Adb,
        '--json',
        '--request-timeout', [string]$RequestTimeout,
        $Subcommand
    ) + @($ExtraArguments)

    Write-Host ('    > ' + $py.Exe + ' ' + ($cliArgs -join ' ')) -ForegroundColor Yellow
    $code = -1
    $lines = @()
    try {
        $lines = @(& $py.Exe @cliArgs 2>&1 | ForEach-Object { [string]$_ })
        if ($null -ne $LASTEXITCODE) {
            $code = [int]$LASTEXITCODE
        } else {
            $code = 0
        }
    } catch {
        $code = 127
        $lines = @([string]$_.Exception.Message)
    }

    $raw = ''
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        $text = [string]$lines[$i]
        if ($text.TrimStart().StartsWith('{')) {
            $raw = $text.Trim()
            break
        }
    }
    $json = $null
    if ($raw -ne '') {
        try {
            $json = $raw | ConvertFrom-Json
        } catch {
            $json = $null
        }
    }
    Show-Output $lines
    return [pscustomobject]@{
        Code  = $code
        Lines = $lines
        Json  = $json
        Raw   = $raw
    }
}

function Test-ServiceInList {
    param([string]$List, [string]$Target)
    if ($null -eq $List) { return $false }
    $text = $List.Trim()
    if ($text -eq '' -or $text -eq 'null') { return $false }
    foreach ($item in ($text -split ':')) {
        if ($item.Trim() -eq $Target) { return $true }
    }
    return $false
}

function Get-MikaErrorHint {
    param([string]$Code)
    if ($Code -eq 'connection') {
        return 'Mika 本地服务没有应答。常见原因：手机休眠/锁屏、Mika 进程被杀。先唤醒并解锁手机、打开一次 Mika，再运行 mika connect。'
    }
    if ($Code -eq 'stale_connection') {
        return '手机重启过，连接信息已过期。运行 mika connect 重新获取。'
    }
    if ($Code -eq 'adb_unavailable') {
        return 'adb 不可执行。检查 -Adb 路径，或重新安装 Android platform-tools。'
    }
    if ($Code -eq 'device_offline') {
        return '手机状态不是 device（unauthorized / offline）。在手机上允许 USB 调试授权，或重新插拔数据线。'
    }
    if ($Code -eq 'connection_info') {
        return 'Mika 连接信息无效或读不到。解锁手机、打开一次 Mika，再运行 mika connect。'
    }
    if ($Code -eq 'incompatible_api') {
        return 'Mika APK 不支持 task API v1。升级手机上的 Mika APK。'
    }
    if ($Code -eq 'device_selection') {
        return 'adb 上有多个设备。用 -Serial 指定唯一的手机。'
    }
    if ($Code -eq 'waiting_on_phone') {
        return '任务在等手机端操作（接管/验证码/支付确认）。到手机上处理，adb 无法代办。'
    }
    if ($Code -eq 'waiting_for_answer') {
        return '任务在等回答。用 mika task answer 或到手机上回答。'
    }
    if ($Code -eq 'outcome_unknown') {
        return '操作可能已被手机接受但响应丢失。先查询任务状态，不要直接重复提交。'
    }
    return '查看上面的原始输出，以及手机上的 Mika 状态。'
}

# ---------------------------------------------------------------- 健康诊断

function Test-Health {
    param([switch]$Record)

    $state = [pscustomobject]@{
        ToolsOk            = $false
        DeviceOk           = $false
        DeviceState        = ''
        AccListRaw         = ''
        AccHasService      = $false
        AccEnabled         = ''
        MikaPid            = ''
        MikaRunning        = $false
        Doctor             = $null
        DoctorConnection   = ''
        DoctorReady        = $false
        DoctorSupportsState = $false
        DoctorErrorCode    = ''
        DoctorErrorMessage = ''
    }

    # 1) 工具
    Write-Step '1) 检查工具路径'
    $adbOk = Test-Path -LiteralPath $Adb -PathType Leaf
    Report-Item '工具：adb' $adbOk ('存在：' + $Adb) -Record:$Record
    if (-not $adbOk) {
        Write-Host '    提示：默认路径取自 worker-workspace\phone-mika.json 的 executor.mika.adb。' -ForegroundColor DarkYellow
    }

    $cliOk = Test-Path -LiteralPath $Cli -PathType Leaf
    Report-Item '工具：Mika CLI' $cliOk ('存在：' + $Cli) -Record:$Record
    if (-not $cliOk) {
        Write-Host '    提示：默认路径取自 worker-workspace\phone-mika.json 的 commandArgs。' -ForegroundColor DarkYellow
    }

    $py = Get-PythonCommand
    if ($null -eq $py) {
        Report-Item '工具：Python 3' $false '未找到 py / python / python3 命令；安装 Python 3 并确保 py 启动器可用。' -Record:$Record
    } else {
        $verCode = -1
        $verLines = @()
        $verArgs = @($py.Prefix) + @('--version')
        try {
            $verLines = @(& $py.Exe @verArgs 2>&1 | ForEach-Object { [string]$_ })
            if ($null -ne $LASTEXITCODE) { $verCode = [int]$LASTEXITCODE }
        } catch {
            $verCode = 127
            $verLines = @([string]$_.Exception.Message)
        }
        $verText = Get-FirstLine $verLines
        if (($verText -eq '') -and ($verLines.Count -gt 0)) { $verText = ([string]$verLines[0]).Trim() }
        $pyOk = ($verCode -eq 0 -and $verText -match 'Python 3')
        Report-Item '工具：Python 3' $pyOk (($py.Exe + ' ' + (@($py.Prefix) -join ' ') + ' 可用；' + $verText)) -Record:$Record
        if (-not $pyOk) {
            Write-Host '    提示：需要 Python 3.10+；如 py 启动器安装异常，可重装 Python 并勾选 py launcher。' -ForegroundColor DarkYellow
        }
    }

    # 2) ADB 与设备
    Write-Step '2) 检查 ADB 与手机连接'
    $server = Run-Adb @('start-server')
    $serverOk = ($server.Code -eq 0)
    Report-Item 'ADB server' $serverOk (('adb start-server 退出码 ' + $server.Code)) -Record:$Record

    $dev = Run-Adb @('devices')
    $deviceState = ''
    $deviceFound = $false
    if ($dev.Code -eq 0) {
        foreach ($line in $dev.Lines) {
            $text = ([string]$line).Trim()
            if ($text -eq '') { continue }
            if ($text -like 'List of devices*') { continue }
            if ($text.StartsWith('*')) { continue }
            $parts = $text -split '\s+', 2
            if ($parts.Count -lt 2) { continue }
            if ($parts[0] -eq $Serial) {
                $deviceState = ($parts[1] -split '\s+')[0]
                $deviceFound = $true
                break
            }
        }
    }
    $state.DeviceState = $deviceState

    if (-not $deviceFound) {
        Report-Item '手机连接' $false ('adb devices 中没有序列号 ' + $Serial + '。检查 USB 数据线（不是仅充电线）、手机 USB 调试开关、本机 RSA 授权弹窗。') -Record:$Record
    } elseif ($deviceState -eq 'device') {
        $state.DeviceOk = $true
        Report-Item '手机连接' $true ('序列号 ' + $Serial + ' 状态为 device') -Record:$Record
    } elseif ($deviceState -eq 'unauthorized') {
        Report-Item '手机连接' $false ('状态 unauthorized：解锁手机，点「允许 USB 调试」；如无弹窗，撤销 USB 调试授权后重新插拔。') -Record:$Record
    } elseif ($deviceState -eq 'offline') {
        Report-Item '手机连接' $false '状态 offline：重新插拔数据线，或关闭再开启手机 USB 调试。' -Record:$Record
    } else {
        Report-Item '手机连接' $false ('状态异常：' + $deviceState + '。按 unauthorized/offline 同样方式处理。') -Record:$Record
    }

    # 3) 无障碍服务
    Write-Step '3) 检查 Mika 无障碍服务'
    if ($state.DeviceOk) {
        $acc = Run-Adb @('shell', 'settings', 'get', 'secure', 'enabled_accessibility_services')
        $state.AccListRaw = $acc.Text.Trim()
        $accReadOk = ($acc.Code -eq 0)
        if ($accReadOk) {
            $hasService = Test-ServiceInList $state.AccListRaw $Service
            $state.AccHasService = $hasService
            $detail = '目标服务不在列表中；当前列表 = ' + (Format-Field $state.AccListRaw) + '。-Restore 会保留已有服务并追加目标服务。'
            if ($hasService) { $detail = '目标服务已启用：' + $Service }
            Report-Item '无障碍服务' $hasService $detail -Record:$Record
        } else {
            Report-Item '无障碍服务' $false ('读取失败（退出码 ' + $acc.Code + '）：' + (Get-FirstLine $acc.Lines)) -Record:$Record
        }

        $accEnabled = Run-Adb @('shell', 'settings', 'get', 'secure', 'accessibility_enabled')
        $state.AccEnabled = $accEnabled.Text.Trim()
        if ($accEnabled.Code -eq 0) {
            $enabledOk = ($state.AccEnabled -eq '1')
            Report-Item '无障碍总开关' $enabledOk ('accessibility_enabled=' + (Format-Field $state.AccEnabled) + '（期望 1）') -Record:$Record
        } else {
            Report-Item '无障碍总开关' $false ('读取失败（退出码 ' + $accEnabled.Code + '）') -Record:$Record
        }
    } else {
        Report-Item '无障碍服务' $false '跳过：ADB 设备不可用，无法读取。' -Record:$Record
        Report-Item '无障碍总开关' $false '跳过：ADB 设备不可用，无法读取。' -Record:$Record
    }

    # 4) Mika 进程
    Write-Step '4) 检查 Mika 进程'
    if ($state.DeviceOk) {
        $pidResult = Run-Adb @('shell', 'pidof', $Package)
        $state.MikaPid = $pidResult.Text.Trim()
        $running = (($pidResult.Code -eq 0) -and ($state.MikaPid -ne ''))
        $state.MikaRunning = $running
        if ($running) {
            Report-Item 'Mika 进程' $true ('pid=' + $state.MikaPid) -Record:$Record
        } else {
            Report-Item 'Mika 进程' $false '未运行（pidof 无输出）。-Restore 会尝试用 monkey / am start 拉起 Mika。' -Record:$Record
        }
    } else {
        Report-Item 'Mika 进程' $false '跳过：ADB 设备不可用，无法检查。' -Record:$Record
    }

    # 5) mika doctor
    Write-Step '5) 检查 Mika 连接（mika doctor）'
    $doc = Run-Mika -Subcommand 'doctor'
    $state.Doctor = $doc

    if ($null -eq $doc.Json) {
        Report-Item 'Mika 连接（doctor.connection）' $false ('未返回可解析 JSON（退出码 ' + $doc.Code + '）：' + (Get-FirstLine $doc.Lines)) -Record:$Record
        Report-Item '手机就绪（device_state.device.ready）' $false 'doctor 未返回可解析 JSON，无法确认。' -Record:$Record
        return $state
    }

    $errCode = ''
    $errMessage = ''
    if ($null -ne $doc.Json.error) {
        $errCode = [string]$doc.Json.error.code
        $errMessage = [string]$doc.Json.error.message
    }
    $state.DoctorErrorCode = $errCode
    $state.DoctorErrorMessage = $errMessage

    $connection = ''
    if ($null -ne $doc.Json.connection) { $connection = [string]$doc.Json.connection }
    $state.DoctorConnection = $connection
    $transport = ''
    if ($null -ne $doc.Json.transport) { $transport = [string]$doc.Json.transport }
    $connOk = ($connection -eq 'ok')
    $connDetail = 'connection=' + (Format-Field $connection) + ' transport=' + (Format-Field $transport)
    if ($errCode -ne '') {
        $connDetail = $connDetail + '；错误码 ' + $errCode + '：' + $errMessage + '。提示：' + (Get-MikaErrorHint $errCode)
    }
    Report-Item 'Mika 连接（doctor.connection）' $connOk $connDetail -Record:$Record

    if (($null -ne $doc.Json.device_state) -and ([string]$doc.Json.device_state.status -ne 'unsupported')) {
        $state.DoctorSupportsState = $true
        $ready = $false
        if ($doc.Json.device_state.device.ready -eq $true) { $state.DoctorReady = $true }
        $ready = $state.DoctorReady
        $deviceStateText = 'status=' + (Format-Field $doc.Json.device_state.status)
        if ($null -ne $doc.Json.device_state.device) {
            $device = $doc.Json.device_state.device
            $deviceStateText = $deviceStateText +
                ' interactive=' + (Format-Field $device.interactive) +
                ' keyguard_showing=' + (Format-Field $device.keyguard_showing) +
                ' device_locked=' + (Format-Field $device.device_locked) +
                ' secure=' + (Format-Field $device.secure) +
                ' ready=' + (Format-Field $device.ready)
        }
        Report-Item '手机就绪（device_state.device.ready）' $ready ('device_state：' + $deviceStateText) -Record:$Record
        Write-Host '    提示：enabled=false、credential_configured=false 表示 Mika 的「远程亮屏/解锁」功能默认关闭，不算故障。' -ForegroundColor DarkYellow
        if (-not $ready) {
            Write-Host '    提示：如果 device_locked=true 或 keyguard_showing=true，手机是安全锁屏，adb 不能解锁，需要人工解锁手机。' -ForegroundColor DarkYellow
        }
    } else {
        Report-Item '手机就绪（device_state.device.ready）' $false 'Mika APK 未提供 device_state 能力（旧版/不支持），无法确认 ready；升级 Mika APK。' -Record:$Record
    }

    return $state
}

# ---------------------------------------------------------------- 修复动作

function Invoke-Restore {
    Write-Step '只读诊断（修复前）'
    $before = Test-Health -Record
    $healthyBefore = Write-Summary

    if ($healthyBefore) {
        Write-Host ''
        Write-Host '诊断显示手机桥与手机状态健康，-Restore 不会修改手机（无需修复）。' -ForegroundColor Green
        Write-Host '若手机任务仍失败，请看任务错误码与 docs\PHONE-RECOVERY.md「症状速查」；本工具不会改动健康手机的状态。' -ForegroundColor Green
        return 0
    }

    if (-not $before.DeviceOk) {
        Write-Host ''
        Write-Host ('ADB 设备不可用（adb devices 状态 = ' + (Format-Field $before.DeviceState) + '），无法自动修复。') -ForegroundColor Red
        Write-Host '先按下面的建议恢复 USB ADB 连接，再重跑 -Restore：' -ForegroundColor Red
        Write-Host '  1. 换一根支持数据传输的 USB 线，插到主板后置 USB 口；' -ForegroundColor Yellow
        Write-Host '  2. 手机：设置 › 开发者选项 › USB 调试 关闭再开启；' -ForegroundColor Yellow
        Write-Host '  3. 解锁手机，在「允许 USB 调试」弹窗中点允许；' -ForegroundColor Yellow
        Write-Host '  4. 回到本机运行：-Check，确认状态为 device。' -ForegroundColor Yellow
        return 2
    }

    # 修复 1：唤醒屏幕 + 尝试解除无安全锁的 keyguard
    Write-Step '修复 1/5：唤醒屏幕'
    $wake = Run-Adb @('shell', 'input', 'keyevent', '224')
    Report-Item '唤醒屏幕（KEYCODE_WAKEUP=224）' ($wake.Code -eq 0) ('input keyevent 224 退出码 ' + $wake.Code)

    $dismiss = Run-Adb @('shell', 'wm', 'dismiss-keyguard')
    if ($dismiss.Code -eq 0) {
        Report-Item '解除 keyguard（wm dismiss-keyguard）' $true '已发出解锁命令；仅对无安全锁/滑动锁有效。'
    } else {
        Report-Item '解除 keyguard（wm dismiss-keyguard）' $false ('失败（退出码 ' + $dismiss.Code + '）：' + (Get-FirstLine $dismiss.Lines) + '。不影响后续步骤；安全锁只能人工解锁。')
    }
    Start-Sleep -Seconds 1

    # 修复 2：拉起 Mika
    Write-Step '修复 2/5：拉起 Mika'
    $monkey = Run-Adb @('shell', 'monkey', '-p', $Package, '1')
    $monkeyOk = (($monkey.Code -eq 0) -and ($monkey.Text -notmatch 'No activities found') -and ($monkey.Text -notmatch 'monkey aborted'))
    if (-not $monkeyOk) {
        Write-Host '    monkey 启动失败，改用 am start（先解析 launcher activity）。' -ForegroundColor Yellow
        $resolve = Run-Adb @('shell', 'cmd', 'package', 'resolve-activity', '--brief', $Package)
        $component = ''
        foreach ($line in $resolve.Lines) {
            $text = ([string]$line).Trim()
            if ($text -match '^[A-Za-z0-9_.]+/[A-Za-z0-9_.]+$') {
                $component = ($text -split '\s+')[-1]
                break
            }
        }
        if ($component -ne '') {
            $am = Run-Adb @('shell', 'am', 'start', '-n', $component)
        } else {
            $am = Run-Adb @('shell', 'am', 'start', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', $Package)
        }
        $amOk = (($am.Code -eq 0) -and ($am.Text -notmatch 'Error'))
        if ($amOk) {
            Report-Item '拉起 Mika' $true ('am start 成功；组件 ' + (Format-Field $component))
        } else {
            Report-Item '拉起 Mika' $false 'monkey 与 am start 都失败。检查 Mika 是否安装/被冻结，或手动点开 Mika。'
        }
    } else {
        Report-Item '拉起 Mika' $true 'monkey 已启动 Mika。'
    }
    Start-Sleep -Seconds 3

    # 修复 3：确保无障碍服务启用（保留已有服务，不覆盖）
    Write-Step '修复 3/5：确保 Mika 无障碍服务启用'
    $accNow = Run-Adb @('shell', 'settings', 'get', 'secure', 'enabled_accessibility_services')
    $currentList = $accNow.Text.Trim()
    $hasService = Test-ServiceInList $currentList $Service
    if (-not $hasService) {
        if (($currentList -eq '') -or ($currentList -eq 'null')) {
            $newList = $Service
        } else {
            $newList = $currentList + ':' + $Service
        }
        Write-Host '    保留已有服务并追加目标服务（不覆盖原列表）。' -ForegroundColor Yellow
        $put = Run-Adb @('shell', 'settings', 'put', 'secure', 'enabled_accessibility_services', $newList)
        $putOk = ($put.Code -eq 0)
        if (-not $putOk) {
            Report-Item '写入无障碍服务列表' $false ('settings put 失败（退出码 ' + $put.Code + '）：' + (Get-FirstLine $put.Lines) + '。部分厂商系统会限制 shell 写 secure 设置，请到手机设置里手动开启 Mika 无障碍服务。')
        }
    } else {
        Write-Host '    目标服务已在列表中，无需追加。' -ForegroundColor DarkGray
    }

    $enabledNow = Run-Adb @('shell', 'settings', 'get', 'secure', 'accessibility_enabled')
    $enabledValue = $enabledNow.Text.Trim()
    if ($enabledValue -ne '1') {
        $putEnabled = Run-Adb @('shell', 'settings', 'put', 'secure', 'accessibility_enabled', '1')
        if ($putEnabled.Code -ne 0) {
            Report-Item '无障碍总开关' $false ('settings put accessibility_enabled 1 失败（退出码 ' + $putEnabled.Code + '）。')
        }
    }

    # 重新读取，确认手机端实际状态
    $verifyList = Run-Adb @('shell', 'settings', 'get', 'secure', 'enabled_accessibility_services')
    $verifyEnabled = Run-Adb @('shell', 'settings', 'get', 'secure', 'accessibility_enabled')
    $verifyHas = Test-ServiceInList $verifyList.Text $Service
    $verifyOn = ($verifyEnabled.Text.Trim() -eq '1')
    Report-Item '无障碍服务（复检）' ($verifyHas -and $verifyOn) ('服务在列表=' + (Format-Field $verifyHas) + '，accessibility_enabled=' + (Format-Field $verifyEnabled.Text.Trim()))

    # 修复 4：mika connect
    Write-Step '修复 4/5：重新建立 Mika 连接（mika connect）'
    $connect = Run-Mika -Subcommand 'connect'
    $connectOk = $false
    if ($null -ne $connect.Json) {
        if ($connect.Json.connected -eq $true) { $connectOk = $true }
    }
    if ($connectOk) {
        Report-Item 'mika connect' $true ('connected=true transport=' + (Format-Field $connect.Json.transport) + ' api_version=' + (Format-Field $connect.Json.api_version))
    } else {
        $connectCode = ''
        $connectMessage = ''
        if (($null -ne $connect.Json) -and ($null -ne $connect.Json.error)) {
            $connectCode = [string]$connect.Json.error.code
            $connectMessage = [string]$connect.Json.error.message
        }
        Report-Item 'mika connect' $false ('失败（退出码 ' + $connect.Code + '）' + (Format-Field $connectCode) + '：' + (Get-FirstLine $connect.Lines))
        if ($connectCode -ne '') {
            Write-Host ('    提示：' + (Get-MikaErrorHint $connectCode)) -ForegroundColor Yellow
        }
        Write-Host '    connect 失败，再运行一次 doctor 收集证据…' -ForegroundColor Yellow
        $evidence = Run-Mika -Subcommand 'doctor'
        if ($null -ne $evidence.Json) {
            if ($null -ne $evidence.Json.error) {
                Write-Host ('    doctor 证据：code=' + (Format-Field $evidence.Json.error.code) + ' message=' + (Format-Field $evidence.Json.error.message)) -ForegroundColor Yellow
            } else {
                Write-Host ('    doctor 证据：connection=' + (Format-Field $evidence.Json.connection)) -ForegroundColor Yellow
            }
        }
    }

    # 修复 5：最终验证
    Write-Step '修复 5/5：最终验证（doctor）'
    $script:CheckResults = @()
    $after = Test-Health -Record
    $finalOk = Write-Summary

    if ($finalOk) {
        Write-Host ''
        Write-Host '验收通过：mika doctor ready=true。' -ForegroundColor Green
        Write-Host '建议再发一条小任务确认端到端（见 docs\PHONE-RECOVERY.md「验收标准」）：手机应出现该任务并完成。' -ForegroundColor Green
        return 0
    }

    Write-Host ''
    Write-Host '验收未通过：doctor ready=false 或连接仍异常。' -ForegroundColor Red
    if (($null -ne $after) -and ($after.DoctorSupportsState) -and (-not $after.DoctorReady)) {
        Write-Host '如果手机是安全锁屏（PIN/密码/图案），adb 不能解锁：请人工解锁手机，或在 Mika 设置里启用远程解锁后重试。' -ForegroundColor Yellow
    }
    if (($null -ne $after) -and ($after.DoctorErrorCode -ne '')) {
        Write-Host ('doctor 错误码：' + $after.DoctorErrorCode + '。' + (Get-MikaErrorHint $after.DoctorErrorCode)) -ForegroundColor Yellow
    }
    Write-Host '仍失败时：打开手机上的 Mika 一次，确认模型配置与「Set up phone control」正常，再运行 mika connect；必要时重装/更新 Mika APK。' -ForegroundColor Yellow
    return 2
}

# ---------------------------------------------------------------- 入口

Write-Header

if ($Mode -eq 'Restore') {
    $exitCode = Invoke-Restore
    exit $exitCode
}

# 默认：-Check 只读诊断
$state = Test-Health -Record
$allOk = Write-Summary

if ($allOk) {
    Write-Host '（-Check 为只读诊断：没有修改手机设置；doctor 会临时建立 ADB 端口转发并自动清理。）' -ForegroundColor Green
    exit 0
}

Write-Host '建议：先按上面的 [FAIL] 项处理；需要自动修复时运行 -Restore。' -ForegroundColor Yellow
exit 2
