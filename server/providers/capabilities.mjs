/**
 * ImageAdapter: explicit id, label, auth, models, capabilities, status(settings)
 * and generate(settings, {cwd, prompt, references, signal}). It returns one PNG
 * result and model. Settings keys are private connection-service inputs.
 *
 * PlanningAdapter: explicit Codex identity, planning-only capability, snapshot
 * and generate(selection, {cwd, schema, prompt, references, signal}). It returns
 * structured value/model. Neither adapter chooses a fallback or unlocks keys.
 */
export const IMAGE_CAPABILITIES = Object.freeze(["image"]);
export const PLANNING_CAPABILITIES = Object.freeze(["planning"]);
export function requireCapability(adapter, capability) {
  if (!adapter?.capabilities?.includes(capability)) throw new Error(`所选 AI 服务不支持 ${capability} 能力。`);
  return adapter;
}
