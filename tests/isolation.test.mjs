import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startIsolatedWorkbench, fakeImageConnections } from "./support/isolated-workbench.mjs";

test("isolated workbenches own disjoint storage and never interrupt each other's live jobs", async (t) => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const a = await startIsolatedWorkbench({ connections: fakeImageConnections({ generate: async (_provider, { signal }) => {
    entered(); await delay(60_000, undefined, { signal });
  } }) });
  t.after(() => a.close());
  const input = { version: 1, kind: "appearance", projectId: "isolation-fixture", prompt: "fixture", references: [], parts: [],
    template: { id: "fixture", name: "Fixture", fingerprint: "a".repeat(64) } };
  const job = await a.jobs.create(input); await started;
  const b = await startIsolatedWorkbench(); t.after(() => b.close());
  assert.notEqual(a.root, b.root); assert.notEqual(a.origin, b.origin);
  for (const instance of [a, b]) {
    assert.notEqual(new URL(instance.origin).port, "4175");
    assert.ok(instance.jobs.root.startsWith(instance.root + "/"));
    assert.match(instance.root, /ispine-isolated-/);
  }
  assert.equal((await a.jobs.get(job.id)).status, "generating");
  assert.deepEqual(await b.jobs.list(input.projectId), []);
  await b.close();
  assert.equal((await a.jobs.get(job.id)).status, "generating");
  assert.equal(JSON.parse(await readFile(join(a.jobs.root, job.id, "job.json"), "utf8")).status, "generating");
  await a.jobs.cancel(job.id); await a.jobs.drainingPromise;
  assert.equal((await a.jobs.get(job.id)).status, "cancelled");
  await a.close();
  await assert.rejects(access(a.root), { code: "ENOENT" });
});

test("isolated fake generation persists candidates without applying them to resources", async (t) => {
  const server = await startIsolatedWorkbench(); t.after(() => server.close());
  const before = server.store.call("projects", "get", ["architecture-fixture"]);
  const response = await fetch(server.origin + "/api/generation/jobs", { method: "POST",
    headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ version: 1, kind: "appearance",
      projectId: before.id, prompt: "fixture", references: [], parts: [], template: { fingerprint: "b".repeat(64) } }) });
  assert.equal(response.status, 202);
  const job = await response.json(); await server.jobs.drainingPromise;
  const completed = await server.jobs.get(job.id);
  assert.equal(completed.status, "completed"); assert.equal(completed.images.length, 1);
  assert.deepEqual(server.store.call("projects", "get", [before.id]), before);
  assert.equal((await fetch(server.origin + completed.images[0].url)).status, 200);
});
