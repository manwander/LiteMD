"""High-quality downsample of the 2x supersampled PNGs to final icon sizes.

For each target size, take the 2x supersample source (ss-<2x>.png) and apply a
LANCZOS (a.k.a. bicubic with sinc window) downscale. LANCZOS is the best
general-purpose downsampling filter for preserving sharp edges while avoiding
aliasing, which is exactly what we want for crisp small icons.
"""
from PIL import Image
import os

SIZES = [1024, 512, 256, 128, 64, 32]
# target -> 2x supersample source
SRC_FOR = {1024: 2048, 512: 1024, 256: 512, 128: 256, 64: 128, 32: 64}

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    for t in SIZES:
        src_path = os.path.join(HERE, f"ss-{SRC_FOR[t]}.png")
        img = Image.open(src_path).convert("RGBA")
        img = img.resize((t, t), Image.LANCZOS)
        out_path = os.path.join(HERE, f"icon-design-{t}.png")
        img.save(out_path, optimize=True)
        print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
