// Render icon-design-v2.svg -> PNG at multiple sizes via @resvg/resvg-js.
const path = require("node:path");
const { promises: fs } = require("node:fs");
const { Resvg } = require("@resvg/resvg-js");

(async () => {
  const dir = __dirname;
  const svg = await fs.readFile(path.join(dir, "icon-design.svg"), "utf8");
  const sizes = [1024, 512, 256, 128, 64, 32];
  for (const s of sizes) {
    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: s },
      background: "transparent",
    });
    const png = resvg.render().asPng();
    const out = path.join(dir, `icon-design-${s}.png`);
    await fs.writeFile(out, png);
    console.log(`Wrote ${out} (${png.length} bytes)`);
  }
})();
