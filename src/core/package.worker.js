import { unpackZip, parseBundle, exportPackage } from "./archive.js";
import { parseSkeleton } from "../spine/runtime.js";
self.onmessage = ({ data }) => {
  try {
    let result;
    if (data.operation === "unpack") result = unpackZip(data.bytes);
    else if (data.operation === "export") {
      const bytes = exportPackage(data.bundle, data.pages, data.options);
      const roundtrip = parseBundle(unpackZip(bytes), {
        skeletonPath: data.bundle.skeletonPath,
      });
      const { data: skeleton } = parseSkeleton(roundtrip);
      if (
        skeleton.animations.length !== data.bundle.animations.length ||
        roundtrip.parts.length !== data.bundle.parts.length
      )
        throw new Error("导出校验未通过：动作或部件数量变化。");
      result = bytes;
    } else throw new Error("未知的资源包操作。");
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
