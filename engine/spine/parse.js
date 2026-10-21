import { AtlasAttachmentLoader } from "@esotericsoftware/spine-core";
import { decodeText } from "../../shared/codec/text.mjs";
import { SkeletonBinary } from "@esotericsoftware/spine-core";
import { SkeletonJson } from "@esotericsoftware/spine-core";
import { TextureAtlas } from "@esotericsoftware/spine-core";

function parseSkeleton(
  bundle,
  atlas = new TextureAtlas(
    bundle.atlasPaths.map((p) => decodeText(bundle.files[p])).join("\n\n"),
  ),
) {
  const loader = new AtlasAttachmentLoader(atlas);
  const reader = bundle.binary
    ? new SkeletonBinary(loader)
    : new SkeletonJson(loader);
  const data = reader.readSkeletonData(
    bundle.binary ? bundle.files[bundle.skeletonPath] : bundle.json,
  );
  if (!data.version?.startsWith("4.3."))
    throw new Error(
      `当前运行库支持 Spine 4.3.x，文件是 ${data.version || "未知版本"}。`,
    );
  return { atlas, data };
}

export { parseSkeleton };
