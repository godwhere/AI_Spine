import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { RigJobs } from "../server/rig-service.mjs";
import { RIG_PART_IMAGE_INSTRUCTIONS } from "../server/rig-planning.mjs";

async function generatedPrompt(t, { features = false, selected = "head" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ispine-complete-part-prompt-")), id = "fixture";
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, id); await mkdir(folder);
  const canvas = createCanvas(64, 64), context = canvas.getContext("2d");
  context.fillStyle = "#f2bfa0"; context.fillRect(12, 8, 40, 48);
  const png = canvas.toBuffer("image/png"); await writeFile(join(folder, "source.png"), png);
  const parts = [
    { id: "head", label: "头部脸底", bone: "head", x: 8, y: 4, width: 48, height: 56, z: 1, binding: "rigid", influences: ["head"] },
    { id: "sleeve", label: "袖口", bone: "forearm", x: 20, y: 20, width: 20, height: 30, z: 2, binding: "rigid", influences: ["forearm"] },
    { id: "frontHair", label: "头发cap", bone: "head", x: 8, y: 4, width: 48, height: 32, z: 4, binding: "rigid", influences: ["head"] },
    ...(features ? [{ id: "eye_open", label: "睁眼", bone: "head", x: 22, y: 16, width: 16, height: 12, z: 3, binding: "rigid", influences: ["head"], attachmentGroup: "eyeLeft" }] : []),
  ];
  const provider = { id: "codex-native", model: "managed-native" }, job = { id, request: { rig: { width: 64, height: 64, parts }, provider,
    sourceFingerprint: "a".repeat(64), prompt: "保持角色比例" }, controller: new AbortController(), images: [] };
  const originalRequest = structuredClone(job.request); let prompt, calls = 0;
  const service = Object.create(RigJobs.prototype);
  service.root = root;
  service.connections = { async generate(selectedProvider, options) {
    calls++; assert.equal(selectedProvider, provider); assert.equal(options.instructions, RIG_PART_IMAGE_INSTRUCTIONS);
    assert.deepEqual(options.references, [join(folder, "reference-0.png"), join(folder, "source.png")]);
    assert.deepEqual(await readFile(options.references[1]), png); prompt = options.prompt;
    return { result: png.toString("base64"), model: "test-native-image" };
  } };
  await service.generatePart(job, selected, 0);
  assert.equal(calls, 1); assert.deepEqual(job.request, originalRequest);
  assert.equal(job.images[0].provider, "codex-native"); assert.equal(job.images[0].raw.width, 64);
  assert.deepEqual(await readFile(join(folder, "image-0-raw.png")), png);
  return prompt;
}

test("part production request requires complete independent support and overlap without changing the frozen provider or raw PNG", async (t) => {
  const prompt = await generatedPrompt(t, { selected: "sleeve" });
  assert.match(prompt, /continuous skeletal animation with joint overlap/);
  assert.match(prompt, /Retain real hidden surfaces and rounded joint ends/);
  assert.match(prompt, /do not include neighboring limbs, hair, clothing, skin, props or a whole-body substitute/);
  assert.match(prompt, /Do not crop a joint flush/); assert.match(prompt, /original character proportions/);
  assert.match(prompt, /fixed logical rectangle without stretching/); assert.doesNotMatch(prompt, /BLANK FACE BASE/);
});

test("a head with separate facial groups requests filled blank skin with no holes or neighboring hair and collar", async (t) => {
  const prompt = await generatedPrompt(t, { features: true });
  assert.match(prompt, /BLANK FACE BASE/); assert.match(prompt, /continuous blank skin/);
  assert.match(prompt, /No eyes, eyebrows or mouth; they are separate attachments/);
  assert.match(prompt, /Do not punch holes, transparent eye sockets or mouth cutouts/);
  assert.match(prompt, /Do not include front hair, neck collar/);
});

test("expression parts stay isolated while a head without separate facial groups is not forced to discard its features", async (t) => {
  const expression = await generatedPrompt(t, { features: true, selected: "eye_open" });
  assert.match(expression, /one isolated expression attachment/);
  assert.match(expression, /do not add the full face or a skin-colored background patch/);
  assert.doesNotMatch(expression, /BLANK FACE BASE/);
  assert.doesNotMatch(await generatedPrompt(t), /BLANK FACE BASE/);
  assert.doesNotMatch(await generatedPrompt(t, { features: true, selected: "frontHair" }), /BLANK FACE BASE/, "head-bound hair must keep its strands, not be regenerated as blank skin");
});
