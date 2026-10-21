import { TextureAtlas } from "@esotericsoftware/spine-core";

export function countAtlasRegions(texts) {
  return texts.length ? new Set(texts.flatMap((text) => new TextureAtlas(text).regions.map((region) => region.name))).size : undefined;
}
