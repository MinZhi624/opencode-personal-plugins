#!/usr/bin/env bash
set -euo pipefail

REPLACE_CONFIG=0
for arg in "$@"; do
  case "$arg" in
    --replace-config) REPLACE_CONFIG=1 ;;
    -h|--help)
      cat <<'EOF'
用法：bash install.sh [--replace-config]

默认：安装/更新 bundle；若已有 OpenCode 配置则保留并提示手工合并。
--replace-config：备份已有 opencode/tui 配置后安装本包模板。
EOF
      exit 0
      ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_ROOT="$CONFIG_HOME/opencode"
BUNDLE_DIR="$CONFIG_ROOT/opencode-zh-bundle"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少命令：$1" >&2
    exit 1
  fi
}

require_command opencode
require_command node
require_command npm

node -e '
const [major, minor] = process.versions.node.split(".").map(Number)
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(`Node.js ${process.versions.node} 过旧；需要 22.6.0 或更高版本。`)
  process.exit(1)
}
'

PYTHON_BIN="${OPENCODE_PYTHON:-python3}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "找不到 Python：$PYTHON_BIN" >&2
  echo "请安装 Python 3.10+，或把 OPENCODE_PYTHON 设为 Python 可执行文件路径。" >&2
  exit 1
fi
"$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' || {
  echo "Python 版本过旧；gpt-reset-credits 需要 Python 3.10+。" >&2
  exit 1
}

OPENCODE_VERSION="$(opencode --version 2>/dev/null || true)"
node - "$OPENCODE_VERSION" <<'NODE'
const raw = process.argv[2] ?? ""
const match = raw.match(/(\d+)\.(\d+)\.(\d+)/)
if (!match) {
  console.error(`无法识别 OpenCode 版本：${raw || "空"}`)
  process.exit(1)
}
const current = match.slice(1).map(Number)
const minimum = [1, 18, 12]
for (let i = 0; i < minimum.length; i++) {
  if (current[i] > minimum[i]) process.exit(0)
  if (current[i] < minimum[i]) {
    console.error(`OpenCode ${current.join(".")} 过旧；需要 1.18.12 或更高版本。`)
    process.exit(1)
  }
}
NODE
echo "OpenCode：${OPENCODE_VERSION:-未知版本}"
echo "Node.js：$(node --version)"
echo "Python：$("$PYTHON_BIN" --version 2>&1)"

mkdir -p "$CONFIG_ROOT"

if [ "$SOURCE_DIR" != "$BUNDLE_DIR" ]; then
  case "$SOURCE_DIR/" in
    "$BUNDLE_DIR/"*)
      echo "不能从目标 bundle 的子目录运行安装器：$SOURCE_DIR" >&2
      exit 1
      ;;
  esac

  node "$SOURCE_DIR/scripts/stage-runtime.mjs"
  RUNTIME_DIR="$SOURCE_DIR/runtime-stage"
  mkdir -p "$BUNDLE_DIR"
  rm -rf \
    "$BUNDLE_DIR/plugins" \
    "$BUNDLE_DIR/scripts" \
    "$BUNDLE_DIR/config" \
    "$BUNDLE_DIR/docs"
  cp -R "$RUNTIME_DIR/." "$BUNDLE_DIR"
fi

echo "安装运行依赖（单一 node_modules）……"
(cd "$BUNDLE_DIR" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
node "$BUNDLE_DIR/scripts/verify.mjs"

NEEDS_MERGE=0
install_config() {
  local label="$1"
  local template="$2"
  local preferred="$3"
  shift 3
  local existing=()
  local candidate

  for candidate in "$@"; do
    [ -e "$candidate" ] && existing+=("$candidate")
  done

  if [ "${#existing[@]}" -eq 0 ]; then
    cp "$template" "$preferred"
    echo "已安装 $label：$preferred"
    return
  fi

  if [ "${#existing[@]}" -eq 1 ] && cmp -s "${existing[0]}" "$template"; then
    echo "$label 已是本包模板：${existing[0]}"
    return
  fi

  if [ "$REPLACE_CONFIG" -eq 1 ]; then
    for candidate in "${existing[@]}"; do
      mv "$candidate" "$candidate.bak.$TIMESTAMP"
      echo "已备份：$candidate.bak.$TIMESTAMP"
    done
    cp "$template" "$preferred"
    echo "已替换 $label：$preferred"
    return
  fi

  NEEDS_MERGE=1
  echo "保留已有 $label：${existing[*]}"
}

install_config \
  "OpenCode 配置" \
  "$BUNDLE_DIR/config/opencode.jsonc" \
  "$CONFIG_ROOT/opencode.jsonc" \
  "$CONFIG_ROOT/opencode.jsonc" \
  "$CONFIG_ROOT/opencode.json"

install_config \
  "TUI 配置" \
  "$BUNDLE_DIR/config/tui.jsonc" \
  "$CONFIG_ROOT/tui.jsonc" \
  "$CONFIG_ROOT/tui.jsonc" \
  "$CONFIG_ROOT/tui.json"

echo
echo "Bundle 已安装到：$BUNDLE_DIR"
if [ "$NEEDS_MERGE" -eq 1 ]; then
  echo "检测到已有配置，尚未自动修改。请按以下文档合并插件条目："
  echo "  $BUNDLE_DIR/docs/MERGE_EXISTING_CONFIG.md"
else
  echo "配置已就绪。"
fi
echo "请彻底退出并重新启动 OpenCode；配置和插件不会热重载。"
