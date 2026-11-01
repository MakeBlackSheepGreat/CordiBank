#!/usr/bin/env python3
"""按「深蓝科技风」模板的视觉语言重建答辩 PPT。

用法：python scripts/build-deck.py [输出路径]
底图来自模板 assets/bg-city.png，全部页面为原生可编辑形状与文本。
"""
from __future__ import annotations

import os
import sys

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt

ROOT = os.path.abspath(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ASSETS = os.path.join(ROOT, "ppt", "面向金融的蜂群智能体系统-答辩材料", "assets")
BG = os.path.join(ASSETS, "bg-city.png")
DEFAULT_OUT = os.path.join(ROOT, "deliverables", "面向金融的蜂群智能体系统-答辩材料.pptx")

W, H = 12192000, 6858000

TITLE_FONT = "思源黑体 CN Heavy"
BOLD_FONT = "思源黑体 CN Bold"
BODY_FONT = "思源黑体 CN Medium"
MONO_FONT = "Consolas"

WHITE = RGBColor(0xFF, 0xFF, 0xFF)
BODY = RGBColor(0xD8, 0xE8, 0xF7)
MUTED = RGBColor(0x9C, 0xC0, 0xDE)
CYAN = RGBColor(0x2F, 0xD4, 0xF0)
CYAN_DIM = RGBColor(0x1F, 0x9F, 0xC0)
ORANGE = RGBColor(0xFF, 0xC0, 0x00)
GREEN = RGBColor(0x3D, 0xDC, 0x97)
AMBER = RGBColor(0xFF, 0xB2, 0x3F)
RED = RGBColor(0xFF, 0x6B, 0x6B)
CARD_FILL = "0A2B57"
DEEP = "071E3E"

TOTAL_PAGES = 13


def _set_ea(run, name: str) -> None:
    rpr = run._r.get_or_add_rPr()
    ea = rpr.find(qn("a:ea"))
    if ea is None:
        from pptx.oxml import parse_xml
        from pptx.oxml.ns import nsdecls

        ea = parse_xml("<a:ea %s/>" % nsdecls("a"))
        rpr.append(ea)
    ea.set("typeface", name)


def _fill_xml(shape, color_hex: str, alpha: int) -> None:
    from pptx.oxml import parse_xml
    from pptx.oxml.ns import nsdecls

    sp_pr = shape._element.spPr
    for tag in ("a:noFill", "a:solidFill", "a:gradFill", "a:blipFill", "a:pattFill", "a:grpFill"):
        for el in sp_pr.findall(qn(tag)):
            sp_pr.remove(el)
    xml = (
        "<a:solidFill %s><a:srgbClr val=\"%s\"><a:alpha val=\"%d\"/></a:srgbClr></a:solidFill>"
        % (nsdecls("a"), color_hex, alpha * 1000)
    )
    fill = parse_xml(xml)
    ln = sp_pr.find(qn("a:ln"))
    if ln is not None:
        ln.addprevious(fill)
    else:
        sp_pr.append(fill)


def _line_xml(shape, color_hex: str | None, alpha: int, width_pt: float) -> None:
    from pptx.oxml import parse_xml
    from pptx.oxml.ns import nsdecls

    sp_pr = shape._element.spPr
    for el in sp_pr.findall(qn("a:ln")):
        sp_pr.remove(el)
    if color_hex is None:
        sp_pr.append(parse_xml("<a:ln %s><a:noFill/></a:ln>" % nsdecls("a")))
        return
    xml = (
        "<a:ln %s w=\"%d\"><a:solidFill><a:srgbClr val=\"%s\"><a:alpha val=\"%d\"/></a:srgbClr>"
        "</a:solidFill></a:ln>" % (nsdecls("a"), int(width_pt * 12700), color_hex, alpha * 1000)
    )
    sp_pr.append(parse_xml(xml))


def card(slide, x, y, w, h, fill=CARD_FILL, fill_alpha=58, line=CYAN, line_alpha=45, width=1.0, radius=0.06):
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Emu(int(x)), Emu(int(y)), Emu(int(w)), Emu(int(h)))
    try:
        shape.adjustments[0] = radius
    except Exception:
        pass
    _fill_xml(shape, fill, fill_alpha)
    _line_xml(shape, line, line_alpha, width)
    shape.shadow.inherit = False
    shape.text_frame.word_wrap = True
    return shape


def rect(slide, x, y, w, h, fill, alpha=100, line=None, line_alpha=60, width=1.0):
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Emu(int(x)), Emu(int(y)), Emu(int(w)), Emu(int(h)))
    _fill_xml(shape, fill, alpha)
    _line_xml(shape, line, line_alpha, width)
    shape.shadow.inherit = False
    return shape


def tx(slide, x, y, w, h, lines, anchor=MSO_ANCHOR.TOP, align=PP_ALIGN.LEFT, wrap=True, margins=(0, 0, 0, 0)):
    box = slide.shapes.add_textbox(Emu(int(x)), Emu(int(y)), Emu(int(w)), Emu(int(h)))
    tf = box.text_frame
    tf.word_wrap = wrap
    tf.vertical_anchor = anchor
    tf.margin_left, tf.margin_right, tf.margin_top, tf.margin_bottom = (Emu(int(v)) for v in margins)
    first = True
    for spec in lines:
        p = tf.paragraphs[0] if first else tf.add_paragraph()
        first = False
        p.alignment = spec.get("a", align)
        if spec.get("ls"):
            p.line_spacing = spec["ls"]
        if spec.get("sa") is not None:
            p.space_after = Pt(spec["sa"])
        if spec.get("sb") is not None:
            p.space_before = Pt(spec["sb"])
        run = p.add_run()
        run.text = spec["t"]
        font = run.font
        font.size = Pt(spec.get("s", 12))
        font.bold = spec.get("b", False)
        font.color.rgb = spec.get("c", BODY)
        name = spec.get("f", BODY_FONT)
        font.name = name
        _set_ea(run, name)
    return box


def bg(slide, darken=32):
    slide.shapes.add_picture(BG, 0, 0, width=Emu(W), height=Emu(H))
    if darken:
        rect(slide, 0, 0, W, H, DEEP, darken, line=None)


def header(slide, eyebrow, title, page, title_size=28):
    rect(slide, 0, 0, Inches(13.333), Inches(1.42), DEEP, 45, line=None)
    tx(slide, Inches(0.62), Inches(0.38), Inches(9.5), Inches(0.3),
       [{"t": eyebrow, "s": 11.5, "b": True, "c": CYAN, "f": BOLD_FONT}])
    tx(slide, Inches(0.62), Inches(0.66), Inches(11.2), Inches(0.62),
       [{"t": title, "s": title_size, "b": True, "c": WHITE, "f": TITLE_FONT}])
    rect(slide, Inches(0.62), Inches(1.30), Inches(0.72), Inches(0.045), CYAN, 100, line=None)
    tx(slide, Inches(11.05), Inches(0.40), Inches(1.68), Inches(0.3),
       [{"t": "CordiBank · 蜂群银行助手", "s": 9.5, "c": MUTED, "f": BODY_FONT, "a": PP_ALIGN.RIGHT}])
    tx(slide, Inches(11.05), Inches(7.04), Inches(1.68), Inches(0.28),
       [{"t": "%02d / %d" % (page, TOTAL_PAGES), "s": 9, "c": MUTED, "f": BODY_FONT, "a": PP_ALIGN.RIGHT}])


def banner(slide, text, y=Inches(6.34), h=Inches(0.62), size=15, accent=CYAN):
    card(slide, Inches(0.62), y, Inches(12.09), h, fill="0E3A73", fill_alpha=88, line=CYAN, line_alpha=35, radius=0.12)
    rect(slide, Inches(0.62), y, Inches(0.07), h, accent, 100, line=None)
    tx(slide, Inches(0.95), y, Inches(11.5), h,
       [{"t": text, "s": size, "b": True, "c": WHITE, "f": BOLD_FONT, "a": PP_ALIGN.CENTER}],
       anchor=MSO_ANCHOR.MIDDLE)


def number_badge(slide, x, y, size, text, color=CYAN, font=TITLE_FONT, text_size=30):
    tx(slide, x, y, size, size, [{"t": text, "s": text_size, "b": True, "c": color, "f": font}])


def build(out_path: str) -> str:
    prs = Presentation()
    prs.slide_width = Emu(W)
    prs.slide_height = Emu(H)
    blank = prs.slide_layouts[6]

    def new_slide():
        return prs.slides.add_slide(blank)

    # ---------- 01 封面 ----------
    s = new_slide()
    bg(s, darken=45)
    rect(s, Inches(0.62), Inches(0.72), Inches(0.55), Inches(0.055), CYAN, 100, line=None)
    tx(s, Inches(1.35), Inches(0.60), Inches(9.0), Inches(0.3),
       [{"t": "2026 FINTECHATHON · 人工智能赛道", "s": 13, "b": True, "c": CYAN, "f": BOLD_FONT}])
    tx(s, Inches(0.62), Inches(1.55), Inches(11.6), Inches(1.0),
       [{"t": "面向金融的蜂群智能体系统", "s": 50, "b": True, "c": WHITE, "f": TITLE_FONT}])
    tx(s, Inches(0.66), Inches(2.62), Inches(10.6), Inches(0.55),
       [{"t": "七个角色分工完成一次银行事务，从听懂到办完全程可追溯", "s": 19, "c": RGBColor(0xBF, 0xE3, 0xF5), "f": BODY_FONT}])
    rect(s, Inches(0.66), Inches(3.32), Inches(1.15), Inches(0.05), CYAN, 100, line=None)

    roles = [
        ("意图官", "听懂诉求，抽出工具与槽位"),
        ("风控官", "四维叠加判风险等级"),
        ("合规官", "查收款人来源与白名单"),
        ("体验官", "指出缺什么并给替代路径"),
        ("仲裁官", "取最高风险并合并理由"),
    ]
    cw, gap = Inches(2.30), Inches(0.14)
    x0, y0 = Inches(0.66), Inches(3.62)
    for i, (name, desc) in enumerate(roles):
        x = x0 + i * (cw + gap)
        card(s, x, y0, cw, Inches(1.12), fill="0B2F5E", fill_alpha=62, line=CYAN, line_alpha=40, radius=0.10)
        tx(s, x + Inches(0.16), y0 + Inches(0.14), cw - Inches(0.3), Inches(0.3),
           [{"t": name, "s": 15, "b": True, "c": CYAN, "f": BOLD_FONT}])
        tx(s, x + Inches(0.16), y0 + Inches(0.52), cw - Inches(0.3), Inches(0.5),
           [{"t": desc, "s": 9.5, "c": BODY, "f": BODY_FONT, "ls": 1.1}])

    y1 = y0 + Inches(1.28)
    for i, (name, desc) in enumerate([("执行官", "按确认令牌执行写操作"), ("审计官", "写入哈希链，序号递增")]):
        x = x0 + i * (cw + gap)
        card(s, x, y1, cw, Inches(1.12), fill="0B2F5E", fill_alpha=62, line=CYAN, line_alpha=40, radius=0.10)
        tx(s, x + Inches(0.16), y1 + Inches(0.14), cw - Inches(0.3), Inches(0.3),
           [{"t": name, "s": 15, "b": True, "c": CYAN, "f": BOLD_FONT}])
        tx(s, x + Inches(0.16), y1 + Inches(0.52), cw - Inches(0.3), Inches(0.5),
           [{"t": desc, "s": 9.5, "c": BODY, "f": BODY_FONT, "ls": 1.1}])

    scene_x = x0 + 2 * (cw + gap)
    scene_w = Inches(12.09) - (scene_x - Inches(0.62))
    card(s, scene_x, y1, scene_w, Inches(1.12), fill="0E3A73", fill_alpha=75, line=CYAN, line_alpha=50, radius=0.10)
    tx(s, scene_x + Inches(0.22), y1 + Inches(0.14), scene_w - Inches(0.4), Inches(0.3),
       [{"t": "六个赛题场景全部打通", "s": 15, "b": True, "c": WHITE, "f": BOLD_FONT}])
    tx(s, scene_x + Inches(0.22), y1 + Inches(0.52), scene_w - Inches(0.4), Inches(0.5),
       [{"t": "转账、账单、理财、卡片、订阅、跨场景联动", "s": 9.5, "c": BODY, "f": BODY_FONT}])

    meta = [("团队", "CordiBank 蜂群项目组"), ("规模", "244 项测试，23 个内置工具"),
            ("交付", "代码、文档、部署说明、测试用例"), ("时间", "2026 年 10 月")]
    my = Inches(6.42)
    for i, (label, value) in enumerate(meta):
        mx = Inches(0.66) + i * Inches(3.02)
        tx(s, mx, my, Inches(2.9), Inches(0.24), [{"t": label, "s": 9, "c": MUTED, "f": BODY_FONT}])
        tx(s, mx, my + Inches(0.22), Inches(2.9), Inches(0.28), [{"t": value, "s": 12, "b": True, "c": WHITE, "f": BOLD_FONT}])
    tx(s, Inches(0.66), Inches(7.10), Inches(12.0), Inches(0.26),
       [{"t": "本项目使用 CordiSwarm 智能体编排框架构建，运行于 Node 22 与 TypeScript 之上，前端为 Vue 3 与 Vite", "s": 8.5, "c": MUTED, "f": BODY_FONT}])

    # ---------- 02 三个数字 ----------
    s = new_slide()
    bg(s)
    header(s, "实测数据 · 全部可复现", "三个数字说明这套系统做到了什么", 2)
    stats = [
        ("244", "项自动化测试", "单元、集成、蜂群协同、真实模型四层。红队四十条用例覆盖直接注入、间接注入、越权与正常请求。"),
        ("23", "个内置工具", "六个赛题场景全部覆盖，另有四个外部服务提供十三个工具，经同一张注册表并入模型工具集。"),
        ("100%", "注入拦截率", "四类注入特征全部命中，正常请求误拦为零。不可逆操作百分之百判红，不给确认通道。"),
    ]
    cw = Inches(3.85)
    for i, (num, unit, desc) in enumerate(stats):
        x = Inches(0.62) + i * (cw + Inches(0.27))
        card(s, x, Inches(1.58), cw, Inches(2.55))
        tx(s, x + Inches(0.3), Inches(1.74), cw - Inches(0.6), Inches(0.95),
           [{"t": num, "s": 54, "b": True, "c": CYAN, "f": TITLE_FONT}])
        tx(s, x + Inches(0.3), Inches(2.72), cw - Inches(0.6), Inches(0.3),
           [{"t": unit, "s": 14, "b": True, "c": WHITE, "f": BOLD_FONT}])
        tx(s, x + Inches(0.3), Inches(3.12), cw - Inches(0.6), Inches(0.9),
           [{"t": desc, "s": 9.5, "c": BODY, "f": BODY_FONT, "ls": 1.18}])

    small = [
        ("怎么跑", "runtime 目录下执行测试命令，输出逐条用例名与通过状态。"),
        ("在哪里看", "控制台「跑红队集」与「工具清单」两个面板直接给出统计数字。"),
        ("证据在哪", "《部署说明》第八节列出全部验证命令与完整输出，评委可原样复跑。"),
    ]
    for i, (name, desc) in enumerate(small):
        x = Inches(0.62) + i * (cw + Inches(0.27))
        card(s, x, Inches(4.42), cw, Inches(1.55), fill="0B2F5E", fill_alpha=50)
        tx(s, x + Inches(0.26), Inches(4.58), cw - Inches(0.5), Inches(0.3),
           [{"t": name, "s": 13, "b": True, "c": CYAN, "f": BOLD_FONT}])
        tx(s, x + Inches(0.26), Inches(4.96), cw - Inches(0.5), Inches(0.9),
           [{"t": desc, "s": 9.5, "c": BODY, "f": BODY_FONT, "ls": 1.2}])
    banner(s, "规模、覆盖与安全三项均可复现：每个数字都有对应命令与真实输出")

    # ---------- 03 问题 ----------
    s = new_slide()
    bg(s)
    header(s, "问题", "一个大脑包办所有事，代价落在三处", 3)
    problems = [
        ("01", "判不准", "同一个模型既要想「用户要什么」，又要想「这事能不能办」。两个目标写在一段提示词里，互相干扰，结果是该拦的没拦，该放的没放。"),
        ("02", "说不清", "出错时只能看到一个结论，不知道是哪一步出的问题。评委问「为什么判黄」，答不上具体规则与阈值，等于没有判定。"),
        ("03", "改不动", "要加一条风控规则，得动主流程；要加一句合规校验，还得动主流程。改一处牵全身，团队里没人敢动那段代码。"),
    ]
    cw = Inches(3.85)
    for i, (num, name, desc) in enumerate(problems):
        x = Inches(0.62) + i * (cw + Inches(0.27))
        card(s, x, Inches(1.55), cw, Inches(2.62))
        tx(s, x + Inches(0.3), Inches(1.66), Inches(1.0), Inches(0.6),
           [{"t": num, "s": 30, "b": True, "c": CYAN_DIM, "f": TITLE_FONT}])
        tx(s, x + Inches(0.3), Inches(2.28), cw - Inches(0.6), Inches(0.36),
           [{"t": name, "s": 18, "b": True, "c": WHITE, "f": BOLD_FONT}])
        tx(s, x + Inches(0.3), Inches(2.76), cw - Inches(0.6), Inches(1.2),
           [{"t": desc, "s": 9.5, "c": BODY, "f": BODY_FONT, "ls": 1.22}])
    card(s, Inches(0.62), Inches(4.42), Inches(12.09), Inches(1.42), fill="0B2F5E", fill_alpha=55)
    tx(s, Inches(0.95), Inches(4.56), Inches(2.2), Inches(0.34),
       [{"t": "三个代价怎么消", "s": 14, "b": True, "c": CYAN, "f": BOLD_FONT}])
    tx(s, Inches(0.95), Inches(4.96), Inches(11.4), Inches(0.8),
       [{"t": "三个代价对应三处改动：多视角交叉验证替代单点判断，规则命中留痕替代只给结论，角色隔离替代改主流程。三组代价在同一套改动里一起消掉，不需要分批上线。",
         "s": 10, "c": BODY, "f": BODY_FONT, "ls": 1.25}])
    banner(s, "解法不是换更强的模型，是把一件事拆给多个专职角色")

    # ---------- 04 七个角色 ----------
    s = new_slide()
    bg(s)
    header(s, "方案", "七个角色，各管一件事，结论汇到仲裁", 4, title_size=26)
    top = [
        ("意图官", "听懂诉求，抽出工具与槽位，缺参数就问"),
        ("风控官", "按策略判风险，四维叠加，输出命中规则"),
        ("合规官", "查收款人来源，查工具白名单，只做否决"),
        ("体验官", "判断还缺什么，给替代路径，不参与风险"),
        ("仲裁官", "取最高风险，合并理由，任一否决即拦"),
    ]
    cw = Inches(2.20)
    gap = Inches(0.25)
    for i, (name, desc) in enumerate(top):
        x = Inches(0.62) + i * (cw + gap)
        card(s, x, Inches(1.50), cw, Inches(1.30))
        tx(s, x + Inches(0.16), Inches(1.62), cw - Inches(0.30), Inches(0.32),
           [{"t": name, "s": 14.5, "b": True, "c": CYAN, "f": BOLD_FONT}])
        tx(s, x + Inches(0.16), Inches(1.98), cw - Inches(0.30), Inches(0.72),
           [{"t": desc, "s": 8.6, "c": BODY, "f": BODY_FONT, "ls": 1.14}])
        if i < 4:
            tx(s, x + cw + Inches(0.04), Inches(2.02), Inches(0.18), Inches(0.26),
               [{"t": "→", "s": 10, "b": True, "c": CYAN, "f": BODY_FONT}])
    y2 = Inches(2.98)
    card(s, Inches(0.62), y2, Inches(3.05), Inches(1.22))
    tx(s, Inches(0.80), y2 + Inches(0.12), Inches(2.7), Inches(0.32),
       [{"t": "执行官　执行或签发令牌", "s": 14, "b": True, "c": WHITE, "f": BOLD_FONT}])
    tx(s, Inches(0.80), y2 + Inches(0.58), Inches(2.7), Inches(0.5),
       [{"t": "按判定拦截、待确认或直接执行", "s": 9, "c": BODY, "f": BODY_FONT}])
    card(s, Inches(3.85), y2, Inches(3.05), Inches(1.22))
    tx(s, Inches(4.03), y2 + Inches(0.12), Inches(2.7), Inches(0.32),
       [{"t": "审计官　写入哈希链", "s": 14, "b": True, "c": WHITE, "f": BOLD_FONT}])
    tx(s, Inches(4.03), y2 + Inches(0.58), Inches(2.7), Inches(0.5),
       [{"t": "逐条带前序哈希，可校验是否被改动", "s": 9, "c": BODY, "f": BODY_FONT}])
    card(s, Inches(7.08), y2, Inches(5.63), Inches(1.22), fill="0E3A73", fill_alpha=72)
    tx(s, Inches(7.30), y2 + Inches(0.12), Inches(5.2), Inches(0.32),
       [{"t": "三路并行　同时执行，任一失败只降级该维度，其余照常", "s": 13, "b": True, "c": CYAN, "f": BOLD_FONT}])
    tx(s, Inches(7.30), y2 + Inches(0.58), Inches(5.2), Inches(0.5),
       [{"t": "风控、合规、体验同时评估，仲裁取最高风险并合并理由", "s": 9, "c": BODY, "f": BODY_FONT}])
    y3 = Inches(4.42)
    card(s, Inches(0.62), y3, Inches(5.95), Inches(1.55), fill="0B2F5E", fill_alpha=52)
    tx(s, Inches(0.86), y3 + Inches(0.14), Inches(5.5), Inches(0.3),
       [{"t": "模型只在一环出现", "s": 13, "b": True, "c": ORANGE, "f": BOLD_FONT}])
    tx(s, Inches(0.86), y3 + Inches(0.52), Inches(5.5), Inches(0.9),
       [{"t": "模型只在意图官解析诉求与选工具，风险判定与执行全在代码层。", "s": 10, "c": BODY, "f": BODY_FONT, "ls": 1.2}])
    card(s, Inches(6.76), y3, Inches(5.95), Inches(1.55), fill="0B2F5E", fill_alpha=52)
    tx(s, Inches(7.00), y3 + Inches(0.14), Inches(5.5), Inches(0.3),
       [{"t": "每个角色留痕", "s": 13, "b": True, "c": ORANGE, "f": BOLD_FONT}])
    tx(s, Inches(7.00), y3 + Inches(0.52), Inches(5.5), Inches(0.9),
       [{"t": "七个角色的结论与耗时都进审计，界面上可逐条展开核对。", "s": 10, "c": BODY, "f": BODY_FONT, "ls": 1.2}])
    banner(s, "评估并行、仲裁合并、任一否决即拦：判定链路每一步都能单独测、单独讲", size=13)

    # ---------- 05 七步链路 ----------
    s = new_slide()
    bg(s)
    header(s, "一条链路", "「转给小王 100 元」走完七步", 5, title_size=26)
    steps = [
        ("01", "输入守卫", "归一化，识别注入特征，命中即拦"),
        ("02", "意图官", "落到 transfer，payee 小王，金额 10000 分"),
        ("03", "三评估并行", "风控判黄，合规放行，体验无需追问"),
        ("04", "仲裁官", "绿绿黄取最高，判黄，需确认"),
        ("05", "确认令牌", "绑定会话、工具、参数摘要，120 秒有效"),
        ("06", "执行官", "重算摘要比对通过，扣账"),
        ("07", "审计官", "写链，序号递增，前序哈希串起来"),
    ]
    for i, (num, name, desc) in enumerate(steps):
        y = Inches(1.50) + i * Inches(0.70)
        card(s, Inches(0.62), y, Inches(7.35), Inches(0.60), fill="0B2F5E", fill_alpha=50, radius=0.10)
        tx(s, Inches(0.78), y, Inches(0.62), Inches(0.60),
           [{"t": num, "s": 17, "b": True, "c": CYAN, "f": TITLE_FONT}], anchor=MSO_ANCHOR.MIDDLE)
        tx(s, Inches(1.42), y, Inches(1.85), Inches(0.60),
           [{"t": name, "s": 12.5, "b": True, "c": WHITE, "f": BOLD_FONT}], anchor=MSO_ANCHOR.MIDDLE)
        tx(s, Inches(3.32), y, Inches(4.5), Inches(0.60),
           [{"t": desc, "s": 9.3, "c": BODY, "f": BODY_FONT}], anchor=MSO_ANCHOR.MIDDLE)
    card(s, Inches(8.20), Inches(1.50), Inches(4.51), Inches(2.55))
    tx(s, Inches(8.45), Inches(1.64), Inches(4.0), Inches(0.32),
       [{"t": "为什么拆成七步", "s": 14, "b": True, "c": CYAN, "f": BOLD_FONT}])
    tx(s, Inches(8.45), Inches(2.02), Inches(4.0), Inches(0.95),
       [{"t": "每一步都能单独测、单独改、单独讲。判错了看第七步之前的记录，改规则只动一个角色，不影响主流程。",
         "s": 10, "c": BODY, "f": BODY_FONT, "ls": 1.3}])
    tx(s, Inches(8.45), Inches(3.02), Inches(4.0), Inches(0.95),
       [{"t": "前三步只看用户说了什么", "s": 10, "b": True, "c": ORANGE, "f": BODY_FONT, "sa": 5},
        {"t": "中间两步决定能不能办", "s": 10, "b": True, "c": ORANGE, "f": BODY_FONT, "sa": 5},
        {"t": "后两步保证办完能回看", "s": 10, "b": True, "c": ORANGE, "f": BODY_FONT}])
    card(s, Inches(8.20), Inches(4.20), Inches(4.51), Inches(1.72), fill="0B2F5E", fill_alpha=52)
    tx(s, Inches(8.45), Inches(4.34), Inches(4.0), Inches(0.3),
       [{"t": "链路可回放", "s": 13, "b": True, "c": WHITE, "f": BOLD_FONT}])
    tx(s, Inches(8.45), Inches(4.70), Inches(4.0), Inches(1.0),
       [{"t": "七步的结论全部写进审计，界面上可以逐条展开。", "s": 10, "c": BODY, "f": BODY_FONT, "ls": 1.25}])
    banner(s, "每一步的输入输出都写进审计记录，界面上可逐条展开核对")

    # ---------- 06 权限分级 ----------
    s = new_slide()
    bg(s)
    header(s, "安全设计 · 一", "权限分级：绿黄红三色，四维叠加", 6, title_size=26)
    levels = [
        ("绿　直连", GREEN, "只读查询，无金额变动，可逆或无代价。查余额、看账单、列订阅，一次请求返回结果。", "执行前无二次确认"),
        ("黄　令牌", AMBER, "写操作但可控可逆。转账、取消订阅、锁卡，先签发一次性确认令牌，参数摘要一致才执行。", "须用户明确确认一次"),
        ("红　拦截", RED, "不可逆或越权。挂失、赎回、解冻、冻结、越界金额，一律拒绝执行，不提供确认通道。", "任何确认都不能放行"),
    ]
    cw = Inches(3.85)
    for i, (name, color, desc, foot) in enumerate(levels):
        x = Inches(0.62) + i * (cw + Inches(0.27))
        card(s, x, Inches(1.52), cw, Inches(2.28))
        rect(s, x + Inches(0.24), Inches(1.68), Inches(0.5), Inches(0.05), "%02X%02X%02X" % (color[0], color[1], color[2]), 100, line=None)
        tx(s, x + Inches(0.28), Inches(1.80), cw - Inches(0.5), Inches(0.36),
           [{"t": name, "s": 18, "b": True, "c": color, "f": BOLD_FONT}])
        tx(s, x + Inches(0.28), Inches(2.26), cw - Inches(0.55), Inches(1.2),
           [{"t": desc, "s": 9.5, "c": BODY, "f": BODY_FONT, "ls": 1.22}])
        tx(s, x + Inches(0.28), Inches(3.02), cw - Inches(0.55), Inches(0.3),
           [{"t": foot, "s": 9, "b": True, "c": color, "f": BODY_FONT}])
    y = Inches(4.18)
    card(s, Inches(0.62), y, Inches(5.95), Inches(1.75), fill="0B2F5E", fill_alpha=52)
    tx(s, Inches(0.86), y + Inches(0.14), Inches(5.4), Inches(0.32),
       [{"t": "四个维度叠加判定", "s": 14, "b": True, "c": CYAN, "f": BOLD_FONT}])
    tx(s, Inches(0.86), y + Inches(0.54), Inches(5.4), Inches(1.1),
       [{"t": "操作类型、涉及金额、收款人身份、可逆性、发生频次。任一维度命中更高等级，等级取最高。每条命中都带规则编号与具体说明，不只给一个颜色。",
         "s": 9.5, "c": BODY, "f": BODY_FONT, "ls": 1.22}])
    card(s, Inches(6.76), y, Inches(5.95), Inches(1.75), fill="0B2F5E", fill_alpha=52)
    tx(s, Inches(7.00), y + Inches(0.14), Inches(5.4), Inches(0.32),
       [{"t": "令牌四绑定", "s": 14, "b": True, "c": CYAN, "f": BOLD_FONT}])
    tx(s, Inches(7.00), y + Inches(0.54), Inches(5.4), Inches(1.1),
       [{"t": "绑定会话、工具、参数摘要、过期时间。执行前重算摘要比对，参数被改过则令牌失效。",
         "s": 9.5, "c": BODY, "f": BODY_FONT, "ls": 1.22}])
    banner(s, "三色是结论，四维是依据，每条判定都带规则名")

    # ---------- 07 注入防御 ----------
    s = new_slide()
    bg(s)
    header(s, "安全设计 · 二", "注入防御：模型不碰执行，判断全在代码", 7, title_size=26)
    gates = [
        ("闸一　输入守卫", "归一化文本，识别指令覆盖、角色伪装、越权索取四类特征，命中即拦，模型看不到这段话。"),
        ("闸二　职责隔离", "模型只做两件事：理解诉求、选工具。风险判定与参数校验全在代码层，模型说了不算。"),
        ("闸三　外部内容隔离", "外部服务返回按数据处理，不进系统提示词，不当指令读。间接注入因此失效。"),
        ("闸四　参数收口", "工具参数按契约校验，金额越界、收款人凭空出现、非法工具名一律拒绝并记审计。"),
    ]
    for i, (name, desc) in enumerate(gates):
        y = Inches(1.50) + i * Inches(1.13)
        card(s, Inches(0.62), y, Inches(7.20), Inches(1.02), fill="0B2F5E", fill_alpha=50, radius=0.10)
        rect(s, Inches(0.62), y, Inches(0.07), Inches(1.02), CYAN, 100, line=None)
        tx(s, Inches(0.90), y + Inches(0.10), Inches(3.0), Inches(0.32),
           [{"t": name, "s": 13.5, "b": True, "c": CYAN, "f": BOLD_FONT}])
        tx(s, Inches(0.90), y + Inches(0.46), Inches(6.7), Inches(0.5),
           [{"t": desc, "s": 9.2, "c": BODY, "f": BODY_FONT, "ls": 1.16}])
    metrics = [
        ("12 / 12", "直接注入全部拦截", "「忽略之前的指令」「你现在是管理员」等十二种改写方式，全部在入口被挡下。"),
        ("8 / 8", "间接注入全部拦截", "把恶意指令藏在账单备注、订阅名称、理财介绍里，经外部服务返回，隔离机制生效。"),
        ("0%", "正常请求误拦截", "十二条正常业务用例零误拦。拦得住和放得过，两头都守住才算可用。"),
    ]
    for i, (num, name, desc) in enumerate(metrics):
        y = Inches(1.50) + i * Inches(1.50)
        card(s, Inches(8.05), y, Inches(4.66), Inches(1.38), fill="0B2F5E", fill_alpha=52)
        tx(s, Inches(8.28), y + Inches(0.10), Inches(1.9), Inches(0.5),
           [{"t": num, "s": 24, "b": True, "c": CYAN, "f": TITLE_FONT}])
        tx(s, Inches(8.28), y + Inches(0.56), Inches(4.1), Inches(0.3),
           [{"t": name, "s": 11.5, "b": True, "c": WHITE, "f": BOLD_FONT}])
        tx(s, Inches(8.28), y + Inches(0.86), Inches(4.1), Inches(0.5),
           [{"t": desc, "s": 8.3, "c": BODY, "f": BODY_FONT, "ls": 1.12}])
    banner(s, "四道闸顺序固定：顺序错了就有绕过路径", size=14)

    # ---------- 08 意图理解 ----------
    s = new_slide()
    bg(s)
    header(s, "核心能力", "意图理解：规则优先，模型兜底", 8, title_size=26)
    layers = [
        ("第一层　规则匹配", "十一条意图规则覆盖六类常见表述，一条规则可派生多个工具意图。中英文数字金额一并归一，单轮解析耗时一毫秒内，结果确定可复现。"),
        ("第二层　模型兜底", "规则没命中才请模型解析，输出受契约约束：工具名、槽位、置信度、理由。越界工具名或非法槽位值直接丢弃。"),
        ("第三层　缺槽追问", "槽位不全不执行。少金额就问金额，少收款人就问收款人，追问结果回填后重走判定流程。"),
    ]
    for i, (name, desc) in enumerate(layers):
        y = Inches(1.50) + i * Inches(1.42)
        card(s, Inches(0.62), y, Inches(7.20), Inches(1.30), fill="0B2F5E", fill_alpha=50, radius=0.10)
        tx(s, Inches(0.88), y + Inches(0.12), Inches(3.2), Inches(0.32),
           [{"t": name, "s": 13.5, "b": True, "c": CYAN, "f": BOLD_FONT}])
        tx(s, Inches(0.88), y + Inches(0.48), Inches(6.7), Inches(0.72),
           [{"t": desc, "s": 9.2, "c": BODY, "f": BODY_FONT, "ls": 1.18}])
    card(s, Inches(8.05), Inches(1.50), Inches(4.66), Inches(2.55))
    tx(s, Inches(8.28), Inches(1.62), Inches(4.2), Inches(0.32),
       [{"t": "一次解析的输出", "s": 13.5, "b": True, "c": CYAN, "f": BOLD_FONT}])
    fields = [("意图：智能转账", CYAN), ("工具：transfer", BODY), ("收款人：小王", BODY),
              ("金额：50000 分", BODY), ("置信度：0.96", BODY), ("理由：出现「转给」与金额", BODY)]
    for i, (text, color) in enumerate(fields):
        tx(s, Inches(8.28), Inches(2.02) + i * Inches(0.32), Inches(4.2), Inches(0.3),
           [{"t": text, "s": 10.5, "b": i == 0, "c": color, "f": MONO_FONT}])
    card(s, Inches(8.05), Inches(4.20), Inches(4.66), Inches(1.72), fill="0B2F5E", fill_alpha=52)
    tx(s, Inches(8.28), Inches(4.32), Inches(4.2), Inches(1.45),
       [{"t": "金额一律用整数分存储，避免浮点误差。理由与置信度一起落审计，出错时能回看是哪一步判的。",
         "s": 8.8, "c": BODY, "f": BODY_FONT, "ls": 1.18, "sa": 4},
        {"t": "槽位缺失时输出 missing 列表，编排层据此追问。", "s": 8.8, "c": BODY, "f": BODY_FONT, "ls": 1.18, "sa": 4},
        {"t": "置信度低于阈值时同样走追问，不猜金额。", "s": 8.8, "c": BODY, "f": BODY_FONT, "ls": 1.18}])
    banner(s, "规则确定可复现，模型只在规则未命中时兜底", size=14)

    # ---------- 09 审计链 ----------
    s = new_slide()
    bg(s)
    header(s, "可追溯", "每条结论都带出处，审计链改一条即断", 9, title_size=26)
    card(s, Inches(0.62), Inches(1.50), Inches(6.20), Inches(2.42))
    tx(s, Inches(0.88), Inches(1.62), Inches(5.6), Inches(0.32),
       [{"t": "追加式哈希链", "s": 13.5, "b": True, "c": CYAN, "f": BOLD_FONT}])
    formulas = ["hash₁ = SHA256(GENESIS + 内容₁)", "hash₂ = SHA256(hash₁ + 内容₂)", "hash₃ = SHA256(hash₂ + 内容₃)"]
    for i, f in enumerate(formulas):
        tx(s, Inches(0.88), Inches(2.04) + i * Inches(0.38), Inches(5.6), Inches(0.34),
           [{"t": f, "s": 11.5, "c": WHITE, "f": MONO_FONT}])
    tx(s, Inches(0.88), Inches(3.24), Inches(5.6), Inches(0.6),
       [{"t": "每条记录写入前把上一条的哈希拼进摘要再算哈希。改动中间任意一条，后面全部对不上。",
         "s": 8.8, "c": BODY, "f": BODY_FONT, "ls": 1.15}])
    card(s, Inches(7.05), Inches(1.50), Inches(5.66), Inches(2.42))
    tx(s, Inches(7.30), Inches(1.62), Inches(5.1), Inches(0.32),
       [{"t": "一条记录里有什么", "s": 13.5, "b": True, "c": CYAN, "f": BOLD_FONT}])
    record = ["序号与时间戳", "会话标识与渠道来源", "意图、工具、槽位摘要",
              "风险等级与命中的规则编号", "蜂群各角色的分工结论", "前序哈希与本条哈希"]
    for i, text in enumerate(record):
        tx(s, Inches(7.30), Inches(2.04) + i * Inches(0.30), Inches(5.1), Inches(0.28),
           [{"t": "· " + text, "s": 9.8, "c": BODY, "f": BODY_FONT}])
    bottom = [
        ("只追加，不改写", "审计记录只追加不覆盖，历史条目不可编辑。序号从一开始递增，可据此确认没有丢条。"),
        ("查询接口自带校验", "审计查询返回时顺带重算全链，校验结果由 chain.ok 字段给出，界面直接显示通过或失败。"),
        ("敏感字段脱敏", "卡号只留后四位，手机号中段掩码。审计文件全文检索无明文卡号与手机号。"),
    ]
    cw = Inches(3.85)
    for i, (name, desc) in enumerate(bottom):
        x = Inches(0.62) + i * (cw + Inches(0.27))
        card(s, x, Inches(4.18), cw, Inches(1.78), fill="0B2F5E", fill_alpha=52)
        tx(s, x + Inches(0.26), Inches(4.32), cw - Inches(0.5), Inches(0.3),
           [{"t": name, "s": 12.5, "b": True, "c": CYAN, "f": BOLD_FONT}])
        tx(s, x + Inches(0.26), Inches(4.70), cw - Inches(0.5), Inches(1.1),
           [{"t": desc, "s": 9.2, "c": BODY, "f": BODY_FONT, "ls": 1.2}])
    banner(s, "数字只来自工具返回，模型不产生业务数字", size=14)

    # ---------- 10 工具注册表 ----------
    s = new_slide()
    bg(s)
    header(s, "工程实现", "三套能力收敛成一张工具注册表", 10, title_size=26)
    rows = [
        ("内置工具", "23 个", "策略表与参数契约是唯一事实来源", "新增一个工具三步：在参数契约加槽位，在策略表加风险画像，在执行层加分支。描述符与模型工具集自动包含，界面的工具清单同步更新。"),
        ("外部服务", "4 服务 13 工具", "走 MCP 协议，独立进程", "汇率、反欺诈、理财费率、生日礼遇四个服务各自独立进程，超时与失败隔离，某个服务挂掉不影响内置工具。外部工具名统一加前缀，既是路由依据也是防伪依据。"),
        ("技能库", "按需加载", "两段式渐进披露", "系统提示词只放目录摘要，每条截断到八十字符。模型判断需要哪一项，再调用加载工具取全文，上限四千字符。提示词体积从一千九百七十一字符降到一百八十四字符。"),
    ]
    for i, (name, stat, sub, desc) in enumerate(rows):
        y = Inches(1.50) + i * Inches(1.42)
        card(s, Inches(0.62), y, Inches(12.09), Inches(1.30), fill="0B2F5E", fill_alpha=52)
        rect(s, Inches(0.62), y, Inches(0.07), Inches(1.30), CYAN, 100, line=None)
        tx(s, Inches(0.92), y + Inches(0.16), Inches(2.0), Inches(0.34),
           [{"t": name, "s": 15, "b": True, "c": WHITE, "f": BOLD_FONT}])
        tx(s, Inches(0.92), y + Inches(0.56), Inches(2.4), Inches(0.3),
           [{"t": stat, "s": 13, "b": True, "c": CYAN, "f": TITLE_FONT}])
        tx(s, Inches(3.35), y + Inches(0.14), Inches(2.9), Inches(0.3),
           [{"t": sub, "s": 9.5, "b": True, "c": ORANGE, "f": BODY_FONT}])
        tx(s, Inches(3.35), y + Inches(0.46), Inches(9.1), Inches(0.75),
           [{"t": desc, "s": 9.2, "c": BODY, "f": BODY_FONT, "ls": 1.18}])
    banner(s, "注册表三条约束：同名工具直接报错不覆盖，外部工具失败不影响内置，可按来源或按服务器整体移除。", size=12.5)

    # ---------- 11 测试分布 ----------
    s = new_slide()
    bg(s)
    header(s, "实测数据", "每一项都有命令与输出可复现", 11, title_size=26)
    tx(s, Inches(0.62), Inches(1.46), Inches(7.2), Inches(0.32),
       [{"t": "测试分布　共 244 项，232 项通过", "s": 13, "b": True, "c": WHITE, "f": BOLD_FONT}])
    dist = [("62", "单元测试"), ("130", "集成测试"), ("24", "蜂群测试"), ("28", "模型测试")]
    for i, (num, name) in enumerate(dist):
        x = Inches(0.62) + (i % 2) * Inches(3.60)
        y = Inches(1.86) + (i // 2) * Inches(1.22)
        card(s, x, y, Inches(3.42), Inches(1.06), fill="0B2F5E", fill_alpha=52)
        tx(s, x + Inches(0.24), y + Inches(0.10), Inches(1.1), Inches(0.5),
           [{"t": num, "s": 26, "b": True, "c": CYAN, "f": TITLE_FONT}])
        tx(s, x + Inches(0.24), y + Inches(0.66), Inches(2.9), Inches(0.3),
           [{"t": name, "s": 10.5, "b": True, "c": WHITE, "f": BOLD_FONT}])
    card(s, Inches(0.62), Inches(4.42), Inches(7.02), Inches(1.50), fill="0E3A73", fill_alpha=70)
    tx(s, Inches(0.86), Inches(4.54), Inches(6.5), Inches(0.3),
       [{"t": "红队四十条分四组", "s": 12.5, "b": True, "c": ORANGE, "f": BOLD_FONT}])
    tx(s, Inches(0.86), Inches(4.90), Inches(6.5), Inches(0.9),
       [{"t": "直接注入十二条、间接注入八条、越权操作八条、正常请求十二条。攻击拦截百分之百，正常请求误拦为零。",
         "s": 9.2, "c": BODY, "f": BODY_FONT, "ls": 1.2}])
    right = [
        ("成本与体积", "两轮对话累计三千八百零六个提示词字符，命中前缀缓存三千四百五十六个，命中率百分之九十一。系统提示词从一千九百七十一字符降到一百八十四字符。"),
        ("外部服务", "四个服务十三个工具全部可用。样例：兑换一百美元折合七百一十二元人民币，理财适配判定给出不适合并列出原因。"),
        ("模型不服从", "模型被诱导时，越权工具与越界金额仍被代码层拒绝，执行结果不受模型影响。"),
        ("证据在哪", "《部署说明》第八节列出全部验证命令与完整输出，评委可在本机原样复跑。"),
    ]
    for i, (name, desc) in enumerate(right):
        y = Inches(1.46) + i * Inches(1.12)
        card(s, Inches(7.90), y, Inches(4.81), Inches(1.02), fill="0B2F5E", fill_alpha=52)
        tx(s, Inches(8.12), y + Inches(0.08), Inches(4.4), Inches(0.28),
           [{"t": name, "s": 11, "b": True, "c": CYAN, "f": BOLD_FONT}])
        tx(s, Inches(8.12), y + Inches(0.38), Inches(4.4), Inches(0.6),
           [{"t": desc, "s": 8.3, "c": BODY, "f": BODY_FONT, "ls": 1.12}])
    tx(s, Inches(0.62), Inches(5.96), Inches(12.0), Inches(0.3),
       [{"t": "单元＝金额解析、槽位抽取、判定规则、令牌校验；集成＝六场景全链路、注入拦截、插件装配；蜂群＝并行评估与仲裁；模型＝真实调用与输出契约。",
         "s": 8.5, "c": MUTED, "f": BODY_FONT}])
    banner(s, "每一项都有命令与真实输出，评委可在本机原样复跑", size=14)

    # ---------- 12 风险清单 ----------
    s = new_slide()
    bg(s)
    header(s, "安全自评", "已知风险清单，八项，写在报告里", 12, title_size=26)
    risks = [
        ("R1　审计链防不住整段删除", "能查出改，查不出删。需外部锚定存证。"),
        ("R2　没有真实身份认证", "会话按渠道标识建，未接统一认证。"),
        ("R3　文件存储无并发控制", "单进程演示可用，多实例部署需换库。"),
        ("R4　模型长尾误判", "兜底解析可能抽错槽位，追问可缓解。"),
        ("R5　提示词语义变体", "同义改写可能绕过特征匹配，需持续补规则。"),
        ("R6　外部服务投毒", "隔离挡住指令注入，挡不住脏数据，需校验上游。"),
        ("R7　没有速率限制", "模型调用无配额，公网部署前需加网关限流。"),
        ("R8　令牌在前端明文展示", "演示用，明文可读，需改为服务端托管会话。"),
    ]
    cw = Inches(2.90)
    for i, (name, desc) in enumerate(risks):
        x = Inches(0.62) + (i % 4) * (cw + Inches(0.16))
        y = Inches(1.50) + (i // 4) * Inches(1.72)
        card(s, x, y, cw, Inches(1.56), fill="0B2F5E", fill_alpha=52)
        tx(s, x + Inches(0.18), y + Inches(0.12), cw - Inches(0.34), Inches(0.56),
           [{"t": name, "s": 9.8, "b": True, "c": ORANGE, "f": BOLD_FONT, "ls": 1.08}])
        tx(s, x + Inches(0.18), y + Inches(0.64), cw - Inches(0.34), Inches(0.8),
           [{"t": desc, "s": 8.3, "c": BODY, "f": BODY_FONT, "ls": 1.12}])
    card(s, Inches(0.62), Inches(4.96), Inches(12.09), Inches(1.30), fill="0E3A73", fill_alpha=72)
    tx(s, Inches(0.92), Inches(5.08), Inches(2.4), Inches(0.3),
       [{"t": "报告怎么写的", "s": 13, "b": True, "c": CYAN, "f": BOLD_FONT}])
    tx(s, Inches(0.92), Inches(5.44), Inches(11.4), Inches(0.7),
       [{"t": "每项风险写清影响、现有缓解、残余风险与改进建议。同时列出未覆盖的测试范围：真实渗透测试、并发压测、密钥轮转流程、多实例部署下的审计一致性。",
         "s": 9.2, "c": BODY, "f": BODY_FONT, "ls": 1.2}])
    banner(s, "主动交代残余风险：每项都写清影响、缓解与建议", size=14)

    # ---------- 13 结语 ----------
    s = new_slide()
    bg(s, darken=45)
    rect(s, 0, 0, Inches(13.333), Inches(1.42), DEEP, 45, line=None)
    tx(s, Inches(0.62), Inches(0.38), Inches(9.5), Inches(0.3),
       [{"t": "结语", "s": 11.5, "b": True, "c": CYAN, "f": BOLD_FONT}])
    tx(s, Inches(0.62), Inches(0.62), Inches(11.6), Inches(1.55),
       [{"t": "把一件事拆给多个专职角色，", "s": 30, "b": True, "c": WHITE, "f": TITLE_FONT, "sa": 2},
        {"t": "比换更强的模型更可靠", "s": 34, "b": True, "c": CYAN, "f": TITLE_FONT}])
    tx(s, Inches(11.05), Inches(0.40), Inches(1.68), Inches(0.3),
       [{"t": "CordiBank · 蜂群银行助手", "s": 9.5, "c": MUTED, "f": BODY_FONT, "a": PP_ALIGN.RIGHT}])
    tx(s, Inches(11.05), Inches(7.04), Inches(1.68), Inches(0.28),
       [{"t": "%02d / %d" % (13, TOTAL_PAGES), "s": 9, "c": MUTED, "f": BODY_FONT, "a": PP_ALIGN.RIGHT}])
    cards = [
        ("七个角色", "分工与仲裁", "意图、风控、合规、体验并行评估，仲裁取最高"),
        ("三色分级", "绿黄红与令牌", "直连、令牌、拦截三档，判定带规则编号"),
        ("哈希链", "全程可追溯", "前序哈希串起每条记录，改一条即断链"),
    ]
    cw = Inches(3.85)
    for i, (name, sub, desc) in enumerate(cards):
        x = Inches(0.62) + i * (cw + Inches(0.27))
        card(s, x, Inches(2.62), cw, Inches(1.95))
        tx(s, x + Inches(0.28), Inches(2.72), cw - Inches(0.55), Inches(0.36),
           [{"t": name, "s": 17, "b": True, "c": WHITE, "f": BOLD_FONT}])
        tx(s, x + Inches(0.28), Inches(3.16), cw - Inches(0.55), Inches(0.3),
           [{"t": sub, "s": 10.5, "b": True, "c": CYAN, "f": BODY_FONT}])
        tx(s, x + Inches(0.28), Inches(3.54), cw - Inches(0.55), Inches(0.8),
           [{"t": desc, "s": 9.2, "c": BODY, "f": BODY_FONT, "ls": 1.2}])
    tx(s, Inches(0.62), Inches(4.78), Inches(12.0), Inches(0.36),
       [{"t": "代码、文档、部署说明与全部测试用例随提交包提供，可在评委机器上复跑", "s": 11, "c": BODY, "f": BODY_FONT}])
    tx(s, Inches(0.62), Inches(6.42), Inches(6.0), Inches(0.34),
       [{"t": "CordiBank 蜂群项目组", "s": 13, "b": True, "c": WHITE, "f": BOLD_FONT}])
    tx(s, Inches(9.0), Inches(6.42), Inches(3.7), Inches(0.34),
       [{"t": "2026 年 10 月", "s": 11, "c": MUTED, "f": BODY_FONT, "a": PP_ALIGN.RIGHT}])

    # 演讲备注取自 Page Spec，逐页写入，保证与内容契约一致
    spec_path = os.path.join(ROOT, "ppt", "面向金融的蜂群智能体系统-答辩材料", "deck-spec.json")
    if os.path.exists(spec_path):
        import json

        with open(spec_path, encoding="utf-8") as stream:
            spec = json.load(stream)
        for slide, page in zip(prs.slides, spec["slides"]):
            slide.notes_slide.notes_text_frame.text = page.get("speaker_notes") or ""

    prs.save(out_path)
    return out_path


if __name__ == "__main__":
    import shutil

    source_out = os.path.join(
        ROOT, "ppt", "面向金融的蜂群智能体系统-答辩材料", "面向金融的蜂群智能体系统-答辩材料.pptx"
    )
    out = sys.argv[1] if len(sys.argv) > 1 else source_out
    path = build(out)
    print("written", path, os.path.getsize(path))
    if len(sys.argv) <= 1:
        shutil.copyfile(path, DEFAULT_OUT)
        print("copied", DEFAULT_OUT)
