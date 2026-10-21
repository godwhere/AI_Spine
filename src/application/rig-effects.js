import { magicEffectOptions, withRigMagicEffects, withoutRigMagicEffects } from "../../shared/domain/rig-effects.mjs";
import { validateRigDocument } from "../../shared/rig-schema.mjs";

export async function prepareRigMagicEffects(document, motionId, values, createFrames) {
  const options = magicEffectOptions(document, motionId, values), frames = await createFrames(options);
  return validateRigDocument(withRigMagicEffects(document, motionId, options, frames));
}
export function removeRigMagicEffects(document, motionId) {
  return validateRigDocument(withoutRigMagicEffects(document, motionId));
}
