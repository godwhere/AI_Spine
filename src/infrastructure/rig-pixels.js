const browserPixels = {
  createCanvas: (width, height) => {
    if (!globalThis.document) throw new Error("图片装配需要 Canvas，请在浏览器中操作或提供像素适配器。");
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; return canvas;
  },
  loadImage: (bytes) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes])), image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("立绘或部件图片无法解码。")); };
    image.src = url;
  }),
  encode: (canvas) => new Promise((resolve, reject) => canvas.toBlob(async (blob) => {
    if (blob) resolve(new Uint8Array(await blob.arrayBuffer())); else reject(new Error("部件 PNG 编码失败。"));
  }, "image/png")),
};

export { browserPixels };
