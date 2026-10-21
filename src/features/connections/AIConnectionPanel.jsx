import { useEffect, useRef, useState } from "react";
import { Sparkles, KeyRound, RefreshCw, Check, LoaderCircle, ExternalLink, X } from "lucide-react";

export function AIConnectionPanel({ client, onClose, onChanged }) {
  const [info, setInfo] = useState(null), [provider, setProvider] = useState("codex-native");
  const [apiKey, setApiKey] = useState(""), [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState(""), [protocol, setProtocol] = useState("images");
  const [remember, setRemember] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [status, setStatus] = useState(null), [login, setLogin] = useState(null);
  const alive = useRef(true), sequence = useRef(0);
  const current = info?.providers.find((p) => p.id === provider);
  const refresh = async () => {
    const ticket = ++sequence.current; setStatus(null);
    try {
      const [result, details] = await Promise.all([client.status(provider), client.connection()]);
      if (alive.current && ticket === sequence.current) { setStatus(result); setInfo(details); if (!details.secureStorage) setRemember(false); }
    } catch (e) { if (alive.current && ticket === sequence.current) setStatus({ connected: false, message: e.message }); }
  };
  useEffect(() => {
    alive.current = true;
    client.connection().then((result) => {
      if (!alive.current) return;
      setInfo(result); setProvider(result.selected); setStatus(result.status); setRemember(result.secureStorage);
    }).catch((e) => { if (alive.current) setError(e.message); });
    return () => { alive.current = false; sequence.current++; };
  }, [client]);
  useEffect(() => { if (info) { setModel(current?.model || current?.models[0] || ""); setBaseUrl(current?.baseUrl || ""); setProtocol(current?.protocol || "images"); void refresh(); } }, [provider, info?.selected]);
  useEffect(() => {
    const checkingLogin = login && provider === "codex-native";
    if (!checkingLogin && !info?.busy) return;
    let checking = false, stopped = false;
    const timer = setInterval(async () => {
      if (checking) return; checking = true;
      try {
        if (checkingLogin) {
          const value = await client.status("codex-native");
          if (alive.current && !stopped && value.connected) { setStatus(value); setLogin(null); setNotice("Codex 登录成功，点击「使用 Codex 账号」启用。"); }
        }
        if (info?.busy && !stopped) { const details = await client.connection(); if (alive.current && !stopped) setInfo(details); }
      } catch { /* The visible refresh action remains available. */ }
      finally { checking = false; }
    }, 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, [login, info?.busy, client, provider]);
  const run = async (action) => {
    sequence.current++;
    setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (e) { if (alive.current) setError(e.message); }
    finally { if (alive.current) setBusy(false); }
  };
  const save = () => run(async () => {
    const result = await client.configure({ provider, ...(current?.auth === "api-key" ? { apiKey, model, remember } : {}),
      ...(current?.configurableEndpoint ? { baseUrl, protocol } : {}) });
    onChanged(result.status);
    if (!alive.current) return;
    setApiKey(""); setInfo(result); setStatus(result.status);
    if (current?.configurableEndpoint) { const saved = result.providers.find((p) => p.id === provider); setBaseUrl(saved.baseUrl); setProtocol(saved.protocol); }
    if (!result.secureStorage) setRemember(false);
    setNotice(provider === "codex-native" ? "已使用 Codex 账号，返回角色后即可生成。" : `API 连接已验证。点击生成时将使用你选择的 ${current?.label || "AI 服务"}。`);
  });
  const forget = () => run(async () => {
    const result = await client.forgetKey(provider); onChanged(result.status);
    if (alive.current) { setApiKey(""); setInfo(result); setStatus({ connected: false, message: "请填写自己的 API Key 并验证连接。" }); setNotice("已移除此应用保存的 API Key，请重新配置后生成。"); }
  });
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <section className="modal ai-connection-modal" role="dialog" aria-modal="true" aria-labelledby="ai-connection-title" onKeyDown={(e) => { if (busy && e.key === "Escape") e.stopPropagation(); }}>
      <header className="modal-header"><div><h2 id="ai-connection-title"><Sparkles size={18} />连接 AI</h2><p>选择生成角色和模板部件时使用的服务。</p></div>
        <button className="icon-button" aria-label="关闭 AI 连接" onClick={onClose} disabled={busy}><X size={18} /></button></header>
      <div className="ai-connection-body">
        {error && <div className="error-banner" role="alert">{error}</div>}
        {notice && <div className="generation-notice" role="status"><Check size={15} />{notice}</div>}
        {info?.warning && <p role="status" className="muted small">{info.warning}</p>}
        <div className="ai-provider-options" role="tablist" aria-label="AI 连接方式">
          {(info?.providers || [{ id: "codex-native", label: "Codex 账号" }, { id: "openai", label: "OpenAI API" }]).map((p) =>
            <button key={p.id} role="tab" aria-selected={provider === p.id} disabled={busy || !info} onClick={() => { setProvider(p.id); setApiKey(""); setError(""); setNotice(""); }}>
              {p.auth === "api-key" || p.id === "openai" ? <KeyRound size={20} /> : <Sparkles size={20} />}<strong>{p.label}</strong><small>{p.configurableEndpoint ? "连接自己的生图网关" : p.auth === "chatgpt" || p.id === "codex-native" ? "默认 · 使用已登录账号" : "填写自己的 API Key"}</small>
            </button>)}
        </div>
        <div className={`generation-connection ${status?.connected ? "connected" : ""}`} role="status"><i /><div><strong>{status ? status.connected ? `${current?.label || "AI"}已连接` : "尚未连接" : "正在检查连接…"}</strong><small>{status?.message || "正在检查所选服务"}</small></div>
          <button className="icon-button" aria-label="检查所选 AI 连接" disabled={busy || !info} onClick={() => void refresh()}><RefreshCw size={15} /></button></div>
        {provider === "codex-native" ? <section className="ai-setup-section">
          <h3>使用 Codex 账号</h3>
          <ol><li>在这台电脑安装 Codex，并使用自己的 ChatGPT 账号登录。</li><li>已登录时会自动识别，无需填写 API Key。</li><li>确认连接后，点击「使用 Codex 账号」，再进入角色的「AI 创作」。</li></ol>
          <div className="button-row"><a className="button" href="https://learn.chatgpt.com/docs/codex" target="_blank" rel="noreferrer"><ExternalLink size={14} />安装与登录说明</a>
            {!status?.connected && <button className="button" disabled={busy || info?.busy || !info} onClick={() => void run(async () => { const value = await client.login(); if (alive.current) setLogin(value); })}><ExternalLink size={14} />开始 Codex 登录</button>}</div>
          {login && <div className="ai-login-pending"><p>在浏览器完成官方登录，连接状态会自动更新。</p><a className="button primary" href={login.authUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开登录页面</a></div>}
        </section> : <section className="ai-setup-section">
          <h3>使用 {current?.label || "AI"}{current?.configurableEndpoint ? " 生图网关" : " Key"}</h3>
          {current?.configurableEndpoint ? <>
            <ol><li>在自己的 Sub2API 管理后台授权上游账号，并为图片模型配置分组。</li><li>在 Sub2API 创建该分组的网关密钥，填写下面的地址和模型。</li><li>验证通过后，在角色的「AI 创作」中生成；候选确认后再应用。</li></ol>
            <label className="ai-setting-field">服务地址<input type="url" aria-label="Sub2API 服务地址" value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setStatus({ connected: false, message: "地址已修改，保存并验证后使用。" }); }} placeholder="http://127.0.0.1:18080/v1" autoComplete="off" spellCheck={false} maxLength={1024} disabled={busy || info?.busy} /></label>
            <p className="muted small">支持 HTTPS 服务地址，或通过加密隧道访问的本机 HTTP 地址。修改地址后需重新填写网关密钥。</p>
            <label className="ai-setting-field">图片接口<select aria-label="Sub2API 图片接口" value={protocol} onChange={(e) => { const value = e.target.value; setProtocol(value); setModel(current.modelsByProtocol?.[value]?.[0] || ""); setStatus({ connected: false, message: "图片接口已修改，保存并验证后使用。" }); }} disabled={busy || info?.busy}>{current.protocols?.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          </> : <p>在所选服务的开发者平台创建自己的 Key，并确认项目可以使用所选生图模型。</p>}
          <label className="ai-setting-field">API Key<input type="password" aria-label={`${current?.label || "AI"} Key`} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={current?.keyConfigured ? "已配置；留空保留现有 Key" : "输入你的 API Key"} autoComplete="off" spellCheck={false} maxLength={512} disabled={busy || info?.busy} /></label>
          <label className="ai-setting-field">生图模型{current?.allowCustomModel ? <><input aria-label={`${current.label} 生图模型`} value={model} onChange={(e) => setModel(e.target.value)} list="sub2api-image-models" placeholder="填写 Sub2API 分组中开放的图片模型名" autoComplete="off" spellCheck={false} maxLength={160} disabled={busy || info?.busy} /><datalist id="sub2api-image-models">{(current.modelsByProtocol?.[protocol] || current.models).map((id) => <option key={id} value={id} />)}</datalist><small className="muted">可输入自定义模型名；候选名称需由你的上游账号支持。Gemini 请选择原生图片接口。</small></> : <select aria-label={`${current?.label || "AI"} 生图模型`} value={model} onChange={(e) => setModel(e.target.value)} disabled={busy || info?.busy}>{current?.models.map((id) => <option key={id} value={id}>{id}</option>)}</select>}</label>
          <label className="ai-remember"><input type="checkbox" checked={remember} disabled={!info?.secureStorage || busy || info?.busy} onChange={(e) => setRemember(e.target.checked)} />在本机安全保存 API Key</label>
          <p className="muted small">{info?.secureStorage ? "保存或解锁已保存的 Key 时，系统可能要求确认。Key 不会进入角色工程或导出 ZIP。取消勾选则仅在本次运行中使用。" : "当前环境无法使用系统加密，Key 仅在本次运行中保留，重启后需要重新填写。"}</p>
          <p className="ai-api-billing">{current?.notice || "API 用量由所选服务商结算。点击生成后才提交生图请求。"}</p>
          <div className="button-row">{current?.links?.keys && <a className="button" href={current.links.keys} target="_blank" rel="noreferrer"><ExternalLink size={14} />创建 API Key</a>}{current?.links?.docs && <a className="button subtle" href={current.links.docs} target="_blank" rel="noreferrer">生图接入说明</a>}
            {current?.keyConfigured && <button className="button danger" disabled={busy || info?.busy} onClick={() => void forget()}>移除已配置的 Key</button>}</div>
        </section>}
        {info?.busy && <p className="muted small" role="status">正在生成中，结束或取消生成后可更改连接。</p>}
      </div>
      <footer className="modal-footer"><span className="muted small">当前默认：{info?.providers.find((p) => p.id === info.selected)?.label || "Codex 账号"}</span><div className="button-row"><button className="button" disabled={busy} onClick={onClose}>返回工作台</button>
        <button className="button primary" disabled={busy || !info || info.busy || (current?.configurableEndpoint && (!baseUrl.trim() || !model.trim())) || (provider === "codex-native" ? !status?.connected : !apiKey.trim() && !current?.keyConfigured)} onClick={() => void save()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{provider === "codex-native" ? "使用 Codex 账号" : "保存并验证连接"}</button></div></footer>
    </section>
  </div>;
}
