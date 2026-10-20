// JSON transport for local project bytes. No account credentials belong here.
const tag = "$ispineBinary";
export function encodeWorkspace(value) {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let data;
    if (globalThis.Buffer) data = Buffer.from(bytes).toString("base64");
    else {
      const chunks = [];
      for (let i = 0; i < bytes.length; i += 16384) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 16384)));
      data = btoa(chunks.join(""));
    }
    return { [tag]: value instanceof ArrayBuffer ? "ArrayBuffer" : "Uint8Array", data };
  }
  if (Array.isArray(value)) return value.map(encodeWorkspace);
  if (value && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, encodeWorkspace(item)]));
  }
  return value;
}
export function decodeWorkspace(value) {
  if (value && typeof value === "object" && Object.hasOwn(value, tag)) {
    if (!["ArrayBuffer", "Uint8Array"].includes(value[tag]) || typeof value.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data))
      throw new Error("本机工程的二进制数据无效。");
    const bytes = globalThis.Buffer ? new Uint8Array(Buffer.from(value.data, "base64")) : Uint8Array.from(atob(value.data), (c) => c.charCodeAt(0));
    return value[tag] === "ArrayBuffer" ? bytes.buffer : bytes;
  }
  if (Array.isArray(value)) return value.map(decodeWorkspace);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeWorkspace(item)]));
  return value;
}
