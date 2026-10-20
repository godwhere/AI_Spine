// Preview thumbnails and derived counts are not authored character changes.
// Compare binary data directly; never stringify images or account settings.
function equal(a, b) {
  if (Object.is(a, b)) return true;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  const ak = Object.keys(a).filter((key) => a[key] !== undefined).sort(), bk = Object.keys(b).filter((key) => b[key] !== undefined).sort();
  return ak.length === bk.length && ak.every((key, index) => key === bk[index] && equal(a[key], b[key]));
}
export function sameAuthoredProjectContent(a, b) {
  return Boolean(a && b && a.id === b.id && ["name", "skeletonPath", "templateId"].every((key) => equal(a[key], b[key])) &&
    ["files", "edits", "generation"].every((key) => equal(a[key] || {}, b[key] || {})));
}
