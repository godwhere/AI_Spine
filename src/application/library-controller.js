import { resourceSummary } from "./editor-persistence.js";

export function createLibraryController({ projects, templates, resources, watch }) {
  let snapshot = { projects: [], trash: [], catalog: [], ready: false, error: null }, epoch = 0;
  let reading = 0, refreshRequested = false, active = false;
  const listeners = new Set();
  const publish = (patch) => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(snapshot); };
  const mutate = (patch) => { epoch++; if (reading) refreshRequested = true; publish(patch); };
  async function refresh(initial = !snapshot.ready) {
    const request = ++epoch;
    reading++;
    const results = await Promise.allSettled([projects.library(), initial ? resources.catalog() : templates.list()]);
    reading--;
    if (!reading && refreshRequested && active) { refreshRequested = false; void refresh().catch(() => {}); }
    const [library, catalog] = results;
    if (request !== epoch) return;
    const patch = { ready: true, error: library.status === "rejected" ? library.reason : catalog.status === "rejected" ? catalog.reason : initial ? catalog.value.error : null };
    if (library.status === "fulfilled") Object.assign(patch, library.value);
    if (catalog.status === "fulfilled") patch.catalog = initial ? catalog.value.items
      : [...catalog.value, ...snapshot.catalog.filter((item) => item.source !== "custom")];
    publish(patch);
    if (patch.error) throw patch.error;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    start() {
      active = true; let observing = true;
      const stop = watch(() => observing ? refresh().catch(() => {}) : undefined);
      void refresh(true).catch(() => {});
      return () => { observing = false; active = false; refreshRequested = false; epoch++; stop(); };
    },
    refresh,
    acceptLibrary(library) { mutate({ projects: library.projects, trash: library.trash }); },
    saved(record) {
      const summary = Object.hasOwn(record, "files") ? resourceSummary(record) : record;
      mutate({ projects: [summary, ...snapshot.projects.filter((item) => item.id !== record.id)] });
    },
    templateSaved(template) { mutate({ catalog: [template, ...snapshot.catalog.filter((item) => item.id !== template.id)] }); },
    templateRemoved(id) { mutate({ catalog: snapshot.catalog.filter((item) => item.id !== id) }); },
  };
}
