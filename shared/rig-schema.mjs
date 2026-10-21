import { validateProduction } from "./domain/production.mjs";
import { retimeMotionEffects } from "./domain/rig-effects.mjs";

// RigDocument v1 is independent of templates, IndexedDB, Canvas, and Spine runtime.
const clone = (value) => structuredClone(value);
const fail = (message) => { throw new Error(message); };
const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
function number(value, label, min = -1e6, max = 1e6) {
  if (!Number.isFinite(value) || value < min || value > max) fail(`${label}无效。`);
  return value;
}
function identifier(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value)) fail(`${label}必须是唯一的字母、数字或下划线标识。`);
  return value;
}
function image(value, label) {
  if (value !== undefined && (typeof value !== "string" || value.length > 96 * 1024 * 1024 || !/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+=*$/.test(value)))
    fail(`${label}必须是本地 PNG、JPEG 或 WebP 数据。`);
}
function point(value, label) {
  if (!plain(value)) fail(`${label}缺少坐标。`);
  return { x: number(value.x, `${label} x`), y: number(value.y, `${label} y`) };
}

// Shared by complete rig documents and pre-analysis drafts with no joints yet.
// The original appearance reference is independent of the final sourceImage.
export function validateRigAppearanceFields(document) {
  validateProduction(document);
  const reference = document.appearanceReference;
  if (reference !== undefined) {
    if (!plain(reference) || typeof reference.image !== "string") fail("原始外观参考缺少本地图片。");
    image(reference.image, "原始外观参考");
    for (const key of ["width", "height"])
      if (!Number.isInteger(reference[key]) || reference[key] < 1 || reference[key] > 8192) fail("原始外观参考尺寸无效。");
    if (reference.name !== undefined && (typeof reference.name !== "string" || reference.name.length > 240)) fail("原始外观参考名称无效。");
  }
  if (document.appearance !== undefined) {
    if (!plain(document.appearance)) fail("形象生成来源元数据无效。");
    for (const key of ["prompt", "sourceFingerprint", "jobId", "imageId", "provider", "model", "createdAt"])
      if (document.appearance[key] !== undefined && (typeof document.appearance[key] !== "string" || document.appearance[key].length > 4000)) fail("形象生成来源字段必须是不超过 4000 字的文本。");
    const inspect = (value, depth = 0) => {
      if (depth > 8 || value instanceof ArrayBuffer || ArrayBuffer.isView(value) ||
          (typeof value === "string" && /^data:image\//i.test(value))) fail("形象元数据不能包含图片数据，请使用原始外观参考或最终立绘字段。");
      if (value && typeof value === "object") for (const item of Object.values(value)) inspect(item, depth + 1);
    };
    inspect(document.appearance);
  }
  if (document.prompts !== undefined && (!plain(document.prompts) || Object.entries(document.prompts).some(([key, value]) =>
    !["appearance", "structure", "parts", "registration"].includes(key) || typeof value !== "string" || value.length > 4000))) fail("形象、结构、部件和坐标提示词必须是不超过 4000 字的文本。");
  return document;
}

export function validateRigSourcePolygon(polygon, width, height, label = "原图轮廓") {
  if (!Array.isArray(polygon) || polygon.length < 3 || polygon.length > 256) fail(`${label}需要 3 至 256 个全局像素坐标。`);
  const points = polygon.map((value) => {
    const result = point(value, label);
    number(result.x, `${label} x`, 0, width); number(result.y, `${label} y`, 0, height);
    return result;
  });
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  if (Math.abs(area) < 1e-6) fail(`${label}不能是零面积轮廓。`);
  return points;
}

export function validateMotionStudyMapping(input, document, frame) {
  if (!plain(input)) fail("动作图缺少部件坐标映射。");
  const mapping = clone(input), jointIds = new Set(document.joints.map((joint) => joint.id));
  if (mapping.frameId !== frame.id || mapping.sourceFingerprint !== frame.sourceFingerprint) fail("动作图坐标映射与该帧来源不一致。");
  const defaults = document.defaultAttachments || {}, first = new Map();
  for (const part of document.parts) if (part.attachmentGroup && !first.has(part.attachmentGroup)) first.set(part.attachmentGroup, part.id);
  const visible = document.parts.filter((part) => !part.attachmentGroup || (Object.hasOwn(defaults, part.attachmentGroup) ? defaults[part.attachmentGroup] : first.get(part.attachmentGroup)) === part.id);
  if (!Array.isArray(mapping.joints) || mapping.joints.length !== jointIds.size || new Set(mapping.joints.map((joint) => joint.id)).size !== jointIds.size) fail("动作图必须对应全部原关节且不得重复。");
  for (const joint of mapping.joints) {
    if (!jointIds.has(joint.id)) fail("动作图引用未知关节。");
    number(joint.x, "动作关节 x", 0, document.width); number(joint.y, "动作关节 y", 0, document.height);
  }
  const ids = new Set(visible.map((part) => part.id));
  if (!Array.isArray(mapping.parts) || mapping.parts.length !== ids.size || new Set(mapping.parts.map((part) => part.partId)).size !== ids.size) fail("动作图必须逐一对应默认可见部件。");
  mapping.parts = mapping.parts.map((part) => {
    if (!ids.has(part.partId) || typeof part.visible !== "boolean") fail("动作图部件标识或可见性无效。");
    number(part.z, "动作部件层级");
    return { ...part, ...(part.visible ? { sourcePolygon: validateRigSourcePolygon(part.sourcePolygon, document.width, document.height, `动作部件 ${part.partId}`) } : {}) };
  });
  if (mapping.gapFill !== undefined) {
    const policy = mapping.gapFill, keys = ["version", "method", "sourceFingerprint", "mappingFingerprint", "maxDistance", "maxGapRatio", "significantAlphaMin", "inferredPixels", "observedGapRatio", "observedMaxDistance", "ownerFingerprint"];
    if (!plain(policy) || Object.keys(policy).some((key) => !keys.includes(key)) || policy.version !== 1 || policy.method !== "nearest-physical-boundary" || policy.maxGapRatio !== .15 || policy.significantAlphaMin !== 9)
      fail("动作缺口策略必须是明确的有限距离物理部件推定，不能保存像素列表或更宽松规则。");
    for (const key of ["sourceFingerprint", "mappingFingerprint", "ownerFingerprint"]) if (!/^[a-f0-9]{64}$/.test(policy[key])) fail("动作缺口策略缺少有效来源和映射指纹。");
    if (policy.sourceFingerprint !== frame.sourceFingerprint) fail("动作缺口策略与源画面不一致。");
    number(policy.maxDistance, "缺口推定距离", 0, 64); number(policy.observedMaxDistance, "缺口实际距离", 0, policy.maxDistance + 1e-9);
    number(policy.observedGapRatio, "主体缺口比例", 0, .15); number(policy.inferredPixels, "缺口推定像素数", 1, document.width * document.height);
    if (!Number.isInteger(policy.inferredPixels)) fail("缺口推定像素数必须是整数。");
  }
  return mapping;
}

export function validateRigMotionStudies(document) {
  if (document.motionStudies === undefined) return document;
  if (!plain(document.motionStudies) || Object.keys(document.motionStudies).length > 64) fail("逐帧动作列表无效。");
  const motions = new Map(document.motions.map((motion) => [motion.id, motion]));
  for (const [motionId, study] of Object.entries(document.motionStudies)) {
    identifier(motionId, "逐帧动作 ID");
    if (!motions.has(motionId) || !plain(study) || (study.motionId !== undefined && study.motionId !== motionId)) fail("逐帧动作必须对应已有动作。");
    // Early production drafts explicitly wrote false for an unapplied plan.
    if (study.applied === false) delete study.applied;
    if (study.playback !== undefined && !["reference", "stepped-parts"].includes(study.playback)) fail("动作图播放方式无效。");
    for (const key of ["baseFingerprint", "geometryFingerprint", "protectedIdleFingerprint", "originalArtworkFingerprint"])
      if (study[key] !== undefined && !/^[a-f0-9]{64}$/.test(study[key])) fail(`逐帧动作 ${key} 指纹无效。`);
    if (!Array.isArray(study.frames) || study.frames.length > 12) fail("逐帧动作最多保存 12 个时间点与 5 张独立源图。");
    const ids = new Set(), fingerprints = new Set(); let previous = -1;
    for (const frame of study.frames) {
      identifier(frame.id, "动作画面 ID");
      if (ids.has(frame.id)) fail("动作画面 ID 重复。");
      if (frame.imageRef !== undefined && (!ids.has(frame.imageRef) || frame.image !== undefined)) fail("动作图重复引用必须指向前面的画面，不能同时保存新图片。");
      ids.add(frame.id); number(frame.time, "动作画面时间", 0, motions.get(motionId).duration);
      if (frame.time <= previous) fail("动作画面时间必须严格递增。"); previous = frame.time;
      image(frame.image, "动作参考图");
      if (frame.sourceFingerprint !== undefined) {
        if (!/^[a-f0-9]{64}$/.test(frame.sourceFingerprint)) fail("动作参考图指纹无效。");
        fingerprints.add(frame.sourceFingerprint);
      }
      if (fingerprints.size > 5) fail("每个动作最多使用 5 张独立源图，终点可重复引用。");
      for (const key of ["label", "prompt", "origin"]) if (frame[key] !== undefined && (typeof frame[key] !== "string" || frame[key].length > 4000)) fail("动作图说明过长或无效。");
      for (const key of ["review", "mappingReview"]) if (frame[key] !== undefined && typeof frame[key] !== "boolean" && (!plain(frame[key]) || typeof frame[key].approved !== "boolean")) fail("动作图审阅状态无效。");
      if (frame.mapping !== undefined) frame.mapping = validateMotionStudyMapping(frame.mapping, document, frame);
      if (frame.playbackTransform !== undefined) {
        const transform = frame.playbackTransform;
        if (!plain(transform) || !plain(transform.anchor)) fail("动作画面播放缩放无效。");
        number(transform.scale, "动作画面播放缩放", .1, 2);
        number(transform.anchor.x, "动作画面缩放基准 X", 0, document.width);
        number(transform.anchor.y, "动作画面缩放基准 Y", 0, document.height);
      }
      if (frame.segments !== undefined) {
        if (!Array.isArray(frame.segments) || frame.segments.length > document.parts.length) fail("动作图独立部件列表无效。");
        const used = new Set();
        for (const segment of frame.segments) {
          if (!document.parts.some((part) => part.id === segment.partId) || used.has(segment.partId)) fail("动作图独立部件未知或重复。");
          used.add(segment.partId); image(segment.image, "动作可见部件");
          if (typeof segment.image !== "string" || segment.visibleOnly !== true || segment.origin !== "source-visible") fail("动作源像素部件必须明确标记为可见裁片，不能冒充补绘。");
          for (const key of ["x", "y", "width", "height"]) number(segment[key], `动作部件 ${key}`, key === "width" || key === "height" ? 1 : 0, key === "x" || key === "width" ? document.width : document.height);
          if (![segment.x,segment.y,segment.width,segment.height].every(Number.isInteger) || segment.x + segment.width > document.width || segment.y + segment.height > document.height) fail("动作裁片必须在画布内并保持整数像素坐标。");
          number(segment.z, "动作裁片层级");
        }
      }
    }
    if (study.applied !== undefined && (!plain(study.applied) || study.applied.kind !== "stepped-parts" || !/^[a-f0-9]{64}$/.test(study.applied.contentFingerprint))) fail("逐帧动作应用记录无效。");
  }
  return document;
}

function registrationMetadata(value) {
  if (!plain(value)) fail("原图坐标登记信息无效。");
  if (value.sourceFingerprint !== undefined && (typeof value.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint))) fail("原图坐标指纹无效。");
  if (value.jobId !== undefined && (typeof value.jobId !== "string" || value.jobId.length > 128)) fail("原图坐标任务标识无效。");
  if (value.gridSize !== undefined && (!Number.isInteger(value.gridSize) || value.gridSize < 1 || value.gridSize > 512)) fail("原图坐标网格尺寸无效。");
  if (value.metrics !== undefined && !plain(value.metrics)) fail("原图坐标验收指标无效。");
  const inspect = (item, depth = 0) => {
    if (depth > 12 || item instanceof ArrayBuffer || ArrayBuffer.isView(item) ||
        (typeof item === "number" && !Number.isFinite(item)) || (typeof item === "string" && /^data:image\//i.test(item)))
      fail("坐标登记信息只保存有限数值和来源信息，不能包含图片数据。");
    if (item && typeof item === "object") for (const entry of Object.values(item)) inspect(entry, depth + 1);
  };
  inspect(value);
}

function attachmentGroups(parts) {
  const groups = new Map();
  for (const part of parts) if (part.attachmentGroup !== undefined) {
    const id = identifier(part.attachmentGroup, "附件组 ID"), group = groups.get(id);
    if (group && (group[0].bone !== part.bone || group[0].z !== part.z)) fail(`同组附件必须使用相同骨骼和层级：${id}`);
    if (group) group.push(part); else groups.set(id, [part]);
  }
  return groups;
}

function attachmentMap(value, groups, label) {
  if (!plain(value)) fail(`${label}必须是附件组到部件的映射。`);
  for (const [groupId, partId] of Object.entries(value)) {
    identifier(groupId, "附件组 ID");
    if (!groups) fail("验证附件切换需要提供部件列表。");
    const group = groups.get(groupId);
    if (!group) fail(`${label}引用了不存在的附件组：${groupId}`);
    if (partId !== null && (typeof partId !== "string" || !group.some((part) => part.id === partId)))
      fail(`${label}引用的部件不存在或不属于该附件组：${groupId}`);
  }
  return { ...value };
}

export function validateRigMotion(input, joints, parts) {
  if (!plain(input)) fail("动作数据无效。");
  const result = clone(input), ids = new Set(joints.map((joint) => joint.id)), groups = parts === undefined ? null : attachmentGroups(parts);
  result.id = identifier(result.id, "动作 ID");
  result.name = typeof result.name === "string" && result.name.trim() ? result.name.trim() : result.id;
  result.description = typeof result.description === "string" ? result.description : "";
  number(result.duration, "动作时长", 0.05, 30);
  if (result.loop !== undefined && typeof result.loop !== "boolean") fail("动作循环设置无效。");
  result.loop = Boolean(result.loop);
  const rootId = joints.find((joint) => joint.parent === null)?.id;
  const slots = parts === undefined ? null : new Set(parts.map((part) => part.attachmentGroup ? `group_${part.attachmentGroup}` : `slot_${part.id}`));
  const requiredSlots = parts === undefined ? null : new Set(parts.filter((part) => part.role !== "effect").map((part) => part.attachmentGroup ? `group_${part.attachmentGroup}` : `slot_${part.id}`));
  if (!Array.isArray(result.poses) || !result.poses.length || result.poses.length > 1200) fail("动作需要 1 至 1200 个姿势。");
  let previous = -1;
  result.poses = result.poses.map((pose) => {
    if (!plain(pose)) fail("动作姿势无效。");
    number(pose.time, "关键帧时间", 0, result.duration);
    if (pose.time <= previous) fail("动作关键帧时间必须严格递增。");
    previous = pose.time;
    if (pose.angles !== undefined && !plain(pose.angles)) fail("动作角度映射无效。");
    const angles = { ...(pose.angles || {}) };
    for (const [id, value] of Object.entries(angles)) {
      if (!ids.has(id)) fail(`动作引用了不存在的关节：${id}`);
      number(value, `关节角度 ${id}`, -3600, 3600);
    }
    const ease = pose.ease || "smooth";
    if (!["smooth", "linear"].includes(ease)) fail("动作插值只支持 smooth 或 linear。");
    const output = { ...pose, angles, root: pose.root ? point(pose.root, "根位移") : { x: 0, y: 0 }, ease };
    for (const field of ["translations", "scales"]) if (pose[field] !== undefined) {
      if (!plain(pose[field])) fail(`动作 ${field} 必须是骨骼局部变换映射。`);
      output[field] = {};
      for (const [id, value] of Object.entries(pose[field])) {
        if (!ids.has(id)) fail(`局部变换引用了不存在的关节：${id}`);
        if (field === "translations" && id === rootId) fail("根骨位移请使用 root，不能重复设置局部平移。");
        const coordinate = point(value, `关节 ${id} ${field}`);
        if (field === "scales") {
          number(coordinate.x, `关节 ${id} 横向缩放`, .001, 100);
          number(coordinate.y, `关节 ${id} 纵向缩放`, .001, 100);
        }
        output[field][id] = coordinate;
      }
    }
    if (pose.drawOrder !== undefined) {
      if (!slots || !Array.isArray(pose.drawOrder) || new Set(pose.drawOrder).size !== pose.drawOrder.length || pose.drawOrder.some((id) => !slots.has(id)) || [...requiredSlots].some((id) => !pose.drawOrder.includes(id)))
        fail("绘制顺序必须完整且唯一地列出当前 slot_/group_ 插槽，不能使用纹理变体或未知部件。");
      output.drawOrder = [...pose.drawOrder];
    }
    if (pose.feet !== undefined) {
      if (!plain(pose.feet) || Object.entries(pose.feet).some(([key, value]) => !["left", "right"].includes(key) || typeof value !== "boolean")) fail("脚锁标记无效。");
      output.feet = { ...pose.feet };
    }
    if (pose.attachments !== undefined) output.attachments = attachmentMap(pose.attachments, groups, "动作附件");
    return output;
  });
  if (result.effectTracks !== undefined) {
    if (!parts || !Array.isArray(result.effectTracks) || result.effectTracks.length > 16) fail("特效时间轴无效。");
    const used = new Set();
    result.effectTracks = result.effectTracks.map((track) => {
      if (!plain(track) || !groups.has(track.groupId) || used.has(track.groupId)) fail("特效时间轴引用了未知或重复的显示组。");
      used.add(track.groupId);
      const members = parts.filter((part) => part.attachmentGroup === track.groupId);
      if (!members.length || members.some((part) => part.role !== "effect" || part.effect?.motionId !== result.id)) fail("特效时间轴只能引用当前动作的独立特效纹理。");
      if (!Array.isArray(track.keys) || !track.keys.length || track.keys.length > 1201) fail("特效时间轴缺少有效帧。");
      let previous = -1;
      const keys = track.keys.map((key) => {
        if (!plain(key)) fail("特效帧无效。");
        number(key.time, "特效帧时间", 0, result.duration);
        if (key.time <= previous || key.name !== null && !members.some((part) => part.id === key.name)) fail("特效帧时间必须递增，且纹理必须属于同一显示组。");
        previous = key.time; return { ...key };
      });
      if (keys[0].time !== 0 || keys.at(-1).name !== null) fail("特效必须记录起始状态，并在结束时隐藏。");
      return { ...track, keys };
    });
  }
  if (result.magicEffects !== undefined) {
    const value = result.magicEffects, options = value?.options;
    if (!plain(value) || typeof value.generator !== "string" || !plain(options) || !ids.has(options.chargeBone) || !ids.has(options.releaseBone)) fail("特效制作参数无效。");
    for (const key of ["chargeStart", "releaseTime", "endTime"]) number(options[key], "特效制作时间", 0, result.duration);
    if (options.releaseTime <= options.chargeStart || options.endTime <= options.releaseTime || ![24, 30].includes(options.fps)) fail("特效制作阶段或帧率无效。");
    for (const key of ["chargeX", "chargeY", "releaseX", "releaseY", "intensity"]) number(options[key], "特效制作参数");
  }
  const byId = new Map(joints.map((joint) => [joint.id, joint]));
  for (const side of ["left", "right"]) {
    if (!result.poses.some((pose) => pose.feet?.[side])) continue;
    const thigh = byId.get(`${side}Thigh`), shin = byId.get(`${side}Shin`), foot = byId.get(`${side}Foot`);
    if (!thigh || shin?.parent !== thigh.id || foot?.parent !== shin.id) fail(`${side} 脚锁需要 Thigh → Shin → Foot 标准腿链。`);
  }
  return result;
}

export function validateRigDocument(input) {
  if (!plain(input) || input.version !== 1) fail("不支持的骨架文档版本。");
  const doc = clone(input);
  identifier(doc.id, "骨架 ID");
  if (typeof doc.name !== "string" || !doc.name.trim()) fail("请填写骨架名称。");
  doc.name = doc.name.trim();
  for (const key of ["width", "height"]) {
    number(doc[key], "立绘尺寸", 1, 8192);
    if (!Number.isInteger(doc[key])) fail("立绘尺寸必须是整数像素。");
  }
  image(doc.sourceImage, "立绘");
  validateRigAppearanceFields(doc);
  if (doc.registration !== undefined) registrationMetadata(doc.registration);
  if (!Array.isArray(doc.joints) || !doc.joints.length || doc.joints.length > 256) fail("骨架需要 1 至 256 个关节。");
  const byId = new Map();
  doc.joints = doc.joints.map((joint) => {
    if (!plain(joint)) fail("关节数据无效。");
    identifier(joint.id, "关节 ID");
    if (byId.has(joint.id)) fail(`关节 ID 重复：${joint.id}`);
    number(joint.x, `关节 ${joint.id} x`, 0, doc.width);
    number(joint.y, `关节 ${joint.id} y`, 0, doc.height);
    const output = { ...joint, label: joint.label || joint.id, parent: joint.parent ?? null };
    byId.set(joint.id, output);
    return output;
  });
  if (doc.joints.filter((joint) => joint.parent === null).length !== 1) fail("骨架必须恰有一个根关节。");
  for (const joint of doc.joints) {
    const visited = new Set([joint.id]);
    let parent = joint.parent;
    while (parent !== null) {
      if (!byId.has(parent)) fail(`关节父级不存在：${parent}`);
      if (visited.has(parent)) fail("关节父链存在循环。");
      visited.add(parent); parent = byId.get(parent).parent;
    }
    if (joint.parent !== null) {
      const parentJoint = byId.get(joint.parent);
      if (Math.hypot(joint.x - parentJoint.x, joint.y - parentJoint.y) < 0.01) fail(`关节骨长不能为零：${joint.id}`);
    }
  }
  if (!Array.isArray(doc.parts) || !doc.parts.length || doc.parts.length > 256) fail("骨架需要 1 至 256 个部件。");
  const partIds = new Set();
  doc.parts = doc.parts.map((part, index) => {
    if (!plain(part)) fail("部件数据无效。");
    identifier(part.id, "部件 ID");
    if (partIds.has(part.id)) fail(`部件 ID 重复：${part.id}`);
    partIds.add(part.id);
    if (!byId.has(part.bone)) fail(`部件绑定关节不存在：${part.bone}`);
    number(part.x, "部件 x", 0, doc.width); number(part.y, "部件 y", 0, doc.height);
    number(part.width, "部件宽度", 0.01, doc.width); number(part.height, "部件高度", 0.01, doc.height);
    if (part.x + part.width > doc.width + 1e-6 || part.y + part.height > doc.height + 1e-6) fail(`部件超出立绘画布：${part.id}`);
    if (!["rigid", "mesh"].includes(part.binding)) fail("部件绑定必须是 rigid 或 mesh。");
    image(part.image, `部件 ${part.id}`);
    if (part.sourcePolygon !== undefined) part = { ...part, sourcePolygon: validateRigSourcePolygon(part.sourcePolygon, doc.width, doc.height, `部件 ${part.id} 原图轮廓`) };
    if (part.registrationBase !== undefined) {
      const base = part.registrationBase;
      if (!plain(base) || typeof base.image !== "string") fail("坐标配准底图缺少独立图片。");
      image(base.image, `部件 ${part.id} 坐标配准底图`);
      number(base.x, "底图 x", 0, doc.width); number(base.y, "底图 y", 0, doc.height);
      number(base.width, "底图宽度", 0.01, doc.width); number(base.height, "底图高度", 0.01, doc.height);
      if (base.x + base.width > doc.width + 1e-6 || base.y + base.height > doc.height + 1e-6 ||
          !["ai", "uploaded", "calibrated"].includes(base.imageSource) || base.completion !== "ready") fail("坐标配准底图必须是画布内已完成的独立补绘图片。");
    }
    if (part.influences !== undefined && !Array.isArray(part.influences)) fail("部件影响关节必须是数组。");
    const influences = [...new Set(part.influences || [part.bone])];
    if (!influences.length || influences.length > 8 || influences.some((id) => !byId.has(id))) fail(`部件影响关节无效：${part.id}`);
    const output = { ...part, label: part.label || part.id, z: number(part.z ?? index, "部件层级"), influences,
      completion: part.completion || (part.image ? "ready" : "needs-inpaint"), critical: part.critical ?? true };
    if (!["ready", "needs-inpaint"].includes(output.completion) || typeof output.critical !== "boolean") fail("部件完成状态无效。");
    if (part.imageSource !== undefined && !["uploaded", "ai", "calibrated", "source-crop", "placeholder", "procedural"].includes(part.imageSource)) fail("部件图像来源无效。");
    if (part.blendMode !== undefined && !["normal", "additive", "multiply", "screen"].includes(part.blendMode)) fail("部件叠加方式无效。");
    if (part.role === "effect") {
      const effect = part.effect;
      if (!part.attachmentGroup || !plain(effect) || !["charge", "release"].includes(effect.kind) || typeof effect.generator !== "string" || effect.generator.length > 80 || part.binding !== "rigid") fail("特效必须是带来源记录的独立刚性显示组。");
      identifier(effect.motionId, "特效所属动作");
      if (!Number.isInteger(effect.frame) || effect.frame < 0 || ![24, 30].includes(effect.fps)) fail("特效帧记录无效。");
      number(effect.time, "特效来源时间", 0, 30);
    }
    if (part.imageSource === "procedural" && part.role !== "effect") fail("程序生成来源只用于独立特效，不能将角色裁片标记为补绘。");
    if (part.mesh !== undefined) {
      if (!plain(part.mesh) || part.mesh.vertices !== undefined) fail("第一版网格支持规则密度和逐顶点权重，不支持自由顶点。");
      const cols = part.mesh.cols ?? 3, rows = part.mesh.rows ?? 3;
      if (![cols, rows].every((value) => Number.isInteger(value) && value >= 2 && value <= 8)) fail("网格行列数必须在 2 至 8 之间。");
      output.mesh = { ...part.mesh, cols, rows };
      if (part.mesh.weights !== undefined) {
        if (!Array.isArray(part.mesh.weights) || part.mesh.weights.length !== cols * rows) fail("网格顶点权重数量不匹配。");
        output.mesh.weights = part.mesh.weights.map((weights) => {
          if (!Array.isArray(weights) || !weights.length || weights.length > influences.length) fail("网格顶点缺少权重。");
          const used = new Set(); let total = 0;
          for (const item of weights) {
            if (!plain(item) || !influences.includes(item.joint) || used.has(item.joint)) fail("网格权重引用的关节无效或重复。");
            used.add(item.joint); total += number(item.weight, "网格权重", 0, 1e6);
          }
          if (total <= 1e-9) fail("网格顶点的权重和必须大于零。");
          return weights.filter((item) => item.weight > 0).map((item) => ({ joint: item.joint, weight: Math.abs(total - 1) < 1e-9 ? item.weight : item.weight / total }));
        });
      }
    }
    if (part.grip !== undefined) {
      const grip = part.grip;
      if (!plain(grip) || part.binding !== "rigid" || grip.primaryHand !== part.bone || !byId.has(grip.primaryHand)) fail("武器必须刚性绑定主手。");
      const primary = point(grip.primaryLocalPoint, "主握点");
      if (primary.x < 0 || primary.y < 0 || primary.x > part.width || primary.y > part.height) fail("主握点超出武器图片。");
      output.grip = { ...grip, primaryLocalPoint: primary };
      if (grip.secondaryHand !== undefined) {
        const hand = byId.get(grip.secondaryHand), forearm = hand && byId.get(hand.parent), upper = forearm && byId.get(forearm.parent);
        if (!upper || grip.secondaryHand === grip.primaryHand) fail("副手握持需要独立的双骨手臂。");
        const secondary = point(grip.secondaryLocalPoint, "副握点");
        if (secondary.x < 0 || secondary.y < 0 || secondary.x > part.width || secondary.y > part.height) fail("副握点超出武器图片。");
        output.grip.secondaryLocalPoint = secondary;
      }
    }
    return output;
  });
  const groups = attachmentGroups(doc.parts);
  for (const group of groups.keys()) {
    const members = doc.parts.filter((part) => part.attachmentGroup === group);
    if (new Set(members.map((part) => part.blendMode || "normal")).size > 1) fail("同一显示组的纹理需要相同叠加方式。");
  }
  if (doc.defaultAttachments !== undefined) doc.defaultAttachments = attachmentMap(doc.defaultAttachments, groups, "默认附件");
  if (!Array.isArray(doc.motions) || doc.motions.length > 64) fail("动作列表无效或超过 64 个。");
  const motionIds = new Set();
  doc.motions = doc.motions.map((motion) => {
    const result = validateRigMotion(motion, doc.joints, doc.parts);
    if (motionIds.has(result.id)) fail(`动作 ID 重复：${result.id}`);
    motionIds.add(result.id);
    return result;
  });
  validateRigMotionStudies(doc);
  return doc;
}

export function replaceRigMotion(document, motion) {
  const doc = validateRigDocument(document), previous = doc.motions.find((item) => item.id === motion.id);
  const replacement = validateRigMotion({ ...(previous && motion.effectTracks === undefined ? retimeMotionEffects(previous, motion.duration) : {}), ...motion }, doc.joints, doc.parts);
  const index = doc.motions.findIndex((item) => item.id === replacement.id);
  if (index < 0) doc.motions.push(replacement); else doc.motions[index] = replacement;
  return validateRigDocument(doc);
}
