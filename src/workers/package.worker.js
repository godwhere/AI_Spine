import { unpackZip } from "../../engine/archive/zip.js";
import { parseBundle } from "../infrastructure/archive-files.js";
import { exportPackage } from "../../engine/archive/package.js";
import { parseSkeleton } from "../../engine/spine/parse.js";
import { unityAssetPath } from "../../engine/archive/unity-export.js";
self.onmessage = ({ data }) => {
  try {
    let result;
    if (data.operation === "unpack") result = unpackZip(data.bytes);
    else if (data.operation === "export") {
      const bytes = exportPackage(data.bundle, data.pages, data.options);
      const roundtrip = parseBundle(unpackZip(bytes), {
        skeletonPath: data.options?.target === "unity" ? unityAssetPath(data.bundle.skeletonPath) : data.bundle.skeletonPath,
      });
      const { data: skeleton } = parseSkeleton(roundtrip);
      if (
        skeleton.animations.length !== data.bundle.animations.length ||
        roundtrip.parts.length !== data.bundle.parts.length
      )
        throw new Error("导出校验未通过：动作或部件数量变化。");
      result = bytes;
    } else throw new Error("未知的资源包操作。");
    // Only return worker-owned results by transfer. Export inputs were cloned
    // into this worker; the editor retains its original PNG/authoring buffers.
    const values = result instanceof Uint8Array ? [result] : Object.values(result);
    const transfers = [...new Set(values.map((value) => value.buffer))];
    self.postMessage({ result }, transfers);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
