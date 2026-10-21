import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dependencyViolation, findCycles, inspectArchitecture, moduleReferences, platformReferences } from "../scripts/check-architecture.mjs";

test("architecture parses static imports, re-exports, require and resolvable dynamic imports in JSX", () => {
  const refs = moduleReferences(`
    // import "not-a-dependency";
    import {
      value
    } from "./value.js";
    export { other } from "./other.js";
    export * from "./all.js";
    const a = import("./lazy.js"), b = import(\`./literal.js\`);
    const c = import(variable), d = require("node:fs");
    export const view = <div>import "also-not-a-dependency"</div>;
  `);
  assert.deepEqual(refs.map((ref) => ref.specifier), ["./value.js", "./other.js", "./all.js", "./lazy.js", "./literal.js", "node:fs"]);
});

test("architecture rejects forbidden directions and allows injected application boundaries", () => {
  for (const [from, to] of [["server/new.mjs", "src/core/old.js"], ["server/new.mjs", "desktop/server.mjs"],
    ["engine/rig/new.js", "src/core/old.js"], ["shared/domain/new.mjs", "node:fs"],
    ["src/application/new.js", "src/infrastructure/http.js"], ["src/features/rig/view.jsx", "src/features/library/state.js"],
    ["server/http/routes.mjs", "node:sqlite"], ["server/application/save.mjs", "node:sqlite"],
    ["server/application/save.mjs", "server/workspace/repository.mjs"], ["src/app/shell.jsx", "electron"],
    ["src/app/main.js", "desktop/preload.cjs"], ["scripts/build.mjs", "@electron/packager"],
    ["src/app/AppShell.jsx", "src/infrastructure/project-repository.js"], ["src/app/AppShell.jsx", "engine/archive/package.js"]]) assert.ok(dependencyViolation(from, to), `${from} -> ${to}`);
  assert.equal(dependencyViolation("src/application/save.js", "shared/domain/project.mjs"), null);
  assert.equal(dependencyViolation("engine/archive/zip.js", "fflate"), null);
  assert.equal(dependencyViolation("src/features/rig/view.jsx", "src/application/rig.js"), null);
  assert.deepEqual(findCycles([{ from: "a", to: "b" }, { from: "b", to: "a" }]), [["a", "b"]]);
});

test("checkout has no new architectural exceptions, missing modules or cycles", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const exceptions = JSON.parse(await readFile(new URL("../docs/architecture-exceptions.json", import.meta.url), "utf8"));
  const report = await inspectArchitecture(root, exceptions);
  for (const key of ["unexpected", "stale", "invalid", "unresolved", "platform", "desktopBridges", "retiredDependencies", "cycles"]) assert.deepEqual(report[key], [], key);
});

test("engine platform checks distinguish authored documents and injected ports from global APIs", () => {
  assert.deepEqual(platformReferences(`export function sample(document, pixels) { return pixels.createCanvas(document.width, document.height); }
    const fixed = new Date("2026-01-01"), parsed = Date.parse("2026-01-01");`), []);
  assert.deepEqual(platformReferences(`const image = new Image(); fetch("/"); globalThis.crypto.randomUUID(); Date.now(); new Date();`)
    .map(({ name }) => name), ["Image", "fetch", "globalThis", "Date.now", "new Date()"]);
});
