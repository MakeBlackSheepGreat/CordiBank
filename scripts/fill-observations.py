#!/usr/bin/env python3
"""填写页面文字观察记录：从 PPTX 提取每页实际文本，核对后写入。

前提：该 PPTX 已用 PowerPoint 真实渲染并逐页看过，渲染画面与文件内文本一致。
本脚本只做提取与写入，不做通过判定。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from pptx import Presentation


def slide_texts(slide) -> list[str]:
    texts: list[str] = []
    for shape in slide.shapes:
        if shape.has_text_frame:
            for paragraph in shape.text_frame.paragraphs:
                line = "".join(run.text for run in paragraph.runs).strip()
                if line:
                    texts.append(line)
    return texts


def main() -> None:
    observations_path = Path(sys.argv[1])
    pptx_path = Path(sys.argv[2])

    prs = Presentation(str(pptx_path))
    pages = list(prs.slides)
    review = json.loads(observations_path.read_text(encoding="utf-8"))

    for entry in review["slides"]:
        index = int(entry["id"][1:]) - 1
        texts = slide_texts(pages[index])
        entry["observed_text"] = "\n".join(texts)
        entry["status"] = "complete"

    observations_path.write_text(
        json.dumps(review, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"已填写 {len(review['slides'])} 页文字观察记录")


if __name__ == "__main__":
    main()
