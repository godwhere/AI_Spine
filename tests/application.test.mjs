import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { createResourceActions } from "../src/application/resource-actions.js";
import { createProjectExporter } from "../src/application/export-project.js";
import { createCandidateApplication } from "../src/application/apply-candidate.js";
import { createEditorPersistence } from "../src/application/editor-persistence.js";
import { createEditorSession } from "../src/application/editor-session.js";
import { editorRecord, prepareBundle } from "../src/application/project-bundle.js";
import { sameAuthoredProjectContent } from "../shared/domain/project.mjs";
import { templateFingerprint } from "../shared/domain/generation.mjs";
import { compilePages } from "../engine/images/calibration.js";
import { exportPackage } from "../engine/archive/package.js";
import { unpackZip } from "../engine/archive/zip.js";
import { parseBundle } from "../engine/archive/bundle.js";
import { parseSkeleton } from "../engine/spine/parse.js";
import { addTemplateVariant } from "../engine/archive/template-variants.js";
import { applyGeneratedParts } from "../src/infrastructure/generation-client.js";
import { template, pixelEnv } from "./helpers.mjs";

function fixture(id = 22) {
  const bundle = prepareBundle(template(id)), savedTemplates = new Map(), writes = [];
  const image = createCanvas(12, 16), context = image.getContext("2d"); context.fillStyle = "#9d4d74"; context.fillRect(2, 2, 8, 12);
  const png = new Uint8Array(image.toBuffer("image/png"));
  const source = { id: "fixture-resource", name: "Fixture", files: bundle.files, skeletonPath: bundle.skeletonPath,
    edits: { [bundle.parts[0].id]: { image: png, transform: { x: 1, y: 0, scaleX: 1, scaleY: 1, rotation: 0 } } },
    generation: { partsPrompt: "Private authored brief" }, updatedAt: "2026-10-20T00:00:00Z" };
  const projects = { get: async () => source, preview: async () => source, library: async () => ({ projects: [source], trash: [] }),
    trash: async (id) => writes.push(["trash", id]), restore: async (id) => writes.push(["restore", id]),
    remove: async (ids) => { writes.push(["remove", ids]); return ids.length; } };
  const templates = { save: async (record) => { savedTemplates.set(record.id, record); writes.push(["template", record.id]); return record; },
    list: async () => [...savedTemplates.values()], get: async (id) => savedTemplates.get(id), remove: async (id) => savedTemplates.delete(id) };
  const archive = { export: async (...args) => exportPackage(...args), unpack: async (bytes) => unpackZip(bytes), readImportFiles: async () => source.files };
  const pixels = { compilePages: (bundle, edits) => compilePages(bundle, edits, pixelEnv) };
  const actions = createResourceActions({ projects, templates, archive, pixels, catalog: { list: async () => [] }, createId: () => "parsed-fixture", now: () => "2026-10-21T00:00:00Z" });
  return { bundle, source, png, projects, templates, archive, pixels, actions, savedTemplates, writes };
}

test("template commands bake calibration, preserve source bytes and update one independent snapshot", async () => {
  const f = fixture(), before = structuredClone(f.source);
  const draft = { record: { id: f.source.id }, name: "  Independent  ", type: "role", categories: ["人物", " 人物 "] };
  const saved = await f.actions.addTemplate(draft);
  assert.equal(saved.id, "custom-fixture-resource"); assert.equal(saved.name, "Independent");
  assert.deepEqual(saved.categories, ["人物"]); assert.equal(saved.createdAt, "2026-10-21T00:00:00Z");
  assert.ok(Object.keys(saved.files).every((path) => !path.startsWith(".ai-spine/")));
  assert.equal(parseSkeleton(parseBundle(saved.files, { id: "snapshot" })).data.animations.length, f.bundle.animations.length);
  assert.notDeepEqual(saved.files[f.bundle.pages[0].file], f.source.files[f.bundle.pages[0].file]);
  assert.deepEqual(f.source, before);
  await f.actions.addTemplate({ ...draft, name: "Updated" }); assert.equal(f.savedTemplates.size, 1);
  await f.actions.trash(f.source); assert.equal(f.savedTemplates.get(saved.id).name, "Updated");
  await f.actions.removeTemplate(saved.id); assert.deepEqual(f.source, before);
});

test("invalid template preparation fails before its repository write and keeps the resource untouched", async () => {
  const f = fixture(), before = structuredClone(f.source);
  await assert.rejects(f.actions.addTemplate({ record: { ...f.source, files: {} }, name: "Bad", type: "role", categories: [] }), /骨架/);
  assert.equal(f.savedTemplates.size, 0); assert.deepEqual(f.writes, []); assert.deepEqual(f.source, before);
});

test("import selection, resource opening and calibrated preview are read-only application operations", async () => {
  const f = fixture(), files = await f.actions.readImport([{}]);
  const choices = { ...files, "second.json": files[f.bundle.skeletonPath] };
  assert.throws(() => f.actions.prepareImport(choices), (error) => error.candidates.length === 2);
  const imported = f.actions.prepareImport(choices, f.bundle.skeletonPath);
  assert.equal(imported.animations.length, f.bundle.animations.length);
  const opened = await f.actions.open({ id: f.source.id }); assert.equal(opened.record, f.source);
  const preview = await f.actions.preview({ id: f.source.id });
  assert.deepEqual(preview.animations, f.bundle.animations); assert.ok(Object.keys(preview.pages).length);
  assert.deepEqual(f.writes, []);
});

test("export validates real ZIP output, downloads before forced persistence and reports save failure separately", async () => {
  const f = fixture(), events = [], downloads = [];
  const run = createProjectExporter({ archive: f.archive, pixels: f.pixels, downloads: { save: async (bytes, name) => { events.push("download"); downloads.push({ bytes, name }); } } });
  for (const mode of ["runtime", "project", "unity"]) {
    events.length = 0;
    const result = await run({ bundle: f.bundle, edits: {}, generation: f.source.generation, name: "Name/Character", mode }, {
      onExported: () => events.push("exported"), persist: async (explicit, options) => {
        assert.equal(explicit, false); assert.deepEqual(options, { force: true }); events.push("save"); throw new Error("Save unavailable");
      },
    });
    assert.deepEqual(events, ["download", "exported", "save"]); assert.equal(result.saveError.message, "Save unavailable");
    assert.match(result.fileName, /^Name_Character-/);
    const files = unpackZip(result.bytes), bundle = parseBundle(files, { id: "reopened" });
    assert.equal(parseSkeleton(bundle).data.animations.length, f.bundle.animations.length);
    assert.equal(Boolean(files[".ai-spine/project.json"]), mode === "project");
  }
  assert.equal(downloads.length, 3); assert.deepEqual(f.writes, []);
});

test("reapplying a frozen scoped candidate retains existing native artwork and manual calibration", async () => {
  const f = fixture(16), source = f.bundle;
  const apply = createCandidateApplication({ images: { applyGeneratedParts: (...args) => applyGeneratedParts(...args, pixelEnv) },
    variants: { add: (...args) => addTemplateVariant(...args, pixelEnv) } });
  const result = { id: "frozen-job", projectId: "candidate-owner", kind: "parts", fingerprint: await templateFingerprint(source) };
  const candidates = [{ id: "image-face", partId: "face", bytes: f.png }], scope = { name: "Hurt face", animations: ["unit_damage"] };
  const first = await apply({ projectId: result.projectId, bundle: source, comparison: source, edits: {}, result, candidates, scope });
  const calibrated = { ...first.edits[first.selectedPart], transform: { ...first.edits[first.selectedPart].transform, x: 7 } };
  const edits = { ...first.edits, [first.selectedPart]: calibrated };
  const second = await apply({ projectId: result.projectId, bundle: first.bundle, comparison: source, edits, result, candidates, scope });
  assert.equal(second.selectedPart, first.selectedPart); assert.equal(second.edits[second.selectedPart], calibrated);
  assert.deepEqual(second.bundle.files, first.bundle.files);
  assert.equal(second.animation, "unit_damage");
  await assert.rejects(apply({ projectId: result.projectId, bundle: source, edits, result: { ...result, fingerprint: "stale" }, candidates }), /不匹配/);
  assert.equal(edits[first.selectedPart], calibrated); assert.deepEqual(source.files, f.bundle.files);
});

test("candidate application requires the current resource identity before reading any image or template data", async () => {
  const apply = createCandidateApplication({ images: { applyGeneratedParts: () => assert.fail("Foreign images must not be processed") }, variants: {} });
  await assert.rejects(apply({ projectId: "current", result: { projectId: "foreign" } }), /另一份资源/);
  await assert.rejects(apply({ result: { projectId: "current" } }), /另一份资源/);
});

test("editor persistence retains blank-title temporary policy, explicit saves, summary-only receipts and immutable image references", async () => {
  const f = fixture(), saved = [], summaries = [];
  const writer = createEditorPersistence({ repository: { save: async (record) => { saved.push(record); return { ...record, updatedAt: "version-1" }; } },
    onSaved: (_saved, context) => summaries.push(context.summary) });
  const session = createEditorSession({ key: "session", entityId: "draft", sameContent: sameAuthoredProjectContent });
  const project = { id: "draft", sessionKey: "session", isDraft: true, initialName: "Initial" };
  writer.openSession({ sessionKey: session.key, entityId: session.entityId });
  const record = editorRecord({ project, bundle: f.bundle, name: "", edits: {}, generation: {} });
  assert.equal(writer.queueProject({ session, project, record, name: "" }), null);
  assert.equal(saved.length, 0);
  await writer.persistProject({ session, project, record, name: "" }, { explicit: true });
  assert.equal(saved.length, 1); assert.equal(saved[0].files, f.bundle.files);
  assert.equal(summaries[0].files, undefined); assert.equal(summaries[0].generation, undefined);
  assert.equal(summaries[0].partCount, f.bundle.parts.length); writer.dispose();
});
