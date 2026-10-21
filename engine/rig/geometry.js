import { bearing } from "./math.js";
import { clamp } from "./math.js";
import { rigGeometry } from "../../shared/domain/rig.mjs";
import { validateRigDocument } from "../../shared/rig-schema.mjs";

const geometrySamplingCache = new WeakMap();

function geometry(document, cache = false) {
  const signature = cache ? JSON.stringify({ geometry: rigGeometry(document), motions: document.motions }) : null;
  const cached = cache && geometrySamplingCache.get(document);
  if (cached?.signature === signature) return cached.result;
  const doc = validateRigDocument(document), byId = new Map(doc.joints.map((joint) => [joint.id, joint]));
  const children = new Map(doc.joints.map((joint) => [joint.id, []]));
  for (const joint of doc.joints) if (joint.parent) children.get(joint.parent).push(joint);
  const ordered = [], setupAngles = {};
  const visit = (joint) => {
    ordered.push(joint);
    const child = children.get(joint.id)[0];
    setupAngles[joint.id] = !joint.parent ? 0 : child ? bearing(joint, child) : setupAngles[joint.parent];
    for (const child of children.get(joint.id)) visit(child);
  };
  const root = doc.joints.find((joint) => joint.parent === null); visit(root);
  const result = { doc, byId, children, ordered, root, setupAngles };
  result.meshes = Object.fromEntries(doc.parts.map((part) => [part.id, meshForPart(result, part)]));
  if (cache) geometrySamplingCache.set(document, { signature, result });
  return result;
}

function segmentDistance(point, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / Math.max(dx * dx + dy * dy, 1e-9), 0, 1);
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}

function meshForPart(g, part) {
  const cols = part.binding === "mesh" ? part.mesh?.cols ?? 3 : 2, rows = part.binding === "mesh" ? part.mesh?.rows ?? 3 : 2;
  const order = [];
  for (let x = 0; x < cols; x++) order.push(x);
  for (let y = 1; y < rows; y++) order.push(y * cols + cols - 1);
  for (let x = cols - 2; x >= 0; x--) order.push((rows - 1) * cols + x);
  for (let y = rows - 2; y > 0; y--) order.push(y * cols);
  const hull = order.length;
  for (let y = 1; y < rows - 1; y++) for (let x = 1; x < cols - 1; x++) order.push(y * cols + x);
  const indices = new Map(order.map((value, index) => [value, index])), vertices = [], uvs = [], triangles = [];
  for (const cell of order) {
    const u = (cell % cols) / (cols - 1), v = Math.floor(cell / cols) / (rows - 1);
    vertices.push(part.x + part.width * u, part.y + part.height * v); uvs.push(u, v);
  }
  for (let y = 0; y < rows - 1; y++) for (let x = 0; x < cols - 1; x++) {
    const a = y * cols + x, b = a + 1, c = a + cols, d = c + 1;
    triangles.push(indices.get(a), indices.get(c), indices.get(b), indices.get(b), indices.get(c), indices.get(d));
  }
  const weights = order.map((_, index) => {
    if (part.binding === "rigid") return [{ joint: part.bone, weight: 1 }];
    if (part.mesh?.weights) return part.mesh.weights[index].map((item) => ({ ...item }));
    const point = { x: vertices[index * 2], y: vertices[index * 2 + 1] };
    const values = part.influences.map((id) => {
      const a = g.byId.get(id), b = g.children.get(id)[0] || a;
      return { joint: id, weight: 1 / Math.max(1, segmentDistance(point, a, b)) ** 2 };
    });
    const sum = values.reduce((total, item) => total + item.weight, 0);
    return values.map((item) => ({ ...item, weight: item.weight / sum }));
  });
  return { vertices, uvs, triangles, weights, cols, rows, hull };
}

function getRigPartMesh(document, partId) {
  const g = geometry(document), result = g.meshes[partId];
  if (!result) throw new Error(`部件不存在：${partId}`);
  return result;
}

function setRigPartWeights(document, partId, vertexIndex, weights) {
  const g = geometry(document), part = g.doc.parts.find((part) => part.id === partId), mesh = g.meshes[partId];
  if (part?.binding !== "mesh" || !Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= mesh.weights.length) throw new Error("请选择网格部件的有效顶点。");
  part.mesh = { cols: mesh.cols, rows: mesh.rows, weights: mesh.weights };
  part.mesh.weights[vertexIndex] = structuredClone(weights);
  return validateRigDocument(g.doc);
}

function bindRigWeapon(document, partId, options = {}) {
  const doc = validateRigDocument(document), part = doc.parts.find((part) => part.id === partId);
  const hand = options.primaryHand || options.hand || "rightHand", grip = options.primaryLocalPoint || options.grip;
  const joint = doc.joints.find((joint) => joint.id === hand);
  if (!part || !joint || !grip) throw new Error("请选择武器部件、主手和图片内握点。");
  part.bone = hand; part.binding = "rigid"; part.influences = [hand]; delete part.mesh;
  part.x = joint.x - grip.x; part.y = joint.y - grip.y;
  part.grip = { primaryHand: hand, primaryLocalPoint: { ...grip } };
  if (options.secondaryHand) {
    part.grip.secondaryHand = options.secondaryHand;
    part.grip.secondaryLocalPoint = structuredClone(options.secondaryLocalPoint || options.secondaryGrip);
  }
  return validateRigDocument(doc);
}

export { bindRigWeapon, geometry, getRigPartMesh, setRigPartWeights };
