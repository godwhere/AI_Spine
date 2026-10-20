import fs from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { parseBundle } from "../src/core/archive.js";
export const pixelEnv = {
  createCanvas,
  loadImage: (bytes) => loadImage(Buffer.from(bytes)),
  encode: async (canvas) => new Uint8Array(canvas.toBuffer("image/png")),
};
export function template(id) {
  const directory = new URL(`../public/templates/${id}/`, import.meta.url);
  const item = JSON.parse(fs.readFileSync(new URL("../public/templates/catalog.json", import.meta.url), "utf8"))
    .find((entry) => String(entry.id) === String(id));
  if (!item) throw new Error(`Unknown template ${id}`);
  const paths = [...new Set([item.skeletonFile, ...item.atlasFiles, ...item.textureFiles])];
  return parseBundle(
    Object.fromEntries(
      paths.map((name) => [
        name,
        new Uint8Array(fs.readFileSync(new URL(name, directory))),
      ]),
    ),
    { name: `Template ${id}`, id: `test-${id}` },
  );
}
export function synthetic({ rotate = 0, pma = false, nested = false } = {}) {
  const canvas = createCanvas(24, 24),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "#e734ae";
  ctx.fillRect(0, 0, 24, 24);
  const image = ctx.getImageData(0, 0, 24, 24);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 6; x++) {
      const dx = 2 + (rotate ? y : x),
        dy = 3 + (rotate ? 5 - x : y),
        index = (dy * 24 + dx) * 4;
      const color =
        x < 3
          ? y < 2
            ? [255, 0, 0]
            : [0, 0, 255]
          : y < 2
            ? [0, 255, 0]
            : [255, 255, 0];
      image.data.set(
        [...color.map((c) => (pma ? Math.round(c * 0.5) : c)), pma ? 128 : 255],
        index,
      );
    }
  ctx.putImageData(image, 0, 0);
  const name = nested ? "textures/page.png" : "page.png";
  const atlas = `${name}\nsize:24,24\nfilter:Linear,Linear\npma:${pma}\npart\nbounds:2,3,6,4\noffsets:2,1,10,8\nrotate:${rotate}\n`;
  const json = {
    skeleton: { spine: "4.3.23" },
    bones: [{ name: "root" }],
    slots: [{ name: "slot", bone: "root", attachment: "part" }],
    skins: [
      {
        name: "default",
        attachments: { slot: { part: { width: 10, height: 8 } } },
      },
    ],
    animations: { idle: {} },
  };
  return parseBundle({
    "skeleton.json": new TextEncoder().encode(JSON.stringify(json)),
    "skeleton.atlas": new TextEncoder().encode(atlas),
    "page.png": new Uint8Array(canvas.toBuffer("image/png")),
  });
}
