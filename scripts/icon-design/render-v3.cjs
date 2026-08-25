// Supersampled render: rasterize the SVG at 2x the target resolution with
// @resvg/resvg-js, then let downsample.py apply a LANCZOS (high-quality)
// downscale to the final size. This produces cleaner edges and sharper small
// icons than rendering straight at the target size.
const path = require("node:path");
const { promises: fs } = require("node:fs");
const { Resvg } = require("@resvg/resvg-js");

(async () => {
  const dir = __dirname;
  const svg = await fs.readFile(path.join(dir, "icon-design.svg"), "utf8");
  // Each target size is rendered at 2x; ss-2048 is also the master source.
  const srcSizes = [2048, 1024, 512, 256, 128, 64];
  for (const s of srcSizes) {
    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: s },
      background: "transparent",
    });
    const png = resvg.render().asPng();
    const out = path.join(dir, `ss-${s}.png`);
    await fs.writeFile(out, png);
    console.log(`Wrote ${out} (${png.length} bytes)`);
  }
})();
