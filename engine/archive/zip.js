import { cleanPath } from "./paths.js";
import { unzipSync } from "fflate";

const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;

const MAX_PACKAGE_FILES = 4096;

// Check central-directory sizes before asking the decompressor to allocate memory.
function unpackZip(bytes) {
  if (bytes.byteLength > MAX_PACKAGE_BYTES)
    throw new Error("资源包超过 256 MB，请拆分后导入。");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("ZIP 文件不完整或格式无效。");
  const count = view.getUint16(end + 10, true);
  let position = view.getUint32(end + 16, true),
    total = 0;
  if (count > MAX_PACKAGE_FILES || count === 65535) throw new Error("资源包文件数量过多。");
  for (let i = 0; i < count; i++) {
    if (
      position + 46 > bytes.length ||
      view.getUint32(position, true) !== 0x02014b50
    )
      throw new Error("ZIP 目录无效。");
    total += view.getUint32(position + 24, true);
    if (total > MAX_PACKAGE_BYTES) throw new Error("资源包解压后超过 256 MB。");
    position +=
      46 +
      view.getUint16(position + 28, true) +
      view.getUint16(position + 30, true) +
      view.getUint16(position + 32, true);
  }
  const extracted = unzipSync(bytes),
    files = {};
  for (const [path, data] of Object.entries(extracted)) {
    if (
      path.endsWith("/") ||
      path.includes("__MACOSX/") ||
      path.endsWith(".DS_Store")
    )
      continue;
    files[cleanPath(path)] = data;
  }
  return files;
}

export { MAX_PACKAGE_BYTES, MAX_PACKAGE_FILES, unpackZip };
