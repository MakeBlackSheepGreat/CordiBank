#!/usr/bin/env python3
"""答辩材料内容密度审计：按竞赛叙事规范检查每页支撑要点是否充足。

规则来源：SlideMuse 技能的 references/content-outline.md 与 content-density.md。
普通内容页默认 3 至 5 条有区别的支撑要点，封面与过渡页按作用豁免。
本脚本只做结构计数，不判断论证是否成立。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROLES = {
    "cover": "封面",
    "agenda": "目录",
    "section-divider": "过渡",
    "concept": "概念解释",
    "process": "流程",
    "comparison": "对比",
    "timeline": "时间线",
    "data-evidence": "数据证据",
    "architecture": "架构",
    "case-study": "案例",
    "summary": "小结",
    "qa": "问答",
}
BRIEF_ROLES = {"cover", "agenda", "section-divider", "summary", "qa"}
STANDARD_RANGE = (3, 5)
MODES = {
    "standard": (3, 5),
    "evidence-led": (1, 5),
    "brief": (1, 2),
    "detailed": (3, 8),
}
CHECKABLE = {"concept", "process", "comparison", "data-evidence", "architecture", "case-study"}

DECK = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("deck-spec.json")
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("density-audit.json")

data = json.loads(DECK.read_text(encoding="utf-8"))
slides = data.get("slides", data if isinstance(data, list) else [])

report = {
    "deck": str(DECK),
    "slide_count": len(slides),
    "slides": [],
    "summary": {},
}

thin = []
for slide in slides:
    role = slide.get("role", "")
    points = slide.get("key_points") or []
    title = slide.get("title", "")
    entry = {
        "id": slide.get("id", ""),
        "page": slide.get("page", slide.get("index", "")),
        "title": title,
        "role": role,
        "role_label": ROLES.get(role, "未声明"),
        "key_point_count": len(points),
        "has_source": bool(slide.get("source_refs")),
        "has_explanation": bool(slide.get("explanation")),
        "has_boundary": bool(slide.get("boundary")),
    }
    if role in BRIEF_ROLES:
        entry["verdict"] = "豁免"
        entry["note"] = "按页面作用处理，不设要点配额"
    elif role not in CHECKABLE:
        entry["verdict"] = "未声明角色"
        entry["note"] = "内容页须声明角色，未声明时无法按型检查"
    else:
        density = slide.get("density") or {}
        mode = density.get("mode", "standard")
        reason = str(density.get("reason", "")).strip()
        low, high = MODES.get(mode, STANDARD_RANGE)
        entry["density_mode"] = mode
        entry["density_reason"] = reason
        if mode != "standard" and not reason:
            entry["verdict"] = "密度例外缺理由"
            entry["note"] = "非标准密度必须写明与该页内容相关的理由"
        elif len(points) < low:
            entry["verdict"] = "偏薄"
            entry["note"] = f"支撑要点 {len(points)} 条，低于 {mode} 模式下限 {low} 条"
            thin.append(entry)
        elif len(points) > high:
            entry["verdict"] = "偏密"
            entry["note"] = f"支撑要点 {len(points)} 条，高于 {mode} 模式上限 {high} 条"
        else:
            entry["verdict"] = "合格"
            entry["note"] = ""
    report["slides"].append(entry)

verdicts: dict[str, int] = {}
for entry in report["slides"]:
    verdicts[entry["verdict"]] = verdicts.get(entry["verdict"], 0) + 1
report["summary"] = {
    "verdicts": verdicts,
    "thin_pages": [
        {"page": e["page"], "title": e["title"], "role_label": e["role_label"], "count": e["key_point_count"]}
        for e in thin
    ],
    "missing_source": [
        {"page": e["page"], "title": e["title"]}
        for e in report["slides"]
        if e["role"] in CHECKABLE and not e["has_source"]
    ],
    "missing_explanation": [
        {"page": e["page"], "title": e["title"]}
        for e in report["slides"]
        if e["role"] in CHECKABLE and not e["has_explanation"]
    ],
}

OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

print(f"共 {report['slide_count']} 页")
for key, value in sorted(verdicts.items()):
    print(f"  {key}: {value} 页")
if thin:
    print("偏薄页：")
    for item in report["summary"]["thin_pages"]:
        print(f"  第 {item['page']} 页 {item['title']}（{item['role_label']}，{item['count']} 条）")
print(f"报告：{OUT}")
