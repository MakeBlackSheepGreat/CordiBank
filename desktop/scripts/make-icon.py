#!/usr/bin/env python3
"""生成桌面应用图标。

图形取自项目品牌：深底 #0B1220，绿色 #22C55E 的蜂巢节点与连线，
象征七角色协同。输出多尺寸 ICO 与 PNG。
"""
from __future__ import annotations

import math
import os
from pathlib import Path

from PIL import Image, ImageDraw

BG = (11, 18, 32, 255)
GREEN = (34, 197, 94, 255)
GREEN_DIM = (22, 130, 62, 255)
AMBER = (245, 158, 11, 255)

OUT_DIR = Path(__file__).resolve().parent.parent / "build"


def draw_icon(size: int) -> Image.Image:
    """按给定边长画图标。节点相对位置用比例表示，缩放后构图不变。"""
    image = Image.new("RGBA", (size, size), BG)
    draw = ImageDraw.Draw(image)

    unit = size / 100.0

    def circle(cx: float, cy: float, r: float, fill) -> None:
        draw.ellipse(
            [(cx - r) * unit, (cy - r) * unit, (cx + r) * unit, (cy + r) * unit],
            fill=fill,
        )

    # 中心节点
    center = (50.0, 50.0)
    # 六个环绕节点，意图官与仲裁官上下，其余四个分布两侧
    ring = [
        (50.0, 20.0),
        (76.0, 33.0),
        (76.0, 67.0),
        (50.0, 80.0),
        (24.0, 67.0),
        (24.0, 33.0),
    ]

    # 连线：中心到每个环绕节点
    for point in ring:
        draw.line(
            [center[0] * unit, center[1] * unit, point[0] * unit, point[1] * unit],
            fill=GREEN_DIM,
            width=max(1, int(1.6 * unit)),
        )

    # 环绕节点之间的环线
    for index in range(len(ring)):
        a = ring[index]
        b = ring[(index + 1) % len(ring)]
        draw.line(
            [a[0] * unit, a[1] * unit, b[0] * unit, b[1] * unit],
            fill=(34, 197, 94, 60),
            width=max(1, int(1.0 * unit)),
        )

    # 节点
    for point in ring:
        circle(point[0], point[1], 6.0, GREEN)
    circle(center[0], center[1], 11.0, AMBER)
    circle(center[0], center[1], 6.0, BG)

    return image


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    sizes = [16, 24, 32, 48, 64, 128, 256]

    base = draw_icon(256)
    base.save(OUT_DIR / "icon.png")

    frames = [draw_icon(size).resize((size, size), Image.LANCZOS) for size in sizes]
    frames[-1].save(
        OUT_DIR / "icon.ico",
        format="ICO",
        sizes=[(size, size) for size in sizes],
    )

    print(f"图标已生成：{OUT_DIR / 'icon.ico'}")
    print(f"预览图：{OUT_DIR / 'icon.png'}")


if __name__ == "__main__":
    main()
