import { MAX_PACKAGE_BYTES } from "../../engine/archive/zip.js";
import { unpackZip } from "../../engine/archive/zip.js";

async function readImportFiles(fileList, { unpack = unpackZip } = {}) {
  const result = {};
  for (const file of fileList) {
    if (file.size > MAX_PACKAGE_BYTES) throw new Error("单个文件超过 256 MB。");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const incoming = /\.zip$/i.test(file.name)
      ? await unpack(bytes)
      : { [file.webkitRelativePath || file.name]: bytes };
    for (const [name, content] of Object.entries(incoming)) {
      if (result[name]) throw new Error(`文件重复：${name}`);
      result[name] = content;
    }
  }
  if (
    Object.values(result).reduce((s, b) => s + b.byteLength, 0) >
    MAX_PACKAGE_BYTES
  )
    throw new Error("导入文件总大小超过 256 MB。");
  return result;
}

async function loadCatalogTemplate(template, fetcher = fetch) {
  const paths = [
    ...new Set([
      template.skeletonFile,
      ...template.atlasFiles,
      ...template.textureFiles,
    ]),
  ];
  const entries = await Promise.all(
    paths.map(async (path) => {
      const response = await fetcher(template.folder + path);
      if (!response.ok) throw new Error(`模板加载失败：${path}`);
      return [path, new Uint8Array(await response.arrayBuffer())];
    }),
  );
  return parseBundle(Object.fromEntries(entries), {
    name: template.name,
    id: `template-${template.id}`,
  });
}

export { loadCatalogTemplate, readImportFiles };

import { parseBundle as parseBundleData } from "../../engine/archive/bundle.js";
export function parseBundle(files, options = {}) {
  return parseBundleData(files, { ...options, id: options.id === undefined ? crypto.randomUUID() : options.id });
}
