#Requires -Version 5.1
<#
.SYNOPSIS
  超级管家（Super Butler）Android APK 手工构建流水线。
  无 Gradle、无 Android Studio、无 AndroidX：aapt2 + javac + d8 + jar + zipalign + apksigner。

.DESCRIPTION
  输入：android/AndroidManifest.xml、android/res/**、android/assets/**、android/src/**/*.java
  输出：dist/SuperButler-0.1.0.apk（已用 android/keystore/superbutler.keystore 签名）

  工具链默认位于 <repo>/toolchain，可用环境变量 BUTLER_TOOLCHAIN 指向别处：
    toolchain/jdk/bin/{java,javac,jar,keytool}.exe
    toolchain/android-sdk/build-tools/36.0.0/{aapt2.exe,d8.jar,apksigner.jar,zipalign.exe}
    toolchain/android-sdk/platforms/android-36/android.jar

.PARAMETER ToolchainDir
  工具链根目录；默认 $env:BUTLER_TOOLCHAIN，未设置则用 <repo>/toolchain。

.PARAMETER PythonExe
  生成图标用的 Python（需 Pillow）；默认 $env:BUTLER_PYTHON，否则自动探测。
  图标已随仓库提供，仅在缺图标时才会调用。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File android\build-apk.ps1
#>
[CmdletBinding()]
param(
    [string]$ToolchainDir = $env:BUTLER_TOOLCHAIN,
    [string]$PythonExe = $env:BUTLER_PYTHON
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 路径与常量
# ---------------------------------------------------------------------------
$AndroidDir = $PSScriptRoot
$RepoRoot = Split-Path -Parent $AndroidDir
$BuildDir = Join-Path $AndroidDir 'build'
$GenDir = Join-Path $BuildDir 'gen'
$ClassesDir = Join-Path $BuildDir 'classes'
$DexDir = Join-Path $BuildDir 'dex'
$ResZip = Join-Path $BuildDir 'res.zip'
$UnsignedApk = Join-Path $BuildDir 'app-unsigned.apk'
$AlignedApk = Join-Path $BuildDir 'app-aligned.apk'
$DistDir = Join-Path $RepoRoot 'dist'
$ApkName = 'SuperButler-0.1.0.apk'
$ApkOut = Join-Path $DistDir $ApkName
$KeystoreDir = Join-Path $AndroidDir 'keystore'
$Keystore = Join-Path $KeystoreDir 'superbutler.keystore'
$PackageName = 'com.superbutler.app'
$MinSdk = 26
$TargetSdk = 36
$MaxApkBytes = 5MB

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host "=== $Message ===" -ForegroundColor Cyan
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    Write-Verbose ("$Exe " + ($Arguments -join ' '))
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw ("命令失败 (exit {0}): {1} {2}" -f $LASTEXITCODE, $Exe, ($Arguments -join ' '))
    }
}

function Resolve-Jdk([string]$ToolchainRoot) {
    $candidates = New-Object System.Collections.Generic.List[string]
    $candidates.Add((Join-Path $ToolchainRoot 'jdk'))
    foreach ($dir in @(Get-ChildItem $ToolchainRoot -Directory -ErrorAction SilentlyContinue)) {
        if ($dir.Name -like 'jdk*') { $candidates.Add($dir.FullName) }
        if ($dir.Name -like 'extract-jdk*') {
            $candidates.Add($dir.FullName)
            foreach ($sub in @(Get-ChildItem $dir.FullName -Directory -ErrorAction SilentlyContinue)) {
                $candidates.Add($sub.FullName)
            }
        }
    }
    foreach ($c in $candidates) {
        if (Test-Path (Join-Path $c 'bin\java.exe')) { return $c }
    }
    throw "找不到 JDK：期望 $ToolchainRoot\jdk\bin\java.exe"
}

function Resolve-BuildTools([string]$ToolchainRoot) {
    $roots = @(
        (Join-Path $ToolchainRoot 'android-sdk\build-tools'),
        (Join-Path $ToolchainRoot 'extract-buildtools')
    )
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        if (Test-Path (Join-Path $root 'aapt2.exe')) { return $root }
        $versions = @(Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending)
        foreach ($v in $versions) {
            if (Test-Path (Join-Path $v.FullName 'aapt2.exe')) { return $v.FullName }
        }
    }
    throw "找不到 Android build-tools（aapt2.exe）：期望 $ToolchainRoot\android-sdk\build-tools\36.0.0"
}

function Resolve-AndroidJar([string]$ToolchainRoot) {
    $roots = @(
        (Join-Path $ToolchainRoot 'android-sdk\platforms'),
        (Join-Path $ToolchainRoot 'extract-platform')
    )
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        if (Test-Path (Join-Path $root 'android.jar')) { return (Join-Path $root 'android.jar') }
        $dirs = @(Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending)
        foreach ($d in $dirs) {
            $jar = Join-Path $d.FullName 'android.jar'
            if (Test-Path $jar) { return $jar }
        }
    }
    throw "找不到 android.jar：期望 $ToolchainRoot\android-sdk\platforms\android-36\android.jar"
}

# ---------------------------------------------------------------------------
# 0. 定位工具链
# ---------------------------------------------------------------------------
Write-Step '0/9 定位工具链'
if (-not $ToolchainDir) { $ToolchainDir = Join-Path $RepoRoot 'toolchain' }
$ToolchainDir = [System.IO.Path]::GetFullPath($ToolchainDir)
if (-not (Test-Path $ToolchainDir)) {
    throw "找不到工具链目录：$ToolchainDir（可用 -ToolchainDir 或 BUTLER_TOOLCHAIN 指定）"
}

$JdkDir = Resolve-Jdk $ToolchainDir
$BuildToolsDir = Resolve-BuildTools $ToolchainDir
$AndroidJar = Resolve-AndroidJar $ToolchainDir

$Java = Join-Path $JdkDir 'bin\java.exe'
$Javac = Join-Path $JdkDir 'bin\javac.exe'
$Jar = Join-Path $JdkDir 'bin\jar.exe'
$Keytool = Join-Path $JdkDir 'bin\keytool.exe'
$Aapt2 = Join-Path $BuildToolsDir 'aapt2.exe'
$ZipAlign = Join-Path $BuildToolsDir 'zipalign.exe'
$D8Jar = Join-Path $BuildToolsDir 'lib\d8.jar'
$ApkSignerJar = Join-Path $BuildToolsDir 'lib\apksigner.jar'

foreach ($tool in @($Java, $Javac, $Jar, $Keytool, $Aapt2, $ZipAlign, $D8Jar, $ApkSignerJar, $AndroidJar)) {
    if (-not (Test-Path $tool)) { throw "缺少工具：$tool" }
}

Write-Host "JDK          : $JdkDir"
Write-Host "Build-Tools  : $BuildToolsDir"
Write-Host "Platform JAR : $AndroidJar"

# ---------------------------------------------------------------------------
# 1. 图标（缺失时用 Pillow 生成）
# ---------------------------------------------------------------------------
Write-Step '1/9 检查启动图标'
$IconFiles = @(
    'res\mipmap-mdpi\ic_launcher.png',
    'res\mipmap-hdpi\ic_launcher.png',
    'res\mipmap-xhdpi\ic_launcher.png',
    'res\mipmap-xxhdpi\ic_launcher.png',
    'res\mipmap-xxxhdpi\ic_launcher.png'
)
$MissingIcons = @($IconFiles | Where-Object { -not (Test-Path (Join-Path $AndroidDir $_)) })
if ($MissingIcons.Count -gt 0) {
    Write-Host "缺少 $($MissingIcons.Count) 个图标，尝试用 Pillow 生成…"
    $IconScript = Join-Path $AndroidDir 'generate-icons.py'
    if (-not (Test-Path $IconScript)) { throw "缺少图标且找不到 $IconScript" }

    $pythonCandidates = New-Object System.Collections.Generic.List[string]
    if ($PythonExe) { $pythonCandidates.Add($PythonExe) }
    $envPython = $env:BUTLER_PYTHON
    if ($envPython) { $pythonCandidates.Add($envPython) }
    $pythonCandidates.Add('python')
    $pythonCandidates.Add('py')

    $pythonUsed = $null
    foreach ($cand in $pythonCandidates) {
        try {
            $resolved = (Get-Command $cand -ErrorAction Stop).Source
            & $resolved -c "import PIL" | Out-Null
            if ($LASTEXITCODE -eq 0) { $pythonUsed = $resolved; break }
        } catch { }
    }
    if (-not $pythonUsed) { throw '未找到带 Pillow 的 Python，无法生成图标' }
    Invoke-Native $pythonUsed @($IconScript)
}
Write-Host "图标就绪：$($IconFiles.Count) 档 mipmap"

# ---------------------------------------------------------------------------
# 2. 清理 + 准备输出目录
# ---------------------------------------------------------------------------
Write-Step '2/9 清理构建目录'
if (Test-Path $BuildDir) { Remove-Item $BuildDir -Recurse -Force }
foreach ($dir in @($BuildDir, $GenDir, $ClassesDir, $DexDir, $DistDir, $KeystoreDir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}
Write-Host "构建目录：$BuildDir"

# ---------------------------------------------------------------------------
# 3. aapt2 compile：编译资源
# ---------------------------------------------------------------------------
Write-Step '3/9 aapt2 compile（资源编译）'
Invoke-Native $Aapt2 @(
    'compile',
    '--dir', (Join-Path $AndroidDir 'res'),
    '-o', $ResZip
)

# ---------------------------------------------------------------------------
# 4. aapt2 link：生成未签名 APK + R.java
# ---------------------------------------------------------------------------
Write-Step '4/9 aapt2 link（资源链接 / 生成 R.java）'
Invoke-Native $Aapt2 @(
    'link',
    '-o', $UnsignedApk,
    '-I', $AndroidJar,
    '--manifest', (Join-Path $AndroidDir 'AndroidManifest.xml'),
    '--java', $GenDir,
    '-A', (Join-Path $AndroidDir 'assets'),
    '--auto-add-overlay',
    '--min-sdk-version', "$MinSdk",
    '--target-sdk-version', "$TargetSdk",
    $ResZip
)

# ---------------------------------------------------------------------------
# 5. javac：编译 Java（含 aapt2 生成的 R.java）
# ---------------------------------------------------------------------------
Write-Step '5/9 javac（Java 源码编译）'
$Sources = @(
    @(Get-ChildItem (Join-Path $AndroidDir 'src') -Recurse -Filter '*.java' -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName })
)
$GeneratedSources = @(
    @(Get-ChildItem $GenDir -Recurse -Filter '*.java' -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName })
)
if ($Sources.Count -eq 0) { throw 'src/ 下没有 Java 源文件' }
$AllSources = @($Sources + $GeneratedSources)
Write-Host "Java 源文件：$($AllSources.Count) 个"
Invoke-Native $Javac (@(
        '-encoding', 'UTF-8',
        '-source', '8',
        '-target', '8',
        '-bootclasspath', $AndroidJar,
        '-Xlint:-options',
        '-d', $ClassesDir
    ) + $AllSources)

# ---------------------------------------------------------------------------
# 6. d8：class -> dex
# ---------------------------------------------------------------------------
Write-Step '6/9 d8（生成 classes.dex）'
$ClassFiles = @(
    @(Get-ChildItem $ClassesDir -Recurse -Filter '*.class' -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName })
)
if ($ClassFiles.Count -eq 0) { throw '没有生成任何 .class 文件' }
Invoke-Native $Java (@(
        '-cp', $D8Jar,
        'com.android.tools.r8.D8',
        '--release',
        '--min-api', "$MinSdk",
        '--lib', $AndroidJar,
        '--output', $DexDir
    ) + $ClassFiles)
$DexFile = Join-Path $DexDir 'classes.dex'
if (-not (Test-Path $DexFile)) { throw 'd8 未生成 classes.dex' }

# ---------------------------------------------------------------------------
# 7. jar：把 classes.dex 放进 APK
# ---------------------------------------------------------------------------
Write-Step '7/9 jar（把 classes.dex 写入 APK）'
Push-Location $DexDir
try {
    Invoke-Native $Jar @('uf', $UnsignedApk, 'classes.dex')
}
finally {
    Pop-Location
}

# ---------------------------------------------------------------------------
# 8. zipalign + apksigner 签名
# ---------------------------------------------------------------------------
Write-Step '8/9 zipalign + apksigner（对齐与签名）'
Invoke-Native $ZipAlign @('-f', '4', $UnsignedApk, $AlignedApk)

if (-not (Test-Path $Keystore)) {
    Write-Host "生成测试签名密钥库：$Keystore"
    Invoke-Native $Keytool @(
        '-genkeypair', '-v',
        '-keystore', $Keystore,
        '-alias', 'superbutler',
        '-keyalg', 'RSA',
        '-keysize', '2048',
        '-validity', '10000',
        '-storepass', 'superbutler',
        '-keypass', 'superbutler',
        '-dname', 'CN=Super Butler, OU=Home Lab, O=Super Butler, L=KL, C=MY'
    )
}

if (Test-Path $ApkOut) { Remove-Item $ApkOut -Force }
Invoke-Native $Java @(
    '-jar', $ApkSignerJar,
    'sign',
    '--ks', $Keystore,
    '--ks-key-alias', 'superbutler',
    '--ks-pass', 'pass:superbutler',
    '--key-pass', 'pass:superbutler',
    '--min-sdk-version', "$MinSdk",
    '--out', $ApkOut,
    $AlignedApk
)

# ---------------------------------------------------------------------------
# 9. 验证与报告
# ---------------------------------------------------------------------------
Write-Step '9/9 验证产物'
$BadgingRaw = & $Aapt2 'dump' 'badging' $ApkOut 2>&1
$Badging = ($BadgingRaw | Out-String)
Write-Host '--- aapt2 dump badging ---'
Write-Host $Badging

Write-Host '--- apksigner verify --print-certs ---'
& $Java '-jar' $ApkSignerJar 'verify' '--print-certs' $ApkOut
if ($LASTEXITCODE -ne 0) { throw 'apksigner verify 失败' }

$ZipEntries = @((& $Jar 'tf' $ApkOut) 2>&1 | ForEach-Object { "$_" })
Write-Host '--- APK 关键条目 ---'
$requiredEntries = @(
    'AndroidManifest.xml',
    'resources.arsc',
    'classes.dex',
    'assets/setup.html'
)
foreach ($entry in $requiredEntries) {
    $hit = $ZipEntries | Where-Object { $_ -eq $entry }
    if ($hit) { Write-Host ("  [OK]   " + $entry) }
    else { throw ("APK 内缺少关键条目：" + $entry) }
}
$MipmapEntry = $ZipEntries | Where-Object { $_ -like 'res/mipmap-*ic_launcher*' } | Select-Object -First 1
if ($MipmapEntry) { Write-Host ("  [OK]   " + $MipmapEntry) }
else { throw 'APK 内缺少启动图标资源' }

$ApkItem = Get-Item $ApkOut
$ApkSizeMb = [math]::Round($ApkItem.Length / 1MB, 2)
Write-Host ''
Write-Host ("APK: {0}" -f $ApkItem.FullName)
Write-Host ("大小: {0} bytes ({1} MB)" -f $ApkItem.Length, $ApkSizeMb)
Write-Host ("SHA256: {0}" -f (Get-FileHash $ApkOut -Algorithm SHA256).Hash)

# 断言：包名 / SDK / 启动 Activity
$expectedBadging = @(
    "package: name='$PackageName'",
    "sdkVersion:'$MinSdk'",
    "targetSdkVersion:'$TargetSdk'",
    "launchable-activity: name='$PackageName.MainActivity'"
)
foreach ($expect in $expectedBadging) {
    if ($Badging -notlike ("*" + $expect + "*")) {
        throw ("badging 校验失败，缺少：{0}" -f $expect)
    }
}
if ($ApkItem.Length -ge $MaxApkBytes) {
    throw ("APK 体积 {0} MB 超过 5 MB 目标上限" -f $ApkSizeMb)
}

Write-Host ''
Write-Host '✅ 构建成功：dist/SuperButler-0.1.0.apk 已生成并通过静态校验' -ForegroundColor Green
Write-Host '安装：adb install -r "dist\SuperButler-0.1.0.apk"' -ForegroundColor Green
exit 0
