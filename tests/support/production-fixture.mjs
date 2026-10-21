import { createCanvas } from "@napi-rs/canvas";
import { validateRigDocument } from "../../shared/rig-schema.mjs";
import { createProductionPlan, productionBriefFields, productionChecks } from "../../shared/domain/production.mjs";
import { confirmProduction } from "../../src/application/rig-production.js";

// Deliberately synthetic geometry: never a visual acceptance of character art.
export function productionArtwork(color = "#8b62d8", offset = 0) {
  const canvas = createCanvas(64, 64), context = canvas.getContext("2d");
  context.fillStyle = color; context.fillRect(17 + offset, 12, 25, 40);
  return canvas.toDataURL("image/png");
}
export function productionFixture({ reviewed = true } = {}) {
  const image = productionArtwork(), production = createProductionPlan();
  production.brief = Object.fromEntries(productionBriefFields.map(([key, label]) => [key, `Synthetic test only: ${label}; fixed source pixels and scale.`]));
  production.boards = production.boards.map((board, i) => board.reuseBase ? board : { ...board, image: productionArtwork(i === 1 ? "#d872af" : "#6b86c4", i) });
  let doc = validateRigDocument({ version: 1, id: "workflow-fixture", name: "工作流隔离测试（几何占位）", width: 64, height: 64, sourceImage: image, origin: "manual", structureDetail: "standard", production,
    joints: [{ id: "root", parent: null, x: 32, y: 40 }, { id: "hand", parent: "root", x: 46, y: 30 }],
    parts: [{ id: "body", bone: "root", x: 16, y: 16, width: 24, height: 32, z: 0, binding: "rigid", image, imageSource: "uploaded", completion: "ready" }],
    motions: production.motions.map((m) => ({ id: m.id, name: m.name, description: m.script, duration: m.duration, loop: m.loop, origin: "manual",
      poses: [0, m.duration / 2, m.duration].map((time, i) => ({ time, angles: { hand: i === 1 ? 10 : 0 }, root: { x: 0, y: i === 1 ? -1 : 0 }, ease: "smooth" })) })) });
  if (reviewed) {
    const confirm = (stage, id) => { doc = confirmProduction(doc, stage, id, productionChecks[stage], "2026-10-21T00:00:00.000Z"); };
    confirm("brief"); confirm("appearance"); for (const b of doc.production.boards) confirm("board", b.id);
    for (const stage of ["structure", "assembly", "binding"]) confirm(stage);
    for (const m of doc.motions) confirm("motion", m.id);
  }
  return doc;
}
