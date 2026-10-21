import { sha256 } from "../codec/sha256.mjs";

export const MAGIC_EFFECT_GENERATOR = "ispine-starlight-v1";
export const isRigEffectPart = (part) => part?.role === "effect";

export function magicEffectOptions(document, motionId, values = {}) {
  const motion = document.motions.find((item) => item.id === motionId);
  if (!motion) throw new Error("请先选择需要特效的动作。");
  const result = { chargeBone: "rightHand", releaseBone: "leftHand", chargeX: -35, chargeY: -295,
    releaseX: 20, releaseY: 0, chargeStart: .15, releaseTime: .95, endTime: 1.65, intensity: .9,
    fps: 30, blend: "normal", ...values };
  for (const name of ["chargeStart", "releaseTime", "endTime", "intensity", "chargeX", "chargeY", "releaseX", "releaseY"])
    if (!Number.isFinite(result[name])) throw new Error("特效时间、位置和强度必须是有效数值。");
  if (result.chargeStart < 0 || result.releaseTime - result.chargeStart < .12 || result.endTime - result.releaseTime < .15 || result.endTime > motion.duration)
    throw new Error("请依次设置蓄力开始、释放时刻和消散结束，全部位于当前动作内。");
  if (result.intensity < .1 || result.intensity > 1.5 || ![24, 30].includes(result.fps) || !["normal", "additive"].includes(result.blend))
    throw new Error("特效强度、帧率或叠加方式无效。");
  for (const kind of ["charge", "release"]) {
    const joint = document.joints.find((item) => item.id === result[kind + "Bone"]);
    if (!joint) throw new Error("请选择有效的特效跟随关节。");
    const x = joint.x + result[kind + "X"] - (kind === "charge" ? 128 : 40), y = joint.y + result[kind + "Y"] - 128;
    if (x < 0 || y < 0 || x + 256 > document.width || y + 256 > document.height)
      throw new Error("特效设定区域超出源画布，请调整跟随关节或偏移。");
  }
  return result;
}

export function magicEffectFrames(options) {
  const result = [];
  for (const kind of ["charge", "release"]) {
    const start = kind === "charge" ? options.chargeStart : Math.max(options.chargeStart, options.releaseTime - .07);
    const end = kind === "charge" ? Math.min(options.endTime, options.releaseTime + .14) : options.endTime;
    const times = new Set([start, options.releaseTime]);
    for (let i = 1; start + i / options.fps < end - 1e-6; i++) times.add(Math.round((start + i / options.fps) * 1e6) / 1e6);
    for (const [index, time] of [...times].sort((a, b) => a - b).entries()) result.push({ kind, index, time, end, width: 256, height: 256 });
  }
  if (result.length > 120) throw new Error("特效时间过长，请缩短蓄力或消散区间。");
  return result;
}

export function withoutRigMagicEffects(document, motionId) {
  const removed = document.parts.filter((part) => isRigEffectPart(part) && part.effect?.motionId === motionId && part.effect.generator === MAGIC_EFFECT_GENERATOR);
  if (!removed.length) return document;
  const ids = new Set(removed.map((part) => part.id)), groups = new Set(removed.map((part) => part.attachmentGroup));
  const defaults = { ...document.defaultAttachments }; for (const group of groups) delete defaults[group];
  return { ...document, parts: document.parts.filter((part) => !ids.has(part.id)), defaultAttachments: defaults,
    motions: document.motions.map((motion) => {
      if (motion.id !== motionId) return motion;
      const next = { ...motion, effectTracks: (motion.effectTracks || []).filter((track) => !groups.has(track.groupId)) };
      delete next.magicEffects;
      if (!next.effectTracks.length) delete next.effectTracks;
      return next;
    }) };
}

export function retimeMotionEffects(motion, duration) {
  if (!motion.effectTracks?.length) return {};
  const ratio = duration / motion.duration;
  const values = { effectTracks: motion.effectTracks.map((track) => ({ ...track, keys: track.keys.map((key) => ({ ...key, time: Math.min(duration, key.time * ratio) })) })) };
  if (motion.magicEffects) {
    const options = { ...motion.magicEffects.options };
    for (const key of ["chargeStart", "releaseTime", "endTime"]) options[key] *= ratio;
    values.magicEffects = { ...motion.magicEffects, options };
  }
  return values;
}

export function withRigMagicEffects(document, motionId, options, frames) {
  const doc = withoutRigMagicEffects(document, motionId), token = sha256(motionId).slice(0, 10), parts = [], tracks = [], defaults = { ...doc.defaultAttachments };
  if (doc.parts.length + frames.length > 256) throw new Error("特效纹理会超过当前角色的区域上限，请缩短时间或降低帧率。");
  for (const kind of ["charge", "release"]) {
    const bone = options[kind + "Bone"], joint = doc.joints.find((item) => item.id === bone), groupId = `fx_${token}_${kind}`, keys = [{ time: 0, name: null }];
    const selected = frames.filter((frame) => frame.kind === kind);
    if (!selected.length) throw new Error("特效纹理尚未完成。");
    for (const frame of selected) {
      const id = `fx-${token}-${kind}-${String(frame.index).padStart(3, "0")}`;
      if (doc.parts.some((part) => part.id === id || part.attachmentGroup === groupId)) throw new Error("特效标识与现有部件冲突，未覆盖任何部件。");
      parts.push({ id, label: `${kind === "charge" ? "蓄力星环" : "释放星芒"} ${frame.index + 1}`, role: "effect", bone,
        x: joint.x + options[kind + "X"] - (kind === "charge" ? 128 : 40), y: joint.y + options[kind + "Y"] - 128,
        width: 256, height: 256, z: kind === "charge" ? 29 : 40, binding: "rigid", influences: [bone],
        attachmentGroup: groupId, blendMode: options.blend, image: frame.image, imageSource: "procedural", completion: "ready", critical: false,
        effect: { generator: MAGIC_EFFECT_GENERATOR, motionId, kind, frame: frame.index, time: frame.time, fps: options.fps } });
      keys.push({ time: frame.time, name: id });
    }
    keys.push({ time: selected[0].end, name: null });
    const unique = new Map(keys.map((key) => [key.time, key]));
    tracks.push({ groupId, kind, generator: MAGIC_EFFECT_GENERATOR, keys: [...unique.values()].sort((a, b) => a.time - b.time) });
    defaults[groupId] = null;
  }
  return { ...doc, parts: [...doc.parts, ...parts], defaultAttachments: defaults,
    motions: doc.motions.map((motion) => motion.id === motionId ? { ...motion,
      effectTracks: [...(motion.effectTracks || []), ...tracks], magicEffects: { generator: MAGIC_EFFECT_GENERATOR, options } } : motion) };
}

export function effectTrackSelection(motion, time) {
  const result = {};
  for (const track of motion?.effectTracks || []) {
    result[track.groupId] = null;
    for (const key of track.keys) { if (key.time > time) break; result[track.groupId] = key.name; }
  }
  return result;
}

export function extendEffectDrawOrder(document, order) {
  const result = [...order], slots = new Set(result);
  const sorted = [...document.parts].sort((a, b) => a.z - b.z), defaults = [...new Set(sorted.map((part) => part.attachmentGroup ? `group_${part.attachmentGroup}` : `slot_${part.id}`))];
  const effects = new Set(sorted.filter(isRigEffectPart).map((part) => `group_${part.attachmentGroup}`));
  for (const slot of defaults) if (effects.has(slot) && !slots.has(slot)) {
    const following = defaults.slice(defaults.indexOf(slot) + 1).find((id) => slots.has(id));
    const at = following ? result.indexOf(following) : result.length; result.splice(at, 0, slot); slots.add(slot);
  }
  return result;
}
