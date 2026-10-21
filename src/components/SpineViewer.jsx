import { useEffect, useRef, useState } from "react";
import { Maximize2, ZoomIn, ZoomOut, LoaderCircle } from "lucide-react";
import { usePreviewRuntime } from "./PreviewRuntime.jsx";
import { pickPart } from "../../engine/spine/geometry.js";

export function SpineViewer({
  bundle,
  pages = EMPTY,
  clock,
  animation,
  loop = true,
  skin,
  selected,
  onSelect,
  onReady,
  previewPort,
  label = "动画预览",
  bones = false,
  revision = 0,
}) {
  const runtime = usePreviewRuntime();
  const canvas = useRef(),
    overlay = useRef(),
    scene = useRef(),
    holder = useRef();
  const settings = useRef(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [view, setView] = useState({ zoom: 1, pan: { x: 0, y: 0 } });
  const callbacks = useRef();
  callbacks.current = { onReady, onSelect };
  settings.current = { clock, animation, loop, skin, selected, bones, ...view };
  useEffect(() => {
    if (!previewPort) return;
    const port = { captureThumbnail() {
      if (!scene.current || !canvas.current?.width) return null;
      return canvas.current.toDataURL("image/png");
    } };
    previewPort.current = port;
    return () => { if (previewPort.current === port) previewPort.current = null; };
  }, [previewPort]);
  useEffect(() => {
    if (!bundle) return;
    let cancelled = false,
      frame = 0,
      instance;
    setLoading(true);
    setError("");
    setView({ zoom: 1, pan: { x: 0, y: 0 } });
    runtime.createScene(bundle, canvas.current)
      .then((value) => {
        instance = value;
        if (cancelled) {
          value.dispose();
          return;
        }
        scene.current = value;
        setLoading(false);
        callbacks.current.onReady?.({
          animations: value.data.animations.map((a) => a.name),
          skins: value.data.skins.map((s) => s.name),
          boneCount: value.data.bones.length,
        });
        const render = (timestamp) => {
          if (cancelled) return;
          const current = settings.current;
          try {
            const shapes = value.render({
              ...current,
              time: current.clock.read(timestamp),
            });
            const layer = overlay.current,
              ratio = Math.min(window.devicePixelRatio || 1, 2),
              width = layer.clientWidth,
              height = layer.clientHeight;
            if (
              layer.width !== Math.round(width * ratio) ||
              layer.height !== Math.round(height * ratio)
            ) {
              layer.width = Math.round(width * ratio);
              layer.height = Math.round(height * ratio);
            }
            const ctx = layer.getContext("2d");
            ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
            ctx.clearRect(0, 0, width, height);
            const matches = shapes.filter(
              (shape) => shape.id === current.selected,
            );
            if (matches.length) {
              const points = matches.flatMap((shape) => shape.points);
              const x = Math.min(...points.map((p) => p.x)),
                y = Math.min(...points.map((p) => p.y)),
                right = Math.max(...points.map((p) => p.x)),
                bottom = Math.max(...points.map((p) => p.y));
              ctx.fillStyle = "#29d8a31a";
              ctx.strokeStyle = "#41dfb4";
              ctx.lineWidth = 1.5;
              ctx.fillRect(x, y, right - x, bottom - y);
              ctx.strokeRect(x, y, right - x, bottom - y);
            }
          } catch (e) {
            setError(e.message);
            return;
          }
          frame = requestAnimationFrame(render);
        };
        frame = requestAnimationFrame(render);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      if (scene.current === instance) scene.current = null;
      instance?.dispose();
    };
  }, [bundle, runtime]);
  useEffect(() => {
    if (!bundle) return;
    let cancelled = false;
    // Scene creation may still be decoding the original texture; retry on ready.
    const apply = () => {
      if (cancelled) return;
      if (!scene.current) return;
      scene.current.updatePages(pages).catch((e) => {
        if (!cancelled) setError(e.message);
      });
    };
    apply();
    return () => {
      cancelled = true;
    };
  }, [bundle, pages, revision, loading]);
  const drag = useRef();
  return (
    <div className="spine-viewer" ref={holder} aria-label={label}>
      <canvas
        ref={canvas}
        className="spine-canvas"
        aria-label={`${label} Spine 动画`}
      />
      <canvas
        ref={overlay}
        className="selection-canvas"
        aria-label={`${label} 部件选择`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            pan: view.pan,
            moved: false,
          };
        }}
        onPointerMove={(e) => {
          const start = drag.current;
          if (!start) return;
          const dx = e.clientX - start.x,
            dy = e.clientY - start.y;
          if (Math.abs(dx) + Math.abs(dy) > 5) start.moved = true;
          if (start.moved) {
            // React may apply this update after pointerup/cancel clears the drag.
            const pan = { x: start.pan.x + dx, y: start.pan.y + dy };
            setView((v) => ({ ...v, pan }));
          }
        }}
        onPointerUp={(e) => {
          const start = drag.current;
          drag.current = null;
          if (!start || start.moved || !scene.current) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const part = pickPart(scene.current.shapes, {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
          if (part) callbacks.current.onSelect?.(part);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onWheel={(e) => {
          setView((v) => ({
            ...v,
            zoom: Math.min(
              4,
              Math.max(0.25, v.zoom * (e.deltaY < 0 ? 1.1 : 0.9)),
            ),
          }));
        }}
      />
      {loading && (
        <div className="viewer-message">
          <LoaderCircle className="spin" size={22} />
          正在加载 Spine 资源…
        </div>
      )}
      {error && (
        <div className="viewer-message error" role="alert">
          {error}
        </div>
      )}
      <div className="viewer-tools">
        <button
          className="icon-button"
          aria-label={`${label} 缩小`}
          onClick={() =>
            setView((v) => ({ ...v, zoom: Math.max(0.25, v.zoom / 1.2) }))
          }
        >
          <ZoomOut size={14} />
        </button>
        <span>{Math.round(view.zoom * 100)}%</span>
        <button
          className="icon-button"
          aria-label={`${label} 放大`}
          onClick={() =>
            setView((v) => ({ ...v, zoom: Math.min(4, v.zoom * 1.2) }))
          }
        >
          <ZoomIn size={14} />
        </button>
        <button
          className="icon-button"
          aria-label={`${label} 适配画布`}
          onClick={() => setView({ zoom: 1, pan: { x: 0, y: 0 } })}
        >
          <Maximize2 size={14} />
        </button>
      </div>
    </div>
  );
}
const EMPTY = Object.freeze({});
