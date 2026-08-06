param(
  [switch]$ReplaceConfig
)

$ErrorActionPreference = "Stop"
$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigHome = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $HOME ".config" }
$ConfigRoot = Join-Path $ConfigHome "opencode"
$BundleDir = Join-Path $ConfigRoot "opencode-zh-bundle"
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

foreach ($Command in @("opencode", "node", "npm")) {
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    throw "缺少命令：$Command"
  }
}

& node -e @'
const [major, minor] = process.versions.node.split(".").map(Number)
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(`Node.js ${process.versions.node} 过旧；需要 22.6.0 或更高版本。`)
  process.exit(1)
}
'@
if ($LASTEXITCODE -ne 0) { throw "Node.js 版本检查失败。" }

$PythonCommand = $null
$PythonPrefix = @()
if ($env:OPENCODE_PYTHON) {
  $PythonCommand = $env:OPENCODE_PYTHON
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
  $PythonCommand = "py"
  $PythonPrefix = @("-3")
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
  $PythonCommand = "python"
} else {
  throw "找不到 Python。请安装 Python 3.10+，或设置 OPENCODE_PYTHON。"
}

& $PythonCommand @PythonPrefix -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
if ($LASTEXITCODE -ne 0) { throw "Python 版本过旧；需要 Python 3.10+。" }

$OpenCodeVersion = & opencode --version
$OpenCodeVersionCheck = @'
const raw = process.argv[1] ?? ""
const match = raw.match(/(\d+)\.(\d+)\.(\d+)/)
if (!match) process.exit(2)
const current = match.slice(1).map(Number)
const minimum = [1, 18, 12]
for (let i = 0; i < minimum.length; i++) {
  if (current[i] > minimum[i]) process.exit(0)
  if (current[i] < minimum[i]) process.exit(1)
}
'@
& node -e $OpenCodeVersionCheck $OpenCodeVersion
if ($LASTEXITCODE -eq 1) { throw "OpenCode $OpenCodeVersion 过旧；需要 1.18.12 或更高版本。" }
if ($LASTEXITCODE -ne 0) { throw "无法识别 OpenCode 版本：$OpenCodeVersion" }

Write-Host "OpenCode：$OpenCodeVersion"
Write-Host "Node.js：$(& node --version)"
Write-Host "Python：$(& $PythonCommand @PythonPrefix --version)"

New-Item -ItemType Directory -Force -Path $ConfigRoot | Out-Null

$SourceFull = [IO.Path]::GetFullPath($SourceDir).TrimEnd([IO.Path]::DirectorySeparatorChar)
$BundleFull = [IO.Path]::GetFullPath($BundleDir).TrimEnd([IO.Path]::DirectorySeparatorChar)
if ($SourceFull -ne $BundleFull) {
  if ($SourceFull.StartsWith($BundleFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "不能从目标 bundle 的子目录运行安装器：$SourceDir"
  }

  New-Item -ItemType Directory -Force -Path $BundleDir | Out-Null
  foreach ($Name in @("plugins", "scripts", "config", "docs")) {
    $Target = Join-Path $BundleDir $Name
    if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
    Copy-Item -Recurse -Force (Join-Path $SourceDir $Name) $Target
  }
  foreach ($Name in @("package.json", "package-lock.json", "README.md", "THIRD_PARTY_NOTICES.md")) {
    Copy-Item -Force (Join-Path $SourceDir $Name) (Join-Path $BundleDir $Name)
  }
}

Write-Host "安装运行依赖（单一 node_modules）……"
Push-Location $BundleDir
try {
  & npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci 失败。" }
} finally {
  Pop-Location
}

& node (Join-Path $BundleDir "scripts/verify.mjs")
if ($LASTEXITCODE -ne 0) { throw "Bundle 验证失败。" }

$script:NeedsMerge = $false
function Install-Config {
  param(
    [string]$Label,
    [string]$Template,
    [string]$Preferred,
    [string[]]$Candidates
  )

  $Existing = @($Candidates | Where-Object { Test-Path $_ })
  if ($Existing.Count -eq 0) {
    Copy-Item -Force $Template $Preferred
    Write-Host "已安装 $Label：$Preferred"
    return
  }

  if ($Existing.Count -eq 1) {
    $ExistingHash = (Get-FileHash -Algorithm SHA256 $Existing[0]).Hash
    $TemplateHash = (Get-FileHash -Algorithm SHA256 $Template).Hash
    if ($ExistingHash -eq $TemplateHash) {
      Write-Host "$Label 已是本包模板：$($Existing[0])"
      return
    }
  }

  if ($ReplaceConfig) {
    foreach ($Path in $Existing) {
      $Backup = "$Path.bak.$Timestamp"
      Move-Item -Force $Path $Backup
      Write-Host "已备份：$Backup"
    }
    Copy-Item -Force $Template $Preferred
    Write-Host "已替换 $Label：$Preferred"
    return
  }

  $script:NeedsMerge = $true
  Write-Host "保留已有 $Label：$($Existing -join ', ')"
}

Install-Config `
  -Label "OpenCode 配置" `
  -Template (Join-Path $BundleDir "config/opencode.jsonc") `
  -Preferred (Join-Path $ConfigRoot "opencode.jsonc") `
  -Candidates @((Join-Path $ConfigRoot "opencode.jsonc"), (Join-Path $ConfigRoot "opencode.json"))

Install-Config `
  -Label "TUI 配置" `
  -Template (Join-Path $BundleDir "config/tui.jsonc") `
  -Preferred (Join-Path $ConfigRoot "tui.jsonc") `
  -Candidates @((Join-Path $ConfigRoot "tui.jsonc"), (Join-Path $ConfigRoot "tui.json"))

Write-Host ""
Write-Host "Bundle 已安装到：$BundleDir"
if ($script:NeedsMerge) {
  Write-Host "检测到已有配置，尚未自动修改。请阅读：$BundleDir/docs/MERGE_EXISTING_CONFIG.md"
} else {
  Write-Host "配置已就绪。"
}
Write-Host "请彻底退出并重新启动 OpenCode；配置和插件不会热重载。"
