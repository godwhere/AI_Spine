function createRigClient(fetcher = fetch) {
  const call = async (path, options) => {
    const response = await fetcher(`/api/rig/${path}`, options);
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw new Error("骨架 AI 服务尚未就绪，请重新打开最新版 iSpine。");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "骨架 AI 请求失败。");
    return result;
  };
  return {
    start: (request) => call("jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }),
    get: (id) => call(`jobs/${encodeURIComponent(id)}`),
    list: async (projectId) => (await call(`jobs?projectId=${encodeURIComponent(projectId)}`)).jobs,
    cancel: (id) => call(`jobs/${encodeURIComponent(id)}`, { method: "DELETE" }),
    retry: (id, { concurrency = 2 } = {}) => call(`jobs/${encodeURIComponent(id)}/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ concurrency }) }),
    async image(jobId, image) {
      const prefix = `/api/rig/jobs/${encodeURIComponent(jobId)}/images/`;
      const path = image.url || (image.id ? prefix + encodeURIComponent(image.id) : "");
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes("/") || /[?#]|\.\./.test(path))
        throw new Error("生成部件地址无效。");
      const response = await fetcher(path);
      if (!response.ok || !response.headers.get("content-type")?.startsWith("image/png"))
        throw new Error("部件图片读取失败，请重新打开生成记录。");
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

export { createRigClient };
