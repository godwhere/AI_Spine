import test from "node:test";
import assert from "node:assert/strict";
import {
  extractPart,
  extractPartFromImage,
  compilePages,
  renderReplacement,
  autoFit,
  identityTransform,
  alphaBounds,
  browserPixels,
} from "../src/core/pixels.js";
import { parseBundle, exportPackage, unpackZip } from "../src/core/archive.js";
import { pixelEnv as env, synthetic, template } from "./helpers.mjs";
const pixel = (canvas, x, y) => [
  ...canvas.getContext("2d").getImageData(x, y, 1, 1).data,
];

function installBrowserGlobals(t, values) {
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => { for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } });
}

function offscreenPixels(t) {
  const calls = { created: [], encoded: 0, html: 0, idle: 0, decoded: 0, closed: 0 };
  function Offscreen(width, height) {
    const canvas = env.createCanvas(width, height); calls.created.push(canvas);
    canvas.convertToBlob = Offscreen.prototype.convertToBlob;
    canvas.toBlob = () => { calls.idle++; throw new Error("Offscreen encoding must not use the HTML idle callback"); };
    canvas.toDataURL = () => { throw new Error("Pixel consumers must not require HTMLCanvas serialization"); };
    return canvas;
  }
  Offscreen.prototype.convertToBlob = async function (options) {
    assert.deepEqual(options, { type: "image/png" }); calls.encoded++;
    return new Blob([await env.encode(this)], { type: "image/png" });
  };
  installBrowserGlobals(t, { OffscreenCanvas: Offscreen,
    document: { createElement() { calls.html++; throw new Error("Offscreen pixels must not allocate a DOM canvas"); } },
    createImageBitmap: async (blob) => { calls.decoded++; const image = await env.loadImage(new Uint8Array(await blob.arrayBuffer())); image.close = () => { calls.closed++; }; return image; } });
  return calls;
}

test("browser pixel allocation and PNG encoding prefer OffscreenCanvas without a DOM canvas or idle callback", async (t) => {
  const calls = offscreenPixels(t), canvas = browserPixels.createCanvas(6, 4), context = canvas.getContext("2d");
  context.fillStyle = "#e8599a"; context.fillRect(1, 1, 4, 2);
  const bytes = await browserPixels.encode(canvas), image = await env.loadImage(bytes), actual = env.createCanvas(6, 4);
  actual.getContext("2d").drawImage(image, 0, 0);
  assert.equal(calls.created.length, 1, "encoding does not copy into an additional canvas");
  assert.equal(calls.encoded, 1); assert.equal(calls.html, 0); assert.equal(calls.idle, 0);
  assert.deepEqual(pixel(actual, 1, 1), [232, 89, 154, 255]); assert.equal(pixel(actual, 0, 0)[3], 0);
  assert.deepEqual(actual.getContext("2d").getImageData(0, 0, 6, 4).data, context.getImageData(0, 0, 6, 4).data);
});

test("browser pixels retain HTMLCanvas toBlob fallback when OffscreenCanvas is unavailable", async (t) => {
  let created = 0, encoded = 0;
  installBrowserGlobals(t, { OffscreenCanvas: undefined, document: { createElement(tag) {
    assert.equal(tag, "canvas"); created++; const canvas = env.createCanvas(1, 1);
    canvas.convertToBlob = undefined; // Match HTMLCanvasElement rather than the native test canvas API.
    canvas.toBlob = (callback, type) => { assert.equal(type, "image/png"); encoded++; queueMicrotask(() => callback(new Blob([canvas.toBuffer("image/png")], { type }))); };
    return canvas;
  } } });
  const canvas = browserPixels.createCanvas(3, 5); canvas.getContext("2d").fillStyle = "#4fc283"; canvas.getContext("2d").fillRect(1, 2, 1, 1);
  const image = await env.loadImage(await browserPixels.encode(canvas)), decoded = env.createCanvas(3, 5); decoded.getContext("2d").drawImage(image, 0, 0);
  assert.equal(created, 1); assert.equal(encoded, 1); assert.equal(image.width, 3); assert.equal(image.height, 5);
  assert.deepEqual(pixel(decoded, 1, 2), [79, 194, 131, 255]); assert.equal(pixel(decoded, 0, 0)[3], 0);
});

test("an incomplete Offscreen implementation falls back without allocating an unusable canvas", (t) => {
  let offscreen = 0, html = 0;
  function Unsupported() { offscreen++; throw new Error("Missing asynchronous encoder"); }
  installBrowserGlobals(t, { OffscreenCanvas: Unsupported, document: { createElement() { html++; return env.createCanvas(1, 1); } } });
  const canvas = browserPixels.createCanvas(7, 9);
  assert.equal(canvas.width, 7); assert.equal(canvas.height, 9); assert.equal(html, 1); assert.equal(offscreen, 0);
});

test("PNG conversion failures propagate without falling back to an idle callback or accepting empty output", async () => {
  const failure = new DOMException("Cannot encode fixture", "EncodingError"); let fallback = 0;
  await assert.rejects(browserPixels.encode({ async convertToBlob() { throw failure; }, toBlob() { fallback++; } }), (error) => error === failure);
  assert.equal(fallback, 0);
  await assert.rejects(browserPixels.encode({ async convertToBlob() { return null; } }), /PNG 编码失败/);
  await assert.rejects(browserPixels.encode({ toBlob(callback) { callback(null); } }), /PNG 编码失败/);
  const security = new DOMException("Tainted fixture", "SecurityError");
  await assert.rejects(browserPixels.encode({ toBlob() { throw security; } }), (error) => error === security);
});

test("the default offscreen adapter keeps rotated extraction, calibration and page assembly pixel-identical", async (t) => {
  const calls = offscreenPixels(t), bundle = synthetic({ rotate: 90 }), part = bundle.parts[0];
  const original = await extractPart(bundle, part), bytes = await browserPixels.encode(original);
  const replacement = await renderReplacement(part, { image: bytes, transform: identityTransform() });
  assert.deepEqual(replacement.getContext("2d").getImageData(0, 0, replacement.width, replacement.height).data,
    original.getContext("2d").getImageData(0, 0, original.width, original.height).data);
  const pages = await compilePages(bundle, { [part.id]: { image: bytes, transform: identityTransform() } });
  const expected = await env.loadImage(bundle.files[part.pageFile]), actual = await env.loadImage(pages[part.pageFile]);
  const expectedCanvas = env.createCanvas(24, 24), actualCanvas = env.createCanvas(24, 24);
  expectedCanvas.getContext("2d").drawImage(expected, 0, 0); actualCanvas.getContext("2d").drawImage(actual, 0, 0);
  assert.deepEqual(actualCanvas.getContext("2d").getImageData(0, 0, 24, 24).data, expectedCanvas.getContext("2d").getImageData(0, 0, 24, 24).data);
  assert.equal(calls.html, 0); assert.equal(calls.idle, 0); assert.ok(calls.encoded >= 2); assert.equal(calls.decoded, calls.closed);
});
test("borrowed-page extraction preserves rotation, trim and PMA without decoding or closing the caller's bitmap", async () => {
  for (const rotate of [0, 90]) for (const pma of [false, true]) {
    const bundle = synthetic({ rotate, pma }), part = bundle.parts[0], image = await env.loadImage(bundle.files[part.pageFile]); let closed = 0;
    image.close = () => { closed++; };
    const borrowed = { ...env, loadImage() { throw new Error("A borrowed page must not be decoded again"); } },
      first = extractPartFromImage(image, part, borrowed), second = extractPartFromImage(image, part, borrowed);
    assert.equal(closed, 0); assert.equal(first.width, 10); assert.equal(first.height, 8);
    assert.deepEqual(first.getContext("2d").getImageData(0, 0, 10, 8).data, second.getContext("2d").getImageData(0, 0, 10, 8).data);
    const red = pixel(first, 2, 3), green = pixel(first, 7, 3), blue = pixel(first, 2, 6);
    assert.ok(red[0] >= 250 && red[1] === 0 && red[2] === 0); assert.ok(green[1] >= 250 && green[0] === 0 && green[2] === 0);
    assert.ok(blue[2] >= 250 && blue[0] === 0 && blue[1] === 0); assert.equal(red[3], pma ? 128 : 255); assert.equal(pixel(first, 0, 0)[3], 0);
    image.close(); assert.equal(closed, 1);
  }
});

test("failed extraction releases its crop while owned and borrowed pages keep distinct close lifetimes", async () => {
  const bundle = synthetic({ pma: true }), part = bundle.parts[0], image = await env.loadImage(bundle.files[part.pageFile]), canvases = []; let closed = 0;
  image.close = () => { closed++; };
  const failing = { ...env, loadImage: async () => image, createCanvas(width, height) {
    const canvas = env.createCanvas(width, height), context = canvas.getContext("2d"); canvases.push(canvas);
    const proxy = new Proxy(context, { get(target, key) { if (key === "getImageData") return () => { throw new Error("injected pixel read failure"); };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } });
    canvas.getContext = () => proxy; return canvas;
  } };
  assert.throws(() => extractPartFromImage(image, part, failing), /pixel read failure/); assert.equal(closed, 0);
  await assert.rejects(extractPart(bundle, part, failing), /pixel read failure/); assert.equal(closed, 1);
  assert.ok(canvases.every((canvas) => canvas.width === 1 && canvas.height === 1));
});
for (const rotate of [0, 90])
  test(`rotated ${rotate}° trimmed region extracts upright and writes back without touching neighbors`, async () => {
    const bundle = synthetic({ rotate }),
      part = bundle.parts[0],
      extracted = await extractPart(bundle, part, env);
    assert.deepEqual(pixel(extracted, 2, 3), [255, 0, 0, 255]);
    assert.deepEqual(pixel(extracted, 7, 3), [0, 255, 0, 255]);
    assert.deepEqual(pixel(extracted, 2, 6), [0, 0, 255, 255]);
    assert.equal(pixel(extracted, 0, 0)[3], 0);
    const edits = {
      part: {
        image: await env.encode(extracted),
        transform: identityTransform(),
      },
    };
    const pages = await compilePages(bundle, edits, env),
      image = await env.loadImage(pages["page.png"]),
      page = env.createCanvas(24, 24);
    page.getContext("2d").drawImage(image, 0, 0);
    const original = await env.loadImage(bundle.files["page.png"]),
      originalCanvas = env.createCanvas(24, 24);
    originalCanvas.getContext("2d").drawImage(original, 0, 0);
    assert.deepEqual(
      [...page.getContext("2d").getImageData(0, 0, 24, 24).data],
      [...originalCanvas.getContext("2d").getImageData(0, 0, 24, 24).data],
    );
  });
test("PMA edit unpremultiplies for calibration and premultiplies only modified atlas pixels", async () => {
  const bundle = synthetic({ pma: true }),
    part = bundle.parts[0],
    extracted = await extractPart(bundle, part, env);
  assert.ok(pixel(extracted, 2, 3)[0] >= 250);
  assert.equal(pixel(extracted, 2, 3)[3], 128);
  const pages = await compilePages(
    bundle,
    {
      part: {
        image: await env.encode(extracted),
        transform: identityTransform(),
      },
    },
    env,
  );
  const image = await env.loadImage(pages["page.png"]),
    canvas = env.createCanvas(24, 24);
  canvas.getContext("2d").drawImage(image, 0, 0);
  const actual = pixel(canvas, 2, 3);
  assert.ok(Math.abs(actual[0] - 128) <= 2);
  assert.equal(actual[3], 128);
  assert.deepEqual(pixel(canvas, 0, 0), [231, 52, 174, 255]);
});
test("alpha-based alignment ignores transparent padding and respects aspect ratio", async () => {
  const bundle = synthetic(),
    part = bundle.parts[0],
    image = env.createCanvas(10, 10),
    ctx = image.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(3, 6, 4, 2);
  const bytes = await env.encode(image),
    transform = await autoFit(bundle, part, bytes, env);
  const rendered = await renderReplacement(
      part,
      { image: bytes, transform },
      env,
    ),
    bounds = alphaBounds(
      rendered
        .getContext("2d")
        .getImageData(0, 0, rendered.width, rendered.height),
    );
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - 5) <= 0.6);
  assert.ok(Math.abs(bounds.y + bounds.height / 2 - 5) <= 0.6);
  assert.equal(transform.scaleX, transform.scaleY);
  assert.ok(bounds.width <= 8);
  await assert.rejects(
    () =>
      autoFit(bundle, part, env.createCanvas(2, 2).toBuffer("image/png"), env),
    /完全透明/,
  );
});
test("translation, rotation and mirroring change real output pixels", async () => {
  const bundle = synthetic(),
    part = bundle.parts[0],
    original = await extractPart(bundle, part, env),
    image = await env.encode(original);
  const mirrored = await renderReplacement(
    part,
    { image, transform: { ...identityTransform(), flipX: true } },
    env,
  );
  assert.deepEqual(pixel(mirrored, 2, 3), [0, 255, 0, 255]);
  const translated = await renderReplacement(
    part,
    { image, transform: { ...identityTransform(), x: 2 } },
    env,
  );
  assert.equal(pixel(translated, 2, 3)[3], 0);
  assert.deepEqual(pixel(translated, 4, 3), [255, 0, 0, 255]);
  const rotated = await renderReplacement(
    part,
    { image, transform: { ...identityTransform(), rotation: 180 } },
    env,
  );
  assert.notDeepEqual(pixel(rotated, 2, 3), pixel(original, 2, 3));
});
test("real weighted-mesh template replacement survives resource export and editable project roundtrip", async () => {
  const bundle = template("22"),
    part = bundle.parts.find((p) => p.degrees === 90 && p.width > 60);
  const image = await env.encode(await extractPart(bundle, part, env));
  const edits = {
    [part.id]: {
      image,
      fileName: "actual-part.png",
      transform: { ...identityTransform(), x: 3, flipX: true },
    },
  };
  const pages = await compilePages(bundle, edits, env);
  assert.notDeepEqual(pages["skeleton.png"], bundle.files["skeleton.png"]);
  const imported = parseBundle(unpackZip(exportPackage(bundle, pages)));
  assert.deepEqual(imported.json, bundle.json);
  assert.equal(imported.parts.length, bundle.parts.length);
  const project = parseBundle(
    unpackZip(exportPackage(bundle, pages, { editable: true, edits })),
  );
  assert.deepEqual(await compilePages(project, project.edits, env), pages);
});
test("multi-page export changes only the edited page and keeps both page references", async () => {
  const base = synthetic(),
    files = { ...base.files };
  files["skeleton.atlas"] = new TextEncoder().encode(
    new TextDecoder().decode(files["skeleton.atlas"]) +
      "\n" +
      "other.png\nsize:24,24\nfilter:Linear,Linear\nother-part\nbounds:0,0,4,4\n",
  );
  files["other.png"] = files["page.png"];
  const bundle = parseBundle(files),
    part = bundle.parts[0],
    image = await env.encode(await extractPart(bundle, part, env));
  const pages = await compilePages(
    bundle,
    { part: { image, transform: { ...identityTransform(), flipX: true } } },
    env,
  );
  assert.equal(Object.keys(pages).length, 1);
  assert.ok(pages["page.png"]);
  const output = unpackZip(exportPackage(bundle, pages));
  assert.deepEqual(output["other.png"], files["other.png"]);
  assert.equal(parseBundle(output).pages.length, 2);
});
