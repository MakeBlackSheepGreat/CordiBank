#!/usr/bin/env python3
"""为 Page Spec 补 display.coverage 映射：把语义字段映射到承载它的页面元素。

内容契约要求 core_message、key_points、explanation、boundary、source_refs 全部在页面上有承载，
否则判为缺失文字。display.coverage 声明「哪个元素承载哪个论点」，
语义字段本身继续保留在规格里，供审阅与后端使用。

映射规则：按元素在页面上的实际文字与语义字段的关键词重合度选取承载者。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

SEMANTIC_FIELDS = ("core_message", "explanation", "boundary", "source_refs")
KEY_CHAR = set("的了和与及或在是有为对从到把被就都也不")


def tokens(text: str) -> set[str]:
    return {ch for ch in text if ch not in KEY_CHAR and not ch.isspace() and re.match(r"[一-鿿A-Za-z0-9]", ch)}


def score(field_text: str, element_text: str) -> float:
    a, b = tokens(field_text), tokens(element_text)
    if not a:
        return 0.0
    return len(a & b) / len(a)


def main() -> None:
    spec_path = Path(sys.argv[1])
    spec = json.loads(spec_path.read_text(encoding="utf-8"))

    for slide in spec["slides"]:
        elements = slide.get("elements", [])
        if not elements:
            continue
        coverage = []

        for field in SEMANTIC_FIELDS:
            value = slide.get(field)
            if not value:
                continue
            if isinstance(value, list):
                for index, item in enumerate(value):
                    best = max(elements, key=lambda e: score(str(item), str(e.get("text", ""))))
                    coverage.append(
                        {
                            "claim": f"{field}/{index}",
                            "element_ids": [best["id"]],
                        }
                    )
            else:
                best = max(elements, key=lambda e: score(str(value), str(e.get("text", ""))))
                coverage.append({"claim": field, "element_ids": [best["id"]]})

        for index in range(len(slide.get("key_points") or [])):
            point = str(slide["key_points"][index])
            best = max(elements, key=lambda e: score(point, str(e.get("text", ""))))
            coverage.append({"claim": f"key_points/{index}", "element_ids": [best["id"]]})

        seen = set()
        unique = []
        for item in coverage:
            key = (item["claim"], tuple(item["element_ids"]))
            if key in seen:
                continue
            seen.add(key)
            unique.append(item)
        slide["display"] = {"coverage": unique}

    spec_path.write_text(
        json.dumps(spec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    total = sum(len(s["display"]["coverage"]) for s in spec["slides"])
    print(f"已生成 {total} 条覆盖映射，分布于 {len(spec['slides'])} 页")


if __name__ == "__main__":
    main()
