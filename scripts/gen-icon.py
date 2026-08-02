"""生成 LiteMD 应用图标源图（1024x1024 PNG）：
青绿渐变圆角方块 + 白色字母 M + Markdown 标题下划线。
对齐产品设计变量：accent #0F6E56，浅色 #2BB89A。
"""
from PIL import Image, ImageDraw, ImageFont

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角方块（半径 180），青绿渐变（上浅下深）
radius = 180
top = (0x2B, 0xB8, 0x9A, 255)      # #2BB89A
bottom = (0x0F, 0x6E, 0x56, 255)   # #0F6E56
mask = Image.new("L", (S, S), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=255)
grad = Image.new("RGBA", (S, S))
gd = ImageDraw.Draw(grad)
for y in range(S):
    t = y / (S - 1)
    r = int(top[0] + (bottom[0] - top[0]) * t)
    g = int(top[1] + (bottom[1] - top[1]) * t)
    b = int(top[2] + (bottom[2] - top[2]) * t)
    gd.line([(0, y), (S, y)], fill=(r, g, b, 255))
img.paste(grad, (0, 0), mask)

# 白色 "M" 字形（用粗体字体）
def find_font():
    for p in [
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/calibrib.ttf",
        "C:/Windows/Fonts/segoeuib.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ]:
        try:
            return ImageFont.truetype(p, 560)
        except Exception:
            continue
    return ImageFont.load_default()

font = find_font()
# 用文本测量确定 "M" 的包围盒，水平垂直居中
tmp = Image.new("RGBA", (S, S))
td = ImageDraw.Draw(tmp)
bbox = td.textbbox((0, 0), "M", font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
tx = (S - tw) / 2 - bbox[0]
ty = (S - th) / 2 - bbox[1] - 40  # 略微上移，给标题线留空间
d.text((tx, ty), "M", font=font, fill=(255, 255, 255, 255))

# Markdown 标题线：M 下方一条粗白线（类似 "# " 标题下划线）
line_y = ty + th + 70
d.rounded_rectangle([(S * 0.30, line_y), (S * 0.70, line_y + 34)], radius=17, fill=(255, 255, 255, 255))

img.save("src-tauri/icons/icon-source.png")
print("saved src-tauri/icons/icon-source.png", img.size)
