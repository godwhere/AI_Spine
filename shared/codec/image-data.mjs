import { decodeBase64 } from "./base64.mjs";
import { encodeBase64 } from "./base64.mjs";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

function imageDataBytes(url) {
  const match = typeof url === "string" && url.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2].length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4)
    throw new Error("骨架图片无效或超过 32 MB，请重新导入。");
  const bytes = decodeBase64(match[2]);
  if (!bytes.length) throw new Error("骨架图片为空。");
  return { bytes, mime: match[1] };
}

function imageDataURL(bytes, mime = "image/png") {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new Error("骨架工程缺少有效图片。");
  return `data:${mime};base64,${encodeBase64(bytes)}`;
}

function bytesToImageDataURL(bytes, type = "image/png") { return `data:${type};base64,${encodeBase64(bytes)}`; }

export { bytesToImageDataURL, imageDataBytes, imageDataURL };
