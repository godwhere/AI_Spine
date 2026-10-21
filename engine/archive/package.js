import { encodeText } from "../../shared/codec/text.mjs";
import { MAX_PACKAGE_BYTES } from "./zip.js";
import { MAX_PACKAGE_FILES } from "./zip.js";
import { PROJECT_PATH } from "./bundle.js";
import { unityPackageFiles } from "./unity-export.js";
import { zipSync } from "fflate";

function exportPackage(
  bundle,
  pageBytes = {},
  { editable = false, edits = {}, name = bundle.name, generation = {}, target } = {},
) {
  if (target === "unity" && editable) throw new Error("Unity 资源包与可编辑工程请分别导出。");
  const output = target === "unity" ? unityPackageFiles(bundle, pageBytes) : { ...bundle.files, ...pageBytes };
  if (editable) {
    const metadata = {
      version: 1,
      name,
      skeletonPath: bundle.skeletonPath,
      originalFiles: Object.keys(bundle.files),
      edits: {},
    };
    for (const [path, bytes] of Object.entries(bundle.files))
      output[`.ai-spine/original/${path}`] = bytes;
    let index = 0;
    for (const [key, edit] of Object.entries(edits)) {
      const imagePath = `.ai-spine/replacements/${index++}.png`;
      output[imagePath] = edit.image;
      metadata.edits[key] = {
        fileName: edit.fileName,
        transform: edit.transform,
        imagePath,
      };
    }
    if (generation.appearancePrompt || generation.partsPrompt || generation.appearance) {
      metadata.generation = {
        appearancePrompt: generation.appearancePrompt || "",
        partsPrompt: generation.partsPrompt || "",
      };
      if (generation.appearance?.image instanceof Uint8Array) {
        const imagePath = ".ai-spine/generation/appearance.png";
        output[imagePath] = generation.appearance.image;
        metadata.generation.appearance = {
          imagePath, fileName: generation.appearance.fileName, prompt: generation.appearance.prompt,
        };
      }
    }
    output[PROJECT_PATH] = encodeText(JSON.stringify(metadata));
  }
  const entries = Object.entries(output);
  if (entries.length > MAX_PACKAGE_FILES) throw new Error("资源包文件数量过多，请拆分后导出。");
  let total = 0;
  for (const [, bytes] of entries) {
    if (!(bytes instanceof Uint8Array)) throw new Error("资源包包含无效的文件数据。");
    total += bytes.byteLength;
    if (total > MAX_PACKAGE_BYTES) throw new Error("资源包解压后超过 256 MB，请拆分后导出。");
  }
  const bytes = zipSync(
    Object.fromEntries(
      entries.map(([p, data]) => [
        p,
        [data, { mtime: new Date("2026-01-01T00:00:00Z") }],
      ]),
    ),
    { level: 6 },
  );
  if (bytes.byteLength > MAX_PACKAGE_BYTES) throw new Error("资源包超过 256 MB，请拆分后导出。");
  return bytes;
}

export { exportPackage };
