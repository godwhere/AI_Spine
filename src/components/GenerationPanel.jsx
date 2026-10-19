import { useEffect, useRef, useState } from "react";
import { X, Sparkles, Upload, RefreshCw, Check, LoaderCircle, Download, Square } from "lucide-react";
import { createLocalGenerationProvider, prepareGenerationRequest } from "../core/generation.js";
import { readReplacement } from "../core/pixels.js";

const active = (job) => ["queued","connecting","generating","validating"].includes(job?.status);
const statusName = { queued:"等待生成",connecting:"连接 Codex",generating:"正在生成",validating:"检查图片",completed:"已完成",failed:"生成失败",cancelled:"已取消" };
function useImage(bytes) {
  const [url,setUrl]=useState("");
  useEffect(()=>{
    if (!bytes) {setUrl("");return;}
    const next=URL.createObjectURL(new Blob([bytes],{type:"image/png"}));setUrl(next);
    return ()=>URL.revokeObjectURL(next);
  },[bytes]);
  return url;
}
export function GenerationPanel({ bundle, projectId, selectedPart, ai, onChange, onApply, captureTemplate, onClose }) {
  const provider=useRef(createLocalGenerationProvider()).current;
  const [kind,setKind]=useState("appearance"),[connection,setConnection]=useState(null),[jobs,setJobs]=useState([]),
    [selectedJob,setSelectedJob]=useState(""),[selected,setSelected]=useState([selectedPart].filter(Boolean)),
    [search,setSearch]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const upload=useRef(), alive=useRef(true);
  const appearanceUrl=useImage(ai.appearance?.image);
  const job=jobs.find((j)=>j.id===selectedJob), running=jobs.find(active), promptKey=kind==="parts"?"partsPrompt":"appearancePrompt";
  const checkConnection=async()=>{
    try {setConnection(await provider.status());} catch(e){setConnection({connected:false,message:e.message});}
  };
  const merge=(value)=>setJobs((all)=>[value,...all.filter((j)=>j.id!==value.id)].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));
  useEffect(()=>{
    alive.current=true;
    void checkConnection();
    provider.list(projectId).then((values)=>{
            if (!alive.current)return;
      setJobs(values); const current=values.find(active)||values[0];
      if(current){setSelectedJob(current.id);setKind(current.kind);if(current.kind==="parts"&&current.partIds?.length)setSelected(current.partIds);}
    }).catch((e)=>{if(alive.current)setError(e.message);});
    return()=>{alive.current=false;};
  },[projectId,provider]);
  useEffect(()=>{
    if(!running)return;
    let stopped=false,polling=false;
    const timer=setInterval(async()=>{
      if(polling)return; polling=true;
      try {const value=await provider.get(running.id);if(!stopped)merge(value);}
      catch(e){if(!stopped)setError(e.message);}
      finally{polling=false;}
    },1800);
    return()=>{stopped=true;clearInterval(timer);};
  },[running?.id,provider]);
  const switchKind=(value)=>{setKind(value);setError("");setNotice("");const latest=jobs.find((j)=>j.kind===value);setSelectedJob(latest?.id||"");if(latest?.partIds?.length)setSelected(latest.partIds);};
  const start=async()=>{
    setBusy(true);setError("");setNotice("");
    try{
      if(kind==="parts"&&!selected.length)throw new Error("请至少选择一个模板部件。");
      const request=await prepareGenerationRequest(bundle,{projectId,prompt:ai[promptKey]||"",partIds:kind==="parts"?selected:[],
        appearanceReference:ai.appearance,templateReference:await captureTemplate()});
      const value=await provider.start(request);
      if(alive.current){merge(value);setSelectedJob(value.id);}
    }catch(e){if(alive.current)setError(e.message);}finally{if(alive.current)setBusy(false);}
  };
  const readImages=async(images)=>Promise.all(images.map(async(image)=>({...image,bytes:await provider.image(job.id,image.id)})));
  const useResult=async(images)=>{
    setBusy(true);setError("");
    try{
      const ready=await readImages(images);
      if(job.kind==="appearance"){
        onChange({...ai,appearance:{image:ready[0].bytes,fileName:`${job.id}.png`,prompt:job.prompt,jobId:job.id}});
        setNotice("形象已设为参考，可在「模板部件」中按区域生成。");
      }else await onApply(job,ready);
    }catch(e){setError(e.message);}finally{if(alive.current)setBusy(false);}
  };
  const download=async(image)=>{
    try{
      const bytes=await provider.image(job.id,image.id),url=URL.createObjectURL(new Blob([bytes],{type:"image/png"})),a=document.createElement("a");
      a.href=url;a.download=`${(image.partId||"character").replace(/[^\w\u4e00-\u9fff-]/g,"_")}-ai.png`;a.click();
      setTimeout(()=>URL.revokeObjectURL(url),10000);
    }catch(e){setError(e.message);}
  };
  const visible=bundle.parts.filter((part)=>part.id.toLowerCase().includes(search.toLowerCase()));
  return <div className="modal-backdrop" onMouseDown={(e)=>{if(e.target===e.currentTarget&&!busy)onClose();}}>
    <section className="modal generation-modal" role="dialog" aria-modal="true" aria-labelledby="generation-title">
      <header className="modal-header"><div><h2 id="generation-title"><Sparkles size={17}/> AI 创作</h2><p>{bundle.name} · 形象与部件生成</p></div>
        <button className="icon-button" aria-label="关闭 AI 创作" onClick={onClose} disabled={busy}><X size={18}/></button></header>
      <div className="generation-layout">
        <aside className="generation-form">
          <div className={`generation-connection ${connection?.connected?"connected":""}`} role="status">
            <i/><div><strong>{connection?connection.connected?"Codex 账号已连接":"Codex 暂未连接":"正在检查 Codex…"}</strong><small>{connection?.message||"连接本机生成服务"}</small></div>
            <button className="icon-button" aria-label="刷新 Codex 连接" onClick={()=>void checkConnection()}><RefreshCw size={14}/></button>
          </div>
          <div className="generation-tabs" role="tablist" aria-label="生成类型">
            <button role="tab" aria-selected={kind==="appearance"} onClick={()=>switchKind("appearance")}>角色形象</button>
            <button role="tab" aria-selected={kind==="parts"} onClick={()=>switchKind("parts")}>模板部件</button>
          </div>
          <label className="generation-label" htmlFor="generation-prompt">{kind==="appearance"?"描述角色形象":"描述部件的材质与风格"}</label>
          <textarea id="generation-prompt" rows={4} maxLength={4000} placeholder={kind==="appearance"?"例如：保留模板体型与朝向，改为冰蓝玉石护甲的熊猫武者，深蓝腰带，手绘游戏风格。":"例如：按形象参考改为冰蓝玉石护手，保留原部件轮廓、方向和关节连接位置。"}
            value={ai[promptKey]||""} onChange={(e)=>onChange({...ai,[promptKey]:e.target.value})}/>
          <div className="generation-reference"><div className="generation-reference-heading"><strong>形象参考</strong><button className="button subtle" onClick={()=>upload.current.click()} disabled={busy}><Upload size={13}/>导入形象</button></div>
            <input hidden ref={upload} type="file" accept="image/png,image/jpeg,image/webp" onChange={async(e)=>{
              const file=e.target.files[0];e.target.value="";if(!file)return;
              try{const value=await readReplacement(file);onChange({...ai,appearance:{image:value.image,fileName:file.name,prompt:"导入的形象参考"}});setNotice("形象参考已更新。");}
              catch(err){setError(err.message);}
            }}/>
            {appearanceUrl?<div className="appearance-reference checkerboard"><img src={appearanceUrl} alt="当前角色形象参考"/><button className="icon-button" aria-label="清除形象参考" onClick={()=>onChange({...ai,appearance:null})}><X size={14}/></button></div>:
              <p className="muted small">可先生成角色形象，或导入已有形象作为部件的风格参考。</p>}
          </div>
          {kind==="parts"&&<section className="generation-parts"><div className="generation-reference-heading"><strong>选择模板部件 · {selected.length}</strong>
            <button className="button subtle" onClick={()=>setSelected(selected.length===bundle.parts.length?[]:bundle.parts.map((p)=>p.id))}>{selected.length===bundle.parts.length?"清空":"全选"}</button></div>
            <input aria-label="搜索生成部件" placeholder="搜索部件名称" value={search} onChange={(e)=>setSearch(e.target.value)}/>
            <div className="generation-part-list">{visible.map((part)=><label key={part.id}><input type="checkbox" checked={selected.includes(part.id)} onChange={(e)=>setSelected(e.target.checked?[...selected,part.id]:selected.filter((id)=>id!==part.id))}/><span title={part.id}>{part.id}<small>{part.originalWidth} × {part.originalHeight}</small></span></label>)}</div>
          </section>}
          <p className="muted small generation-hint">{kind==="appearance"?"模板的体型与当前姿势会作为参考。形象用于指导后续部件生成。":"按选定区域逐个生成透明图片，保留原骨架与网格。应用后请检查关节、边缘和遮挡。"}</p>
          <button className="button primary full" onClick={()=>void start()} disabled={busy||!!running||!connection?.connected||!ai[promptKey]?.trim()||(kind==="parts"&&!selected.length)}>
            {busy?<LoaderCircle className="spin" size={16}/>:<Sparkles size={16}/>} {running?"已有生成进行中":kind==="parts"?`生成 ${selected.length} 个部件`:"生成角色形象"}</button>
          {running&&<button className="button full" onClick={async()=>{try{merge(await provider.cancel(running.id));}catch(e){setError(e.message);}}}><Square size={13}/>取消本次生成</button>}
        </aside>
        <div className="generation-results">
          {error&&<div className="error-banner" role="alert">{error}</div>}
          {notice&&<div className="generation-notice" role="status"><Check size={15}/>{notice}</div>}
          <div className="generation-results-heading"><h3>生成记录</h3><span className="muted small">候选确认后进入工作台</span></div>
          {jobs.length>0&&<div className="generation-history" aria-label="生成记录列表">{jobs.map((item)=><button key={item.id} className={job?.id===item.id?"active":""} onClick={()=>{setSelectedJob(item.id);setKind(item.kind);if(item.partIds?.length)setSelected(item.partIds);setNotice("");}}>
            <span>{item.kind==="parts"?"部件":"形象"} · {statusName[item.status]} {item.completed}/{item.total}</span><small>{new Date(item.createdAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</small></button>)}</div>}
          {job?<>
            <div className="generation-job-status" role="status">{active(job)&&<LoaderCircle size={17} className="spin"/>}<strong>{statusName[job.status]}</strong><span>{job.completed} / {job.total}{job.currentPart?` · ${job.currentPart}`:""}</span></div>
            {active(job)&&<progress value={job.completed} max={job.total} aria-label="生图完成进度"/>}
            {job.error&&<div className="error-banner" role="alert">{job.error}</div>}
            <p className="generation-job-prompt">{job.prompt}</p>
            {job.images.length>0?<><div className={`generation-candidates ${job.kind==="appearance"?"portrait":""}`}>{job.images.map((image)=><article className="generation-candidate" key={image.id}>
              <div className="candidate-image checkerboard"><img src={image.url} alt={image.partId?`生成部件 ${image.partId}`:"生成的角色形象"}/></div>
              <strong title={image.partId}>{image.partId||"角色形象"}</strong><small>{image.width} × {image.height} · 透明 PNG</small>
              <div className="button-row"><button className="button primary" disabled={busy} onClick={()=>void useResult([image])}><Check size={14}/>{job.kind==="appearance"?"设为形象参考":"应用并校准"}</button>
                <button className="icon-button framed" aria-label={`下载 ${image.partId||"角色形象"}`} onClick={()=>void download(image)}><Download size={15}/></button></div>
            </article>)}</div>
              {job.kind==="parts"&&job.images.length>1&&<button className="button primary full" disabled={busy} onClick={()=>void useResult(job.images)}><Check size={15}/>应用已完成的 {job.images.length} 个部件</button>}</>:
              <div className="generation-empty"><Sparkles size={35}/><h3>{active(job)?"Codex 正在绘制":"本次没有图片结果"}</h3><p>{active(job)?"可以关闭此窗口继续编辑，稍后从 AI 创作查看结果。":"调整描述后可重新生成。"}</p></div>}
          </>:<div className="generation-empty"><Sparkles size={38}/><h3>从模板开始创造</h3><p>先确定角色形象，再按模板生成部件。<br/>生成结果可继续校准、预览并导出。</p></div>}
        </div>
      </div>
      <footer className="modal-footer"><span className="muted small">生成请求仅在点击生成后发送到 Codex。结果保存在本机。</span><button className="button" onClick={onClose} disabled={busy}>返回工作台</button></footer>
    </section>
  </div>;
}
