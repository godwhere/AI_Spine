import { MOTION_MAX_GAP_RATIO } from "../../shared/domain/motion-ownership.mjs";

// Pure source-pixel ownership, shared by diagnostics and strict compilation.
const MOTION_SIGNIFICANT_ALPHA = 8;

function motionPolygonContains(polygon, x, y) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}

function rasterMotionOwners(mapping, source) {
  const { width, height, data } = source, parts = mapping.parts.filter((part) => part.visible).sort((a, b) => a.z - b.z), owners = new Int16Array(width * height).fill(-1);
  for (const [index, part] of parts.entries()) {
    const xs = part.sourcePolygon.map((p) => p.x), ys = part.sourcePolygon.map((p) => p.y);
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(height, Math.ceil(Math.max(...ys))); y++)
      for (let x = Math.max(0, Math.floor(Math.min(...xs))); x < Math.min(width, Math.ceil(Math.max(...xs))); x++)
        if (data[(y * width + x) * 4 + 3] && motionPolygonContains(part.sourcePolygon, x + .5, y + .5)) owners[y * width + x] = index;
  }
  return { parts, owners };
}

const include = (bounds, x, y) => bounds ? { x: Math.min(bounds.x, x), y: Math.min(bounds.y, y),
  width: Math.max(bounds.x + bounds.width, x + 1) - Math.min(bounds.x, x), height: Math.max(bounds.y + bounds.height, y + 1) - Math.min(bounds.y, y) } : { x, y, width: 1, height: 1 };

// Separable exact squared-Euclidean distance transform. Ties use the smaller
// row-major boundary pixel, making the inferred owner independent of traversal.
function nearestPhysicalBoundary(document, source, parts, owners) {
  const { width: w, height: h, data } = source, physical = parts.map((part) => !document.parts.find((base) => base.id === part.partId)?.attachmentGroup);
  const nearest = new Int32Array(w * h).fill(-1), squared = new Float64Array(w * h).fill(Infinity);
  for (let y = 0; y < h; y++) {
    let left = -1;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, owner = owners[i];
      if (owner >= 0 && physical[owner] && data[i * 4 + 3] > MOTION_SIGNIFICANT_ALPHA &&
          (x === 0 || y === 0 || x === w - 1 || y === h - 1 || owners[i - 1] !== owner || owners[i + 1] !== owner || owners[i - w] !== owner || owners[i + w] !== owner)) left = i;
      if (left >= 0) { nearest[i] = left; squared[i] = (x - left % w) ** 2; }
    }
    let right = -1;
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x, owner = owners[i];
      if (owner >= 0 && physical[owner] && data[i * 4 + 3] > MOTION_SIGNIFICANT_ALPHA &&
          (x === 0 || y === 0 || x === w - 1 || y === h - 1 || owners[i - 1] !== owner || owners[i + 1] !== owner || owners[i - w] !== owner || owners[i + w] !== owner)) right = i;
      if (right >= 0 && (right % w - x) ** 2 < squared[i]) { nearest[i] = right; squared[i] = (right % w - x) ** 2; }
    }
  }
  const result = new Int32Array(w * h).fill(-1), distances = new Float64Array(w * h).fill(Infinity), v = new Int32Array(h), z = new Float64Array(h + 1);
  for (let x = 0; x < w; x++) {
    let k = -1;
    for (let q = 0; q < h; q++) {
      const fq = squared[q * w + x]; if (!Number.isFinite(fq)) continue;
      let intersection = -Infinity;
      while (k >= 0) { const p = v[k]; intersection = (fq + q * q - squared[p * w + x] - p * p) / (2 * (q - p)); if (intersection > z[k]) break; k--; }
      k++; v[k] = q; z[k] = k === 0 ? -Infinity : intersection; z[k + 1] = Infinity;
    }
    if (k < 0) continue;
    let envelope = 0;
    for (let y = 0; y < h; y++) {
      while (envelope < k && z[envelope + 1] < y) envelope++;
      const row = v[envelope], i = y * w + x; result[i] = nearest[row * w + x]; distances[i] = squared[row * w + x] + (y - row) ** 2;
    }
  }
  return { nearest: result, squared: distances, physical };
}

function inferMotionGapOwners(document, mapping, source, maxDistance = 64) {
  if (!Number.isFinite(maxDistance) || maxDistance < 0 || maxDistance > 64) throw new Error("缺口候选距离必须在 0 至 64 像素内。");
  const { parts, owners: originalOwners } = rasterMotionOwners(mapping, source), owners = new Int16Array(originalOwners), { width, height, data } = source;
  const field = nearestPhysicalBoundary(document, source, parts, owners), byPart = parts.map((part, index) => ({ partId: part.partId, physical: field.physical[index], ownedPixels: 0, addedPixels: 0, bounds: null, addedBounds: null, maxDistance: 0 }));
  let sourcePixels = 0, significantPixels = 0, missingPixels = 0, missingSignificantPixels = 0, weakMissingPixels = 0, missingBounds = null, significantMissingBounds = null, maxObservedDistance = 0, unresolvedSignificantPixels = 0, addedPixels = 0;
  for (let i = 0; i < owners.length; i++) {
    const alpha = data[i * 4 + 3]; if (!alpha) continue;
    sourcePixels++; if (alpha > MOTION_SIGNIFICANT_ALPHA) significantPixels++;
    const x = i % width, y = Math.floor(i / width), owner = owners[i];
    if (owner >= 0) { const part = byPart[owner]; part.ownedPixels++; part.bounds = include(part.bounds, x, y); continue; }
    missingPixels++; missingBounds = include(missingBounds, x, y);
    if (alpha <= MOTION_SIGNIFICANT_ALPHA) { weakMissingPixels++; continue; }
    missingSignificantPixels++; significantMissingBounds = include(significantMissingBounds, x, y);
    const distance = Math.sqrt(field.squared[i]), seed = field.nearest[i]; maxObservedDistance = Math.max(maxObservedDistance, distance);
    if (seed < 0 || distance > maxDistance) { unresolvedSignificantPixels++; continue; }
    const next = originalOwners[seed], part = byPart[next]; owners[i] = next; addedPixels++; part.addedPixels++; part.addedBounds = include(part.addedBounds, x, y); part.maxDistance = Math.max(part.maxDistance, distance);
  }
  const significantGapRatio = significantPixels ? missingSignificantPixels / significantPixels : 0;
  return { originalOwners, owners, partIds: parts.map((part) => part.partId), nearestBoundary: field.nearest, distancesSquared: field.squared,
    sourcePixels, significantPixels, missingPixels, missingSignificantPixels, weakMissingPixels, missingBounds, significantMissingBounds, significantGapRatio,
    maxDistance: maxObservedDistance, maxAllowedDistance: maxDistance, unresolvedSignificantPixels, addedPixels, parts: byPart,
    canPropose: significantGapRatio <= MOTION_MAX_GAP_RATIO && unresolvedSignificantPixels === 0 };
}

export { MOTION_SIGNIFICANT_ALPHA, inferMotionGapOwners, motionPolygonContains, rasterMotionOwners };
