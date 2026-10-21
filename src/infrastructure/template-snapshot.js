import { createCustomTemplateRecord as createRecord, validatedSnapshot as validateSnapshot } from "../../engine/archive/template-snapshot.js";
export function createCustomTemplateRecord(project, files, options = {}) {
  return createRecord(project, files, { ...options, now: new Date().toISOString() });
}
export function validatedSnapshot(record) { return validateSnapshot(record, { now: new Date().toISOString() }); }
