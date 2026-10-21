import { AnimationState } from "@esotericsoftware/spine-core";
import { AnimationStateData } from "@esotericsoftware/spine-core";
import { MeshAttachment } from "@esotericsoftware/spine-core";
import { Physics } from "@esotericsoftware/spine-core";
import { RegionAttachment } from "@esotericsoftware/spine-core";
import { Skeleton } from "@esotericsoftware/spine-core";

function attachmentVertices(skeleton, slot) {
  const pose = slot.appliedPose,
    attachment = pose.attachment;
  if (attachment instanceof RegionAttachment) {
    const vertices = new Float32Array(8);
    attachment.computeWorldVertices(
      slot,
      attachment.getOffsets(pose),
      vertices,
      0,
      2,
    );
    return { attachment, vertices };
  }
  if (attachment instanceof MeshAttachment) {
    const vertices = new Float32Array(attachment.worldVerticesLength);
    attachment.computeWorldVertices(
      skeleton,
      slot,
      0,
      vertices.length,
      vertices,
      0,
      2,
    );
    return { attachment, vertices };
  }
  return null;
}

function measureAnimation(data, animation, skin) {
  const skeleton = new Skeleton(data);
  if (skin) skeleton.setSkin(skin);
  skeleton.setupPose();
  const state = new AnimationState(new AnimationStateData(data));
  const target = animation ? data.findAnimation(animation) : null,
    track = target ? state.setAnimation(0, target, false) : null;
  let x = Infinity,
    y = Infinity,
    right = -Infinity,
    top = -Infinity;
  for (let step = 0; step <= 16; step++) {
    skeleton.setupPose();
    if (track) {
      track.trackTime = (target.duration * step) / 16;
      state.apply(skeleton);
    }
    skeleton.updateWorldTransform(Physics.none);
    const bounds = skeleton.getBoundsRect();
    if (Number.isFinite(bounds.x) && bounds.width > 0 && bounds.height > 0) {
      x = Math.min(x, bounds.x);
      y = Math.min(y, bounds.y);
      right = Math.max(right, bounds.x + bounds.width);
      top = Math.max(top, bounds.y + bounds.height);
    }
  }
  return Number.isFinite(x)
    ? { x, y, width: right - x, height: top - y }
    : { x: -200, y: 0, width: 400, height: 400 };
}

function measurePreviewBounds(data, skin) {
  const actions = data.animations.length ? data.animations : [null];
  let x = Infinity,
    y = Infinity,
    right = -Infinity,
    top = -Infinity;
  for (const action of actions) {
    const bounds = measureAnimation(data, action?.name, skin);
    x = Math.min(x, bounds.x);
    y = Math.min(y, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    top = Math.max(top, bounds.y + bounds.height);
  }
  return { x, y, width: right - x, height: top - y };
}

function pointInTriangle(point, a, b, c) {
  const sign = (p, q, r) =>
    (p.x - r.x) * (q.y - r.y) - (q.x - r.x) * (p.y - r.y);
  const d1 = sign(point, a, b),
    d2 = sign(point, b, c),
    d3 = sign(point, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function pickPart(shapes, point) {
  for (const shape of [...shapes].reverse()) {
    for (let i = 0; i < shape.triangles.length; i += 3) {
      const [a, b, c] = shape.triangles
        .slice(i, i + 3)
        .map((index) => shape.points[index]);
      if (a && b && c && pointInTriangle(point, a, b, c)) return shape.id;
    }
  }
  return null;
}

export { attachmentVertices, measureAnimation, measurePreviewBounds, pickPart, pointInTriangle };
