import { extractPart, browserPixels, readReplacement, autoFit } from "./pixels.js";

// The browser talks only to the local job API; provider credentials stay server-side.
export function buildGenerationRequest(
  bundle,
  { prompt, partIds = [], appearanceReference, concurrency = 3 } = {},
) {
  if (!prompt?.trim()) throw new Error("请填写形象或部件的生成要求。");
  if (prompt.trim().length > 4000) throw new Error("生成要求请控制在 4000 字以内。");
  const parts = [...new Set(partIds)].map((id) => {
    const part = bundle.parts.find((p) => p.id === id);
    if (!part) throw new Error(`模板没有这个部件：${id}`);
    return {
      id: part.id,
      page: part.pageFile,
      width: part.originalWidth,
      height: part.originalHeight,
      atlas: {
        x: part.x,
        y: part.y,
        width: part.width,
        height: part.height,
        rotation: part.degrees,
        offsetX: part.offsetX,
        offsetY: part.offsetY,
      },
    };
  });
  return {
    version: 1,
    kind: parts.length ? "parts" : "appearance",
    concurrency: parts.length ? concurrency : 1,
    prompt: prompt.trim(),
    template: {
      id: bundle.id,
      name: bundle.name,
      spineVersion: bundle.version,
    },
    parts,
    references: bundle.pages.map((page) => ({
      fileName: page.file,
      bytes: bundle.files[page.file],
    })),
    ...(appearanceReference ? { appearanceReference } : {}),
  };
}

export async function templateFingerprint(bundle) {
  const chunks = [bundle.skeletonPath,...(bundle.atlasPaths||[])].sort().flatMap((path)=>[
    new TextEncoder().encode(`${path}\0`), bundle.files[path],
  ]);
  const bytes = new Uint8Array(chunks.reduce((sum,chunk)=>sum+chunk.length,0));
  let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2,"0")).join("");
}

export async function prepareGenerationRequest(bundle, options, env = browserPixels) {
  const request = buildGenerationRequest(bundle, options);
  request.projectId = options.projectId;
  request.template.fingerprint = await templateFingerprint(bundle);
  request.references = [];
  if (options.templateReference) request.references.push({ role:"template", bytes:options.templateReference });
  if (options.appearanceReference?.image) request.references.push({ role:"appearance", bytes:options.appearanceReference.image });
  for (const selected of request.parts) {
    const part = bundle.parts.find((p)=>p.id===selected.id);
    const canvas = await extractPart(bundle,part,env);
    request.references.push({ role:"part", partId:part.id, bytes:await env.encode(canvas) });
  }
  delete request.appearanceReference;
  return request;
}

export async function applyGeneratedParts(bundle, edits, result, images, env = browserPixels) {
  if (result.kind !== "parts" || result.fingerprint !== await templateFingerprint(bundle))
    throw new Error("生成结果与当前模板不匹配，未应用任何部件。");
  if (!images.length) throw new Error("没有可应用的部件图片。");
  const next = Object.assign(Object.create(null),edits), used = new Set();
  for (const image of images) {
    const part = bundle.parts.find((p)=>p.id===image.partId);
    if (!part || used.has(part.id) || !(image.bytes instanceof Uint8Array)) throw new Error("生成部件映射无效。");
    used.add(part.id);
    const replacement = await readReplacement(new File([image.bytes],`${part.name}-ai.png`,{type:"image/png"}),env);
    replacement.transform = await autoFit(bundle,part,replacement.image,env);
    next[part.id] = replacement;
  }
  return next;
}

function toBase64(bytes) {
  let binary = "";
  for (let i=0;i<bytes.length;i+=32768) binary += String.fromCharCode(...bytes.subarray(i,i+32768));
  return btoa(binary);
}
export function createLocalGenerationProvider(fetcher = fetch) {
  const call = async (path, options={}) => {
    const response = await fetcher(`/api/generation/${path}`, options);
    const type=response.headers.get("content-type")||"";
    if (!type.includes("application/json")) throw new Error("本地生图服务未启动。请使用项目的本地启动器打开工作台。");
    const body=await response.json();
    if (!response.ok) throw new Error(body.error||"本地生图请求失败。");
    return body;
  };
  return {
    status:(provider)=>call(`status${provider ? `?provider=${encodeURIComponent(provider)}` : ""}`),
    connection:()=>call("connection"),
    configure:(options)=>call("connection",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(options)}),
    login:()=>call("connection/login",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}),
    forgetKey:(provider="openai")=>call(`connection/${encodeURIComponent(provider)}`,{method:"DELETE"}),
    list:async(projectId)=>(await call(`jobs?projectId=${encodeURIComponent(projectId)}`)).jobs,
    get:(id)=>call(`jobs/${encodeURIComponent(id)}`),
    retry:(id,concurrency=3)=>call(`jobs/${encodeURIComponent(id)}/retry`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({concurrency})}),
    cancel:(id)=>call(`jobs/${encodeURIComponent(id)}`,{method:"DELETE"}),
    start:(request)=>call("jobs",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      ...request,references:request.references.map(({bytes,...ref})=>({...ref,base64:toBase64(bytes)})),
    })}),
    async image(jobId,imageId) {
      const response=await fetcher(`/api/generation/jobs/${encodeURIComponent(jobId)}/images/${encodeURIComponent(imageId)}`);
      if (!response.ok || !response.headers.get("content-type")?.startsWith("image/png")) throw new Error("生成图片读取失败，请重新打开生成记录。");
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
export function createGenerationService(provider) {
  return {
    configured: typeof provider?.generate === "function",
    async generate(request, { signal } = {}) {
      if (signal?.aborted) throw new DOMException("生成已取消。", "AbortError");
      if (!provider?.generate)
        throw Object.assign(
          new Error("尚未连接生成服务。可先导入图片完成替换与校准。"),
          { code: "GENERATION_NOT_CONNECTED" },
        );
      const result = await provider.generate(request, { signal });
      if (signal?.aborted) throw new DOMException("生成已取消。", "AbortError");
      if (
        !Array.isArray(result?.images) ||
        result.images.some((image) => !(image.bytes instanceof Uint8Array))
      )
        throw new Error("生成服务返回了无效的图片结果。");
      return result;
    },
  };
}
