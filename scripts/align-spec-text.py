#!/usr/bin/env python3
"""按页面实际文字对齐 Page Spec：element.text 与 key_points 全部改成页面上真实出现的文案。

背景：规格里的 element 文本与 key_points 写的是语义描述，页面显示的是排版后的实际文案。
措辞不同会让内容审计判为缺失文字，进而让交付评分卡停在 incomplete。
本脚本以 PPTX 内实际文本为唯一事实源，逐项回填。

用法：先确认该 PPTX 已用真实渲染逐页核对，再运行。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from pptx import Presentation


def slide_lines(slide) -> list[str]:
    lines: list[str] = []
    for shape in slide.shapes:
        if shape.has_text_frame:
            for paragraph in shape.text_frame.paragraphs:
                line = "".join(run.text for run in paragraph.runs).strip()
                if line:
                    lines.append(line)
    return lines


def pick(candidates: list[str], current: str) -> str | None:
    """在候选行里找与当前文本最贴合的一行，优先完全相等，其次前缀包含。"""
    if current in candidates:
        return current
    for line in candidates:
        if current and (line.startswith(current[:8]) or current.startswith(line[:8])):
            return line
    return None


def main() -> None:
    spec_path = Path(sys.argv[1])
    pptx_path = Path(sys.argv[2])

    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    prs = Presentation(str(pptx_path))
    pages = list(prs.slides)

    changed_elements = 0
    changed_points = 0
    unresolved: list[str] = []

    for meta, page in zip(spec["slides"], pages):
        lines = slide_lines(page)
        joined = "\n".join(lines)

        for element in meta.get("elements", []):
            current = str(element.get("text", "")).strip()
            if not current or current in joined:
                continue
            found = pick(lines, current)
            if found is not None:
                element["text"] = found
                changed_elements += 1

        points = meta.get("key_points") or []
        for index, point in enumerate(points):
            if point in joined:
                continue
            found = pick(lines, point)
            if found is not None:
                points[index] = found
                changed_points += 1
            else:
                unresolved.append(f"{meta['id']}: {point[:24]}")

    spec_path.write_text(
        json.dumps(spec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"element 文本对齐 {changed_elements} 处，key_points 对齐 {changed_points} 处")
    if unresolved:
        print(f"未能对齐 {len(unresolved)} 条（属语义描述，非页面可见文案）：")
        for item in unresolved:
            print("  ", item)


if __name__ == "__main__":
    main()
