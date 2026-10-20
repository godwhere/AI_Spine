import { useEffect, useRef, useState } from "react";
import { rigDefaultVisiblePartIds } from "../core/rig-client.js";

export function RigCanvas({ document, selectedJoint, selectedPart, selectedVertex, mesh, pose, visiblePartIds, registration = null, partAnnotation = null, selectedPolygonVertex = 0, showParts = true, showImage = true, disabled = false, editingTool = "joints", onSelectJoint, onMoveJoint, onBeginMove, onSelectPart, onSelectVertex, onSelectPolygonVertex, onBeginPolygonMove, onMovePolygonVertex, onMovePart, onBeginPartMove, onEndPartMove, onCancelPartMove }) {
  const svg = useRef(), drag = useRef(), contourDrag = useRef(), partDrag = useRef();
  const [partPreview, setPartPreview] = useState(null);
  const adjustingParts = editingTool === "parts" && !pose && !registration;
  const canMoveParts = adjustingParts && !disabled && showParts && typeof onMovePart === "function";
  const displayedJoints = pose?.joints || Object.fromEntries(document.joints.map((joint) => [joint.id, joint]));
  const part = document.parts.find((item) => item.id === selectedPart);
  const previewPart = partPreview?.id === part?.id ? { ...part, x: partPreview.x, y: partPreview.y } : part;
  const visible = new Set(pose?.visiblePartIds || visiblePartIds || rigDefaultVisiblePartIds(document));
  const onlySelected = Boolean(registration?.onlySelected), shownParts = document.parts.filter((item) => visible.has(item.id) && (!onlySelected || item.id === selectedPart));
  const shownJoints = adjustingParts || partAnnotation ? [] : onlySelected ? document.joints.filter((joint) => joint.id === part?.bone || part?.influences?.includes(joint.id)) : document.joints;
  const selectedVertices = part && visible.has(part.id) ? pose?.parts?.[part.id]?.vertices || (!pose ? [previewPart.x, previewPart.y, previewPart.x + part.width, previewPart.y, previewPart.x + part.width, previewPart.y + part.height, previewPart.x, previewPart.y + part.height] : null) : null;
  const annotationPoints = selectedVertices ? Array.from({ length: selectedVertices.length / 2 }, (_, index) => ({ x: selectedVertices[index * 2], y: selectedVertices[index * 2 + 1] })) : [];
  const annotationBounds = annotationPoints.length ? { x: Math.min(...annotationPoints.map((point) => point.x)), y: Math.min(...annotationPoints.map((point) => point.y)),
    right: Math.max(...annotationPoints.map((point) => point.x)), bottom: Math.max(...annotationPoints.map((point) => point.y)) } : null;
  const annotationCenter = annotationBounds && { x: (annotationBounds.x + annotationBounds.right) / 2, y: (annotationBounds.y + annotationBounds.bottom) / 2 };
  const annotationLabel = partAnnotation && part ? `${part.label || part.id} · ${partAnnotation.motionName || "基准"} ${Number(partAnnotation.time || 0).toFixed(2)}s · ${annotationCenter ? `第 ${Math.floor(annotationCenter.x / 32) + 1} 列 / 第 ${Math.floor(annotationCenter.y / 32) + 1} 行 · X ${annotationCenter.x.toFixed(1)} / Y ${annotationCenter.y.toFixed(1)}` : visible.has(part.id) ? "位置不可用" : "当前隐藏"}` : "";
  let view = { x: 0, y: 0, width: document.width, height: document.height };
  if (registration?.focus && part) {
    const polygon = registration.polygons?.[part.id] || part.sourcePolygon;
    const bounds = polygon?.length ? { x: Math.min(...polygon.map((point) => point.x)), y: Math.min(...polygon.map((point) => point.y)),
      width: Math.max(...polygon.map((point) => point.x)) - Math.min(...polygon.map((point) => point.x)), height: Math.max(...polygon.map((point) => point.y)) - Math.min(...polygon.map((point) => point.y)) } : part;
    const x = Math.max(0, bounds.x - 24), y = Math.max(0, bounds.y - 24);
    view = { x, y, width: Math.max(1, Math.min(document.width, bounds.x + bounds.width + 24) - x), height: Math.max(1, Math.min(document.height, bounds.y + bounds.height + 24) - y) };
  }
  const point = (event) => {
    if (![event.clientX, event.clientY].every(Number.isFinite)) return null;
    try {
      const matrix = svg.current?.getScreenCTM?.();
      if (!matrix) return null;
      const value = svg.current.createSVGPoint(); value.x = event.clientX; value.y = event.clientY;
      const cursor = value.matrixTransform(matrix.inverse());
      return [cursor.x, cursor.y].every(Number.isFinite) ? cursor : null;
    } catch { return null; }
  };
  const begin = (event, joint) => {
    onSelectJoint(joint.id);
    if (disabled || pose) return;
    event.preventDefault(); event.stopPropagation();
    const cursor = point(event);
    if (!cursor) return;
    drag.current = { id: joint.id, dx: cursor.x - joint.x, dy: cursor.y - joint.y };
    onBeginMove?.(); svg.current.setPointerCapture(event.pointerId);
  };
  const matchesPointer = (active, event) => event?.pointerId == null || active.pointerId == null || event.pointerId === active.pointerId;
  const releasePartPointer = (active) => {
    try {
      if (active.pointerId != null && (!active.capture.hasPointerCapture || active.capture.hasPointerCapture(active.pointerId))) active.capture.releasePointerCapture?.(active.pointerId);
    } catch { /* The browser may already have released a cancelled pointer. */ }
  };
  const finishPartMove = (event, cancelled = false) => {
    const active = partDrag.current;
    if (!active || !matchesPointer(active, event)) return;
    partDrag.current = null;
    setPartPreview(null);
    releasePartPointer(active);
    if (!active.started) return;
    if (cancelled || !canMoveParts || selectedPart !== active.id || document !== active.document || (active.x === active.startX && active.y === active.startY)) {
      if (onCancelPartMove) onCancelPartMove({ preserveDocument: document !== active.document });
      else onEndPartMove?.();
    } else {
      try { onMovePart(active.id, active.x, active.y); } finally { onEndPartMove?.(); }
    }
  };
  useEffect(() => {
    const active = partDrag.current;
    if (active && (!canMoveParts || selectedPart !== active.id || document !== active.document)) finishPartMove(null, true);
  }, [canMoveParts, selectedPart, document]);
  useEffect(() => () => {
    const active = partDrag.current;
    if (!active) return;
    partDrag.current = null; releasePartPointer(active);
    if (active.started) {
      if (active.cancel) active.cancel({ preserveDocument: true });
      else active.end?.();
    }
  }, []);
  const partPosition = (item, x, y) => ({
    x: Math.max(0, Math.min(document.width - item.width, x)),
    y: Math.max(0, Math.min(document.height - item.height, y)),
  });
  const beginPartMove = (event) => {
    if (!canMoveParts || !part || partDrag.current || (event.button != null && event.button !== 0)) return;
    const cursor = point(event);
    if (!cursor) return;
    event.preventDefault(); event.stopPropagation();
    const capture = svg.current;
    try { capture.setPointerCapture(event.pointerId); } catch { return; }
    capture.focus?.({ preventScroll: true });
    partDrag.current = { id: part.id, pointerId: event.pointerId, capture, document, started: false, cancel: onCancelPartMove, end: onEndPartMove,
      dx: cursor.x - part.x, dy: cursor.y - part.y, startX: part.x, startY: part.y, x: part.x, y: part.y };
  };
  const movePartByKey = (event) => {
    if (event.key === "Escape" && partDrag.current) {
      event.preventDefault(); event.stopPropagation(); finishPartMove(null, true); return;
    }
    if (!canMoveParts || !part || !visible.has(part.id) || partDrag.current || event.altKey || event.ctrlKey || event.metaKey) return;
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!delta) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 10 : 1, next = partPosition(part, part.x + delta[0] * step, part.y + delta[1] * step);
    if (next.x === part.x && next.y === part.y) return;
    onBeginPartMove?.();
    try { onMovePart(part.id, next.x, next.y); } finally { onEndPartMove?.(); }
  };
  const labelSize = registration ? Math.max(3.5, view.width / 30) : Math.max(11, document.width / 67);
  const radius = registration ? Math.max(1.5, Math.min(view.width, view.height) / 70) : Math.max(5, document.width / 120);
  const gridLabelStep = registration?.focus ? 32 : 128, gridX = Math.ceil(view.x / gridLabelStep) * gridLabelStep, gridY = Math.ceil(view.y / gridLabelStep) * gridLabelStep;
  const clipId = `rig-source-${document.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return <div className="rig-overlay-stage">
    <svg ref={svg} viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`} preserveAspectRatio="xMidYMid meet"
      role={adjustingParts ? "group" : "img"} aria-label={registration ? "原图网格与部件坐标对齐" : pose ? "骨架动作叠图" : adjustingParts ? "手动调整部件位置" : "拖动关节校准骨架"}
      tabIndex={canMoveParts ? 0 : undefined} onKeyDown={movePartByKey}
      onPointerMove={(event) => {
        if (partDrag.current) {
          const active = partDrag.current;
          if (!matchesPointer(active, event)) return;
          if (!canMoveParts || selectedPart !== active.id) { finishPartMove(event, true); return; }
          const cursor = point(event), item = document.parts.find((value) => value.id === active.id);
          if (!cursor || !item) return;
          const next = partPosition(item, cursor.x - active.dx, cursor.y - active.dy);
          if (next.x === active.x && next.y === active.y) return;
          if (!active.started) { active.started = true; onBeginPartMove?.(); }
          active.x = next.x; active.y = next.y;
          setPartPreview({ id: active.id, x: next.x, y: next.y }); return;
        }
        if (contourDrag.current && !disabled) {
          const cursor = point(event), { id, index } = contourDrag.current;
          if (!cursor) return;
          onMovePolygonVertex?.(id, index, cursor.x, cursor.y); return;
        }
        if (!drag.current || disabled) return;
        const cursor = point(event);
        if (!cursor) return;
        onMoveJoint(drag.current.id, Math.max(0, Math.min(document.width, cursor.x - drag.current.dx)), Math.max(0, Math.min(document.height, cursor.y - drag.current.dy)));
      }} onPointerUp={(event) => { finishPartMove(event); drag.current = null; contourDrag.current = null; }}
      onPointerCancel={(event) => { finishPartMove(event, true); drag.current = null; contourDrag.current = null; }} onLostPointerCapture={(event) => finishPartMove(event, true)}>
      <defs>{document.parts.map((item) => <clipPath key={item.id} id={`${clipId}-${item.id}`}><rect x={item.x} y={item.y} width={item.width} height={item.height} /></clipPath>)}
        <pattern id={`${clipId}-grid`} width="32" height="32" patternUnits="userSpaceOnUse"><path d="M 32 0 H 0 V 32" fill="none" stroke="#8d75b8" strokeWidth="0.8" /></pattern>
        <filter id={`${clipId}-alpha-outline`} x="-10%" y="-10%" width="120%" height="120%"><feMorphology in="SourceAlpha" operator="dilate" radius="1.4" result="expanded" /><feComposite in="expanded" in2="SourceAlpha" operator="out" result="edge" /><feFlood floodColor="#df5a9e" /><feComposite in2="edge" operator="in" /></filter>
      </defs>
      <rect width={document.width} height={document.height} fill="#f2f0f8" />
      {!registration && document.sourceImage && showImage && <image href={document.sourceImage} x="0" y="0" width={document.width} height={document.height} opacity={showParts ? 0.5 : 0.92} />}
      {registration && <>
        {document.sourceImage && ["source", "overlay"].includes(registration.mode) && <image href={document.sourceImage} x="0" y="0" width={document.width} height={document.height} opacity={registration.mode === "source" ? 1 : 1 - registration.opacity} />}
        {registration.assembly && ["assembled", "overlay"].includes(registration.mode) && <image href={registration.assembly} x="0" y="0" width={document.width} height={document.height} opacity={registration.mode === "assembled" ? 1 : registration.opacity} />}
        {registration.owners && registration.mode === "owners" && <image href={registration.owners} x="0" y="0" width={document.width} height={document.height} />}
      </>}
      {showParts && !pose && shownParts.sort((a, b) => a.z - b.z).map((item) => <g key={item.id} data-rig-part={item.id}
        transform={partPreview?.id === item.id ? `translate(${partPreview.x - item.x} ${partPreview.y - item.y})` : undefined}
        onPointerDown={(event) => { if (disabled) return; event.stopPropagation(); onSelectPart?.(item.id); if (canMoveParts) svg.current?.focus?.({ preventScroll: true }); }}>
        {!registration && (item.image ? <image href={item.image} x={item.x} y={item.y} width={item.width} height={item.height} opacity={adjustingParts || selectedPart === item.id ? 1 : 0.66} />
          : document.sourceImage && <image href={document.sourceImage} x="0" y="0" width={document.width} height={document.height} clipPath={`url(#${clipId}-${item.id})`} opacity={selectedPart === item.id ? 0.9 : 0.24} />)}
        <rect x={item.x} y={item.y} width={item.width} height={item.height} fill={adjustingParts ? "none" : "transparent"} pointerEvents={adjustingParts ? "stroke" : undefined} stroke={selectedPart === item.id ? "#d69a31" : "#9c91b8"} strokeWidth={selectedPart === item.id ? 2 : 1} vectorEffect="non-scaling-stroke" strokeDasharray={item.image ? undefined : "5 4"} />
      </g>)}
      {(registration?.grid || partAnnotation) && <g aria-label="32 像素原图坐标网格" pointerEvents="none"><rect width={document.width} height={document.height} fill={`url(#${clipId}-grid)`} opacity="0.55" />
        {Array.from({ length: Math.max(0, Math.ceil((view.x + view.width - gridX) / gridLabelStep)) }, (_, index) => <text key={`x-${index}`} x={gridX + index * gridLabelStep + 1} y={view.y + labelSize} fill="#725991" fontSize={labelSize}>{gridX + index * gridLabelStep}</text>)}
        {Array.from({ length: Math.max(0, Math.ceil((view.y + view.height - gridY) / gridLabelStep)) }, (_, index) => <text key={`y-${index}`} x={view.x + 1} y={gridY + index * gridLabelStep + labelSize} fill="#725991" fontSize={labelSize}>{gridY + index * gridLabelStep}</text>)}
      </g>}
      {partAnnotation && part && <g aria-label="所选部件的当前网格位置" pointerEvents="none">
        {annotationBounds && <><rect x={annotationBounds.x} y={annotationBounds.y} width={annotationBounds.right - annotationBounds.x} height={annotationBounds.bottom - annotationBounds.y} fill="#f0a93718" stroke="#d58b1f" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          <circle cx={annotationCenter.x} cy={annotationCenter.y} r="5" fill="#d58b1f" /></>}
        <text x="12" y={document.height - 16} fontSize={labelSize} fill="#5634a3" stroke="#fff" strokeWidth="4" paintOrder="stroke">{annotationLabel}</text>
      </g>}
      {registration && Object.entries(registration.polygons || {}).filter(([id]) => !onlySelected || id === selectedPart).map(([id, points]) => <g key={id} data-rig-polygon={id}>
        <polygon points={points.map(({ x, y }) => `${x},${y}`).join(" ")} fill={id === selectedPart ? "#42b28c15" : "transparent"} stroke={id === selectedPart ? "#23976b" : "#6b7fb6"} strokeWidth={id === selectedPart ? 2 : 0.8} vectorEffect="non-scaling-stroke" onPointerDown={(event) => { event.stopPropagation(); onSelectPart?.(id); }} />
        {id === selectedPart && points.map((vertex, index) => <circle key={index} cx={vertex.x} cy={vertex.y} r={radius * 0.65} fill={index === selectedPolygonVertex ? "#f9d063" : "#fff"} stroke="#238b68" strokeWidth="1.5" vectorEffect="non-scaling-stroke" tabIndex={0} role="button" aria-label={`轮廓顶点 ${index + 1}`} onPointerDown={(event) => {
          event.preventDefault(); event.stopPropagation(); onSelectPolygonVertex?.(index); if (disabled) return;
          onBeginPolygonMove?.(); contourDrag.current = { id, index }; svg.current.setPointerCapture(event.pointerId);
        }} onKeyDown={(event) => { const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }; if (["Enter", " "].includes(event.key)) { event.preventDefault(); onSelectPolygonVertex?.(index); } if (moves[event.key] && !disabled) { event.preventDefault(); onBeginPolygonMove?.(); const [x, y] = moves[event.key]; onMovePolygonVertex?.(id, index, vertex.x + x * (event.shiftKey ? 10 : 1), vertex.y + y * (event.shiftKey ? 10 : 1)); } }} />)}
      </g>)}
      {registration?.alphaPart?.image && <image href={registration.alphaPart.image} x={registration.alphaPart.x} y={registration.alphaPart.y} width={registration.alphaPart.width} height={registration.alphaPart.height} filter={`url(#${clipId}-alpha-outline)`} pointerEvents="none" />}
      {registration?.alphaBounds && <rect {...registration.alphaBounds} fill="none" stroke="#df5a9e" strokeWidth="1" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" pointerEvents="none" />}
      {mesh && part && visible.has(part.id) && !pose && !adjustingParts && <g className="rig-mesh-overlay">
        {Array.from({ length: mesh.triangles.length / 3 }, (_, index) => {
          const vertices = mesh.triangles.slice(index * 3, index * 3 + 3).map((vertex) => `${mesh.vertices[vertex * 2]},${mesh.vertices[vertex * 2 + 1]}`).join(" ");
          return <polygon key={index} points={vertices} fill="transparent" stroke="#43a69e" strokeWidth="0.8" vectorEffect="non-scaling-stroke" pointerEvents="none" />;
        })}
        {mesh.weights.map((weights, index) => {
          const weight = weights.find((item) => item.joint === selectedJoint)?.weight || 0;
          return <circle key={index} cx={mesh.vertices[index * 2]} cy={mesh.vertices[index * 2 + 1]} r={radius * 0.65}
            fill={`hsl(${210 - weight * 175} 75% 56%)`} stroke={index === selectedVertex ? "#fff" : "#317d84"} strokeWidth={index === selectedVertex ? 2.5 : 1} vectorEffect="non-scaling-stroke"
            tabIndex={0} role="button" aria-label={`选择网格顶点 ${index + 1}`} onPointerDown={(event) => { event.stopPropagation(); onSelectVertex(index); }}
            onKeyDown={(event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); onSelectVertex(index); } }} />;
        })}
      </g>}
      {shownJoints.map((joint) => {
        const current = displayedJoints[joint.id] || joint, parent = displayedJoints[joint.parent];
        return parent && (!onlySelected || shownJoints.some((item) => item.id === joint.parent)) ? <line key={joint.id} x1={parent.x} y1={parent.y} x2={current.x} y2={current.y} stroke={joint.id === selectedJoint ? "#744ce5" : "#596b91"} strokeWidth={joint.id === selectedJoint ? 4 : 2} vectorEffect="non-scaling-stroke" pointerEvents="none" /> : null;
      })}
      {shownJoints.map((joint) => {
        const current = displayedJoints[joint.id] || joint;
        return <g key={joint.id}>
          <circle cx={current.x} cy={current.y} r={joint.id === selectedJoint ? radius * 1.35 : radius} fill={joint.id === selectedJoint ? "#8050ec" : "#fff"} stroke="#7250c1" strokeWidth="2" vectorEffect="non-scaling-stroke"
            className={pose ? "" : "rig-joint-handle"} tabIndex={0} role="button" aria-label={`关节 ${joint.label || joint.id}`}
            onPointerDown={(event) => begin(event, joint)} onKeyDown={(event) => {
              if (["Enter", " "].includes(event.key)) { event.preventDefault(); onSelectJoint(joint.id); }
              const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
              if (moves[event.key] && !disabled && !pose) { event.preventDefault(); onBeginMove?.(); const [x, y] = moves[event.key]; onMoveJoint(joint.id, Math.max(0, Math.min(document.width, joint.x + x * (event.shiftKey ? 10 : 1))), Math.max(0, Math.min(document.height, joint.y + y * (event.shiftKey ? 10 : 1)))); }
            }} />
          {joint.id === selectedJoint && <text x={current.x + radius * 2} y={current.y - radius * 1.5} fontSize={labelSize} fill="#5634a3" stroke="#fff" strokeWidth="3" paintOrder="stroke" pointerEvents="none">{joint.label || joint.id}</text>}
        </g>;
      })}
      {adjustingParts && showParts && part && visible.has(part.id) && <g data-rig-part-adjustment={part.id}
        transform={partPreview?.id === part.id ? `translate(${partPreview.x - part.x} ${partPreview.y - part.y})` : undefined}>
        <rect x={part.x} y={part.y} width={part.width} height={part.height} fill="none" stroke="#8050ec" strokeWidth="2.5" vectorEffect="non-scaling-stroke"
          pointerEvents={canMoveParts ? "stroke" : "none"} style={{ cursor: canMoveParts ? "move" : undefined }} onPointerDown={beginPartMove} />
        {canMoveParts && <>
          {[[part.x, part.y], [part.x + part.width, part.y], [part.x + part.width, part.y + part.height], [part.x, part.y + part.height]].map(([x, y], index) =>
            <circle key={index} cx={x} cy={y} r={radius * 0.65} fill="#fff" stroke="#8050ec" strokeWidth="2" vectorEffect="non-scaling-stroke" aria-hidden="true" style={{ cursor: "move" }} onPointerDown={beginPartMove} />)}
          <g role="button" tabIndex={0} aria-label={`移动部件 ${part.label || part.id}`} aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
            onPointerDown={beginPartMove} onKeyDown={movePartByKey} style={{ cursor: "move" }}>
            <circle cx={part.x + part.width / 2} cy={part.y + part.height / 2} r={radius * 1.1} fill="#d69a31" stroke="#fff" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            <path d={`M ${part.x + part.width / 2 - radius / 2} ${part.y + part.height / 2} h ${radius} M ${part.x + part.width / 2} ${part.y + part.height / 2 - radius / 2} v ${radius}`} fill="none" stroke="#fff" strokeWidth="1.5" vectorEffect="non-scaling-stroke" pointerEvents="none" />
          </g>
        </>}
      </g>}
    </svg>
    {!document.sourceImage && !document.joints.length && <div className="rig-canvas-empty"><strong>从角色立绘开始</strong><p>导入图片后分析结构，再拖动关节纠正位置。</p></div>}
  </div>;
}
