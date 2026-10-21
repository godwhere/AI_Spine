import { assertAppliedMotionStudy } from "../../shared/domain/motion-study.mjs";
import { attachmentState } from "./attachments.js";
import { attachmentTimelineTime } from "./attachments.js";
import { distance } from "./math.js";
import { geometry } from "./geometry.js";
import { isMotionStudyPlaybackActive } from "../../shared/domain/motion-study.mjs";
import { motionDrawOrder } from "./sample.js";
import { motionStudyFramePose } from "./motion-study.js";
import { motionStudyKeyTime } from "./motion-study.js";
import { motionStudyRegionName } from "../../shared/domain/motion-study.mjs";
import { motionStudySlotName } from "../../shared/domain/motion-study.mjs";
import { rigPartSlotName } from "./attachments.js";
import { rotate } from "./math.js";
import { round } from "./math.js";
import { sampled } from "./sample.js";
import { turn } from "./math.js";

function compileRigSkeleton(document, { sampleRate = 30 } = {}) {
  if (!Number.isFinite(sampleRate) || sampleRate < 5 || sampleRate > 120) throw new Error("动作烘焙帧率必须在 5 至 120 之间。");
  const g = geometry(document), { doc } = g, boneIndices = new Map(g.ordered.map((joint, index) => [joint.id, index]));
  const bones = g.ordered.map((joint) => {
    const parent = joint.parent && g.byId.get(joint.parent), child = g.children.get(joint.id)[0];
    const offset = parent ? rotate(joint.x - parent.x, joint.y - parent.y, -g.setupAngles[parent.id]) : { x: joint.x, y: joint.y - doc.height };
    return { name: joint.id, ...(parent ? { parent: parent.id } : {}), x: round(offset.x), y: round(-offset.y),
      rotation: round(-g.setupAngles[joint.id] + (parent ? g.setupAngles[parent.id] : 0)), length: round(child ? distance(joint, child) : 0) };
  });
  const orderedParts = [...doc.parts].sort((a, b) => a.z - b.z), attachments = {}, slots = [], slotGroups = new Map();
  const setupAttachments = attachmentState(doc).attachmentSelection;
  for (const part of orderedParts) {
    const joint = g.byId.get(part.bone), slot = rigPartSlotName(part);
    let attachment;
    if (part.binding === "rigid") {
      const center = rotate(part.x + part.width / 2 - joint.x, part.y + part.height / 2 - joint.y, -g.setupAngles[joint.id]);
      attachment = { type: "region", path: part.id, x: round(center.x), y: round(-center.y), rotation: round(g.setupAngles[joint.id]), width: part.width, height: part.height };
    } else {
      const mesh = g.meshes[part.id], vertices = [];
      for (let i = 0; i < mesh.weights.length; i++) {
        vertices.push(mesh.weights[i].length);
        const total = mesh.weights[i].reduce((sum, weight) => sum + weight.weight, 0);
        for (const weight of mesh.weights[i]) {
          const bone = g.byId.get(weight.joint), local = rotate(mesh.vertices[i * 2] - bone.x, mesh.vertices[i * 2 + 1] - bone.y, -g.setupAngles[bone.id]);
          vertices.push(boneIndices.get(bone.id), round(local.x), round(-local.y), weight.weight / total);
        }
      }
      attachment = { type: "mesh", path: part.id, uvs: mesh.uvs, triangles: mesh.triangles, vertices, hull: mesh.hull, width: part.width, height: part.height };
    }
    if (!attachments[slot]) {
      attachments[slot] = {};
      const selected = part.attachmentGroup ? setupAttachments[part.attachmentGroup] : part.id;
      slots.push({ name: slot, bone: part.bone, ...(selected === null ? {} : { attachment: selected }) });
      if (part.attachmentGroup) slotGroups.set(part.attachmentGroup, slot);
    }
    attachments[slot][part.id] = attachment;
  }
  const animations = {};
  const translationBones = new Set(doc.motions.flatMap((motion) => motion.poses.flatMap((pose) => Object.keys(pose.translations || {}))));
  const scaleBones = new Set(doc.motions.flatMap((motion) => motion.poses.flatMap((pose) => Object.keys(pose.scales || {}))));
  const hasDrawOrder = doc.motions.some((motion) => motion.poses.some((pose) => pose.drawOrder));
  for (const motion of doc.motions) {
    const steps = Math.ceil(motion.duration * sampleRate);
    // Runtime timelines store Float32 times: merge indistinguishable grid/key
    // times before baking, while retaining exact authored endpoint poses.
    const timeMap = new Map();
    for (const time of [...Array.from({ length: steps + 1 }, (_, i) => motion.duration * i / steps), ...motion.poses.map((pose) => pose.time), motion.duration])
      timeMap.set(Math.fround(time), { time, sampleTime: time });
    const contacts = { left: false, right: false };
    for (const pose of motion.poses) {
      let changes = false;
      for (const side of ["left", "right"]) if (pose.feet?.[side] !== undefined) {
        changes ||= contacts[side] !== pose.feet[side]; contacts[side] = pose.feet[side];
      }
      if (!changes || pose.time === 0) continue;
      // IK contact is discrete. Preserve its left limit and step to the new
      // solution rather than blending an unlocked leg into the locked interval.
      // A transition uses the first Float32 time at or after the authored time:
      // the storage precision may delay it by one ULP, but can never release early.
      const value = Float32Array.of(pose.time), bits = new Uint32Array(value.buffer);
      if (value[0] < pose.time) bits[0]++;
      const transition = value[0]; bits[0]--; const before = value[0];
      timeMap.set(before, { time: before, sampleTime: before, stepped: true });
      timeMap.set(transition, { time: transition, sampleTime: pose.time });
    }
    const baked = [...timeMap.values()].sort((a, b) => a.time - b.time), times = baked.map((frame) => frame.time);
    const poses = baked.map((frame) => sampled(g, motion, frame.sampleTime, false)), timelines = {};
    for (const joint of g.ordered) {
      let previous;
      const frames = poses.map((pose, index) => {
        let value = -pose.angles[joint.id];
        if (previous !== undefined) value = previous + turn(value - previous);
        previous = value;
        return { time: times[index], value: round(value), ...(baked[index].stepped ? { curve: "stepped" } : {}) };
      });
      timelines[joint.id] = { rotate: frames };
      if (translationBones.has(joint.id)) timelines[joint.id].translate = poses.map((pose, index) => ({ time: times[index],
        x: round(pose.translations[joint.id].x), y: round(-pose.translations[joint.id].y), ...(baked[index].stepped ? { curve: "stepped" } : {}) }));
      if (scaleBones.has(joint.id)) timelines[joint.id].scale = poses.map((pose, index) => ({ time: times[index],
        x: round(pose.scales[joint.id].x), y: round(pose.scales[joint.id].y), ...(baked[index].stepped ? { curve: "stepped" } : {}) }));
    }
    timelines[g.root.id].translate = poses.map((pose, index) => ({ time: times[index], x: round(pose.root.x), y: round(-pose.root.y), ...(baked[index].stepped ? { curve: "stepped" } : {}) }));
    const slotTimelines = {};
    for (const [groupId, slot] of slotGroups) {
      const keys = new Map([[Math.fround(0), { time: 0, name: setupAttachments[groupId] }]]);
      for (const pose of motion.poses) if (Object.hasOwn(pose.attachments || {}, groupId)) {
        const time = attachmentTimelineTime(pose.time);
        keys.set(time, { time, name: pose.attachments[groupId] });
      }
      slotTimelines[slot] = { attachment: [...keys.values()].sort((a, b) => a.time - b.time) };
    }
    const drawOrder = [];
    if (hasDrawOrder) for (const pose of motion.poses) if (pose.time === 0 || pose.drawOrder) {
      const desired = motionDrawOrder(g, motion, pose.time), target = new Map(desired.map((slot, index) => [slot, index]));
      drawOrder.push({ time: attachmentTimelineTime(pose.time), offsets: slots.map((slot, index) => ({ slot: slot.name, offset: target.get(slot.name) - index })) });
    }
    // Every animation must reset order at zero, including old motions whose first
    // authored pose starts later, when switching from a crossing/turning action.
    if (hasDrawOrder && drawOrder[0]?.time !== 0) drawOrder.unshift({ time: 0, offsets: [] });
    animations[motion.id] = { bones: timelines, ...(slotGroups.size ? { slots: slotTimelines } : {}), ...(hasDrawOrder ? { drawOrder } : {}) };
  }
  const result = { skeleton: { spine: "4.3.23", x: 0, y: 0, width: doc.width, height: doc.height, images: "images/", fps: sampleRate },
    bones, slots,
    skins: [{ name: "default", attachments }], animations };
  compileMotionStudies(result, g);
  return result;
}

function compileMotionStudies(skeleton, g) {
  const { doc } = g, studies = Object.entries(doc.motionStudies || {}).filter(([, study]) => isMotionStudyPlaybackActive(study));
  if (!studies.length) return;
  const scaledBones = new Set(doc.motions.flatMap((motion) => motion.poses.flatMap((pose) => Object.keys(pose.scales || {}))));
  const originalSlots = [...skeleton.slots], allStudySlots = [];
  for (const [motionId] of studies) {
    const study = assertAppliedMotionStudy(doc, motionId), partIds = [...new Set(study.frames.flatMap((frame) => frame.segments.map((segment) => segment.partId)))];
    for (const partId of partIds) {
      const part = doc.parts.find((item) => item.id === partId), name = motionStudySlotName(motionId, partId);
      skeleton.slots.push({ name, bone: part.bone }); allStudySlots.push(name);
      skeleton.skins[0].attachments[name] = {};
    }
    const timelines = {}, slotTimelines = Object.fromEntries(partIds.map((partId) => [motionStudySlotName(motionId, partId), { attachment: [] }]));
    const drawOrders = [];
    for (const frame of study.frames) {
      const joints = motionStudyFramePose(doc, frame), time = motionStudyKeyTime(frame.time);
      for (const bone of skeleton.bones) {
        const joint = joints[bone.name], parent = bone.parent && joints[bone.parent];
        const position = parent ? rotate(joint.x - parent.x, joint.y - parent.y, -parent.angle) : { x: joint.x, y: joint.y - doc.height };
        const timeline = timelines[bone.name] ||= { rotate: [], translate: [] };
        timeline.rotate.push({ time, value: round(-joint.angle + (parent?.angle || 0) - bone.rotation), curve: "stepped" });
        timeline.translate.push({ time, x: round(position.x - bone.x), y: round(-position.y - bone.y), curve: "stepped" });
      }
      for (const partId of partIds) {
        const segment = frame.segments.find((value) => value.partId === partId), slot = motionStudySlotName(motionId, partId);
        const name = segment ? motionStudyRegionName(motionId, frame.id, partId) : null;
        slotTimelines[slot].attachment.push({ time, name });
        if (!segment) continue;
        const part = doc.parts.find((value) => value.id === partId), joint = joints[part.bone];
        const center = rotate(segment.x + segment.width / 2 - joint.x, segment.y + segment.height / 2 - joint.y, -joint.angle);
        skeleton.skins[0].attachments[slot][name] = { type: "region", path: name, x: round(center.x), y: round(-center.y), rotation: round(joint.angle), width: segment.width, height: segment.height };
      }
      drawOrders.push({ time, active: [...frame.segments].sort((a, b) => a.z - b.z).map((part) => motionStudySlotName(motionId, part.partId)) });
    }
    for (const name of scaledBones) if (timelines[name]) timelines[name].scale = [{ time: 0, x: 1, y: 1 }];
    skeleton.animations[motionId] = { bones: timelines, slots: slotTimelines, studyDrawOrders: drawOrders };
  }
  const names = skeleton.slots.map((slot) => slot.name);
  for (const [motionId, animation] of Object.entries(skeleton.animations)) {
    const isStudy = studies.some(([id]) => id === motionId); animation.slots ||= {};
    for (const slot of originalSlots) {
      if (isStudy) animation.slots[slot.name] = { attachment: [{ time: 0, name: null }] };
      else if (!animation.slots[slot.name]?.attachment) animation.slots[slot.name] = { ...animation.slots[slot.name], attachment: [{ time: 0, name: slot.attachment ?? null }] };
    }
    for (const name of allStudySlots) if (!animation.slots[name]) animation.slots[name] = { attachment: [{ time: 0, name: null }] };
    if (isStudy) {
      animation.drawOrder = animation.studyDrawOrders.map(({ time, active }) => {
        const activeIds = new Set(active), ordered = [...names.filter((name) => !activeIds.has(name)), ...active], target = new Map(ordered.map((name,index) => [name,index]));
        return { time, offsets: names.map((slot,index) => ({ slot, offset: target.get(slot) - index })) };
      });
      delete animation.studyDrawOrders;
    } else {
      animation.drawOrder ||= [{ time: 0, offsets: [] }];
      for (const bone of skeleton.bones) if (!animation.bones?.[bone.name]?.translate)
        (animation.bones[bone.name] ||= {}).translate = [{ time: 0, x: 0, y: 0 }];
    }
  }
}

export { compileRigSkeleton };
