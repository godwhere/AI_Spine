import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";
import { transformWithEsbuild } from "vite";
import { alphaBounds, compactThumbnail } from "../src/core/thumbnail.js";

const makeCanvas = () => createCanvas(1, 1);
const pixels = (canvas) => canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);

test("alpha bounds include faint edge pixels and ignore transparent RGB", () => {
  const data = new Uint8ClampedArray(10 * 8 * 4);
  data[(1 * 10 + 0) * 4 + 3] = 1;
  data[(7 * 10 + 9) * 4 + 3] = 255;
  data[4 * 4] = 255;
  assert.deepEqual(alphaBounds({ data, width: 10, height: 8 }), { left: 0, top: 1, width: 10, height: 7 });
});

test("display compaction keeps every character edge and leaves the source unchanged", () => {
  const source = createCanvas(400, 300), context = source.getContext("2d");
  for (const [color, x, y] of [["red", 180, 60], ["lime", 216, 60], ["blue", 180, 176], ["yellow", 216, 176]]) {
    context.fillStyle = color; context.fillRect(x, y, 4, 4);
  }
  const before = source.toBuffer("image/png"), result = compactThumbnail(source, makeCanvas);
  assert.equal(result.width, 128); assert.equal(result.height, 128);
  assert.deepEqual(source.toBuffer("image/png"), before);
  const output = pixels(result), bounds = alphaBounds(output);
  assert.ok(bounds.left >= 10 && bounds.top >= 10);
  assert.ok(bounds.left + bounds.width <= 118 && bounds.top + bounds.height <= 118);
  const found = new Set();
  for (let i = 0; i < output.data.length; i += 4) {
    const [r, g, b, a] = output.data.subarray(i, i + 4); if (!a) continue;
    if (r > 200 && g < 20 && b < 20) found.add("red");
    if (g > 200 && r < 20 && b < 20) found.add("green");
    if (b > 200 && r < 20 && g < 20) found.add("blue");
    if (r > 200 && g > 200 && b < 20) found.add("yellow");
  }
  assert.equal(found.size, 4, "all four outer character markers remain visible");
});

test("wide and tall artwork retains its aspect ratio with transparent padding", () => {
  for (const [width, height] of [[80, 12], [12, 80]]) {
    const source = createCanvas(200, 200), context = source.getContext("2d");
    context.fillStyle = "#7548fa"; context.fillRect(45, 53, width, height);
    const bounds = alphaBounds(pixels(compactThumbnail(source, makeCanvas)));
    assert.ok(Math.abs(bounds.width / width - bounds.height / height) < 0.03);
    assert.ok(bounds.left >= 10 && bounds.top >= 10);
    assert.ok(bounds.left + bounds.width <= 118 && bounds.top + bounds.height <= 118);
  }
});

test("opaque backgrounds and fully transparent images keep their original display", () => {
  const opaque = createCanvas(32, 32); opaque.getContext("2d").fillRect(0, 0, 32, 32);
  assert.equal(compactThumbnail(opaque, makeCanvas), null);
  assert.equal(compactThumbnail(createCanvas(32, 32), makeCanvas), null);
});

const componentSource = (await readFile(new URL("../src/components/ResourceThumbnail.jsx", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace("export function ResourceThumbnail", "function ResourceThumbnail");
const { code } = await transformWithEsbuild(componentSource, "ResourceThumbnail.jsx", { loader: "jsx", jsx: "transform", jsxFactory: "jsx" });
const componentFactory = new Function("useState", "useEffect", "compactThumbnail", "Image", "document", "jsx", `${code}; return ResourceThumbnail;`);

function thumbnailUI(compact = (image) => ({ toDataURL: () => `compact:${image.src}` })) {
  const images = []; let display = null, source, cleanup, pending, mounted = true, writesAfterUnmount = 0;
  class FakeImage { constructor() { images.push(this); } }
  const useState = () => [display, (value) => { if (!mounted) writesAfterUnmount++; display = value; }];
  const useEffect = (effect, [next]) => { if (source !== next) { source = next; pending = effect; } };
  const component = componentFactory(useState, useEffect, compact, FakeImage, { createElement() {} }, (type, props) => ({ type, props }));
  return {
    images,
    render(src) { const result = component({ src }); if (pending) { cleanup?.(); cleanup = pending(); pending = null; } return result.props.src; },
    unmount() { mounted = false; cleanup?.(); },
    get writesAfterUnmount() { return writesAfterUnmount; },
  };
}

test("changing source or closing a thumbnail ignores old image responses", () => {
  const ui = thumbnailUI(); assert.equal(ui.render("first.png"), "first.png");
  ui.images[0].onload(); assert.equal(ui.render("first.png"), "compact:first.png");
  const lateFirst = ui.images[0].onload;
  assert.equal(ui.render("second.png"), "second.png", "never show an old derivative during the next load");
  lateFirst(); assert.equal(ui.render("second.png"), "second.png");
  const lateSecond = ui.images[1].onload; ui.unmount(); lateSecond();
  assert.equal(ui.writesAfterUnmount, 0);
});

test("unreadable canvas or failed image loading falls back to the original source", () => {
  const ui = thumbnailUI(() => { throw new Error("unreadable image"); });
  ui.render("original.png"); ui.images[0].onload(); assert.equal(ui.render("original.png"), "original.png");
  ui.render("next.png"); ui.images[1].onerror(); assert.equal(ui.render("next.png"), "next.png"); ui.unmount();
});
