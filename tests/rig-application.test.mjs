import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { createRigSession } from "../src/application/rig-session.js";
import { createRigCommands } from "../src/application/rig-commands.js";
import { createRigOperations } from "../src/application/rig-operations.js";
import { createCalibrationSession } from "../src/application/part-calibration.js";
import { buildRigFiles } from "../engine/rig/build-files.js";
import { parseSkeleton } from "../engine/spine/parse.js";
import { validateRigDocument } from "../shared/rig-schema.mjs";
import { pixelEnv } from "./helpers.mjs";

function fixture() {
  const canvas = createCanvas(24, 24); canvas.getContext("2d").fillRect(4, 4, 16, 16);
  const image = canvas.toDataURL("image/png");
  return validateRigDocument({ version: 1, id: "application-rig", name: "Application fixture", width: 64, height: 64, sourceImage: image,
    joints: [{ id: "root", parent: null, x: 32, y: 32 }, { id: "hand", parent: "root", x: 48, y: 32 }],
    parts: [{ id: "body", bone: "root", x: 16, y: 16, width: 24, height: 24, z: 0, binding: "mesh", influences: ["root", "hand"],
      mesh: { cols: 3, rows: 3 }, image, imageSource: "uploaded", completion: "ready" }],
    motions: ["idle", "hit"].map((id) => ({ id, name: id, duration: 1, loop: id === "idle", origin: "manual", poses: [{ time: 0, angles: {} }, { time: 1, angles: {} }] })) });
}

test("rig commands retain one document history, normalize edited weights and leave unrelated content immutable", () => {
  const document = fixture(), original = structuredClone(document), session = createRigSession(document);
  const commands = createRigCommands(session, { createId: () => "variant" });
  commands.setVertexWeight("body", 0, "hand", 0.8);
  const weighted = session.getDocument(); assert.notEqual(weighted, document);
  assert.equal(weighted.parts[0].image, document.parts[0].image); assert.deepEqual(weighted.motions, document.motions);
  assert.ok(Math.abs(weighted.parts[0].mesh.weights[0].reduce((sum, value) => sum + value.weight, 0) - 1) < 1e-9);
  commands.setInfluence("body", "root", false);
  assert.deepEqual(session.getDocument().parts[0].mesh.weights[0], [{ joint: "hand", weight: 1 }]);
  assert.throws(() => commands.setInfluence("body", "hand", false), /至少保留/);
  session.undo(); assert.equal(session.getDocument(), weighted);
  commands.setPartGroup("body", "eyeLeft");
  const created = commands.addPart({ duplicateId: "body", boneId: "root" });
  assert.deepEqual(created, { id: "part-variant", group: "eyeLeft" });
  const variant = session.getDocument().parts.at(-1);
  assert.equal(variant.image, undefined); assert.equal(variant.completion, "needs-inpaint");
  commands.setDefaultAttachment("eyeLeft", variant.id); commands.removePart(variant.id);
  assert.equal(session.getDocument().parts.length, 1); assert.deepEqual(document, original);
});

test("rig publication checks every motion before compiling a real editable Spine preview", async () => {
  const document = fixture(), checked = [], report = { finite: true, issues: ["Unreachable secondary grip"] };
  const operations = createRigOperations({ images: {}, buildFiles: (value) => buildRigFiles(value, pixelEnv),
    inspectMotion: async (_value, id) => { checked.push(id); return id === "hit" ? report : { finite: true, issues: [] }; } });
  await assert.rejects(operations.validateForSave(document), (error) => error.motionId === "hit" && error.report === report);
  assert.deepEqual(checked, ["idle", "hit"]);
  const result = await operations.preview(document);
  assert.deepEqual(result.bundle.animations, ["idle", "hit"]);
  const parsed = parseSkeleton(result.bundle).data;
  assert.equal(parsed.bones.length, 2); assert.ok(parsed.skins[0].getAttachments().length > 0);
  assert.deepEqual(result.document.parts, document.parts);
});

test("temporary calibration cannot overwrite a replacement with late initialization and cancel leaves the project edit unchanged", () => {
  const image = new Uint8Array([1, 2, 3]), source = { image, transform: { x: 0, scaleX: 1, scaleY: 1 } };
  const session = createCalibrationSession(source);
  session.remember(); session.patch({ x: 4 }, false); session.patch({ y: 2 }, false);
  const moved = session.getSnapshot().draft; session.undo(); assert.equal(session.getSnapshot().draft, source);
  session.redo(); assert.equal(session.getSnapshot().draft, moved); assert.equal(moved.image, image);
  const replacement = { image: new Uint8Array([4]), transform: { x: 1 } };
  const empty = createCalibrationSession(); empty.replace(replacement); empty.initialize(source);
  assert.equal(empty.getSnapshot().draft, replacement);
  assert.deepEqual(source.transform, { x: 0, scaleX: 1, scaleY: 1 }); assert.equal(source.image, image);
});
