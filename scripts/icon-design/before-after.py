"""Generate before/after comparison PNG for the icon redesign."""
import os
from PIL import Image, ImageDraw

d = r"C:\Users\manwa\Desktop\LiteMD\scripts\icon-design"
out = os.path.join(d, "before-after.png")

old = Image.open(os.path.join(d, "preview-v3-256.png")).convert("RGBA")  # placeholder, we'll swap
# Actually we want: old = original icon-source-old, new = new 256 preview.
# We deleted it; reconstruct from the backup.
old_src = r"C:\Users\manwa\Desktop\LiteMD\src-tauri\icons.bak\icon-source.png"
new_src = os.path.join(d, "preview-v3-256.png")
old = Image.open(old_src).convert("RGBA").resize((256, 256), Image.LANCZOS)
new = Image.open(new_src).convert("RGBA")

# Also load 32 previews
old32 = Image.open(r"C:\Users\manwa\Desktop\LiteMD\src-tauri\icons.bak\32x32.png").convert("RGBA")
new32 = Image.open(os.path.join(d, "preview-v3-32.png")).convert("RGBA")

W = 256 * 2 + 60 * 3
H = 256 + 80 + 60 + 80
img = Image.new("RGBA", (W, H), (245, 246, 248, 255))
draw = ImageDraw.Draw(img)

img.paste(old, (60, 30), old)
img.paste(new, (60 + 256 + 60, 30), new)
draw.text((60, 30 + 256 + 10), "Before  (default placeholder)", fill=(80, 80, 90))
draw.text((60 + 256 + 60, 30 + 256 + 10), "After  (LiteMD)", fill=(80, 80, 90))

# Bottom row: 32px comparison
y2 = 30 + 256 + 80
img.paste(old32, (60, y2), old32)
img.paste(new32, (60 + 64 + 30, y2), new32)
draw.text((60, y2 + 40 + 4), "32px before", fill=(80, 80, 90))
draw.text((60 + 64 + 30, y2 + 40 + 4), "32px after", fill=(80, 80, 90))

img.save(out)
print(out)