param(
    [Parameter(Mandatory = $true)][string]$InstallerA,
    [Parameter(Mandatory = $true)][string]$VerA,
    [Parameter(Mandatory = $true)][string]$InstallerB,
    [Parameter(Mandatory = $true)][string]$VerB,
    [Parameter(Mandatory = $true)][string]$Work
)
$ErrorActionPreference = 'Stop'
$script:StateDir = Join-Path $Work 'state'

function Fail([string]$kind, [string]$msg) {
    Write-Host "H10 判据失败[$kind]: $msg"
    exit 1
}

function NormalizedPath([string]$p) {
    if ($null -eq $p) { return '' }
    ($p -replace '/', '\').TrimEnd('\')
}

# PS 7.3 起，native 命令的 stderr 在 ErrorActionPreference=Stop 下会变成终止性异常，于是「探针正常产出的警告行」能把这一步判红。
# 为什么必须自己起进程而不用调用运算符：壳是 GUI 子系统的可执行文件，`& exe` 不等待它、也不接它的 stdout —— 探针行直接落进虚空，$LASTEXITCODE 还是空，判据读不到任何东西。
# 两个管道各起一个异步读，否则子进程写满 stderr 缓冲会与父进程的 stdout 读互相锁死。
function RunExe([string]$exe, [string[]]$argv) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $exe
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    foreach ($a in $argv) { $psi.ArgumentList.Add($a) }
    $p = [System.Diagnostics.Process]::Start($psi)
    $so = $p.StandardOutput.ReadToEndAsync()
    $se = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit(600000)) {
        try { $p.Kill(); $p.WaitForExit() } catch { }
        Fail probe "$exe 在 10 分钟内未退出"
    }
    (($so.Result + $se.Result).TrimEnd()) + "`nexit=$($p.ExitCode)"
}

function RunExit([string]$text) {
    if ($text -match '(?s).*exit=(-?\d+)\s*$') { return [int]$Matches[1] }
    return -1
}

function Find-InstalledExe {
    $dirs = @()
    # 卸载登记键与固定目录里的产品名一律从单源派生（brand.js#TAURI_PRODUCT_NAME），本脚本不再手写。
    $uninstall = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\'
    $keys = @($uninstall + '*',
              'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
              $uninstall + $script:ProductName + '*')
    foreach ($k in $keys) {
        foreach ($it in @(Get-ItemProperty -Path $k -ErrorAction SilentlyContinue)) {
            if ($null -eq $it) { continue }
            $hay = ('{0} {1} {2} {3}' -f $it.DisplayName, $it.DisplayIcon, $it.UninstallString, $it.InstallLocation)
            if ($hay -notmatch [regex]::Escape($script:ProductName)) { continue }
            if ($it.InstallLocation) { $dirs += $it.InstallLocation }
            if ($it.UninstallString -match '"([^"]+)"') { $dirs += (Split-Path $Matches[1]) }
        }
    }
    $dirs += @("$env:LOCALAPPDATA\$($script:ProductName)", "$env:LOCALAPPDATA\Programs\$($script:ProductName)",
               "$env:ProgramFiles\$($script:ProductName)", "${env:ProgramFiles(x86)}\$($script:ProductName)")
    foreach ($d in ($dirs | Select-Object -Unique)) {
        if (-not (Test-Path $d)) { continue }
        # 名字判据 = 单源期望名**逐字相等**（此前是 `-like 'lobox*'`：只要有任何一个 lobox* 文件就当找到了，
        #   于是「Tauri 把主二进制打成别的名字」这类不一致永远查不出来 —— 判据见 Assert-InstalledName）。
        $exe = Get-ChildItem -Path $d -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq $script:GuiExe } |
            Select-Object -First 1
        if ($exe) { return $exe.FullName }
    }
    $null
}

function Resolve-InstalledExe([string]$tag) {
    for ($i = 0; $i -lt 30; $i++) {
        $exe = Find-InstalledExe
        if ($exe) { Write-Host "[$tag] 已装二进制 = $exe"; return $exe }
        Start-Sleep -Seconds 2
    }
    # 诊断用（不进判据）：按 productName 前缀把候选都列出来，名字分叉时现场就能看见真名。
    $cand = @(Get-ChildItem -Path $env:LOCALAPPDATA -Filter '*.exe' -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like ($script:ProductName + '*') -and $_.Name -notmatch 'uninstall' } | Select-Object -First 5)
    Write-Host "[$tag] 卸载键与固定目录都没命中；LOCALAPPDATA 递归搜到 $($cand.Count) 个候选："
    $cand | ForEach-Object { Write-Host "  候选 $($_.FullName)" }
    Fail install "$tag 装完后找不到期望的壳可执行文件 $($script:GuiExe)（见上方候选）"
}

# 装后名字断言（Windows）：**实际落盘**的二进制名与安装包名必须逐字等于从单源派生的期望名。
# 为什么必须显式断言：本脚本原用 `-like 'lobox*'` 找 exe、工作流用 `*_x64-setup.exe` 通配取安装包，
#   Tauri 若把主二进制/productName 打成别的名字，通配照样挑得到一个文件、探针照样跑得起来 ⇒ 永远查不出来。
# 判据实现与 Linux/macOS 是同一份（ci/installed-name-check.js，四平台共用），这里只负责把实测名传进去。
function Assert-InstalledName([string]$exe, [string]$installer, [string]$tag) {
    $checker = Join-Path $PSScriptRoot 'installed-name-check.js'
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & node $checker --platform win32 --tag $tag --actual-exe (Split-Path $exe -Leaf) --installer (Split-Path $installer -Leaf)
    $rc = $LASTEXITCODE
    $ErrorActionPreference = $eap
    if ($rc -ne 0) { Fail name "$tag 的装后名字断言未通过（node 退出码 $rc；判据见上一行的 ::error:: ）" }
}

function SilentInstall([string]$pkg, [string]$tag) {
    if (-not (Test-Path $pkg)) { Fail input "$tag 安装包不存在: $pkg" }
    $p = Start-Process -FilePath $pkg -ArgumentList '/S' -PassThru
    if (-not $p.WaitForExit(600000)) {
        try { $p.Kill(); $p.WaitForExit() } catch { }
        Fail install "$tag 的静默安装 10 分钟未退出（可能在等提权授权）"
    }
    if ($p.ExitCode -ne 0) { Fail install "$tag 的 NSIS 静默安装退出码 $($p.ExitCode)" }
}

function ProbeInstalled([string]$exe, [string]$ver, [string]$tag) {
    $out = RunExe $exe @('--shell-update-plan')
    Write-Host $out
    if ((RunExit $out) -ne 0) { Fail probe "$tag 的 --shell-update-plan 退出码非零" }
    if ($out -notmatch "(?m)^shell_version=$([regex]::Escape($ver))") {
        Fail probe "$tag 装后的二进制自报版本不是 ${ver}（跑的不是这份安装包）"
    }
    if ($out -notmatch ('state_dir=' + [regex]::Escape((NormalizedPath $script:StateDir)))) {
        if ($out -notmatch ('state_dir=' + [regex]::Escape($script:StateDir))) {
            Fail probe "$tag 装后的状态根不是隔离目录，判据会读到机器上的真状态"
        }
    }
    $id = Join-Path $script:StateDir 'shell\identity.json'
    $lg = Join-Path $script:StateDir 'shell\shell.log'
    if (-not (Test-Path $id)) { Fail persist "$tag 没写 identity.json（装机形态下落盘链路断了）" }
    $parsed = Get-Content $id -Raw -Encoding UTF8 | ConvertFrom-Json
    if ((NormalizedPath "$($parsed.exe)") -ne (NormalizedPath $exe)) {
        Fail persist "$tag 的 identity.json 记的 exe 是 $($parsed.exe)，不是 $exe"
    }
    $ws = NormalizedPath $env:GITHUB_WORKSPACE
    if ($ws -and (NormalizedPath "$($parsed.exe)").StartsWith($ws)) {
        Fail persist "$tag 的 identity.json 记的 exe 在工作区内，那是构建产物不是装机产物"
    }
    if (-not (Test-Path $lg)) { Fail persist "$tag 没写 shell.log" }
    if ((Get-Content $lg -Raw -Encoding UTF8) -notlike "*壳启动 v$ver*") {
        Fail persist "$tag 的 shell.log 没有 v$ver 的启动行"
    }
}

function HashOf([string]$f) { (Get-FileHash -Algorithm SHA256 -Path $f).Hash }

if (-not (Test-Path $InstallerA)) { Fail input "A 安装包不存在: $InstallerA" }
if (-not (Test-Path $InstallerB)) { Fail input "B 安装包不存在: $InstallerB" }
if (Test-Path $script:StateDir) { Remove-Item -Recurse -Force $script:StateDir }
New-Item -ItemType Directory -Force -Path $Work | Out-Null
New-Item -ItemType Directory -Force -Path $script:StateDir | Out-Null
$env:DSH_SUPERVISOR_HOME = $script:StateDir

# 计划任务名与壳二进制名/productName 一律取自跨语言单源（core/src/shared/brand.js），本脚本不再手写这些名字。
$brandJs = Join-Path $PSScriptRoot '..\..\core\src\shared\brand.js'
$eapSaved = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$guardTask = node -e "process.stdout.write(require(process.argv[1]).WINDOWS_GUARD_TASK)" $brandJs
$watchdogTask = node -e "process.stdout.write(require(process.argv[1]).WINDOWS_WATCHDOG_TASK)" $brandJs
$guiBin = node -e "process.stdout.write(require(process.argv[1]).GUI_BIN_NAME)" $brandJs
$productName = node -e "process.stdout.write(require(process.argv[1]).TAURI_PRODUCT_NAME)" $brandJs
$ErrorActionPreference = $eapSaved
if (-not $guardTask -or -not $watchdogTask) { Fail input "读不到计划任务名（单源 $brandJs）" }
if (-not $guiBin -or -not $productName) { Fail input "读不到壳二进制名/productName（单源 $brandJs）" }
$script:GuiBin = $guiBin
$script:GuiExe = $guiBin + '.exe'
$script:ProductName = $productName

SilentInstall $InstallerA 'A'
$exeA = Resolve-InstalledExe 'A'
Assert-InstalledName $exeA $InstallerA 'A'
ProbeInstalled $exeA $VerA 'A'
$hashA = HashOf $exeA

SilentInstall $InstallerB 'B'
$exeB = Resolve-InstalledExe 'B'
Assert-InstalledName $exeB $InstallerB 'B'
ProbeInstalled $exeB $VerB 'B'
$hashB = HashOf $exeB
if (($VerA -ne $VerB) -and ($hashA -eq $hashB)) { Fail upgrade "覆盖安装后二进制字节没变（sha256=${hashB}）" }

$plan = RunExe $exeB @('--node-plan')
Write-Host $plan
if ((RunExit $plan) -ne 0) { Fail node-plan "装好的壳 --node-plan 退出码非零" }
foreach ($key in @('node=', 'node_probe_candidates=', 'latest_lts=', 'mirror_selected=')) {
    if ($plan -notmatch "(?m)^$([regex]::Escape($key))") { Fail node-plan "--node-plan 输出缺 ${key}（结论未产出）" }
}
$matrix = RunExe $exeB @('--platform-matrix')
Write-Host $matrix
if ((RunExit $matrix) -ne 0) { Fail matrix "装好的壳 --platform-matrix 退出码非零" }
if ($matrix -notmatch 'definition_path=') { Fail matrix '--platform-matrix 无 definition_path' }

$env:DSH_GUARD_BIN = $exeB
try {
    $sp = RunExe $exeB @('--service-plan', '--service-apply')
    Write-Host $sp
    if ((RunExit $sp) -ne 0) { Fail service "服务定义建立失败：$sp" }
    if ($sp -notmatch '(?m)^建立后现存\s+= 是') { Fail service 'schtasks /Create 后 /Query 回读为「否」' }
    if ($sp -notmatch '(?m)^建立结果.*-> "[^"]*\.exe" --run-guard') {
        Fail service '建立结果里没有带引号且以稳定入口结尾的定义行'
    }
    foreach ($line in ($sp -split "`n")) {
        if ($line -like '建立结果*' -and $line -match '\\\?\\') { Fail service '服务定义含 schtasks 不接受的 verbatim 前缀' }
    }
} finally {
    $ErrorActionPreference = 'Continue'
    foreach ($t in @($guardTask, $watchdogTask)) {
        & schtasks.exe /Delete /TN $t /F 2>&1 | Out-Null
    }
}

$ErrorActionPreference = 'Continue'
$un = Get-ChildItem -Path (Split-Path $exeB) -Filter '*uninstall*.exe' -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($un) {
    $up = Start-Process -FilePath $un.FullName -ArgumentList '/S' -PassThru
    if (-not $up.WaitForExit(180000)) { try { $up.Kill() } catch { } }
    Write-Host "已卸载：$($un.FullName)"
} else {
    Write-Host '::warning::没找到卸载器，跳过卸载（判定已在上面的步骤里收口）'
}
Write-Host "H10 通过：A=$VerA 装得上且落盘 -> B=$VerB 覆盖升级后自报版本 -> 装好的壳能建服务定义"
