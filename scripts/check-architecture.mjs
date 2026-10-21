import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import { access, readFile, readdir } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const within = (file, prefix) => file.startsWith(`${prefix}/`);
const traverse = traverseModule.default || traverseModule;
const platformGlobals = new Set(["window", "document", "navigator", "globalThis", "fetch", "XMLHttpRequest",
  "WebSocket", "indexedDB", "localStorage", "sessionStorage", "File", "Blob", "FileReader", "Image",
  "OffscreenCanvas", "createImageBitmap", "crypto", "Buffer", "process", "require", "atob", "btoa"]);

export function platformReferences(source) {
  const refs = [];
  traverse(parse(source, { sourceType: "module" }), {
    ReferencedIdentifier(path) {
      if (platformGlobals.has(path.node.name) && !path.scope.getBinding(path.node.name))
        refs.push({ name: path.node.name, line: path.node.loc.start.line });
    },
    CallExpression(path) {
      const node = path.node;
      if (node.callee.type === "MemberExpression" && node.callee.object.name === "Date" &&
          (node.callee.property.name === "now" || node.callee.property.value === "now") && !path.scope.getBinding("Date"))
        refs.push({ name: "Date.now", line: node.loc.start.line });
    },
    NewExpression(path) {
      if (path.node.callee.name === "Date" && !path.node.arguments.length && !path.scope.getBinding("Date"))
        refs.push({ name: "new Date()", line: path.node.loc.start.line });
    },
  });
  return refs;
}

// Parse syntax rather than matching lines: comments, JSX, multiline exports and
// string-literal dynamic imports all need the same dependency rules.
export function moduleReferences(source) {
  const tree = parse(source, { sourceType: "unambiguous", plugins: ["jsx"], createImportExpressions: true });
  const refs = [];
  const literal = (node) => node?.type === "StringLiteral" ? node.value :
    node?.type === "TemplateLiteral" && !node.expressions.length ? node.quasis[0].value.cooked : null;
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source)
      refs.push({ specifier: node.source.value, kind: node.type, line: node.loc.start.line });
    if (node.type === "ImportExpression") {
      const specifier = literal(node.source);
      if (specifier !== null) refs.push({ specifier, kind: "dynamic", line: node.loc.start.line });
    }
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "require") {
      const specifier = literal(node.arguments[0]);
      if (specifier !== null) refs.push({ specifier, kind: "require", line: node.loc.start.line });
    }
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "start", "end", "extra"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(tree.program);
  return refs;
}

export function dependencyViolation(from, to) {
  if (within(from, "server") && within(to, "src")) return "server-no-src";
  if (within(from, "server") && within(to, "desktop")) return "server-no-desktop";
  if (within(to, "desktop") || to === "electron" || to.startsWith("@electron/")) return "browser-only-no-shell";
  if (within(from, "shared")) {
    if (!within(to, "shared")) return "shared-pure";
    if (within(from, "shared/codec") && !within(to, "shared/codec")) return "codec-no-domain";
  }
  if (within(from, "engine") && !["engine", "shared"].some((prefix) => within(to, prefix)) &&
      !["fflate", "@esotericsoftware/spine-core"].includes(to)) return "engine-platform-independent";
  if (within(from, "src/application") && !["src/application", "engine", "shared"].some((prefix) => within(to, prefix)))
    return "application-ports-only";
  if (from === "src/app/AppShell.jsx" && !["src/app", "src/application", "src/components", "src/features", "shared"].some((prefix) => within(to, prefix)) &&
      !["react", "lucide-react"].includes(to)) return "shell-composition-only";
  if (within(from, "src/features")) {
    const feature = from.split("/").slice(0, 3).join("/");
    if (![feature, "src/application", "src/components", "shared"].some((prefix) => within(to, prefix)) &&
        !["react", "lucide-react"].includes(to)) return "feature-boundary";
  }
  if (within(from, "server/http") && (within(to, "server/workspace") || within(to, "server/providers") || within(to, "engine") ||
      to.replace(/^node:/, "") === "sqlite")) return "http-injected-services";
  if (within(from, "server/application") && (within(to, "server/workspace") || within(to, "server/infrastructure") ||
      within(to, "server/providers") || builtins.has(to.replace(/^node:/, "")))) return "server-application-ports-only";
  if (["server/application", "server/jobs", "server/ai"].some((prefix) => within(from, prefix)) &&
      (to === "electron" || within(to, "desktop"))) return "server-platform-independent";
  return null;
}

async function sourceFiles(root, directory) {
  const result = [];
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await sourceFiles(root, path));
    else if (/\.(?:mjs|cjs|js|jsx)$/.test(entry.name)) result.push(path);
  }
  return result;
}

export function findCycles(edges) {
  const graph = new Map();
  for (const { from, to } of edges) {
    if (!graph.has(from)) graph.set(from, []);
    graph.get(from).push(to);
  }
  let index = 0;
  const indices = new Map(), lows = new Map(), stack = [], active = new Set(), cycles = [];
  function visit(node) {
    indices.set(node, index); lows.set(node, index++); stack.push(node); active.add(node);
    for (const next of graph.get(node) || []) {
      if (!indices.has(next)) { visit(next); lows.set(node, Math.min(lows.get(node), lows.get(next))); }
      else if (active.has(next)) lows.set(node, Math.min(lows.get(node), indices.get(next)));
    }
    if (lows.get(node) !== indices.get(node)) return;
    const group = []; let next;
    do { next = stack.pop(); active.delete(next); group.push(next); } while (next !== node);
    if (group.length > 1 || graph.get(node)?.includes(node)) cycles.push(group.sort());
  }
  for (const node of graph.keys()) if (!indices.has(node)) visit(node);
  return cycles.sort((a, b) => a[0].localeCompare(b[0]));
}

export async function inspectArchitecture(root, exceptions = []) {
  const files = (await Promise.all(["src", "server", "shared", "engine", "desktop", "scripts", "worker"].map((dir) => sourceFiles(root, dir)))).flat().sort();
  const known = new Set(files), edges = [], unresolved = [], platform = [], desktopBridges = [];
  for (const from of files) {
    const source = await readFile(resolve(root, from), "utf8");
    traverse(parse(source, { sourceType: "unambiguous", plugins: ["jsx"] }), {
      "MemberExpression|OptionalMemberExpression"(path) {
        const property = path.node.property;
        if ((!path.node.computed && property.name === "aiSpineDesktop") || (path.node.computed && property.value === "aiSpineDesktop"))
          desktopBridges.push({ from, line: path.node.loc.start.line });
      },
    });
    if (within(from, "shared") || within(from, "engine") || within(from, "src/application"))
      platform.push(...platformReferences(source).map((ref) => ({ from, ...ref })));
    for (const ref of moduleReferences(source)) {
      let to = ref.specifier;
      if (to.startsWith(".")) {
        to = relative(root, resolve(root, dirname(from), to.split("?")[0])).replaceAll("\\", "/");
        if (!known.has(to)) {
          const candidate = [".js", ".jsx", ".mjs", "/index.js"].map((ext) => to + ext).find((path) => known.has(path));
          if (candidate) to = candidate;
          else if (/\.(?:mjs|cjs|js|jsx)$/.test(to) && !await access(resolve(root, to)).then(() => true, () => false))
            unresolved.push({ from, ...ref });
        }
      } else if (builtins.has(to.replace(/^node:/, ""))) to = `node:${to.replace(/^node:/, "")}`;
      edges.push({ from, to, kind: ref.kind, line: ref.line });
    }
  }
  const violations = edges.flatMap((edge) => {
    const rule = dependencyViolation(edge.from, edge.to);
    return rule ? [{ ...edge, rule }] : [];
  });
  const matches = (edge, entry) => edge.from === entry.from && edge.to === entry.to && edge.rule === entry.rule;
  const unexpected = violations.filter((edge) => !exceptions.some((entry) => matches(edge, entry)));
  const stale = exceptions.filter((entry) => !violations.some((edge) => matches(edge, entry)));
  const invalid = exceptions.filter((entry) => !entry.target || !/^P[0-7]$/.test(entry.phase) || !entry.reason);
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const retiredDependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => name === "electron" || name.startsWith("@electron/"));
  return { files: files.length, edges, violations, unexpected, stale, invalid, unresolved, platform, desktopBridges, retiredDependencies, cycles: findCycles(edges) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const exceptions = JSON.parse(await readFile(resolve(root, "docs/architecture-exceptions.json"), "utf8"));
  const report = await inspectArchitecture(root, exceptions);
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(JSON.stringify({ files: report.files, imports: report.edges.length, exceptions: report.violations.length,
    unexpected: report.unexpected, stale: report.stale, invalid: report.invalid, unresolved: report.unresolved,
    platform: report.platform, desktopBridges: report.desktopBridges, retiredDependencies: report.retiredDependencies, cycles: report.cycles }, null, 2));
  if (["unexpected", "stale", "invalid", "unresolved", "platform", "desktopBridges", "retiredDependencies", "cycles"].some((key) => report[key].length)) process.exitCode = 1;
}
