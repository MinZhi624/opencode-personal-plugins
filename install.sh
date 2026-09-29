#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少命令：$1" >&2
    exit 1
  fi
}

require_command opencode
require_command node
require_command npm

# 选择、环境检查、复制、npm ci 与配置写入决策都在共享 Node 模块内完成。
exec node "$SOURCE_DIR/scripts/install-main.mjs" "$@"
