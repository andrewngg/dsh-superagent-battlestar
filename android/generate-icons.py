#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""BattleStar 启动图标生成器（仅依赖 Pillow）。

产物：
  android/res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png  (48/72/96/144/192)
  dist/icon-512.png                                                  (512x512 商店展示图)

风格：深蓝紫渐变圆角方块 + 白色衬线「B」字标 + 淡光晕与细描边。
"""

import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont, ImageFilter
except ImportError:  # pragma: no cover
    sys.stderr.write("需要 Pillow：pip install Pillow\n")
    sys.exit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
RES_DIR = os.path.join(HERE, "res")
DIST_DIR = os.path.normpath(os.path.join(HERE, "..", "dist"))

# 品牌色：深蓝紫
TOP = (58, 40, 122)       # #3A287A
BOTTOM = (11, 8, 24)      # #0B0818
GLOW = (124, 92, 255)     # #7C5CFF
WHITE = (255, 255, 255)

MASTER = 1024
SIZES = [
    ("mdpi", 48),
    ("hdpi", 72),
    ("xhdpi", 96),
    ("xxhdpi", 144),
    ("xxxhdpi", 192),
]


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def find_font():
    win = os.environ.get("WINDIR", r"C:\Windows")
    candidates = [
        os.path.join(win, "Fonts", "georgiab.ttf"),   # Georgia Bold（衬线，管家气质）
        os.path.join(win, "Fonts", "timesbd.ttf"),    # Times New Roman Bold
        os.path.join(win, "Fonts", "constanb.ttf"),   # Constantia Bold
        os.path.join(win, "Fonts", "arialbd.ttf"),    # Arial Bold 兜底
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


def vertical_gradient(size):
    img = Image.new("RGB", (size, size), BOTTOM)
    draw = ImageDraw.Draw(img)
    for y in range(size):
        draw.line([(0, y), (size, y)], fill=lerp(TOP, BOTTOM, y / (size - 1)))
    return img.convert("RGBA")


def add_glow(img):
    """中心偏上的紫罗兰光晕（分层 alpha 合成，避免逐像素运算过慢）。"""
    size = img.size[0]
    base = img.copy()
    cx, cy = size * 0.50, size * 0.41
    max_r = size * 0.68
    steps = 80
    for i in range(1, steps + 1):
        r = max_r * i / steps
        alpha = int(52 * (1 - i / (steps + 1.0)) ** 1.8)
        if alpha <= 0:
            continue
        layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(layer).ellipse(
            [cx - r, cy - r, cx + r, cy + r], fill=GLOW + (alpha,)
        )
        base = Image.alpha_composite(base, layer)
    return base


def add_monogram(img, text="B"):
    size = img.size[0]
    font_path = find_font()
    font_size = int(size * 0.60)
    if font_path:
        font = ImageFont.truetype(font_path, font_size)
    else:  # 没有可用字体时退回默认字体
        font = ImageFont.load_default()
        font_size = int(size * 0.5)

    measure = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mdraw = ImageDraw.Draw(measure)
    box = mdraw.textbbox((0, 0), text, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    x = (size - w) / 2.0 - box[0]
    y = (size - h) / 2.0 - box[1] - size * 0.015

    # 柔和投影（增加立体感，小尺寸下也不糊）
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).text(
        (x, y + size * 0.020), text, font=font, fill=(0, 0, 0, 150)
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(size * 0.012))
    img = Image.alpha_composite(img, shadow)

    txt = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(txt).text((x, y), text, font=font, fill=WHITE + (255,))
    return Image.alpha_composite(img, txt)


def add_ring(img):
    size = img.size[0]
    ring = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inset = size * 0.075
    ImageDraw.Draw(ring).rounded_rectangle(
        [inset, inset, size - inset, size - inset],
        radius=size * 0.20,
        outline=WHITE + (46,),
        width=max(2, int(size * 0.006)),
    )
    return Image.alpha_composite(img, ring)


def round_corners(img, radius_ratio=0.215):
    size = img.size[0]
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255
    )
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def build_master():
    img = vertical_gradient(MASTER)
    img = add_glow(img)
    img = add_monogram(img)
    img = add_ring(img)
    return round_corners(img)


def main():
    master = build_master()
    for density, px in SIZES:
        target_dir = os.path.join(RES_DIR, "mipmap-" + density)
        os.makedirs(target_dir, exist_ok=True)
        out = master.resize((px, px), Image.LANCZOS)
        path = os.path.join(target_dir, "ic_launcher.png")
        out.save(path, "PNG", optimize=True)
        print("wrote %s (%dx%d)" % (path, px, px))

    os.makedirs(DIST_DIR, exist_ok=True)
    store = master.resize((512, 512), Image.LANCZOS)
    path = os.path.join(DIST_DIR, "icon-512.png")
    store.save(path, "PNG", optimize=True)
    print("wrote %s (512x512)" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
