export function alphaBounds({ data, width, height }) {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!data[(y * width + x) * 4 + 3]) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return right < left ? null : { left, top, width: right - left + 1, height: bottom - top + 1 };
}

// This canvas is only a display derivative; source images and saved projects
// remain untouched. Alpha, including faint edge pixels, is the only crop rule.
export function compactThumbnail(image, createCanvas, size = 128) {
  const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
  if (!width || !height || width * height > 16 * 1024 * 1024) return null;
  const source = createCanvas(); source.width = width; source.height = height;
  const context = source.getContext("2d");
  context.drawImage(image, 0, 0);
  const bounds = alphaBounds(context.getImageData(0, 0, width, height));
  if (!bounds || (bounds.width === width && bounds.height === height)) return null;
  const output = createCanvas(); output.width = size; output.height = size;
  const padding = Math.ceil(size * 0.08), scale = (size - padding * 2) / Math.max(bounds.width, bounds.height);
  const targetWidth = bounds.width * scale, targetHeight = bounds.height * scale;
  output.getContext("2d").drawImage(source, bounds.left, bounds.top, bounds.width, bounds.height,
    (size - targetWidth) / 2, (size - targetHeight) / 2, targetWidth, targetHeight);
  return output;
}
