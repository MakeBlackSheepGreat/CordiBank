#!/usr/bin/env bash
# 答辩材料渲染核对：把 PPTX 逐页渲染成 PNG，生成缩略总览图与渲染报告。
# 用途：提交前用真实 Office 渲染复核每页画面，不依赖编辑器预览。
# 依赖：SlideMuse 技能的隔离环境（渲染器发现 PowerPoint 或 LibreOffice）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL="${SLIDEMUSE_SKILL:-$HOME/.workbuddy/skills/slidemuse}"
PY="$SKILL/.venv/Scripts/python.exe"
[ -x "$PY" ] || PY="$SKILL/.venv/bin/python"

DECK="${1:-$ROOT/deliverables/面向金融的蜂群多智能体系统-答辩材料.pptx}"
OUT="${2:-$ROOT/.work/render-review}"

if [ ! -f "$DECK" ]; then
  echo "找不到 PPTX：$DECK" >&2
  exit 1
fi
if [ ! -x "$PY" ]; then
  echo "找不到 SlideMuse 隔离环境：$PY" >&2
  exit 1
fi

mkdir -p "$OUT"
"$PY" "$SKILL/scripts/render_deck.py" "$DECK" "$OUT" --backend auto --overwrite
echo "渲染完成：$OUT"
echo "逐页 PNG：$OUT/001.png 起"
echo "总览图：$OUT/review.png"
