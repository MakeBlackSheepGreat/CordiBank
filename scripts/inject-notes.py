#!/usr/bin/env python3
"""把讲稿写入 PPTX 的演讲备注页。

数据来源为 Page Spec 的 speaker_notes 字段，逐页按 id 对应页序。
用途：10 分钟答辩时每页都有可读的口播稿，且备注与内容规格保持同一份来源。

实现方式：直接构造 notesSlide 部件并挂到各页的 rels 上。
原因：目标 PPTX 由 slidep 生成，notesMaster 存在但没有 body 占位符，
python-pptx 的 notes_text_frame 取不到，需自行补齐标准 XML。
"""
from __future__ import annotations

import json
import posixpath
import re
import shutil
import sys
import zipfile
from pathlib import Path

NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"
CONTENT_TYPE_NOTES = (
    "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"
)


def escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def notes_slide_xml(notes: str) -> str:
    paragraphs = "".join(
        '<a:p><a:r><a:rPr lang="zh-CN" altLang="en-US" dirty="0"/>'
        f"<a:t>{escape(line)}</a:t></a:r></a:p>"
        for line in (notes.splitlines() or [""])
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f'<p:notes xmlns:p="{NS_P}" xmlns:a="{NS_A}" xmlns:r="{NS_R}">'
        "<p:cSld><p:spTree>"
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
        '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        "<p:sp>"
        '<p:nvSpPr><p:cNvPr id="2" name="备注占位符 1"/><p:cNvSpPr><a:spLocks noGrp="1"/>'
        "</p:cNvSpPr><p:nvPr><p:ph type=\"body\" idx=\"1\"/></p:nvPr></p:nvSpPr>"
        "<p:spPr/>"
        "<p:txBody><a:bodyPr/><a:lstStyle/>"
        f"{paragraphs}"
        "</p:txBody></p:sp>"
        "</p:spTree></p:cSld>"
        "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>"
        "</p:notes>"
    )


def main() -> None:
    spec_path = Path(sys.argv[1])
    pptx_path = Path(sys.argv[2])

    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    notes_list = [str(s.get("speaker_notes", "")).strip() for s in spec["slides"]]

    with zipfile.ZipFile(pptx_path) as zf:
        names = zf.namelist()
        items = {name: zf.read(name) for name in names}

    slide_names = sorted(
        (n for n in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
        key=lambda n: int(re.search(r"(\d+)", posixpath.basename(n)).group(1)),
    )
    if len(slide_names) != len(notes_list):
        raise SystemExit(f"页数不匹配：PPTX {len(slide_names)} 页，规格 {len(notes_list)} 页")

    content_types = items["[Content_Types].xml"].decode("utf-8")
    overrides = [
        f'<Override PartName="/ppt/notesSlides/notesSlide{n}.xml" '
        f'ContentType="{CONTENT_TYPE_NOTES}"/>'
        for n in range(1, len(slide_names) + 1)
    ]
    if "notesSlide+xml" not in content_types:
        content_types = content_types.replace("</Types>", "".join(overrides) + "</Types>")
        items["[Content_Types].xml"] = content_types.encode("utf-8")

    for index, (slide_name, notes) in enumerate(zip(slide_names, notes_list), start=1):
        if not notes:
            continue
        number = int(re.search(r"(\d+)", posixpath.basename(slide_name)).group(1))
        notes_name = f"ppt/notesSlides/notesSlide{number}.xml"
        items[notes_name] = notes_slide_xml(notes).encode("utf-8")

        rels_name = f"ppt/slides/_rels/slide{number}.xml.rels"
        if rels_name in items:
            rels = items[rels_name].decode("utf-8")
        else:
            rels = (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                "</Relationships>"
            )
        if REL_TYPE not in rels:
            used = re.findall(r'Id="rId(\d+)"', rels)
            next_id = max((int(x) for x in used), default=0) + 1
            rels = rels.replace(
                "</Relationships>",
                f'<Relationship Id="rId{next_id}" Type="{REL_TYPE}" '
                f'Target="../notesSlides/notesSlide{number}.xml"/></Relationships>',
            )
        items[rels_name] = rels.encode("utf-8")

        slide_xml = items[slide_name].decode("utf-8")
        if "<p:notes" not in slide_xml:
            slide_xml = slide_xml.replace("</p:sld>", '<p:extLst/></p:sld>')
        items[slide_name] = slide_xml.encode("utf-8")

    tmp = pptx_path.with_suffix(".tmp.pptx")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
        for name, data in items.items():
            out.writestr(name, data)
    shutil.move(str(tmp), str(pptx_path))
    print(f"已写入 {sum(1 for n in notes_list if n)} 页讲稿，共 {len(notes_list)} 页")


if __name__ == "__main__":
    main()
