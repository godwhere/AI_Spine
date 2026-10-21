import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { captureTemplatePreview } from "../src/infrastructure/template-preview.js";
import { synthetic } from "./helpers.mjs";

function documentFixture({ emptyOutput = false } = {}) {
  const canvases = [], attached = new Set();
  return {
    canvases, attached,
    body: { appendChild(canvas) { attached.add(canvas); } },
    querySelector() { throw new Error("Edited preview must not be queried"); },
    createElement(tag) {
      assert.equal(tag, "canvas");
      const canvas = createCanvas(768, 768);
      canvas.style = {};
      canvas.setAttribute = () => {};
      canvas.remove = () => attached.delete(canvas);
      Object.defineProperties(canvas, {
        clientWidth: { get: () => attached.has(canvas) ? 768 : 0 },
        clientHeight: { get: () => attached.has(canvas) ? 768 : 0 },
      });
      canvas.toBlob = (callback, type) => callback(emptyOutput ? null : new Blob([canvas.toBuffer("image/png")], { type }));
      canvases.push(canvas);
      return canvas;
    },
  };
}
const hashes = (files) => Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, createHash("sha256").update(bytes).digest("hex")]));

test("template reference renders original files, preserves edits and normalizes Retina output", async () => {
  const bundle = synthetic(), document = documentFixture();
  const replacement = createCanvas(24, 24);
  replacement.getContext("2d").fillStyle = "#00ffff";
  replacement.getContext("2d").fillRect(0, 0, 24, 24);
  bundle.edits = { part: { image: new Uint8Array(replacement.toBuffer("image/png")), transform: { x: 9, y: -4, scaleX: 2, scaleY: 2, rotation: 15 } } };
  const originals = hashes(bundle.files), edits = structuredClone(bundle.edits);
  let disposed = 0;
  const bytes = await captureTemplatePreview(bundle, { animation: "idle", skin: "default", time: 1.25 }, {
    document,
    async createScene(source, canvas) {
      assert.equal(source, bundle);
      assert.equal(canvas.clientWidth, 768);
      assert.equal(canvas.clientHeight, 768);
      assert.match(canvas.style.cssText, /left:-10000px/);
      assert.doesNotMatch(canvas.style.cssText, /display:none/);
      const original = await loadImage(Buffer.from(source.files["page.png"]));
      return {
        updatePages() { throw new Error("Compiled pages must not replace original atlas pages"); },
        render(pose) {
          assert.deepEqual(pose, { animation: "idle", skin: "default", time: 1.25 });
          canvas.width = canvas.height = 1536;
          canvas.getContext("2d").drawImage(original, 0, 0, 1536, 1536);
        },
        dispose() { disposed++; },
      };
    },
  });
  assert.ok(bytes instanceof Uint8Array);
  const image = await loadImage(Buffer.from(bytes));
  assert.equal(image.width, 768);
  assert.equal(image.height, 768);
  const readback = createCanvas(768, 768), context = readback.getContext("2d");
  context.drawImage(image, 0, 0);
  assert.deepEqual([...context.getImageData(1, 1, 1, 1).data], [231, 52, 174, 255]);
  assert.deepEqual(hashes(bundle.files), originals);
  assert.deepEqual(bundle.edits, edits);
  assert.equal(disposed, 1);
  assert.equal(document.attached.size, 0);
});

test("scene creation failure removes the temporary canvas", async () => {
  const document = documentFixture();
  await assert.rejects(() => captureTemplatePreview(synthetic(), {}, {
    document, createScene: async () => { throw new Error("WebGL unavailable"); },
  }), /WebGL unavailable/);
  assert.equal(document.attached.size, 0);
});

for (const failure of ["render", "PNG"]) test(`${failure} failure disposes the scene and removes its canvas`, async () => {
  const document = documentFixture({ emptyOutput: failure === "PNG" });
  let disposed = 0;
  await assert.rejects(() => captureTemplatePreview(synthetic(), {}, {
    document, createScene: async () => ({
      render() { if (failure === "render") throw new Error("Render unavailable"); },
      dispose() { disposed++; },
    }),
  }), failure === "render" ? /Render unavailable/ : /模板参考图片读取失败/);
  assert.equal(disposed, 1);
  assert.equal(document.attached.size, 0);
});
