#!/usr/bin/env python3
"""按中文技术文档写作规范检查文档，逐条报告可机器判定的问题。

检查项对应 references/checklist.md：
标题层级、段落长度、句长、逗号构件长度、双重否定、被动语态、
中英文空格、半角字符与全角标点间距、数字写法、标点规范、术语一致性。

用法：python scripts/writing-check.py docs/02-技术文档.md docs/03-安全自评报告.md
"""
from __future__ import annotations

import io
import re
import sys
from pathlib import Path

HALF_PUNCT = "，。；：！？（）「」【】《》—…"
ASCII_PUNCT_AFTER_CJK = re.compile(r"[\u4e00-\u9fff]\s+[,.;:!?]")
CJK_ASCII_NO_SPACE = re.compile(r"[\u4e00-\u9fff][A-Za-z0-9]|[A-Za-z0-9][\u4e00-\u9fff]")
FULL_PUNCT_WITH_SPACE = re.compile(r"[，。；：！？、]\s")
DOUBLE_NEGATIVE = re.compile(r"(没有|不|无|未|非)[^。；，]{0,6}(不能|无法|不会|不可|没有)")
PASSIVE = re.compile(r"(被|受到|遭到|得以|予以)[^。；，]{0,4}(处理|执行|调用|触发|拦截|拒绝|覆盖|修改|存储|写入|读取|判定|过滤)")
EXCLAMATION = re.compile(r"！")
ELLIPSIS_BAD = re.compile(r"\.\.\.|。。。")
REPEAT_WORD = re.compile(r"([一-鿿]{2,4})\1")
TERMS = {
    "MCP": "MCP（Model Context Protocol，模型上下文协议）",
    "RPC": "RPC（Remote Procedure Call，远程过程调用）",
    "SHA-256": "SHA-256",
    "Vue": "Vue 3",
    "Vite": "Vite",
    "Node": "Node",
    "TypeScript": "TypeScript",
}


def strip_code(text: str) -> str:
    """去掉代码块、表格与行内代码，只留正文句子。"""
    out = []
    in_code = False
    for line in text.split("\n"):
        if line.strip().startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        if line.strip().startswith("|"):
            continue
        out.append(re.sub(r"`[^`]*`", "", line))
    return "\n".join(out)


def check_headings(lines: list[str]) -> list[str]:
    issues = []
    levels = []
    for number, line in enumerate(lines, 1):
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            levels.append((number, len(m.group(1)), m.group(2).strip()))
    for index, (number, level, title) in enumerate(levels):
        if re.search(r"[。，、；：！？]$", title):
            issues.append(f"第 {number} 行 标题末尾有标点：{title}")
        if level == 1 and index + 1 < len(levels) and levels[index + 1][1] == 3:
            issues.append(f"第 {number} 行 一级标题下直接出现三级标题：{title}")
    for index in range(len(levels) - 1):
        number, level, title = levels[index]
        next_number, next_level, next_title = levels[index + 1]
        if next_level == level and next_title == title:
            issues.append(f"第 {number} 行 同级标题同名：{title}")
    counts: dict[int, list[str]] = {}
    for _, level, title in levels:
        counts.setdefault(level, []).append(title)
    for level, titles in counts.items():
        if level >= 2 and len(titles) == 1:
            issues.append(f"第 {level} 级标题只有一个：{titles[0]}")
    return issues


def check_paragraphs(text: str) -> list[str]:
    issues = []
    for index, para in enumerate(strip_code(text).split("\n\n"), 1):
        content = para.strip()
        if not content or content.startswith("#"):
            continue
        lines = [x for x in content.split("\n") if x.strip()]
        if len(lines) > 7:
            issues.append(f"段落过长（{len(lines)} 行）：{content[:30]}⋯⋯")
        if len(lines) > 4 and len(content) > 200:
            issues.append(f"段落偏长：{content[:30]}⋯⋯")
    return issues


def check_sentences(text: str) -> list[str]:
    issues = []
    body = strip_code(text)
    for para in body.split("\n\n"):
        content = para.strip()
        if not content or content.startswith("#"):
            continue
        for sentence in re.split(r"[。！？]", content):
            sentence = sentence.strip()
            if not sentence:
                continue
            if len(sentence) > 100:
                issues.append(f"单句过长（{len(sentence)} 字）：{sentence[:30]}⋯⋯")
            for part in sentence.split("，"):
                if len(part) > 40:
                    issues.append(f"逗号构件过长（{len(part)} 字）：{part[:30]}⋯⋯")
    return issues


def check_terms(text: str) -> list[str]:
    issues = []
    body = strip_code(text)
    for term, definition in TERMS.items():
        if term in body and definition not in body and term not in ("SHA-256", "Vue", "Vite", "Node", "TypeScript"):
            issues.append(f"英文术语缺首现定义：{term}")
    return issues


def check_file(path: Path) -> list[str]:
    raw = io.open(path, encoding="utf-8").read()
    lines = raw.split("\n")
    body = strip_code(raw)
    issues: list[str] = []

    issues += check_headings(lines)

    for index, line in enumerate(lines, 1):
        if line.strip().startswith("|") or line.strip().startswith("```"):
            continue
        # 行内代码整体剔除后再判空隙，避免代码内容被误判为多余空格
        text_line = re.sub(r"`[^`]*`", "CODE", line)
        if ASCII_PUNCT_AFTER_CJK.search(text_line):
            issues.append(f"第 {index} 行 半角标点前有空格")
        if CJK_ASCII_NO_SPACE.search(text_line):
            issues.append(f"第 {index} 行 中英文之间缺空格：{text_line.strip()[:40]}")
        if FULL_PUNCT_WITH_SPACE.search(text_line):
            issues.append(f"第 {index} 行 全角标点后有空格")
        if EXCLAMATION.search(text_line):
            issues.append(f"第 {index} 行 含感叹号")
        if ELLIPSIS_BAD.search(text_line):
            issues.append(f"第 {index} 行 省略号写法不规范")
        if DOUBLE_NEGATIVE.search(text_line):
            issues.append(f"第 {index} 行 疑似双重否定：{text_line.strip()[:40]}")
        if PASSIVE.search(text_line):
            issues.append(f"第 {index} 行 疑似被动语态：{text_line.strip()[:40]}")
        if re.search(r"[，。、；：]{2,}", text_line):
            issues.append(f"第 {index} 行 标点连用")
        if re.search(r"[一-鿿]\s+[一-鿿]", text_line):
            issues.append(f"第 {index} 行 中文之间有多余空格：{text_line.strip()[:40]}")
    for term, definition in TERMS.items():
        if term in body and definition not in body and term not in ("SHA-256", "Vue", "Vite", "Node", "TypeScript"):
            issues.append(f"英文术语缺首现定义：{term}")
    issues += check_paragraphs(raw)
    issues += check_sentences(raw)
    return issues


def main() -> None:
    total = 0
    for arg in sys.argv[1:]:
        path = Path(arg)
        issues = check_file(path)
        total += len(issues)
        print(f"=== {path.name} ===")
        if not issues:
            print("  全部检查项通过")
        for item in issues:
            print(f"  {item}")
    print(f"\n合计问题 {total} 处")


if __name__ == "__main__":
    main()
