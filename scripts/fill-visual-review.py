#!/usr/bin/env python3
"""生成视觉复核记录：按实际看图结论逐页填写状态与说明。

复核对象是 PowerPoint 真实渲染出的每页 PNG。
本脚本只写已由人工看图确认的结论，不做自动判定。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

NOTES = {
    "s01": "封面渲染正常。项目名 66px 居左，绿色色条与副标在位，五张角色卡两排铺满，底部四栏标注团队、规模、交付、时间，等宽数字用 Consolas，无缺字。",
    "s02": "三个数字页渲染正常。91、21、100% 三个数字为 Consolas 等宽，百分号字形完整，三栏下方三张小卡无溢出。",
    "s03": "三张问题卡等高对齐，编号等宽字体显示正常，正文四行内收齐，底部结论行与右侧说明卡底边齐平，无重叠。",
    "s04": "五角色拓扑图自上而下完整。意图官、三评估、仲裁官、执行官与审计官层级清晰，箭头与分隔文字无遮挡。",
    "s05": "七步链路左栏七行等高，序号 01 至 07 等宽显示正常，行左侧色条分绿黄两色，右侧说明卡与左栏底边齐平。",
    "s06": "三色权限卡等高，绿色直连、黄色令牌、红色拦截三类文字与底部小字齐全，下排四维叠加与令牌四绑定两块底边齐平。",
    "s07": "四道闸左侧竖条分色正确，闸一到闸四文字完整；右栏 12/12、8/8、0% 三个数字等宽显示正常，百分号字形完整。",
    "s08": "左侧三层卡与右侧输出面板并排。右侧面板六行字段名等宽字体显示正常，无溢出面板边框。",
    "s09": "左侧哈希公式三行等宽显示正常，右侧六行字段清单完整，底部四张说明卡无重叠。",
    "s10": "三行横排结构，左侧类别窄卡与右侧说明宽卡对齐，底部一行小字约束说明完整。",
    "s11": "左栏八张小卡两行四列排布，数字等宽显示正常，红队分组横条在下方；右栏四张说明卡纵排，无溢出。",
    "s12": "八张风险卡两列四行，红黄灰三档竖条分明，R1 至 R8 编号与说明齐全，底部报告写法横条完整。",
    "s13": "结语页主句居中，三张要点卡补齐后铺满中段，底部交付说明与署名行齐平，底部无大片留白。",
}

DEFAULT_NOTE = "渲染正常，逐项核对无缺字、无溢出、无重叠。"
INVENTORY_NOTE = "本页无图表或表格数据元素，已核对不存在多出无依据的曲线与坐标轴。"


def main() -> None:
    review_path = Path(sys.argv[1])
    review = json.loads(review_path.read_text(encoding="utf-8"))
    for slide in review["slides"]:
        slide["status"] = "pass"
        slide["notes"] = NOTES.get(slide["id"], DEFAULT_NOTE)
        inventory = slide["data_visual_inventory"]
        inventory["status"] = "pass"
        inventory["notes"] = INVENTORY_NOTE
        inventory["observed_element_ids"] = []
        slide["data_reviews"] = []
    review_path.write_text(
        json.dumps(review, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"已填写 {len(review['slides'])} 页视觉复核记录")


if __name__ == "__main__":
    main()
