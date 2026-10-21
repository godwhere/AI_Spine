import { IMAGE_CAPABILITIES } from "./capabilities.mjs";
import { readFile } from "node:fs/promises";

const IMAGE_MODELS = ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2", "gpt-image-1.5"];
const GEMINI_MODELS = ["gemini-3.1-flash-image", "gemini-3-pro-image-preview", "gemini-2.5-flash-image"];
const MAX_IMAGE = 18 * 1024 * 1024, MAX_RESPONSE = 25 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function sub2apiSettings({ baseUrl, protocol = "images" } = {}) {
  if (!["images", "gemini"].includes(protocol)) throw new Error("请选择 Sub2API 支持的图片接口。");
  let url;
  try { url = new URL(String(baseUrl || "").trim()); }
  catch { throw new Error("请填写完整的 Sub2API 服务地址。"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash)
    throw new Error("Sub2API 地址须使用 HTTPS 或本机 HTTP，且不能包含账号、密钥、查询参数或片段。");
  let path = url.pathname.replace(/\/+$/, "");
  if (/\/(?:images\/(?:generations|edits)|models(?:\/[^/]+)?)$/.test(path))
    throw new Error("请填写 Sub2API 服务根地址或 API 前缀，不要填写具体的生成接口。");
  path = path.replace(/\/v1(?:beta)?$/, "");
  url.pathname = `${path}/${protocol === "gemini" ? "v1beta" : "v1"}`;
  return { baseUrl: url.toString().replace(/\/$/, ""), protocol };
}

function requestError(status) {
  if (status === 401) return new Error("Sub2API 网关密钥无效或已失效，请重新填写。");
  if (status === 402) return new Error("Sub2API 当前密钥额度不足，请检查网关配置。");
  if (status === 403) return new Error("Sub2API 未允许此密钥使用该模型，请检查账号分组和模型权限。");
  if (status === 404) return new Error("Sub2API 接口或模型不存在，请检查服务地址、图片接口和分组。");
  if (status === 429) return new Error("Sub2API 达到并发或用量限制，请稍后重试或降低同时生成数量。");
  return new Error(`Sub2API 请求失败（HTTP ${status}），请检查网关和上游账号状态。`);
}

async function bytes(response, limit, signal) {
  if (Number(response.headers.get("content-length") || 0) > limit) {
    await response.body?.cancel(); throw new Error("Sub2API 返回内容超过允许大小。");
  }
  if (!response.body) throw new Error("Sub2API 没有返回内容。");
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("Sub2API 返回内容超过允许大小。");
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  signal?.throwIfAborted();
  return Buffer.concat(chunks);
}

async function json(response, signal) {
  if (!response.ok) { await response.body?.cancel(); throw requestError(response.status); }
  const data = await bytes(response, MAX_RESPONSE, signal);
  try { return JSON.parse(data.toString("utf8")); }
  catch { throw new Error("Sub2API 返回的内容不是 JSON，请检查 API 地址。"); }
}

async function pngResult(data) {
  if (!data.length || data.length > MAX_IMAGE) throw new Error("Sub2API 图片为空或超过 18 MB。");
  if (data.subarray(0, 8).equals(PNG)) return data.toString("base64");
  // Preserve dimensions when a Gemini channel returns JPEG or WebP. The shared
  // job validator still checks real transparency; conversion never invents it.
  const { loadImage, createCanvas } = await import("@napi-rs/canvas");
  let image;
  try { image = await loadImage(data); }
  catch { throw new Error("Sub2API 没有返回可读取的图片。"); }
  if (!image.width || !image.height || image.width * image.height > 64 * 1024 * 1024)
    throw new Error("Sub2API 图片尺寸超过允许范围。");
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext("2d").drawImage(image, 0, 0);
  const png = canvas.toBuffer("image/png");
  if (png.length > MAX_IMAGE) throw new Error("Sub2API 图片超过 18 MB。");
  return png.toString("base64");
}

function decodeImage(value) {
  if (typeof value !== "string") throw new Error("Sub2API 没有返回图片数据。");
  const encoded = value.replace(/^data:image\/[\w.+-]+;base64,/, "");
  if (!encoded || encoded.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw new Error("Sub2API 图片数据无效或超过 18 MB。");
  return Buffer.from(encoded, "base64");
}

export function sub2apiImagesProvider(fetcher = fetch) {
  return {
    id: "sub2api", label: "Sub2API", auth: "api-key", models: IMAGE_MODELS, capabilities: IMAGE_CAPABILITIES,
    configurableEndpoint: true, allowCustomModel: true,
    protocols: [{ id: "images", label: "OpenAI Images（GPT Image）" }, { id: "gemini", label: "Gemini 原生图片接口" }],
    modelsByProtocol: { images: IMAGE_MODELS, gemini: GEMINI_MODELS },
    links: { docs: "https://github.com/Wei-Shaw/sub2api/blob/main/README_CN.md" },
    notice: "使用你配置的 Sub2API 网关和账号分组。验证连接不会生成图片；实际生成时才会上传描述与参考图。",
    normalizeSettings: sub2apiSettings,
    async status(settings) {
      if (!settings.baseUrl || !settings.key) return { connected: false, message: "请填写 Sub2API 服务地址、网关密钥和生图模型，再验证连接。" };
      const { baseUrl } = sub2apiSettings(settings);
      const signal = AbortSignal.timeout(15000);
      const value = await json(await fetcher(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${settings.key}` }, redirect: "error", signal,
      }), signal);
      const models = value.data || value.models;
      if (!Array.isArray(models) || !models.some((item) => (item.id || item.name?.replace(/^models\//, "")) === settings.model))
        throw new Error("Sub2API 模型目录未包含所选模型，请检查模型名和密钥所属分组。");
      return { connected: true, message: `Sub2API 网关与模型 ${settings.model} 已验证；实际图片能力在生成时检查。` };
    },
    async generate(settings, { prompt, references = [], signal } = {}) {
      const { baseUrl, protocol } = sub2apiSettings(settings);
      if (!settings.key) throw new Error("Sub2API 网关密钥尚未配置。");
      signal?.throwIfAborted();
      const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(600000)]);
      const headers = { Authorization: `Bearer ${settings.key}` };
      let path, body;
      if (protocol === "gemini") {
        const parts = [];
        for (const file of references) parts.push({ inlineData: { mimeType: "image/png", data: (await readFile(file)).toString("base64") } });
        parts.push({ text: prompt });
        path = `/models/${encodeURIComponent(settings.model)}:generateContent`;
        body = JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } });
        headers["Content-Type"] = "application/json";
      } else {
        const options = { model: settings.model, prompt, n: "1", size: "auto", quality: "medium", background: "transparent", output_format: "png", response_format: "b64_json" };
        if (references.length) {
          body = new FormData();
          for (const [name, value] of Object.entries(options)) body.set(name, value);
          for (const [index, file] of references.entries()) body.append("image[]", new Blob([await readFile(file)], { type: "image/png" }), `reference-${index}.png`);
          path = "/images/edits";
        } else { body = JSON.stringify({ ...options, n: 1 }); path = "/images/generations"; headers["Content-Type"] = "application/json"; }
      }
      requestSignal.throwIfAborted();
      const value = await json(await fetcher(baseUrl + path, { method: "POST", headers, body, redirect: "error", signal: requestSignal }), requestSignal);
      let data;
      if (protocol === "gemini") {
        const images = (value.candidates || []).flatMap((candidate) => candidate.content?.parts || [])
          .map((part) => part.inlineData || part.inline_data).filter((item) => item?.data);
        if (images.length !== 1) throw new Error("Gemini 未返回一张图片，请检查所选模型的图片输出能力。");
        data = decodeImage(images[0].data);
      } else {
        if (!Array.isArray(value.data) || value.data.length !== 1) throw new Error("Sub2API 未返回一张图片，请检查生图模型和网关配置。");
        const image = value.data[0];
        if (image.b64_json) data = decodeImage(image.b64_json);
        else if (typeof image.url === "string" && image.url.startsWith("data:image/")) data = decodeImage(image.url);
        else if (typeof image.url === "string") {
          const url = new URL(image.url, baseUrl + "/");
          if (url.origin !== new URL(baseUrl).origin || url.username || url.password || url.hash)
            throw new Error("Sub2API 返回了外部图片地址，请将网关返回格式设为 Base64 或使用同源图片地址。");
          // Download endpoints receive no gateway Authorization header, even on
          // the same origin. Never follow a redirect carrying a credential.
          const response = await fetcher(url.toString(), { redirect: "error", signal: requestSignal });
          if (!response.ok) { await response.body?.cancel(); throw new Error("Sub2API 生成图片下载失败，请重试。"); }
          data = await bytes(response, MAX_IMAGE, requestSignal);
        } else throw new Error("Sub2API 没有返回图片数据。");
      }
      const result = await pngResult(data);
      requestSignal.throwIfAborted();
      return { result, model: settings.model };
    },
  };
}
