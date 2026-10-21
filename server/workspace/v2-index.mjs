import { serialize } from "node:v8";
import { ProjectIndex, PROJECT_NAMESPACE } from "./project-index.mjs";

export function createV2ProjectIndex(db, repository, { install = false } = {}) {
  const row = (id) => {
    const descriptor = repository.descriptor(PROJECT_NAMESPACE, "projects", id);
    if (!descriptor) return null;
    const record = repository.record(PROJECT_NAMESPACE, "projects", id);
    return { id, record, payload: serialize(record), source_rowid: descriptor.ordinal };
  };
  const index = new ProjectIndex(db, { source: { row, *rows() {
    for (const item of db.prepare("SELECT id FROM documents_v2 WHERE namespace=? AND store='projects' ORDER BY rowid").iterate(PROJECT_NAMESPACE)) yield row(item.id);
  } } });
  if (install) {
    repository.indexProject = (descriptor, read) => { const record = read(); index.write(record, serialize(record), descriptor.ordinal); };
    repository.removeProjectIndex = (id) => index.remove(id);
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const item = operation === "DELETE" ? "OLD" : "NEW", name = `project_index_v2_${operation.toLowerCase()}`;
      const previous = db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(name)?.sql;
      if (previous && !previous.includes("workspace.active-format")) db.exec(`DROP TRIGGER ${name}`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${operation} ON documents_v2
        WHEN ${item}.namespace='${PROJECT_NAMESPACE}' AND ${item}.store='projects'
          AND COALESCE((SELECT value FROM settings WHERE key='workspace.active-format'),'1')='2'
        BEGIN INSERT INTO project_index_dirty VALUES (${item}.id) ON CONFLICT(id) DO NOTHING; END;`);
    }
  }
  return index;
}
