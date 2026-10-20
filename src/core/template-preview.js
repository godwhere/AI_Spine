import { createSpineScene } from "../spine/runtime.js";

export async function captureTemplatePreview(
  bundle,
  { animation, skin, time = 0 } = {},
  { document = globalThis.document, createScene = createSpineScene } = {},
) {
  if (!bundle || !document?.body) throw new Error("模板参考预览尚未准备好。");
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 768;
  canvas.style.cssText = "position:fixed;left:-10000px;top:0;display:block;width:768px;height:768px;max-width:none;max-height:none;pointer-events:none;";
  canvas.setAttribute("aria-hidden", "true");
  canvas.tabIndex = -1;
  document.body.appendChild(canvas);
  let scene;
  try {
    if (!canvas.clientWidth || !canvas.clientHeight) throw new Error("模板参考画布尺寸无效。");
    // A separate scene reads the original atlas pages; applied edits stay in the editor.
    scene = await createScene(bundle, canvas);
    scene.render({ animation, skin, time: Number.isFinite(time) ? Math.max(0, time) : 0 });
    const output = document.createElement("canvas");
    output.width = output.height = 768;
    const context = output.getContext("2d");
    if (!context) throw new Error("模板参考图片读取失败。");
    context.drawImage(canvas, 0, 0, output.width, output.height);
    const blob = await new Promise((resolve) => output.toBlob(resolve, "image/png"));
    if (!blob?.size) throw new Error("模板参考图片读取失败。");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    try { scene?.dispose(); }
    finally { canvas.remove(); }
  }
}
