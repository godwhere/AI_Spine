import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { codexNativeProvider } from "../providers/codex-native.mjs";
import { openAIImagesProvider } from "../providers/openai-images.mjs";
import { sub2apiImagesProvider } from "../providers/sub2api-images.mjs";
import { requireCapability } from "../providers/capabilities.mjs";

function validModel(adapter, model) {
  return adapter.allowCustomModel ? typeof model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model)
    : !adapter.models.length || adapter.models.includes(model);
}

function connectionError(error, key) {
  const message = String(error?.message || "AI 服务请求失败。");
  const result = new Error(key ? message.replaceAll(key, "[已隐藏]") : message);
  result.name = error?.name || "Error";
  return result;
}

// Provider adapters own authentication checks and image requests; jobs keep one
// provider/model snapshot and share the existing candidate/calibration pipeline.
export class AIConnections {
  constructor({ root, rpc, generateNative, protection, fetcher, providers, isBusy = () => false }) {
    this.root = root; this.protection = protection; this.isBusy = isBusy;
    this.providers = new Map((providers || [codexNativeProvider(rpc, generateNative), openAIImagesProvider(fetcher), sub2apiImagesProvider(fetcher)]).map((p) => [p.id, requireCapability(p, "image")]));
    this.config = { selected: "codex-native", profiles: {} };
    this.keys = new Map(); this.unlocking = new Map(); this.ready = this.load();
    this.rpc = rpc;
    this.authListener = (event) => { if (event.method === "account/login/completed" && event.params?.loginId === this.loginAttempt?.value.loginId) this.loginAttempt = null; };
    rpc?.on?.("notification", this.authListener);
  }
  async load() {
    try {
      const saved = JSON.parse(await readFile(join(this.root, "connection.json"), "utf8"));
      if (this.providers.has(saved.selected)) this.config.selected = saved.selected;
      for (const [id, value] of Object.entries(saved.profiles || {})) {
        const adapter = this.providers.get(id); if (!adapter) continue;
        this.config.profiles[id] = { ...(adapter.normalizeSettings ? adapter.normalizeSettings(value) : {}),
          model: validModel(adapter, value.model) ? value.model : adapter.models[0] };
        if (typeof value.encryptedKey === "string" && value.encryptedKey)
          this.config.profiles[id].encryptedKey = value.encryptedKey;
      }
    } catch (error) { if (error.code !== "ENOENT") this.loadError = "AI 连接配置无法读取，请重新连接。"; }
  }
  adapter(id) { const value = this.providers.get(id); if (!value) throw new Error("不支持这个 AI 服务，请选择列表中的服务。"); return value; }
  settings(id, model) {
    const adapter = this.adapter(id), profile = this.config.profiles[id];
    return { ...(adapter.configurableEndpoint ? { baseUrl: profile?.baseUrl || "", protocol: profile?.protocol || "images" } : {}),
      key: this.keys.get(id), model: model || profile?.model || adapter.models[0] };
  }
  async unlock(id) {
    if (this.closed) throw new Error("AI 连接已关闭，请重新连接。");
    if (this.keys.has(id)) return this.keys.get(id);
    if (this.unlocking.has(id)) return this.unlocking.get(id);
    const encryptedKey = this.config.profiles[id]?.encryptedKey;
    if (!encryptedKey) throw new Error("请先在 AI 连接中配置该服务的 API Key。");
    if (!this.protection) throw new Error("当前环境无法解锁已保存的 API Key，请重新输入并仅在本次运行中使用。原密文会保留。");
    const pending = (async () => {
      let key;
      try { key = await this.protection.decrypt(Buffer.from(encryptedKey, "base64")); }
      catch { throw new Error("无法解锁已保存的 API Key。请允许系统安全存储访问后重试，或重新输入 Key。原密文会保留。"); }
      if (typeof key !== "string" || key.length < 8 || key.length > 512 || /\s/.test(key))
        throw new Error("已保存的 API Key 无法读取，请重新输入。原密文会保留。");
      if (this.closed || this.unlocking.get(id) !== pending || this.config.profiles[id]?.encryptedKey !== encryptedKey)
        throw new Error("AI 连接已关闭或凭据已更改，请重新连接。");
      this.keys.set(id, key); return key;
    })();
    this.unlocking.set(id, pending);
    try { return await pending; }
    finally { if (this.unlocking.get(id) === pending) this.unlocking.delete(id); }
  }
  async persist(config = this.config) {
    await mkdir(this.root, { recursive: true });
    const file = join(this.root, "connection.json");
    await writeFile(file + ".tmp", JSON.stringify(config), { mode: 0o600 });
    await rename(file + ".tmp", file);
  }
  async status(id) {
    await this.ready; id ||= this.config.selected;
    const adapter = this.adapter(id);
    if (adapter.auth === "api-key" && !this.keys.has(id) && this.config.profiles[id]?.encryptedKey)
      return { provider: id, label: adapter.label, connected: false, message: "API Key 已安全保存在本机。请在 AI 连接中点击「保存并验证连接」验证并使用；也可在实际生成时解锁。" };
    try { return { provider: id, label: adapter.label, ...await adapter.status(this.settings(id)) }; }
    catch { return { provider: id, label: adapter.label, connected: false, message: id === "codex-native"
      ? "暂时无法连接 Codex。请确认本机已安装并登录 Codex，再刷新连接。"
      : "API 连接检查失败，请检查网络、Key 与所选模型后重试。" }; }
  }
  async info(status) {
    await this.ready;
    return { selected: this.config.selected, status: status || await this.status(), secureStorage: Boolean(this.protection) && this.storageAvailable !== false, busy: this.isBusy(), warning: this.loadError,
      providers: [...this.providers.values()].map((p) => ({ id: p.id, label: p.label, auth: p.auth, capabilities: p.capabilities, models: p.models, links: p.links, notice: p.notice,
        ...(p.configurableEndpoint ? { configurableEndpoint: true, allowCustomModel: p.allowCustomModel, protocols: p.protocols, modelsByProtocol: p.modelsByProtocol,
          baseUrl: this.settings(p.id).baseUrl, protocol: this.settings(p.id).protocol } : {}),
        model: this.settings(p.id).model, keyConfigured: this.keys.has(p.id) || Boolean(this.config.profiles[p.id]?.encryptedKey),
        keySaved: Boolean(this.config.profiles[p.id]?.encryptedKey), needsUnlock: !this.keys.has(p.id) && Boolean(this.config.profiles[p.id]?.encryptedKey) })) };
  }
  async configure(input) {
    if (this.changing || this.isBusy()) throw new Error("请等待生成结束或取消生成后，再更改 AI 连接。");
    this.changing = true;
    try {
      await this.ready;
      const adapter = this.adapter(input.provider), next = structuredClone(this.config);
      const model = input.model || this.settings(adapter.id).model;
      if (!validModel(adapter, model)) throw new Error("请选择受支持的生图模型或填写有效的模型名称。");
      const extra = adapter.normalizeSettings ? adapter.normalizeSettings({ ...this.settings(adapter.id), ...input }) : {};
      if (adapter.configurableEndpoint && this.config.profiles[adapter.id]?.baseUrl && extra.baseUrl !== this.settings(adapter.id).baseUrl && !(typeof input.apiKey === "string" && input.apiKey.trim()))
        throw new Error("Sub2API 地址或接口已更改，请重新填写网关密钥后验证，避免把原密钥发送到其他地址。");
      let key = this.keys.get(adapter.id), canRemember = false, unlockedStored = false;
      if (adapter.auth === "api-key") {
        if (input.apiKey !== undefined && typeof input.apiKey !== "string") throw new Error("API Key 格式无效。");
        key = input.apiKey?.trim() || key;
        if (key && (key.length < 8 || key.length > 512 || /\s/.test(key))) throw new Error("请填写有效的 API Key。");
        if (!key && !next.profiles[adapter.id]?.encryptedKey) throw new Error("请填写有效的 API Key。");
        if (input.remember !== false) {
          try { canRemember = Boolean(this.protection && (this.protection.isAvailable ? await this.protection.isAvailable() : true)); }
          catch { throw new Error("无法访问系统安全存储，原连接配置未更改。请重试，或取消勾选安全保存，仅在本次运行中使用。"); }
          this.storageAvailable = canRemember;
          if (!canRemember && next.profiles[adapter.id]?.encryptedKey)
            throw new Error("当前无法安全保存新的 API Key，原密文和连接配置未更改。可取消勾选安全保存，仅在本次运行中使用。");
        }
        if (!key && next.profiles[adapter.id]?.encryptedKey) { key = await this.unlock(adapter.id); unlockedStored = true; }
        if (!key || key.length < 8 || key.length > 512 || /\s/.test(key)) throw new Error("请填写有效的 API Key。");
      }
      let status;
      try { status = await adapter.status({ ...extra, key, model }); }
      catch (error) { throw connectionError(error, key); }
      if (!status.connected) throw new Error(status.message);
      if (this.isBusy()) throw new Error("已有生成开始，请结束生成后再更改连接。");
      next.selected = adapter.id;
      next.profiles[adapter.id] = { ...next.profiles[adapter.id], ...extra, ...(model ? { model } : {}) };
      if (adapter.auth === "api-key") {
        if (input.remember === false) delete next.profiles[adapter.id].encryptedKey;
        else if (canRemember && !unlockedStored) {
          try { next.profiles[adapter.id].encryptedKey = Buffer.from(await this.protection.encrypt(key)).toString("base64"); }
          catch { throw new Error("API Key 无法安全保存，原连接配置未更改。请重试，或取消勾选安全保存，仅在本次运行中使用。"); }
        } else if (!canRemember) status = { ...status, message: `${status.message || "连接已验证。"} Key 仅在本次运行中使用，重启后需重新填写。` };
      }
      await this.persist(next);
      this.config = next; this.unlocking.delete(adapter.id); if (key) this.keys.set(adapter.id, key); this.loadError = null;
      return this.info({ provider: adapter.id, label: adapter.label, ...status });
    } finally { this.changing = false; }
  }
  async forget(id) {
    await this.ready;
    if (this.changing || this.isBusy()) throw new Error("请先结束生成，再移除 API Key。");
    const adapter = this.adapter(id);
    if (adapter.auth !== "api-key") throw new Error("Codex 的账号由 Codex 管理。");
    this.changing = true;
    try {
      const next = structuredClone(this.config);
      if (next.profiles[id]) delete next.profiles[id].encryptedKey;
      await this.persist(next); this.config = next; this.keys.delete(id); this.unlocking.delete(id);
      return this.info();
    } finally { this.changing = false; }
  }
  async snapshot(selection) {
    await this.ready;
    if (this.changing) throw new Error("正在更新 AI 连接，请稍后再生成。");
    const id = selection?.id || this.config.selected, adapter = this.adapter(id);
    const model = selection?.model || this.settings(id).model;
    if (!validModel(adapter, model)) throw new Error("原生成记录的模型不再可用，请重新选择模型生成。");
    const extra = adapter.normalizeSettings ? adapter.normalizeSettings(this.settings(id)) : {};
    if (adapter.configurableEndpoint && selection?.baseUrl && (selection.baseUrl !== extra.baseUrl || selection.protocol !== extra.protocol))
      throw new Error("原任务的 Sub2API 地址或图片接口已更改，请重新连接原网关后继续生成。");
    if (adapter.auth === "api-key" && !this.keys.has(id) && !this.config.profiles[id]?.encryptedKey) throw new Error("请先在 AI 连接中配置该服务的 API Key。");
    return { id, label: adapter.label, ...extra, ...(model ? { model } : {}) };
  }
  async generate(selection, options = {}) {
    await this.ready;
    const adapter = this.adapter(selection.id);
    const settings = this.settings(selection.id, selection.model);
    if (adapter.configurableEndpoint && (!selection.baseUrl || selection.baseUrl !== settings.baseUrl || selection.protocol !== settings.protocol))
      throw new Error("原任务的 Sub2API 地址或图片接口已更改，请重新连接原网关后继续生成。");
    options.signal?.throwIfAborted();
    if (adapter.auth === "api-key" && !settings.key) settings.key = await this.unlock(selection.id);
    options.signal?.throwIfAborted();
    try { return await adapter.generate(settings, options); }
    catch (error) { throw connectionError(error, settings.key); }
  }
  async login() {
    await this.ready;
    if (this.isBusy() || this.changing) throw new Error("请先结束生成，再连接 Codex 账号。");
    if (this.loginAttempt && Date.now() - this.loginAttempt.at < 10 * 60 * 1000) return this.loginAttempt.value;
    const result = await this.adapter("codex-native").login();
    this.loginAttempt = { at: Date.now(), value: result };
    return result;
  }
  close() { this.closed = true; this.rpc?.off?.("notification", this.authListener); this.keys.clear(); this.unlocking.clear(); }
}
