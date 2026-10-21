import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { unpackZip } from "../engine/archive/zip.js";
import { parseBundle } from "../src/infrastructure/archive-files.js";

test("the retained starter archive contains all six calibrated replacements and editable generation data", async () => {
  const zip = new Uint8Array(await readFile(resolve("outputs/egg-starberry/starberry-project.zip")));
  const files = await unpackZip(zip);
  const bundle = parseBundle(files);
  assert.equal(bundle.parts.length, 6); assert.equal(Object.keys(bundle.edits).length, 6);
  assert.ok(bundle.generation.appearance); assert.ok(bundle.generation.partsPrompt);
  for (const part of bundle.parts) {
    assert.ok(bundle.edits[part.id].image?.length, part.id);
  }
});
test("the retained editable export fixture preserves all replacements, transforms, source files, and prompts", async () => {
  const load = async (path) => parseBundle(unpackZip(new Uint8Array(await readFile(resolve(path)))));
  const source = await load("outputs/egg-starberry/starberry-project.zip");
  const exported = await load("outputs/desktop/evidence/starberry-desktop-project.zip");
  assert.equal(exported.parts.length, 6);
  assert.deepEqual(exported.edits, source.edits);
  for (const [path, bytes] of Object.entries(source.files)) assert.deepEqual(exported.files[path], bytes, path);
  assert.deepEqual(exported.generation.appearance.image, source.generation.appearance.image);
  assert.equal(exported.generation.appearancePrompt, source.generation.appearancePrompt);
  assert.equal(exported.generation.partsPrompt, source.generation.partsPrompt);
});
