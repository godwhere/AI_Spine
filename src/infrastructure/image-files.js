import { alphaBounds } from "../../engine/images/calibration.js";
import { browserPixels } from "./browser-pixels.js";
import { closeImage } from "../../engine/images/calibration.js";
import { identityTransform } from "../../engine/images/calibration.js";

async function readReplacement(file, env = browserPixels) {
  if (file.size > 32 * 1024 * 1024)
    throw new Error("替换图片超过 32 MB，请缩小后重试。");
  const image = await env.loadImage(new Uint8Array(await file.arrayBuffer()));
  try {
    const canvas = env.createCanvas(image.width, image.height);
    canvas.getContext("2d").drawImage(image, 0, 0);
    if (
      !alphaBounds(
        canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height),
      )
    )
      throw new Error("替换图片完全透明。");
    return {
      image: await env.encode(canvas),
      fileName: file.name,
      transform: identityTransform(),
    };
  } finally {
    closeImage(image);
  }
}

export { readReplacement };
