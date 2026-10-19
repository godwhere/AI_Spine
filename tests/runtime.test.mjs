import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
  pickPart,
} from "../src/spine/runtime.js";
import { parseBundle, exportPackage, unpackZip } from "../src/core/archive.js";
import { template } from "./helpers.mjs";
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
