export function createLibraryController({ projects, templates, resources, watch }) {
  let snapshot = { projects: [], trash: [], catalog: [], ready: false, error: null }, epoch = 0;
  let reading = 0, refreshRequested = false, active = false, catalogReady = false;
  const listeners = new Set();
  const publish = (patch) => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(snapshot); };
  const mutate = (patch) => { epoch++; if (reading) refreshRequested = true; publish(patch); };
  async function refresh(initial = !catalogReady) {
    const request = ++epoch;
    reading++;
    const results = await Promise.allSettled([projects.library(), initial ? resources.catalog() : templates.list()]);
    reading--;
    if (!reading && refreshRequested && active) { refreshRequested = false; void refresh().catch(() => {}); }
    const [library, catalog] = results;
    if (request !== epoch) return;
    const patch = { ready: true, error: library.status === "rejected" ? library.reason : catalog.status === "rejected" ? catalog.reason : initial ? catalog.value.error || null : null };
    if (library.status === "fulfilled") Object.assign(patch, library.value);
    if (catalog.status === "fulfilled") patch.catalog = initial ? catalog.value.items
      : [...catalog.value, ...snapshot.catalog.filter((item) => item.source !== "custom")];
    if (initial && catalog.status === "fulfilled" && !catalog.value.error) catalogReady = true;
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
    saved() {
      // A receipt can predate another page's deletion or newer edit. Only the
      // current repository summary may decide which list contains a resource.
      epoch++;
      // Repositories can share an in-flight read; retry after it settles.
      if (reading) { refreshRequested = true; return; }
      return refresh().catch(() => {});
    },
    templateSaved(template) { mutate({ catalog: [template, ...snapshot.catalog.filter((item) => item.id !== template.id)] }); },
    templateRemoved(id) { mutate({ catalog: snapshot.catalog.filter((item) => item.id !== id) }); },
  };
}
