function requireCustomId(id) {
  if (typeof id !== "string" || !id.startsWith("custom-") || !id.slice(7).trim())
    throw new Error("只能操作我创建的模板，内置模板不可删除。");
}

function customTemplateMetadata(project, { type = "role", categories = [], now } = {}) {
  if (project?.deletedAt) throw new Error("资源已在回收站，请先恢复后再加入模板。");
  if (typeof project?.id !== "string" || !project.id.trim() || typeof project.name !== "string" || !project.name.trim())
    throw new Error("资源缺少名称或有效标识。");
  if (!["role", "effect"].includes(type) || !Array.isArray(categories) || categories.some((value) => typeof value !== "string"))
    throw new Error("模板类型或分类无效。");
  return {
    id: `custom-${project.id}`, source: "custom", sourceProjectId: project.id,
    name: project.name.trim(), thumbnail: typeof project.thumbnail === "string" ? project.thumbnail : "",
    type, categories: [...new Set(categories.map((value) => value.trim()).filter(Boolean))],
    createdAt: now, updatedAt: now,
  };
}

export { requireCustomId, customTemplateMetadata };
