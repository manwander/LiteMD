// Render icon-design.svg -> icon-design-1024.png via @resvg/resvg-js.
const path = require("node:path");
const { promises: fs } = require("node:fs");
const { Resvg } = require("@resvg/resvg-js");

(async () => {
  const svgPath = path.join(__dirname, "icon-design.svg");
  const out1024 = path.join(__dirname, "icon-design-1024.png");
  const svg = await fs.readFile(svgPath, "utf8");
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1024 },
    background: "transparent",
  });
  const pngData = resvg.render().asPng();
  await fs.writeFile(out1024, pngData);
  console.log(`Wrote ${out1024} (${pngData.length} bytes)`);
})();