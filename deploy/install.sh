#!/usr/bin/env sh
set -eu

AGT_ROOT="${1:-}"
if [ -z "$AGT_ROOT" ]; then
  echo "用法: ./deploy/install.sh /path/to/XRK-AGT"
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
PY_DEST="$AGT_ROOT/subserver/pyserver/apis/jmcomic"
PLUGIN_DEST="$AGT_ROOT/core/jm-Core/plugin"

mkdir -p "$PY_DEST" "$PLUGIN_DEST"

for file in __init__.py config_loader.py download_service.py default_config.yaml requirements.txt README.md; do
  src="$SCRIPT_DIR/$file"
  dest="$PY_DEST/$file"
  if [ "$(cd "$(dirname "$src")" && pwd -P)/$(basename "$src")" = "$(cd "$(dirname "$dest")" 2>/dev/null && pwd -P)/$(basename "$dest")" ]; then
    continue
  fi
  cp "$src" "$dest"
done

cp "$SCRIPT_DIR/plugin/车牌.js" "$PLUGIN_DEST/车牌.js"

echo "已部署 Python 扩展 -> $PY_DEST"
echo "已部署 QQ 插件     -> $PLUGIN_DEST/车牌.js"
echo ""
echo "下一步:"
echo "  cd $AGT_ROOT/subserver/pyserver"
echo "  uv pip install -r apis/jmcomic/requirements.txt"
echo "  # 重启子服务与主服务"
