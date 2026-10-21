import { ArrowLeft, LoaderCircle, CheckCircle2, Bone, Move, Sparkles, Save, Download, Pause, Play, RotateCcw, Layers, Replace, SlidersHorizontal, Undo2, Redo2, Search, Check } from "lucide-react";
import { hasRigAuthoring, rigAuthoringSummary } from "../../../shared/domain/rig-summary.mjs";
import { SpineViewer } from "../../components/SpineViewer.jsx";
// Presentation of the shared editor session. Commands and persistence are injected.
export function EditorView({ session, view, commands, Workflow }) {
  const { bundle, name: projectName, project, edits, generation } = session.value;
  const editorState = session;
  const { saving, saveState, processing, resourceBusy, selectedPart, animation, playing, speed, clock, skin, previewMode, showBones, showParts, part, replacementInput, templateComparison, changeCount, compiled, editorPreviewPort, partSearch, visibleParts, time, duration } = view;
  const { leaveEditor, setProjectName, editResourceRig, openCreationStep, persist, saveAsNewResource, setModal, changeAnimation, togglePlay, setSpeed, setTime, setSkin, setPreviewMode, setShowBones, setShowParts, setSelectedPart, partLabel, setEditing, updateEdits, notify, undo, redo, setPartSearch } = commands;
  return <main className="editor-main" key={bundle?.id}>
          <div className="project-toolbar">
            <button
              className="button subtle"
              onClick={() => void leaveEditor()}
              disabled={saving}
            >
              <ArrowLeft size={16} />
              返回首页
            </button>
            <input
              className="project-name-input"
              aria-label="资源名称"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
            />
            <span
              className={`save-indicator ${saveState.includes("失败") ? "error" : ""}`}
            >
              {saving ? (
                <LoaderCircle className="spin" size={13} />
              ) : (
                <CheckCircle2 size={13} />
              )}
              {saving ? "正在保存…" : saveState}
            </span>
            <div className="toolbar-spacer" />
            {hasRigAuthoring(bundle?.files) && <button className="button" disabled={processing || resourceBusy} onClick={() => void editResourceRig({ ...project, name: projectName, files: bundle.files, skeletonPath: bundle.skeletonPath, edits, generation })}><Bone size={16} />骨架与动作</button>}
            {hasRigAuthoring(bundle?.files) && <button className="button" disabled={processing || resourceBusy} onClick={() => void editResourceRig({ ...project, name: projectName, files: bundle.files, skeletonPath: bundle.skeletonPath, edits, generation }, { manualAdjustment: true, selectedPartId: selectedPart })}><Move size={16} />手动调整</button>}
            <button className="button accent" onClick={() => openCreationStep(generation.appearance ? 1 : 0)}>
              <Sparkles size={16} /> AI 创作
            </button>
            <button
              className="button"
              onClick={() => void persist(true).catch(() => {})}
              disabled={saving}
            >
              <Save size={15} />
              保存
            </button>
            {saveState === "保存失败" && <button className="button" onClick={() => void saveAsNewResource()}>另存为新资源</button>}
            <button
              className="button primary"
              onClick={() => setModal("export")}
              disabled={processing}
            >
              <Download size={16} />
              导出
            </button>
          </div>
          <Workflow hasAppearance={!!generation.appearance?.image} replaced={bundle.parts.filter((part)=>edits[part.id]).length}
            total={bundle.parts.length} animations={bundle.animations.length} active={2} onStep={openCreationStep} disabled={processing} authored={hasRigAuthoring(bundle.files)} rigSummary={rigAuthoringSummary(bundle.files)}/>
          <section className="panel calibration-panel">
            <div className="animation-toolbar">
              <label>
                动作{" "}
                <select
                  aria-label="校准动作"
                  value={animation}
                  onChange={(e) => changeAnimation(e.target.value)}
                >
                  {bundle?.animations.map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
              <button
                className="icon-button framed"
                aria-label={playing ? "暂停动画" : "播放动画"}
                onClick={togglePlay}
              >
                {playing ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <label className="speed-control">
                两侧同步{" "}
                <select
                  aria-label="播放速度"
                  value={speed}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    setSpeed(value);
                    clock.current.set({ speed: value });
                  }}
                >
                  {[0.25, 0.5, 1, 1.5, 2].map((value) => (
                    <option key={value} value={value}>
                      {value * 100}%
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button subtle"
                onClick={() => {
                  clock.current.seek(0);
                  setTime(0);
                }}
              >
                <RotateCcw size={14} />
                复位
              </button>
              {bundle?.skins.length > 1 && (
                <label>
                  皮肤{" "}
                  <select
                    aria-label="预览皮肤"
                    value={skin}
                    onChange={(e) => setSkin(e.target.value)}
                  >
                    {bundle.skins.map((name) => (
                      <option key={name}>{name}</option>
                    ))}
                  </select>
                </label>
              )}
              <div className="toolbar-spacer" />
              <button className="button subtle"
                onClick={() => setPreviewMode(previewMode === "resource" ? "compare" : "resource")}><Layers size={16} />{previewMode === "resource" ? "模板对照" : "放大资源"}</button>
              <button
                className={`button subtle ${showBones ? "active" : ""}`}
                onClick={() => setShowBones(!showBones)}
                aria-pressed={showBones}
              >
                <Bone size={15} />
                骨骼
              </button>
              <button
                className={`button subtle ${showParts ? "active" : ""}`}
                onClick={() => setShowParts(!showParts)}
                aria-pressed={showParts}
              >
                <Layers size={15} />
                部件列表
              </button>
            </div>
            <div className="part-toolbar">
              <label>
                当前部件{" "}
                <select
                  aria-label="选择部件"
                  value={selectedPart}
                  onChange={(e) => setSelectedPart(e.target.value)}
                >
                  {bundle?.parts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {edits[p.id] ? "● " : ""}
                      {partLabel(p)}
                    </option>
                  ))}
                </select>
              </label>
              <span className="part-dimensions">
                {part?.originalWidth} × {part?.originalHeight}
              </span>
              <button
                className="button accent"
                disabled={!part}
                onClick={() => replacementInput.current.click()}
              >
                <Replace size={15} />
                替换图片
              </button>
              <button
                className="button"
                disabled={!part}
                onClick={() => setEditing(true)}
              >
                <SlidersHorizontal size={15} />
                调整细节
              </button>
              <button
                className="button subtle"
                disabled={!edits[selectedPart]}
                onClick={() => {
                  const next = { ...edits };
                  delete next[selectedPart];
                  updateEdits(next);
                  notify("当前部件已恢复模板图片。");
                }}
              >
                <RotateCcw size={14} />
                恢复模板
              </button>
              <div className="toolbar-spacer" />
              <button
                className="icon-button"
                aria-label="撤销修改"
                disabled={!editorState.canUndo}
                onClick={undo}
              >
                <Undo2 size={17} />
              </button>
              <button
                className="icon-button"
                aria-label="重做修改"
                disabled={!editorState.canRedo}
                onClick={redo}
              >
                <Redo2 size={17} />
              </button>
            </div>
            <div
              className={`comparison-layout ${showParts ? "with-parts" : ""} ${previewMode === "resource" ? "resource-focus" : ""}`}
            >
              {previewMode === "compare" && <div className="comparison-view">
                <div className="viewer-heading">
                  <span>模板动画</span>
                  <small>
                    {templateComparison.bundle?.boneCount} 根骨骼 · {templateComparison.bundle?.parts.length}{" "}
                    个纹理区域
                  </small>
                </div>
                {templateComparison.error && <p className="error-banner" role="alert">{templateComparison.error}</p>}
                {templateComparison.bundle && (
                  <SpineViewer
                    bundle={templateComparison.bundle}
                    clock={clock.current}
                    animation={animation}
                    skin={skin}
                    selected={selectedPart}
                    onSelect={setSelectedPart}
                    label="模板动画"
                    bones={showBones}
                  />
                )}
              </div>}
              <div className="comparison-view" data-preview="edited">
                <div className="viewer-heading">
                  <span>当前资源动画</span>
                  <small className={processing ? "accent-text" : ""}>
                    {processing
                      ? "正在更新贴图…"
                      : `${changeCount} 个部件已修改`}
                  </small>
                </div>
                {bundle && (
                  <SpineViewer
                    bundle={bundle}
                    pages={compiled}
                    clock={clock.current}
                    animation={animation}
                    skin={skin}
                    selected={selectedPart}
                    onSelect={setSelectedPart}
                    label="当前资源动画"
                    previewPort={editorPreviewPort}
                    bones={showBones}
                  />
                )}
              </div>
              {showParts && (
                <aside className="parts-sidebar">
                  <div className="parts-search">
                    <Search size={15} />
                    <input
                      aria-label="搜索部件"
                      placeholder="搜索部件"
                      value={partSearch}
                      onChange={(e) => setPartSearch(e.target.value)}
                    />
                  </div>
                  <div className="parts-list">
                    {visibleParts.map((p) => (
                      <button
                        key={p.id}
                        className={`part-list-item ${p.id === selectedPart ? "selected" : ""}`}
                        onClick={() => setSelectedPart(p.id)}
                      >
                        <span>
                          {partLabel(p)}
                          <small>
                            {p.width} × {p.height}
                          </small>
                        </span>
                        {edits[p.id] && <Check size={14} />}
                      </button>
                    ))}
                  </div>
                </aside>
              )}
            </div>
            <div className="timeline">
              <span>{(time % duration).toFixed(2)}s</span>
              <input
                aria-label="动画进度"
                type="range"
                min="0"
                max={duration}
                step=".01"
                value={Math.min(duration, time % duration)}
                onChange={(e) => {
                  clock.current.seek(Number(e.target.value));
                  setTime(Number(e.target.value));
                }}
              />
              <span>{duration.toFixed(2)}s</span>
            </div>
          </section>
          <div className="editor-footnote">
            <span>
              单击角色选择部件 · 拖动平移 · 滚轮缩放 · 空格播放 / 暂停
            </span>
            <span>输出保留原骨架、网格、皮肤和动作</span>
          </div>
        </main>;
}
