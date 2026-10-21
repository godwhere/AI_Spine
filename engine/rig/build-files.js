import { compileRigSkeleton } from "./compile.js";
import { decodeBase64 } from "../../shared/codec/base64.mjs";
import { motionStudyAssets } from "./motion-study.js";
import { packRigAtlasRegions } from "./atlas.js";
import { validateRigDocument } from "../../shared/rig-schema.mjs";

function dataBytes(dataURL) { return decodeBase64(dataURL.slice(dataURL.indexOf(",") + 1)); }

async function buildRigFiles(document, pixels, atlasOptions) {
  const doc = validateRigDocument(document), env = pixels;
  const assets = [...doc.parts, ...motionStudyAssets(doc)], artwork = new Map(assets.map((part) => [part.id, part]));
  const layouts = packRigAtlasRegions(assets, atlasOptions), files = {}, pages = {}, atlasPages = [];
  const source = doc.sourceImage ? await env.loadImage(dataBytes(doc.sourceImage)) : null;
  try {
    for (const [index, layout] of layouts.entries()) {
      const file = index === 0 ? "rig.png" : `rig-${index + 1}.png`;
      const canvas = env.createCanvas(layout.width, layout.height), ctx = canvas.getContext("2d");
      try {
        for (const region of layout.regions) {
          const part = artwork.get(region.id), image = part.image ? await env.loadImage(dataBytes(part.image)) : null;
          const crop = env.createCanvas(region.width, region.height), context = crop.getContext("2d");
          try {
            if (image) context.drawImage(image, 0, 0, region.width, region.height);
            else if (source) context.drawImage(source, part.x * source.width / doc.width, part.y * source.height / doc.height,
              part.width * source.width / doc.width, part.height * source.height / doc.height, 0, 0, region.width, region.height);
            else { context.fillStyle = `hsl(${(doc.parts.indexOf(part) * 47) % 360},45%,68%)`; context.fillRect(0, 0, region.width, region.height); }
            ctx.drawImage(crop, region.x, region.y);
            files[`images/${part.id}.png`] = image && part.image.startsWith("data:image/png;") && image.width === region.width && image.height === region.height
              ? dataBytes(part.image) : new Uint8Array(await env.encode(crop));
          } finally { image?.close?.(); crop.width = 1; crop.height = 1; }
        }
        pages[file] = new Uint8Array(await env.encode(canvas));
        atlasPages.push([file, `size:${layout.width},${layout.height}`, "filter:Linear,Linear", "pma:false",
          ...layout.regions.flatMap((part) => [part.id, `bounds:${part.x},${part.y},${part.width},${part.height}`, `offsets:0,0,${part.width},${part.height}`])].join("\n"));
      } finally { canvas.width = 1; canvas.height = 1; }
    }
    const encoder = new TextEncoder();
    files["rig.json"] = encoder.encode(JSON.stringify(compileRigSkeleton(doc)));
    files["rig.atlas"] = encoder.encode(atlasPages.join("\n\n") + "\n"); Object.assign(files, pages);
    return files;
  } finally { source?.close?.(); }
}

export { buildRigFiles };
