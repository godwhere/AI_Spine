import { useEffect, useRef, useState } from "react";
import { X, Sparkles, Upload, RefreshCw, Check, LoaderCircle, Download, Square } from "lucide-react";
import { CreationWorkflow } from "./CreationWorkflow.jsx";
import { assertTemplateCandidateProject } from "../../../shared/domain/generation.mjs";

const active = (job) => ["queued","connecting","generating","validating"].includes(job?.status);
const statusName = { queued:"等待生成",connecting:"连接 AI",generating:"正在生成",validating:"检查图片",completed:"已完成",failed:"生成失败",cancelled:"已取消" };
function useImage(bytes) {
  const [url,setUrl]=useState("");
  useEffect(()=>{
    if (!bytes) {setUrl("");return;}
    const next=URL.createObjectURL(new Blob([bytes],{type:"image/png"}));setUrl(next);
    return ()=>URL.revokeObjectURL(next);
  },[bytes]);
  return url;
}
export function GenerationPanel({ provider, prepareGenerationRequest, readReplacement, bundle, projectId, selectedPart, currentAnimation, ai, onChange, onApply, captureTemplate, onClose, onConfigure, initialKind = "appearance", replaced = 0, onStep }) {
  const [kind,setKind]=useState(initialKind),[connection,setConnection]=useState(null),[jobs,setJobs]=useState([]),
    [selectedJob,setSelectedJob]=useState(""),[selected,setSelected]=useState([selectedPart].filter(Boolean)),
    [search,setSearch]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState(""),[concurrency,setConcurrency]=useState(3),
    [applicationMode,setApplicationMode]=useState("character"),[variantName,setVariantName]=useState(""),[applicationAnimations,setApplicationAnimations]=useState([]);
  const upload=useRef(), alive=useRef(true), context=useRef();
  context.current={projectId,bundle};
  const appearanceUrl=useImage(ai.appearance?.image);
  const job=jobs.find((j)=>j.id===selectedJob), running=jobs.find(active), promptKey=kind==="parts"?"partsPrompt":"appearancePrompt";
  const checkConnection=async()=>{
    try {setConnection(await provider.status());} catch(e){setConnection({connected:false,message:e.message});}
  };
  const merge=(value)=>setJobs((all)=>[value,...all.filter((j)=>j.id!==value.id)].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));
  useEffect(()=>{
    let stopped=false;
    alive.current=true;
    void checkConnection();
    provider.list(projectId).then((values)=>{
      if (stopped || !alive.current)return;
      setJobs(values); const current=values.find(active)||values.find((value)=>value.kind===initialKind);
      if(current){setSelectedJob(current.id);setKind(current.kind);if(active(current))setConcurrency(current.concurrency||1);if(current.kind==="parts"&&current.partIds?.length)setSelected(current.partIds);}
    }).catch((e)=>{if(!stopped&&alive.current)setError(e.message);});
    return()=>{stopped=true;alive.current=false;};
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
  const continueToParts=()=>{
    if (!ai.partsPrompt?.trim()) onChange({...ai,partsPrompt:ai.appearancePrompt?.trim()||"按当前角色形象参考重绘所选模板部件，统一角色身份、颜色、材质与光照，保留每个原部件的轮廓、朝向、接缝、关节位置和透明留白。"});
    switchKind("parts");setSelected(bundle.parts.map((part)=>part.id));
  };
  const retry=async()=>{
    setBusy(true);setError("");setNotice("");
    try{const value=await provider.retry(job.id,concurrency);if(alive.current){merge(value);setSelectedJob(value.id);setKind(value.kind);setSelected(value.partIds);}}
    catch(e){if(alive.current)setError(e.message);}finally{if(alive.current)setBusy(false);}
  };
  const start=async()=>{
    setBusy(true);setError("");setNotice("");
    try{
      if(kind==="parts"&&!selected.length)throw new Error("请至少选择一个模板部件。");
      const request=await prepareGenerationRequest(bundle,{projectId,prompt:ai[promptKey]||"",partIds:kind==="parts"?selected:[],concurrency,
        appearanceReference:ai.appearance,templateReference:await captureTemplate()});
      const value=await provider.start(request);
      if(alive.current){merge(value);setSelectedJob(value.id);}
    }catch(e){if(alive.current)setError(e.message);}finally{if(alive.current)setBusy(false);}
  };
  const changeApplicationMode=(value)=>{
    setApplicationMode(value);setError("");
    if(value==="character"){setVariantName("");setApplicationAnimations([]);}
    else if(value==="animations"&&!applicationAnimations.length&&bundle.animations.includes(currentAnimation))setApplicationAnimations([currentAnimation]);
  };
  const applicationTarget=(images)=>{
    assertTemplateCandidateProject(projectId,job);
    if(job?.kind!=="parts")return undefined;
    if(!images.length)throw new Error("没有可应用的部件图片。");
    const used=new Set();
    for(const image of images){
      if(!job.images.some((candidate)=>candidate.id===image.id&&candidate.partId===image.partId)||
        !job.partIds?.includes(image.partId)||!bundle.parts.some((part)=>part.id===image.partId)||used.has(image.partId))throw new Error("候选与生成任务的部件映射不匹配，未应用。");
      used.add(image.partId);
    }
    if(applicationMode==="character")return undefined;
    if(applicationMode!=="animations")throw new Error("请选择有效的候选应用范围。");
    if(!variantName.trim()||variantName.trim().length>80)throw new Error("请填写 1–80 字的变体名称。");
    if(!applicationAnimations.length||new Set(applicationAnimations).size!==applicationAnimations.length||applicationAnimations.some((id)=>!bundle.animations.includes(id)))throw new Error("请至少选择一个当前模板中的有效动作。");
    if(images.length!==1)throw new Error("指定动作时请逐次应用一张候选图片。");
    return {name:variantName.trim(),animations:[...applicationAnimations]};
  };
  const applicationError=(images)=>{try{applicationTarget(images);return "";}catch(e){return e.message;}};
  const readImages=async(images)=>Promise.all(images.map(async(image)=>({...image,bytes:await provider.image(job.id,image.id)})));
  const useResult=async(images)=>{
    setBusy(true);setError("");
    try{
      const scope=applicationTarget(images);
      const ready=await readImages(images);
      if(!alive.current||context.current.projectId!==projectId||context.current.bundle!==bundle)throw new Error("资源已改变，候选未应用。请重新选择当前资源的候选。");
      if(job.kind==="appearance"){
        onChange({...ai,appearance:{image:ready[0].bytes,fileName:`${job.id}.png`,prompt:job.prompt,jobId:job.id}});
        setNotice("形象已设为参考，可在「模板部件」中按区域生成。");
      }else if(scope)await onApply(job,ready,scope);
      else await onApply(job,ready);
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
      <CreationWorkflow hasAppearance={!!appearanceUrl} replaced={replaced} total={bundle.parts.length} animations={bundle.animations.length} active={kind==="appearance"?0:1} disabled={busy}
        onStep={(step)=>step<2?switchKind(step===0?"appearance":"parts"):onStep(step)}/>
      <div className="generation-layout">
        <aside className="generation-form">
          <div className={`generation-connection ${connection?.connected?"connected":""}`} role="status">
            <i/><div><strong>{connection?connection.connected?`${connection.label || "AI"}已连接`:"AI 暂未连接":"正在检查 AI…"}</strong><small>{connection?.message||"连接本机生成服务"}</small></div>
            <button className="button subtle" onClick={onConfigure}>设置</button>
            <button className="icon-button" aria-label="刷新 AI 连接" onClick={()=>void checkConnection()}><RefreshCw size={14}/></button>
          </div>
          <div className="generation-form-scroll">
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
            {appearanceUrl&&kind==="appearance"&&<button className="button full workflow-next" disabled={busy} onClick={continueToParts}>使用此形象 → 制作全部 {bundle.parts.length} 个部件</button>}
          </div>
          {kind==="parts"&&<section className="generation-parts"><div className="generation-reference-heading"><strong>选择模板部件 · {selected.length}</strong>
            <button className="button subtle" onClick={()=>setSelected(selected.length===bundle.parts.length?[]:bundle.parts.map((p)=>p.id))}>{selected.length===bundle.parts.length?"清空":"全选"}</button></div>
            <input aria-label="搜索生成部件" placeholder="搜索部件名称" value={search} onChange={(e)=>setSearch(e.target.value)}/>
            <div className="generation-part-list">{visible.map((part)=><label key={part.id}><input type="checkbox" checked={selected.includes(part.id)} onChange={(e)=>setSelected(e.target.checked?[...selected,part.id]:selected.filter((id)=>id!==part.id))}/><span title={part.id}>{part.id}<small>{part.originalWidth} × {part.originalHeight}</small></span></label>)}</div>
          </section>}
          <p className="muted small generation-hint">{kind==="appearance"?"模板的体型与当前姿势会作为参考。形象用于指导后续部件生成。":"每个区域独立生成透明图片，可同时绘制多个部件。应用后请检查关节、边缘和遮挡。"}</p>
          </div>
          {kind==="parts"&&<label className="generation-concurrency">同时生成<select aria-label="同时生成数量" value={concurrency} disabled={busy||!!running} onChange={(e)=>setConcurrency(Number(e.target.value))}>
            {[1,2,3,4].map((value)=><option key={value} value={value}>{value===1?"1 张（依次）":`${value} 张`}</option>)}
          </select></label>}
          <button className="button primary full" onClick={()=>void start()} disabled={busy||!!running||!connection?.connected||!ai[promptKey]?.trim()||(kind==="parts"&&!selected.length)}>
            {busy?<LoaderCircle className="spin" size={16}/>:<Sparkles size={16}/>} {running?"已有生成进行中":kind==="parts"?`生成 ${selected.length} 个部件`:"生成角色形象"}</button>
          {running&&<button className="button full" onClick={async()=>{try{merge(await provider.cancel(running.id));}catch(e){setError(e.message);}}}><Square size={13}/>取消本次生成</button>}
        </aside>
        <div className="generation-results">
          {error&&<div className="error-banner" role="alert">{error}</div>}
          {notice&&<div className="generation-notice" role="status"><Check size={15}/>{notice}</div>}
          <div className="generation-results-heading"><h3>生成记录</h3><span className="muted small">候选确认后进入工作台</span></div>
          {kind==="parts"&&<section className="generation-application-scope" aria-label="候选应用设置">
            <label className="generation-application-heading">候选应用范围<select aria-label="候选应用范围" value={applicationMode} disabled={busy} onChange={(e)=>changeApplicationMode(e.target.value)}>
              <option value="character">全部动作</option><option value="animations">指定动作</option>
            </select></label>
            {applicationMode==="animations"&&<><label>变体名称<input aria-label="变体名称" maxLength={80} value={variantName} disabled={busy} placeholder="例如：受击痛苦表情" onChange={(e)=>setVariantName(e.target.value)}/></label>
              <fieldset className="generation-application-animations"><legend>用于动作</legend>{bundle.animations.map((id)=><label key={id}><input type="checkbox" aria-label={`用于动作 ${id}`} checked={applicationAnimations.includes(id)} disabled={busy} onChange={(e)=>setApplicationAnimations(e.target.checked?[...new Set([...applicationAnimations,id])]:applicationAnimations.filter((value)=>value!==id))}/>{id}</label>)}</fieldset>
              <p className="muted small">已指定 {applicationAnimations.length} 个动作；一次应用一张候选，其他动作继续使用原部件。</p>
              {job?.kind==="parts"&&job.images.length>0&&applicationError([job.images[0]])&&<p className="muted small generation-application-hint" role="status">{applicationError([job.images[0]])}</p>}
            </>}
          </section>}
          {jobs.length>0&&<div className="generation-history" aria-label="生成记录列表">{jobs.map((item)=><button key={item.id} className={job?.id===item.id?"active":""} onClick={()=>{setSelectedJob(item.id);setKind(item.kind);if(item.partIds?.length)setSelected(item.partIds);setNotice("");}}>
            <span>{item.kind==="parts"?"部件":"形象"} · {statusName[item.status]} {item.completed}/{item.total}</span><small>{item.provider?.label || "Codex 账号"} · {new Date(item.createdAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</small></button>)}</div>}
          {job?<>
            <div className="generation-job-status" role="status">{active(job)&&<LoaderCircle size={17} className="spin"/>}<strong>{statusName[job.status]}</strong><span>{job.completed} / {job.total}{job.kind==="parts"?` · 同时 ${job.concurrency||1} 张`:""}</span></div>
            {!!job.currentParts?.length&&<p className="generation-active-parts">正在绘制：{job.currentParts.join("、")}</p>}
            {active(job)&&<progress value={job.completed} max={job.total} aria-label="生图完成进度"/>}
            {job.error&&<div className="error-banner" role="alert">{job.error}</div>}
            {["failed","cancelled"].includes(job.status)&&job.completed<job.total&&<button className="button" disabled={busy||!!running||!connection?.connected} onClick={()=>void retry()}><RefreshCw size={14}/>{job.kind==="parts"?`继续生成剩余 ${job.total-job.completed} 个部件`:"重新生成角色形象"}</button>}
            <p className="generation-job-prompt">{job.prompt}</p>
            {job.images.length>0?<><div className={`generation-candidates ${job.kind==="appearance"?"portrait":""}`}>{job.images.map((image)=><article className="generation-candidate" key={image.id}>
              <div className="candidate-image checkerboard"><img src={image.url} alt={image.partId?`生成部件 ${image.partId}`:"生成的角色形象"}/></div>
              <strong title={image.partId}>{image.partId||"角色形象"}</strong><small>{image.width} × {image.height} · 透明 PNG</small>
              <div className="button-row"><button className="button primary" disabled={busy||!!applicationError([image])} onClick={()=>void useResult([image])}><Check size={14}/>{job.kind==="appearance"?"设为形象参考":applicationMode==="animations"?`应用到指定 ${applicationAnimations.length} 个动作`:"应用并校准"}</button>
                <button className="icon-button framed" aria-label={`下载 ${image.partId||"角色形象"}`} onClick={()=>void download(image)}><Download size={15}/></button></div>
            </article>)}</div>
              {job.kind==="parts"&&job.images.length>1&&<button className="button primary full" disabled={busy||!!applicationError(job.images)} onClick={()=>void useResult(job.images)}><Check size={15}/>{applicationMode==="animations"?`应用 ${job.images.length} 个部件到指定 ${applicationAnimations.length} 个动作`:`应用已完成的 ${job.images.length} 个部件`}</button>}</>:
              <div className="generation-empty"><Sparkles size={35}/><h3>{active(job)?"AI 正在绘制":"本次没有图片结果"}</h3><p>{active(job)?"可以关闭此窗口继续编辑，稍后从 AI 创作查看结果。":"调整描述后可重新生成。"}</p></div>}
          </>:<div className="generation-empty"><Sparkles size={38}/><h3>从模板开始创造</h3><p>先确定角色形象，再按模板生成部件。<br/>生成结果可继续校准、预览并导出。</p></div>}
        </div>
      </div>
      <footer className="modal-footer"><span className="muted small">点击生成后才会发送至所选 AI 服务。结果保存在本机。</span><button className="button" onClick={onClose} disabled={busy}>返回工作台</button></footer>
    </section>
  </div>;
}
