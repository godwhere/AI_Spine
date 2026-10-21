import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceStore } from "../server/bootstrap/workspace.mjs";
import { startWorkbenchServer } from "../server/bootstrap/workbench.mjs";
import { encodeWorkspace, decodeWorkspace } from "../shared/workspace-codec.mjs";
import { localKeyProtection } from "../server/infrastructure/key-protection.mjs";
import { synthetic } from "./helpers.mjs";
import { createCustomTemplateRecord } from "../src/infrastructure/template-snapshot.js";

const PROJECTS = "ai-spine-local-workbench", DRAFTS = "ispine-rig-drafts", TEMPLATES = "ai-spine-custom-templates";
const project = (id = "character") => ({ id, name: "Character", files: { "source.png": new Uint8Array([137,80,78,71]) },
  edits: { arm: { image: new Uint8Array([1,2,3]), transform: { x: 12, scaleX: 1.2 } } },
  generation: { appearance: { image: new Uint8Array([4,5,6]) }, partsPrompt: "private brief" } });
const draft = { version: 1, id: "source-draft", name: "Source draft", width: 32, height: 32, joints: [], parts: [], motions: [],
  sourceImage: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==" };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ispine-shared-"));
  const store = createWorkspaceStore(root); t.after(() => { store.close(); return rm(root, { recursive: true, force: true }); });
  return { root, store };
}

test("binary source art and calibration persist across separate store connections and restart", async (t) => {
  const { root, store } = await fixture(t), second = createWorkspaceStore(root); t.after(() => second.close());
  const saved = store.call("projects", "save", [project()]);
  assert.deepEqual(second.call("projects", "get", [saved.id]), saved);
  assert.deepEqual(decodeWorkspace(JSON.parse(JSON.stringify(encodeWorkspace(saved)))), saved);
  assert.ok(second.status().revision > 0);
  const summary = second.call("projects", "summary").projects[0];
  assert.equal(summary.files, undefined); assert.equal(summary.generation, undefined); assert.equal(summary.edits, undefined);
  assert.equal(summary.replacementCount, 1);
  const reopened = createWorkspaceStore(root);
  assert.deepEqual(reopened.call("projects", "get", [saved.id]).edits, saved.edits); reopened.close();
});
test("shared revisions reject another client's stale save while retaining authored no-op semantics", async (t) => {
  const { store } = await fixture(t), first = store.call("projects", "save", [project()]);
  const current = store.call("projects", "save", [{ ...first, name: "New name" }, { expectedUpdatedAt: first.updatedAt }]);
  assert.throws(() => store.call("projects", "save", [{ ...first, name: "Stale" }, { expectedUpdatedAt: first.updatedAt }]), { code: "RESOURCE_CHANGED" });
  const revision = store.status().revision;
  assert.deepEqual(store.call("projects", "save", [{ ...current, thumbnail: "new preview" }, { expectedUpdatedAt: current.updatedAt }]), current);
  assert.equal(store.status().revision, revision);
});
test("trash, restoration and atomic permanent deletion retain ID-only stale-save protection", async (t) => {
  const { store } = await fixture(t), first = store.call("projects", "save", [project()]);
  store.call("projects", "save", [project("second")]); store.call("projects", "trash", [first.id]);
  assert.equal(store.call("projects", "list").trash[0].files, undefined);
  assert.deepEqual(store.call("projects", "read", [first.id]).files, first.files);
  assert.throws(() => store.call("projects", "save", [first]), /回收站/);
  assert.throws(() => store.call("projects", "remove", [[first.id, "second"]]), /回收站/);
  assert.equal(store.call("projects", "list").trash.length, 1);
  store.call("projects", "restore", [first.id]); assert.deepEqual(store.call("projects", "get", [first.id]).edits, first.edits);
  store.call("projects", "trash", [first.id]); store.call("projects", "remove", [[first.id]]);
  assert.throws(() => store.call("projects", "save", [first]), /永久删除/);
  assert.equal(store.get(PROJECTS,"projects",first.id), null);
  assert.deepEqual(Object.keys(store.get(PROJECTS,"removedProjects",first.id)).sort(), ["id","removedAt"]);
  assert.equal(store.call("projects", "list").hasDeletedProjects, true);
});
test("desktop/browser migration is idempotent, preserves divergent versions and cannot resurrect removed data", async (t) => {
  const { store } = await fixture(t), original = { ...project(), updatedAt: "2026-10-20T00:00:00.000Z" };
  const snapshot = { [PROJECTS]: { projects: [original], removedProjects: [] }, [DRAFTS]: {
    metadata: [{ id: "source-draft", documentId: draft.id, name: draft.name, updatedAt: original.updatedAt }], documents: [{ id: "source-draft", document: draft }] } };
  assert.equal(store.migrate("desktop", snapshot).projects, 1);
  assert.deepEqual(store.call("projects", "get", [original.id]), original);
  assert.deepEqual(store.call("drafts", "get", [draft.id]).document.sourceImage, draft.sourceImage);
  assert.equal(store.migrate("desktop", snapshot).unchanged, 2);
  assert.equal(store.migrate("chrome", snapshot).conflicts, 0);
  const changed = structuredClone(snapshot); changed[PROJECTS].projects[0].edits.arm.transform.x = 99;
  assert.equal(store.migrate("chrome", changed).conflicts, 1);
  assert.equal(store.call("projects", "list").projects.length, 2);
  assert.equal(store.call("projects", "get", [original.id]).edits.arm.transform.x, 12);
  store.call("projects", "trash", [original.id]); store.call("projects", "remove", [[original.id]]);
  store.migrate("desktop", snapshot);
  assert.equal(store.call("projects", "get", [original.id]), null);
  assert.equal(store.call("projects", "list").projects.length, 1);
});
test("source-only drafts and custom templates stay independent of resource lifetime", async (t) => {
  const { store } = await fixture(t), bundle = synthetic();
  store.call("drafts", "save", [draft]);
  const template = createCustomTemplateRecord({ id:"template-source",name:"Template",skeletonPath:bundle.skeletonPath },bundle.files);
  store.call("templates", "save", [template]);
  assert.equal(store.call("projects", "list").projects.length, 0);
  assert.deepEqual(store.call("templates", "get", [template.id]).files, template.files);
  assert.equal(store.call("templates", "list")[0].files, undefined);
  assert.equal(store.call("drafts", "get", [draft.id]).document.sourceImage, draft.sourceImage);
  assert.throws(() => store.call("templates", "delete", ["22"]), /只能操作/);
  store.call("templates", "delete", [template.id]);
  assert.equal(store.call("drafts", "list").length, 1);
});
test("a new browser migration marker cannot revive trashed or permanently removed resources", async (t) => {
  const { store } = await fixture(t), original = store.call("projects", "save", [project()]);
  const snapshot = { [PROJECTS]: { projects: [original], removedProjects: [] } };
  store.call("projects", "trash", [original.id]);
  assert.equal(store.migrate("fresh-browser", snapshot).skippedDeleted, 1);
  assert.equal(store.call("projects", "list").projects.length, 0);
  assert.equal(store.call("projects", "list").trash.length, 1);
  store.call("projects", "remove", [[original.id]]);
  assert.equal(store.migrate("cleared-browser-cache", snapshot).skippedDeleted, 1);
  assert.deepEqual(store.call("projects", "list"), { projects: [], trash: [], hasDeletedProjects: true });
  assert.equal(store.get(PROJECTS,"projects",original.id),null);
});
test("two draft editors cannot silently replace each other's saved work", async (t) => {
  const { store } = await fixture(t), first = store.call("drafts", "save", [draft]);
  const next = store.call("drafts", "save", [{ ...draft, name: "Latest draft" }, { expectedUpdatedAt: first.updatedAt }]);
  assert.notEqual(next.updatedAt, first.updatedAt);
  assert.throws(() => store.call("drafts", "save", [{ ...draft, name: "Stale draft" }, { expectedUpdatedAt: first.updatedAt }]), { code: "DRAFT_CHANGED" });
  assert.equal(store.call("drafts", "get", [draft.id]).name, "Latest draft");
});
test("HTTP clients share one library; foreign origins cannot read or mutate it; service restarts keep bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(),"ispine-workbench-http-")); t.after(() => rm(root,{recursive:true,force:true}));
  const clientRoot = join(root,"client"); await mkdir(clientRoot); await writeFile(join(clientRoot,"index.html"),"<title>iSpine</title>");
  let aiCalls=0;
  const jobs=()=>({status:async()=>({connected:false}),close:async()=>{},connections:{info:async()=>({selected:"sub2api"})}});
  let server=await startWorkbenchServer({clientRoot,dataRoot:root,port:0,protection:undefined,jobs:jobs()});
  const call=async(operation,args)=>{
    const r=await fetch(server.origin+"/api/workspace/projects",{method:"POST",headers:{Origin:server.origin,"Content-Type":"application/json"},body:JSON.stringify(encodeWorkspace({operation,args}))});
    return {status:r.status,...decodeWorkspace(await r.json())};
  };
  try {
    const saved=await call("save",[project()]);assert.equal(saved.status,200);
    const other=await call("list",[]);assert.equal(other.value.projects[0].files,undefined);
    assert.deepEqual((await call("get",[saved.value.id])).value.files,saved.value.files);
    assert.equal((await fetch(server.origin+"/api/workspace/status",{headers:{Origin:"https://foreign.example"}})).status,403);
    assert.equal((await fetch(server.origin+"/api/workspace/projects",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).status,403);
    await server.close(); server=await startWorkbenchServer({clientRoot,dataRoot:root,port:0,protection:undefined,jobs:jobs()});
    assert.deepEqual((await call("get",["character"])).value,saved.value);
    assert.equal(aiCalls,0);
  } finally {await server.close();}
});
test("native key protection is lazy, authenticated and preserves legacy ciphertext without unlocking it", async () => {
  let calls=0, secret;
  const run=async(_bin,args)=>{
    calls++;
    if(args[0]==="find-generic-password") {if(!secret)throw Object.assign(new Error("missing"),{code:44});return {stdout:secret+"\n"};}
    secret=args.at(-1);return {stdout:""};
  };
  const protection=localKeyProtection({platform:"darwin",run});
  assert.equal(protection.isAvailable(),true);assert.equal(calls,0);
  await assert.rejects(protection.decrypt(Buffer.from("old electron ciphertext")),/旧桌面/);assert.equal(calls,0);
  const encrypted=await protection.encrypt("gateway-secret-fixture");
  assert.ok(!encrypted.includes(Buffer.from("gateway-secret-fixture")));
  assert.equal(await protection.decrypt(encrypted),"gateway-secret-fixture");
  const corrupted=Buffer.from(encrypted);corrupted[corrupted.length-1]^=1;
  await assert.rejects(protection.decrypt(corrupted));
  assert.equal(localKeyProtection({platform:"linux",run}),undefined);
});
