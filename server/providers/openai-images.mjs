import { IMAGE_CAPABILITIES } from "./capabilities.mjs";
import { readFile } from "node:fs/promises";

const BASE = "https://api.openai.com/v1";
function apiError(status) {
  if (status === 401) return new Error("API Key 无效或已失效，请重新填写。");
  if (status === 403 || status === 404) return new Error("该 API Key 无法访问所选生图模型，请检查项目权限或更换模型。");
  if (status === 429) return new Error("OpenAI API 达到用量或速率限制，请检查 API 账户后重试。");
  return new Error(`OpenAI API 请求失败（HTTP ${status}），请稍后重试。`);
}
export function openAIImagesProvider(fetcher = fetch) {
  const models = ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-1.5"];
  return {
    id: "openai", label: "OpenAI API", auth: "api-key", models, capabilities: IMAGE_CAPABILITIES,
    links: { keys: "https://platform.openai.com/api-keys", docs: "https://developers.openai.com/api/docs/guides/image-generation" },
    notice: "API 用量由你的 OpenAI API 账户结算。保存并验证只检查连接，点击生成后才提交生图请求。",
    async status({ key, model }) {
      if (!key) return { connected: false, message: "请填写自己的 OpenAI API Key 并验证连接。" };
      const response = await fetcher(`${BASE}/models/${encodeURIComponent(model)}`, {
        headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw apiError(response.status);
      const result = await response.json();
      if (result.id !== model) throw new Error("API 未返回所选模型，请检查连接。");
      return { connected: true, message: `已验证 API Key 和模型 ${model}；生图权限在首次生成时检查。` };
    },
    async generate({ key, model }, { prompt, references, signal }) {
      if (!key) throw new Error("OpenAI API Key 尚未配置，请先连接 AI。");
      signal?.throwIfAborted();
      const options = { model, prompt, n: "1", size: "auto", quality: "medium", background: "transparent", output_format: "png" };
      let body, path;
      if (references.length) {
        body = new FormData();
        for (const [name, value] of Object.entries(options)) body.set(name, value);
        for (const [index, file] of references.entries()) {
          const bytes = await readFile(file);
          body.append("image[]", new Blob([bytes], { type: "image/png" }), `reference-${index}.png`);
        }
        path = "/images/edits";
      } else { body = JSON.stringify({ ...options, n: 1 }); path = "/images/generations"; }
      signal?.throwIfAborted();
      const response = await fetcher(BASE + path, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, ...(references.length ? {} : { "Content-Type": "application/json" }) },
        body, redirect: "error", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(600000)]),
      });
      if (!response.ok) throw apiError(response.status);
      const length = Number(response.headers.get("content-length") || 0);
      if (length > 25 * 1024 * 1024) throw new Error("API 图片响应超过允许大小。");
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length;
          if (size > 25 * 1024 * 1024) throw new Error("API 图片响应超过允许大小。");
          chunks.push(Buffer.from(value));
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (value.data?.length !== 1 || typeof value.data[0].b64_json !== "string")
        throw new Error("API 没有返回一张 PNG 图片，请检查模型的生图支持。");
      signal?.throwIfAborted();
      return { result: value.data[0].b64_json, model };
    },
  };
}
