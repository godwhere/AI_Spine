const browserPixels = {
  createCanvas(width, height) {
    const Canvas = globalThis.OffscreenCanvas;
    if (typeof Canvas === "function" && typeof Canvas.prototype?.convertToBlob === "function")
      return new Canvas(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
  async loadImage(bytes) {
    const image = await createImageBitmap(new Blob([bytes]));
    if (
      image.width > 16384 ||
      image.height > 16384 ||
      image.width * image.height > 64 * 1024 * 1024
    ) {
      image.close();
      throw new Error("图片过大，请缩小到 64 百万像素以内。");
    }
    return image;
  },
  async encode(canvas) {
    const blob = typeof canvas.convertToBlob === "function"
      ? await canvas.convertToBlob({ type: "image/png" })
      : await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("PNG 编码失败。");
    return new Uint8Array(await blob.arrayBuffer());
  },
};

export { browserPixels };
