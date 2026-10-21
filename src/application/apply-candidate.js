import { templateFingerprint, assertTemplateCandidateProject } from "../../shared/domain/generation.mjs";
import { prepareBundle } from "./project-bundle.js";

export function createCandidateApplication({ images, variants }) {
  return async function applyCandidate({ projectId, bundle, comparison, edits, result, candidates, scope }) {
    assertTemplateCandidateProject(projectId, result);
    const applicationBundle = scope && result.fingerprint !== await templateFingerprint(bundle) ? comparison : bundle;
    if (!applicationBundle) throw new Error("原模板无法恢复，未应用候选。");
    const next = await images.applyGeneratedParts(applicationBundle, edits, result, candidates);
    if (!scope) return { bundle, edits: next, selectedPart: candidates[0].partId };
    const image = candidates[0];
    const variant = await variants.add(bundle, { partId: image.partId, image: image.bytes, transform: next[image.partId].transform,
      name: scope.name, animations: scope.animations, provenance: { jobId: result.id, imageId: image.id } });
    const previousNative = bundle.files[variant.metadata.nativePath];
    const sameNative = previousNative?.length === image.bytes.length && previousNative.every((value, index) => value === image.bytes[index]);
    const replacement = (variant.metadata.unchanged || sameNative) && edits[variant.partId] ? edits[variant.partId] : variant.edit;
    return { bundle: prepareBundle(variant.bundle), edits: { ...edits, [variant.partId]: replacement },
      selectedPart: variant.partId, animation: scope.animations[0] };
  };
}
