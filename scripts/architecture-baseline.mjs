import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const git = (...args) => execFileSync("git", args, { cwd: root }).toString();
const outputPath = process.argv[2] && !process.argv[2].startsWith("--") ? resolve(process.argv[2]) : null;
const files = git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter((path) => path && resolve(root, path) !== outputPath);
const hashes = Object.fromEntries(await Promise.all(files.map(async (path) => [path,
  await readFile(resolve(root, path)).then((bytes) => createHash("sha256").update(bytes).digest("hex"), () => null)])));
const protectedFiles = [".openai/hosting.json", "worker/index.js", "scripts/prepare-sites-build.mjs", "tests/sites-worker.test.mjs"];
const baseline = { capturedAt: new Date().toISOString(), commit: git("rev-parse", "HEAD").trim(), status: git("status", "--porcelain=v1"),
  runtime: { execPath: process.execPath, version: process.version }, files: hashes };
const compare = process.argv.indexOf("--compare");
if (compare >= 0) {
  const previous = JSON.parse(await readFile(process.argv[compare + 1], "utf8"));
  const changed = Object.keys(previous.files).filter((path) => previous.files[path] !== hashes[path]);
  const protectedChanges = changed.filter((path) => protectedFiles.includes(path) || /^(?:public|outputs)\//.test(path));
  console.log(JSON.stringify({ base: previous.commit, current: baseline.commit, changed,
    added: files.filter((path) => !(path in previous.files)), protectedChanges }, null, 2));
  if (protectedChanges.length) process.exitCode = 1;
} else {
  const output = process.argv[2];
  if (!output) throw new Error("Provide an output path, or --compare <baseline.json>.");
  await writeFile(output, JSON.stringify(baseline, null, 2));
  console.log(JSON.stringify({ output, commit: baseline.commit, files: files.length, runtime: baseline.runtime }));
}
