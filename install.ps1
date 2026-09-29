$ErrorActionPreference = "Stop"
$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path

foreach ($Command in @("opencode", "node", "npm")) {
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    throw "缺少命令：$Command"
  }
}

# 选择、环境检查、复制、npm ci 与配置写入决策都在共享 Node 模块内完成。
& node (Join-Path $SourceDir "scripts/install-main.mjs") @args
exit $LASTEXITCODE
