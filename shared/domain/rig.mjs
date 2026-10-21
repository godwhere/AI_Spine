function rigGeometry(document) {
  return {
    width: document.width,
    height: document.height,
    joints: document.joints.map(({ id, parent, x, y }) => ({ id, parent, x, y })),
    parts: document.parts.map(({ id, bone, x, y, width, height, z, binding, influences, grip, mesh, attachmentGroup }) => ({ id, bone, x, y, width, height, z, binding, influences, grip: grip || null, mesh: mesh || null, attachmentGroup: attachmentGroup || null })),
    defaultAttachments: document.defaultAttachments || {},
  };
}

function rigAttachmentGroups(document) {
  const groups = new Map();
  for (const part of document.parts) if (part.attachmentGroup) {
    if (!groups.has(part.attachmentGroup)) groups.set(part.attachmentGroup, []);
    groups.get(part.attachmentGroup).push(part);
  }
  return [...groups].map(([id, parts]) => ({ id, parts,
    defaultPartId: Object.hasOwn(document.defaultAttachments || {}, id) ? document.defaultAttachments[id] : parts[0].id }));
}

function rigDefaultVisiblePartIds(document, overrides = {}) {
  const groups = rigAttachmentGroups(document), selected = {};
  for (const group of groups) {
    const value = Object.hasOwn(overrides, group.id) ? overrides[group.id] : group.defaultPartId;
    selected[group.id] = value === null || group.parts.some((part) => part.id === value) ? value : group.defaultPartId;
  }
  return document.parts.filter((part) => !part.attachmentGroup || selected[part.attachmentGroup] === part.id).map((part) => part.id);
}

function cleanAttachmentReferences(document) {
  const groups = rigAttachmentGroups(document), byGroup = new Map(groups.map((group) => [group.id, new Set(group.parts.map((part) => part.id))]));
  const defaults = Object.fromEntries(groups.map((group) => [group.id,
    group.defaultPartId === null || byGroup.get(group.id).has(group.defaultPartId) ? group.defaultPartId : group.parts[0].id]));
  const motions = document.motions.map((motion) => ({ ...motion,
    ...(motion.effectTracks ? { effectTracks: motion.effectTracks.filter((track) => byGroup.has(track.groupId)).map((track) => ({ ...track,
      keys: track.keys.map((key) => key.name === null || byGroup.get(track.groupId).has(key.name) ? key : { ...key, name: null }) })) } : {}),
    poses: motion.poses.map((pose) => {
    if (!pose.attachments) return pose;
    return { ...pose, attachments: Object.fromEntries(Object.entries(pose.attachments).filter(([id, value]) => byGroup.has(id) && (value === null || byGroup.get(id).has(value)))) };
  }) }));
  return { ...document, ...(groups.length || document.defaultAttachments ? { defaultAttachments: defaults } : {}), motions };
}

function rigWithPartAttachmentGroup(document, partId, groupId = "") {
  const part = document.parts.find((item) => item.id === partId);
  if (!part) throw new Error("找不到要分组的部件。");
  if (groupId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(groupId)) throw new Error("显示组 ID 请使用 1–96 位字母、数字、下划线或连字符，首位为字母或数字。");
  const sibling = groupId && document.parts.find((item) => item.id !== partId && item.attachmentGroup === groupId);
  const updated = { ...part };
  if (groupId) updated.attachmentGroup = groupId; else delete updated.attachmentGroup;
  if (sibling) {
    updated.z = sibling.z;
    if (updated.bone !== sibling.bone) { updated.bone = sibling.bone; updated.influences = [sibling.bone]; delete updated.mesh; delete updated.grip; }
  }
  return cleanAttachmentReferences({ ...document, parts: document.parts.map((item) => item.id === partId ? updated : item) });
}

function rigWithPartFields(document, partId, fields) {
  const part = document.parts.find((item) => item.id === partId);
  if (!part) throw new Error("找不到要修改的部件。");
  const shared = {};
  if (part.attachmentGroup) {
    if (Object.hasOwn(fields, "z")) shared.z = fields.z;
    if (Object.hasOwn(fields, "blendMode")) shared.blendMode = fields.blendMode;
    if (part.role === "effect") for (const key of ["x", "y", "width", "height"]) if (Object.hasOwn(fields, key)) shared[key] = fields[key];
    if (Object.hasOwn(fields, "bone")) Object.assign(shared, { bone: fields.bone, influences: [fields.bone], mesh: undefined, grip: undefined });
  }
  return { ...document, parts: document.parts.map((item) => item.id === partId ? { ...item, ...fields }
    : part.attachmentGroup && item.attachmentGroup === part.attachmentGroup ? { ...item, ...shared } : item) };
}

function rigWithoutPart(document, partId) {
  if (document.parts.length <= 1) throw new Error("至少保留一个部件；可先添加新部件后再删除。");
  return cleanAttachmentReferences({ ...document, parts: document.parts.filter((part) => part.id !== partId) });
}

function rigWithDefaultAttachment(document, groupId, partId) {
  const group = rigAttachmentGroups(document).find((item) => item.id === groupId);
  if (!group || (partId !== null && !group.parts.some((part) => part.id === partId))) throw new Error("默认附件不属于这个显示组。");
  return { ...document, defaultAttachments: { ...document.defaultAttachments, [groupId]: partId } };
}

function rigReadiness(document) {
  const parts = document.parts || [];
  const pending = parts.filter((part) => !part.image || part.completion !== "ready" ||
    !["uploaded", "ai", "calibrated"].includes(part.imageSource) && !(part.role === "effect" && part.imageSource === "procedural" && part.effect?.generator));
  return { ready: parts.length > 0 && pending.length === 0, total: parts.length, completed: parts.length - pending.length, pending };
}

export { rigAttachmentGroups, rigDefaultVisiblePartIds, rigGeometry, rigReadiness, rigWithDefaultAttachment, rigWithPartAttachmentGroup, rigWithPartFields, rigWithoutPart };
