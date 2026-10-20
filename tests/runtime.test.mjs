import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as spine from "@esotericsoftware/spine-webgl";
import {
  Skeleton,
  AnimationState,
  AnimationStateData,
  Physics,
  VertexAttachment,
  RegionAttachment,
} from "@esotericsoftware/spine-webgl";
import {
  parseSkeleton,
  measureAnimation,
  measurePreviewBounds,
  pickPart,
} from "../src/spine/runtime.js";
import { parseBundle, exportPackage, unpackZip, decodeText } from "../src/core/archive.js";
import { template, synthetic } from "./helpers.mjs";
const catalog = JSON.parse(
  fs.readFileSync(new URL("../public/templates/catalog.json", import.meta.url)),
);

for (const item of catalog)
  test(`${item.name}: all actions and skins preserve valid weighted vertices, paths and clipping`, () => {
    const bundle = template(item.id),
      { data } = parseSkeleton(bundle),
      skeleton = new Skeleton(data);
    const state = new AnimationState(new AnimationStateData(data));
    let poses = 0;
    for (const skin of data.skins) {
      skeleton.setSkin(skin);
      skeleton.setupPose();
      for (const animation of data.animations) {
        const track = state.setAnimation(0, animation, false);
        for (let step = 0; step <= 10; step++) {
          skeleton.setupPose();
          track.trackTime = (animation.duration * step) / 10;
          state.apply(skeleton);
          skeleton.updateWorldTransform(Physics.none);
          for (const slot of skeleton.drawOrder.appliedPose) {
            const a = slot.appliedPose.attachment;
            let vertices;
            if (a instanceof RegionAttachment) {
              vertices = new Float32Array(8);
              a.computeWorldVertices(
                slot,
                a.getOffsets(slot.appliedPose),
                vertices,
                0,
                2,
              );
            } else if (a instanceof VertexAttachment) {
              vertices = new Float32Array(a.worldVerticesLength);
              a.computeWorldVertices(
                skeleton,
                slot,
                0,
                vertices.length,
                vertices,
                0,
                2,
              );
            }
            if (vertices)
              assert.ok(
                [...vertices].every(Number.isFinite),
                `${item.name}/${animation.name}/${skin.name}`,
              );
          }
          poses++;
        }
      }
    }
    assert.ok(poses > 0);
    const restored = parseSkeleton(
      parseBundle(unpackZip(exportPackage(bundle))),
    ).data;
    assert.equal(restored.animations.length, data.animations.length);
    assert.equal(restored.bones.length, data.bones.length);
  });
test("stable animation framing and mesh triangle picking use real geometry", () => {
  const { data } = parseSkeleton(template("22")),
    bounds = measureAnimation(data, "attack", "default");
  assert.ok(bounds.width > 0 && bounds.height > 0);
  const shapes = [
    {
      id: "back",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
      ],
      triangles: [0, 1, 2],
    },
    {
      id: "front",
      points: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 0, y: 4 },
      ],
      triangles: [0, 1, 2],
    },
  ];
  assert.equal(pickPart(shapes, { x: 1, y: 1 }), "front");
  assert.equal(pickPart(shapes, { x: 8, y: 1 }), "back");
  assert.equal(pickPart(shapes, { x: 8, y: 8 }), null);
});
test("one preview frame contains every Panda action without enlarging stun", () => {
  const { data } = parseSkeleton(template("22"));
  for (const skin of data.skins) {
    const preview = measurePreviewBounds(data, skin.name),
      idle = measureAnimation(data, "idle", skin.name),
      stun = measureAnimation(data, "stun", skin.name);
    assert.ok(stun.width < idle.width, "compact stun reproduces the framing regression");
    for (const action of data.animations) {
      const bounds = measureAnimation(data, action.name, skin.name);
      assert.ok(bounds.x >= preview.x - 1e-6, action.name);
      assert.ok(bounds.y >= preview.y - 1e-6, action.name);
      assert.ok(bounds.x + bounds.width <= preview.x + preview.width + 1e-6, action.name);
      assert.ok(bounds.y + bounds.height <= preview.y + preview.height + 1e-6, action.name);
    }
  }
});
test("preview framing remains valid for imported skeletons without animations", () => {
  const { data } = parseSkeleton(synthetic());
  data.animations.length = 0;
  assert.deepEqual(measurePreviewBounds(data, "default"), measureAnimation(data, undefined, "default"));
});
test("scene rendering holds non-loop end poses and final attachments while default loops still wrap", async () => {
  const source = fs.readFileSync(new URL("../src/spine/runtime.js", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import\s*\{([^}]+)\}\s*from[^;]+;/gm)].flatMap((match) => match[1].split(",").map((name) => name.trim()).filter(Boolean));
  // Only the GPU and image decoding boundary is replaced. The scene below uses
  // the production render function and the official skeleton/animation state.
  const bindings = { ...spine, decodeText,
    ManagedWebGLRenderingContext: class { gl = { isContextLost: () => false, viewport() {}, clearColor() {}, clear() {} }; dispose() {} },
    SceneRenderer: class { skeletonRenderer = {}; camera = { setViewport() {}, position: { set() {} }, update() {} }; begin() {} drawSkeleton() {} end() {} dispose() {} },
    GLTexture: class { constructor(context, image) { this.image = image; } setFilters() {} setWraps() {} getImage() { return this.image; } dispose() {} },
  };
  class Image { width = 24; height = 24; set src(value) { queueMicrotask(() => this.onload()); } }
  const createScene = new Function(...imports, "Image", "window", `${source.replace(/^import\s*\{[^}]+\}\s*from[^;]+;\n/gm, "").replace(/\bexport (?=(?:async )?function )/g, "")};return createSpineScene;`)(...imports.map((name) => bindings[name]), Image, { devicePixelRatio: 1 });
  const bundle = synthetic();
  bundle.json.skins[0].attachments.slot.end = { path: "part", width: 10, height: 8 };
  bundle.json.animations = { death: {
    bones: { root: { rotate: [{ time: 0, value: 0 }, { time: 1.3, value: 90 }] } },
    slots: { slot: { attachment: [{ time: 0, name: "part" }, { time: Math.fround(1.3), name: "end" }] } },
  } };
  const canvas = { clientWidth: 640, clientHeight: 480, width: 0, height: 0, dataset: {} };
  const scene = await createScene(bundle, canvas), duration = scene.data.findAnimation("death").duration;
  try {
    const render = (time, loop) => scene.render({ animation: "death", skin: "default", time, ...(loop === undefined ? {} : { loop }), zoom: 1.4, pan: { x: 17, y: -9 } });
    render(0, false); const start = canvas.dataset.poseChecksum, camera = [canvas.dataset.viewScale, canvas.dataset.viewCenter];
    render(1.3, false); const end = canvas.dataset.poseChecksum;
    assert.notEqual(end, start);
    assert.equal(scene.skeleton.findSlot("slot").appliedPose.attachment.name, "end");
    assert.ok(Math.abs(scene.skeleton.findBone("root").appliedPose.a) < 1e-6);
    assert.equal(canvas.dataset.animationTime, "1.300");
    render(8, false);
    assert.equal(canvas.dataset.poseChecksum, end, "overshooting keeps the actual last world vertices");
    assert.equal(scene.skeleton.findSlot("slot").appliedPose.attachment.name, "end");
    render(0.2, false); assert.notEqual(canvas.dataset.poseChecksum, end, "scrubbing backward still applies animation state");
    render(duration, true);
    assert.equal(canvas.dataset.poseChecksum, start); assert.equal(scene.skeleton.findSlot("slot").appliedPose.attachment.name, "part");
    render(duration, false); assert.equal(canvas.dataset.poseChecksum, end, "changing loop updates the existing track");
    render(duration);
    assert.equal(canvas.dataset.poseChecksum, start, "existing callers still repeat by default");
    assert.deepEqual([canvas.dataset.viewScale, canvas.dataset.viewCenter], camera, "time/loop changes preserve the shared frame and manual zoom/pan");
  } finally { scene.dispose(); }
});
test("official 4.3 binary example imports, samples animation and re-exports unchanged", () => {
  const directory = new URL("./fixtures/binary/", import.meta.url);
  const files = Object.fromEntries(
    ["spineboy-pro.skel", "spineboy.atlas", "spineboy.png"].map((name) => [
      name,
      new Uint8Array(fs.readFileSync(new URL(name, directory))),
    ]),
  );
  const bundle = parseBundle(files),
    { data } = parseSkeleton(bundle);
  assert.equal(data.animations.length, 11);
  assert.ok(measureAnimation(data, "walk", "default").width > 0);
  assert.deepEqual(
    unpackZip(exportPackage(bundle))["spineboy-pro.skel"],
    files["spineboy-pro.skel"],
  );
});
