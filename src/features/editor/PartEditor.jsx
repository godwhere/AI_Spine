import { useEffect, useRef, useState } from "react";
import {
  X,
  Upload,
  FlipHorizontal2,
  FlipVertical2,
  RotateCcw,
  Undo2,
  Redo2,
  WandSparkles,
  Check,
  Move,
  Image,
  LoaderCircle,
} from "lucide-react";
import { createCalibrationSession } from "../../application/part-calibration.js";

export function PartEditor({ calibration, bundle, part, edit, onApply, onClose, externalError = "", displayName, referenceLabel = "模板参考", instruction = "" }) {
  const sessionRef = useRef(null);
  if (!sessionRef.current) sessionRef.current = createCalibrationSession(edit);
  const session = sessionRef.current;
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [state, setState] = useState(() => session.getSnapshot());
  const { draft } = state;
  useEffect(() => session.subscribe(setState), [session]);
  const { identityTransform, drawReplacement, partClipping } = calibration;
  const [reference, setReference] = useState(null),
    [image, setImage] = useState(null);
  const [ghost, setGhost] = useState(40),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [linked, setLinked] = useState(true);
  const canvas = useRef(),
    input = useRef(),
    stage = useRef(),
    drag = useRef();
  const [historyTick, setHistoryTick] = useState(0);
  useEffect(() => {
    const observer = new ResizeObserver(() => setHistoryTick((v) => v + 1));
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let cancelled = false;
    calibration.prepare(bundle, part)
      .then(async (prepared) => {
        if (cancelled) return;
        setReference(prepared.reference);
        if (!edit) {
          const value = await prepared.createDraft();
          if (!cancelled) session.initialize(value);
        }
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => {
      cancelled = true;
    };
  }, [bundle, part, edit]);
  useEffect(() => {
    if (!draft) return;
    let cancelled = false,
      loaded;
    calibration
      .loadImage(draft.image)
      .then((value) => {
        loaded = value;
        if (cancelled) value.close();
        else setImage({ bitmap: value, source: draft.image });
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => {
      cancelled = true;
      loaded?.close();
    };
  }, [draft?.image]);
  const { remember, undo, redo } = session;
  const change = (values, saveHistory = true) => session.patch(values, saveHistory);
  useEffect(() => {
    if (!reference || !image || !draft || image.source !== draft.image) return;
    const target = canvas.current,
      width = target.clientWidth,
      height = target.clientHeight,
      ratio = Math.min(devicePixelRatio || 1, 2);
    target.width = Math.round(width * ratio);
    target.height = Math.round(height * ratio);
    const ctx = target.getContext("2d"),
      scale = Math.min(
        (width - 72) / part.originalWidth,
        (height - 72) / part.originalHeight,
      ),
      x = (width - part.originalWidth * scale) / 2,
      y = (height - part.originalHeight * scale) / 2;
    stage.current = { scale, x, y };
    ctx.scale(ratio, ratio);
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.globalAlpha = ghost / 100;
    ctx.drawImage(reference, 0, 0);
    ctx.globalAlpha = 1;
    drawReplacement(ctx, image.bitmap, part, draft.transform);
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = "#5a7186";
    ctx.setLineDash([5 / scale, 4 / scale]);
    ctx.strokeRect(
      part.offsetX,
      part.originalHeight - part.offsetY - part.height,
      part.width,
      part.height,
    );
    ctx.setLineDash([]);
    ctx.strokeStyle = "#39d7a6";
    ctx.strokeRect(0, 0, part.originalWidth, part.originalHeight);
    const cx = part.originalWidth / 2,
      cy = part.originalHeight / 2;
    ctx.beginPath();
    ctx.moveTo(cx - 8 / scale, cy);
    ctx.lineTo(cx + 8 / scale, cy);
    ctx.moveTo(cx, cy - 8 / scale);
    ctx.lineTo(cx, cy + 8 / scale);
    ctx.stroke();
  }, [reference, image, draft, ghost, part, historyTick]);
  useEffect(() => {
    const handle = (e) => {
      if (e.key === "Escape") onClose();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  });
  const replace = async (file) => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const replacement = await calibration.readReplacement(file);
      if (active.current) session.replace(replacement);
    } catch (e) {
      if (active.current) setError(`图片无法读取：${e.message}`);
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const fit = async () => {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const snapshot = session.getSnapshot().draft;
      const transform = await calibration.fit(bundle, part, snapshot.image);
      if (active.current && session.getSnapshot().draft === snapshot) change(transform);
    } catch (e) {
      if (active.current) setError(e.message);
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const numeric = (label, key, min, max, step = 1, percent = false) => (
    <label className="number-field">
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number(
          (
            (draft?.transform[key] ?? (percent ? 1 : 0)) * (percent ? 100 : 1)
          ).toFixed(2),
        )}
        onChange={(e) => {
          const raw = Number(e.target.value);
          if (!Number.isFinite(raw)) return;
          const value = Math.max(min, Math.min(max, raw)) / (percent ? 100 : 1),
            values = { [key]: value };
          if (percent && linked) {
            values.scaleX = value;
            values.scaleY = value;
          }
          change(values);
        }}
      />
    </label>
  );
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="part-editor-title"
        className="modal part-editor"
      >
        <header className="modal-header">
          <div>
            <h2 id="part-editor-title">调整细节</h2>
            <p>{displayName || part.name || part.id}</p>
            {instruction && <p className="rig-hint">{instruction}</p>}
          </div>
          <button
            className="icon-button"
            aria-label="关闭调整细节"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="editor-modal-body">
          <div className="calibration-area">
            <div className="calibration-top">
              <span>
                <Move size={14} /> 拖动部件调整位置
              </span>
              <label>
                {referenceLabel}{" "}
                <input
                  aria-label={`${referenceLabel}透明度`}
                  type="range"
                  min="0"
                  max="100"
                  value={ghost}
                  onChange={(e) => setGhost(Number(e.target.value))}
                />{" "}
                {ghost}%
              </label>
            </div>
            <canvas
              ref={canvas}
              className="calibration-canvas checkerboard"
              aria-label="部件校准画布"
              data-testid="calibration-canvas"
              tabIndex={0}
              onPointerDown={(e) => {
                if (!draft || !stage.current) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                remember();
                drag.current = {
                  x: e.clientX,
                  y: e.clientY,
                  transform: draft.transform,
                };
              }}
              onPointerMove={(e) => {
                if (!drag.current) return;
                const start = drag.current;
                change(
                  {
                    x:
                      start.transform.x +
                      (e.clientX - start.x) / stage.current.scale,
                    y:
                      start.transform.y +
                      (e.clientY - start.y) / stage.current.scale,
                  },
                  false,
                );
              }}
              onPointerUp={() => {
                drag.current = null;
              }}
              onPointerCancel={() => {
                drag.current = null;
              }}
              onKeyDown={(e) => {
                const moves = {
                  ArrowLeft: [-1, 0],
                  ArrowRight: [1, 0],
                  ArrowUp: [0, -1],
                  ArrowDown: [0, 1],
                };
                if (moves[e.key] && draft) {
                  e.preventDefault();
                  const [dx, dy] = moves[e.key],
                    step = e.shiftKey ? 10 : 1;
                  change({
                    x: draft.transform.x + dx * step,
                    y: draft.transform.y + dy * step,
                  });
                }
              }}
            />
            <p className="canvas-caption">
              绿色框：原始画布 · 虚线框：实际输出范围 · 方向键微调，Shift 加速
            </p>
          </div>
          <aside className="calibration-controls">
            <div className="control-section">
              <h3>部件图片</h3>
              <p className="muted">
                {part.originalWidth} × {part.originalHeight} ·{" "}
                {part.degrees ? "Atlas 旋转区域" : "Atlas 普通区域"}
              </p>
              <button
                className="button full"
                onClick={() => input.current.click()}
                disabled={busy}
              >
                <Upload size={15} />
                替换图片
              </button>
              <input
                ref={input}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={(e) => {
                  void replace(e.target.files[0]);
                  e.target.value = "";
                }}
              />
              {draft && (
                <p className="file-name">
                  <Image size={13} />
                  {draft.fileName}
                </p>
              )}
            </div>
            <div className="control-section">
              <h3>变换</h3>
              <div className="field-grid">
                {numeric("水平位置", "x", -16384, 16384, 0.5)}
                {numeric("垂直位置", "y", -16384, 16384, 0.5)}
                {numeric("水平缩放 %", "scaleX", 1, 1000, 1, true)}
                {numeric("垂直缩放 %", "scaleY", 1, 1000, 1, true)}
                {numeric("旋转角度 °", "rotation", -360, 360, 0.5)}
              </div>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={linked}
                  onChange={(e) => setLinked(e.target.checked)}
                />
                锁定缩放比例
              </label>
              <div className="button-row">
                <button
                  className={`button ${draft?.transform.flipX ? "active" : ""}`}
                  onClick={() => change({ flipX: !draft?.transform.flipX })}
                >
                  <FlipHorizontal2 size={15} />
                  水平镜像
                </button>
                <button
                  className={`button ${draft?.transform.flipY ? "active" : ""}`}
                  onClick={() => change({ flipY: !draft?.transform.flipY })}
                >
                  <FlipVertical2 size={15} />
                  垂直镜像
                </button>
              </div>
            </div>
            <div className="control-section">
              <button
                className="button full accent"
                onClick={fit}
                disabled={busy || !draft || part.nativePixels}
              >
                {busy ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <WandSparkles size={15} />
                )}
                按模板轮廓适配
              </button>
              <p className="muted small">
                按透明轮廓的大小和中心对齐，完成后检查关节与持握位置。
              </p>
              <div className="button-row">
                <button
                  className="button"
                  onClick={() => change(identityTransform())}
                >
                  <RotateCcw size={14} />
                  重置变换
                </button>
                <button
                  className="icon-button"
                  aria-label="撤销校准"
                  disabled={!state.canUndo}
                  onClick={undo}
                >
                  <Undo2 size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label="重做校准"
                  disabled={!state.canRedo}
                  onClick={redo}
                >
                  <Redo2 size={16} />
                </button>
              </div>
            </div>
            {draft && partClipping(part, draft.transform) && (
              <p className="notice">
                素材可能超出原区域。输出保留模板的裁切范围和网格，请在动画中检查边缘。
              </p>
            )}
            {(error || externalError) && (
              <p className="error" role="alert">
                {error || externalError}
              </p>
            )}
          </aside>
        </div>
        <footer className="modal-footer">
          <span className="muted">
            校准同一纹理区域，会同步影响引用它的附件。
          </span>
          <div className="button-row">
            <button className="button" onClick={onClose}>
              取消
            </button>
            <button
              className="button primary"
              disabled={!draft || busy}
              onClick={() => onApply(draft)}
            >
              <Check size={16} />
              完成调整
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
