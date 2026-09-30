# 安装冒烟 H10（Windows）：只执行**装进系统里的那份 exe**，不碰构建树。
# 用法: install-smoke-win.ps1 -InstallerA <exe> -VerA <v> -InstallerB <exe> -VerB <v> -Work <dir>
# A = 上一已发布版本，B = 本次构建产物；先静默装 A 再覆盖装 B，即用户的升级路径。
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

# PS 7.3 起，native 命令的 stderr 在 ErrorActionPreference=Stop 下会变成终止性异常，
# 于是「探针正常产出的警告行」能把这一步判红。
# 为什么必须自己起进程而不用调用运算符：壳是 GUI 子系统的可执行文件，`& exe` 不等待它、
# 也不接它的 stdout —— 探针行直接落进虚空，$LASTEXITCODE 还是空，判据读不到任何东西。
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

# 安装包里的二进制路径不靠猜：先读卸载键的 InstallLocation，拿不到再按产品名搜。
function Find-InstalledExe {
    $dirs = @()
    $keys = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
              'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
              'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\dsh-supervisor*')
    foreach ($k in $keys) {
        foreach ($it in @(Get-ItemProperty -Path $k -ErrorAction SilentlyContinue)) {
            if ($null -eq $it) { continue }
            $hay = ('{0} {1} {2} {3}' -f $it.DisplayName, $it.DisplayIcon, $it.UninstallString, $it.InstallLocation)
            if ($hay -notmatch 'dsh-supervisor') { continue }
            if ($it.InstallLocation) { $dirs += $it.InstallLocation }
            # 卸载器所在目录就是安装目录（NSIS 把 uninstall.exe 放在同处）。
            if ($it.UninstallString -match '"([^"]+)"') { $dirs += (Split-Path $Matches[1]) }
        }
    }
    $dirs += @("$env:LOCALAPPDATA\dsh-supervisor", "$env:LOCALAPPDATA\Programs\dsh-supervisor",
               "$env:ProgramFiles\dsh-supervisor", "${env:ProgramFiles(x86)}\dsh-supervisor")
    foreach ($d in ($dirs | Select-Object -Unique)) {
        if (-not (Test-Path $d)) { continue }
        $exe = Get-ChildItem -Path $d -Filter '*.exe' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like 'dsh-supervisor*' -and $_.Name -notmatch 'uninstall' } |
            Select-Object -First 1
        if ($exe) { return $exe.FullName }
    }
    $null
}

# NSIS 装完可能已把自己复制到临时目录继续跑，退出码 0 不等于文件落盘；按秒轮询。
function Resolve-InstalledExe([string]$tag) {
    for ($i = 0; $i -lt 30; $i++) {
        $exe = Find-InstalledExe
        if ($exe) { Write-Host "[$tag] 已装二进制 = $exe"; return $exe }
        Start-Sleep -Seconds 2
    }
    $cand = @(Get-ChildItem -Path $env:LOCALAPPDATA -Filter 'dsh-supervisor*.exe' -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch 'uninstall' } | Select-Object -First 5)
    Write-Host "[$tag] 卸载键与固定目录都没命中；LOCALAPPDATA 递归搜到 $($cand.Count) 个候选："
    $cand | ForEach-Object { Write-Host "  候选 $($_.FullName)" }
    Fail install "$tag 装完后找不到已安装的壳可执行文件（见上方候选）"
}

function SilentInstall([string]$pkg, [string]$tag) {
    if (-not (Test-Path $pkg)) { Fail input "$tag 安装包不存在: $pkg" }
    # GUI 子系统的安装程序用调用运算符不会等待；WaitForExit(ms) 保证 UAC 卡住时是有界失败。
    $p = Start-Process -FilePath $pkg -ArgumentList '/S' -PassThru
    if (-not $p.WaitForExit(600000)) {
        try { $p.Kill(); $p.WaitForExit() } catch { }
        Fail install "$tag 的静默安装 10 分钟未退出（可能在等提权授权）"
    }
    if ($p.ExitCode -ne 0) { Fail install "$tag 的 NSIS 静默安装退出码 $($p.ExitCode)" }
}

# 三项独立事实：二进制自报版本、状态根被尊重、落盘链路里 exe 记的就是装进去的那份。
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

SilentInstall $InstallerA 'A'
$exeA = Resolve-InstalledExe 'A'
ProbeInstalled $exeA $VerA 'A'
$hashA = HashOf $exeA

SilentInstall $InstallerB 'B'
$exeB = Resolve-InstalledExe 'B'
ProbeInstalled $exeB $VerB 'B'
$hashB = HashOf $exeB
# 版本串一致而字节未变 = 覆盖安装没换掉文件。同版本构建可逐字节相同，故只在版本不同时判。
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

# 装到系统盘的路径才是真机路径（可能含空格），服务定义的引号与 verbatim 前缀只在装机形态下有意义。
# 计划任务是机器级状态，隔离不到工作目录，故建完即删（失败不翻判定：判定已在上）。
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
    foreach ($t in @('DSH-Supervisor', 'DSH-Supervisor-Watchdog')) {
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
