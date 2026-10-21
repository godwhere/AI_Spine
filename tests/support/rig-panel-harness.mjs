import { readFile, readdir } from "node:fs/promises";
import { transformWithEsbuild } from "vite";

// Load the actual presentation modules. Only the React renderer is replaced;
// panel conditionals and event handlers run unchanged in component tests.
const files = await readdir(new URL("../../src/features/rig/", import.meta.url));
const modules = await Promise.all(files.filter((name) => name.endsWith(".jsx") && name.startsWith("Rig") && !["RigWorkbench.jsx", "RigCanvas.jsx"].includes(name)).map(async (file) => {
  const source = await readFile(new URL(`../../src/features/rig/${file}`, import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import \{ ([^}]+) \} from (.+);$/gm)];
  const names = imports.flatMap((match) => match[1].split(",").map((name) => name.trim()));
  const exports = [...source.matchAll(/export function (\w+)/g)].map((match) => match[1]);
  const dependencies = imports.filter((match) => match[2].startsWith('"./')).flatMap((match) => match[1].split(",").map((name) => name.trim()));
  const { code } = await transformWithEsbuild(source.replace(/^import .*;\n/gm, "").replaceAll("export function ", "function "), file, { loader: "jsx", jsx: "transform", jsxFactory: "jsx" });
  return { names, exports, dependencies, controls: file === "RigControls.jsx",
    factory: new Function(...names, "jsx", "React", `${code};return {${exports.join(",")}};`) };
}));

export function createRigPanelBindings(bindings, jsx, React = { Fragment: "fragment" }) {
  const values = { ...bindings }, transparent = new Set(), remaining = [...modules];
  while (remaining.length) {
    const owned = new Set(modules.flatMap((module) => module.exports));
    const index = remaining.findIndex((module) => module.dependencies.filter((name) => owned.has(name)).every((name) => values[name]));
    if (index < 0) throw new Error("Unresolved rig panel dependency");
    const [module] = remaining.splice(index, 1);
    const components = module.factory(...module.names.map((name) => values[name] || "stub"), jsx, React);
    Object.assign(values, components);
    if (!module.controls) for (const component of Object.values(components)) transparent.add(component);
  }
  return { values, transparent };
}
