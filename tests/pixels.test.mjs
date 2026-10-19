import test from "node:test";
import assert from "node:assert/strict";
import {
  extractPart,
  compilePages,
  renderReplacement,
  autoFit,
  identityTransform,
  alphaBounds,
} from "../src/core/pixels.js";
import { parseBundle, exportPackage, unpackZip } from "../src/core/archive.js";
import { pixelEnv as env, synthetic, template } from "./helpers.mjs";
const pixel = (canvas, x, y) => [
  ...canvas.getContext("2d").getImageData(x, y, 1, 1).data,
];
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
