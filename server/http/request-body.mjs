export const JSON_LIMIT = 40 * 1024 * 1024;
export async function readOptions(req) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("请使用 JSON 请求。");
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 4096) throw new Error("连接配置过大。"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
