import { countAtlasRegions } from "../../engine/archive/region-count.js";
import { prepareBundle, prepareProject } from "./project-bundle.js";
import { createCustomTemplateRecord } from "../../engine/archive/template-snapshot.js";
import { templateVariantBase, templateVariantEntries } from "../../engine/archive/template-variants.js";

export function createResourceActions({ projects, templates, archive, pixels, catalog, createId, now }) {
  const prepare = (files, options) => prepareProject(files, options, createId);
  return {
    comparison(bundle) {
      if (!bundle) return { bundle: null };
      try { return { bundle: templateVariantBase(bundle), variants: templateVariantEntries(bundle) }; }
      catch (error) { return { bundle: null, error: error.message }; }
    },
    async catalog() {
      const [builtIn, custom] = await Promise.allSettled([catalog.list(), templates.list()]);
      return { items: [...(custom.status === "fulfilled" ? custom.value : []), ...(builtIn.status === "fulfilled" ? builtIn.value : [])],
        error: [builtIn, custom].find((result) => result.status === "rejected")?.reason };
    },
    async loadTemplate(template) {
      if (template.source !== "custom") return prepareBundle(await archive.loadCatalogTemplate(template));
      const record = await templates.get(template.id);
      if (!record) throw new Error("这个模板已被删除，请刷新模板库。");
      return prepare(record.files, { name: record.name, skeletonPath: record.skeletonPath, id: `template-${record.id}` });
    },
    async templateRegionCount(template, { signal } = {}) {
      if (template.source === "custom") return template.regionCount;
      return countAtlasRegions(await Promise.all((template.atlasFiles || []).map((path) => catalog.atlas(template.folder + path, { signal }))));
    },
    async open(record) {
      if (!record.files) record = await projects.get(record.id);
      if (!record) throw new Error("这个资源已被删除，请重新选择。");
      return { record, bundle: prepare(record.files, { skeletonPath: record.skeletonPath, name: record.name }) };
    },
    async preview(record) {
      if (!record.files) record = await projects.preview(record.id);
      if (!record) throw new Error("这个资源已被删除，请重新选择。");
      const bundle = prepare(record.files, { skeletonPath: record.skeletonPath, name: record.name });
      return { record, bundle, pages: await pixels.compilePages(bundle, record.edits || {}),
        animations: bundle.animations, durations: bundle.durations, skin: bundle.skins[0] || "" };
    },
    readImport: (files) => archive.readImportFiles(files, { unpack: archive.unpack }),
    prepareImport(files, skeletonPath) {
      return prepare(files, { skeletonPath, name: skeletonPath?.split("/").at(-1).replace(/\.(json|skel)$/i, "") || "导入的资源" });
    },
    async trash(record, restore = false) {
      await (restore ? projects.restore(record.id) : projects.trash(record.id));
      return projects.library();
    },
    async remove(records) {
      const count = await projects.remove(records.map((record) => record.id));
      return { count, library: await projects.library() };
    },
    async addTemplate(draft) {
      const source = draft.record.files ? draft.record : await projects.get(draft.record.id);
      if (!source) throw new Error("这个资源已被删除，请重新选择。");
      const bundle = prepare(source.files, { skeletonPath: source.skeletonPath, name: source.name });
      const pages = await pixels.compilePages(bundle, source.edits || {});
      const files = await archive.unpack(await archive.export(bundle, pages, { editable: false }));
      const record = createCustomTemplateRecord({ ...source, name: draft.name.trim() }, files,
        { type: draft.type, categories: draft.categories, now: now() });
      return templates.save(record);
    },
    removeTemplate: (id) => templates.remove(id),
  };
}
