const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const codes = Uint8Array.from(alphabet, (char) => char.charCodeAt(0));
const values = new Uint8Array(128);
for (let index = 0; index < alphabet.length; index++) values[codes[index]] = index;
const decoder = new TextDecoder();

export function encodeBase64(bytes) {
  const output = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let offset = 0;
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index], b = bytes[index + 1] || 0, c = bytes[index + 2] || 0;
    output[offset++] = codes[a >>> 2];
    output[offset++] = codes[((a & 3) << 4) | (b >>> 4)];
    output[offset++] = index + 1 < bytes.length ? codes[((b & 15) << 2) | (c >>> 6)] : 61;
    output[offset++] = index + 2 < bytes.length ? codes[c & 63] : 61;
  }
  return decoder.decode(output);
}

// Match atob's accepted padding/whitespace and rejection rules without a DOM or
// Node Buffer dependency. Existing fingerprints hash the resulting bytes.
export function decodeBase64(input) {
  let text = String(input).replace(/[\t\n\f\r ]/g, "");
  if (text.length % 4 === 0) text = text.replace(/={1,2}$/, "");
  if (text.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(text)) {
    const error = new Error("Invalid character"); error.name = "InvalidCharacterError"; throw error;
  }
  const bytes = new Uint8Array(Math.floor(text.length * 6 / 8));
  let bits = 0, value = 0, offset = 0;
  for (let index = 0; index < text.length; index++) {
    value = (value << 6) | values[text.charCodeAt(index)]; bits += 6;
    if (bits >= 8) { bits -= 8; bytes[offset++] = (value >>> bits) & 255; }
  }
  return bytes;
}
