const identityTransform = () => ({
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  flipX: false,
  flipY: false,
});

const closeImage = (image) => image.close?.();

function alphaBounds(imageData, threshold = 8) {
  const { width, height, data } = imageData;
  let x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > threshold) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  return x1 < 0
    ? null
    : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

async function extractPart(bundle, part, env) {
  const image = await env.loadImage(bundle.files[part.pageFile]);
  try {
    return extractPartFromImage(image, part, env);
  } finally {
    closeImage(image);
  }
}

// The caller owns the decoded page and may borrow it for several regions.
// Keep rotation, trim and PMA handling identical to normal extraction.
function extractPartFromImage(image, part, env) {
  const canvas = env.createCanvas(part.originalWidth, part.originalHeight);
  try {
    const ctx = canvas.getContext("2d");
    const top = part.originalHeight - part.offsetY - part.height;
    ctx.save();
    if (part.degrees === 90) {
      ctx.translate(part.offsetX + part.width, top);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(
        image,
        part.x,
        part.y,
        part.height,
        part.width,
        0,
        0,
        part.height,
        part.width,
      );
    } else
      ctx.drawImage(
        image,
        part.x,
        part.y,
        part.width,
        part.height,
        part.offsetX,
        top,
        part.width,
        part.height,
      );
    ctx.restore();
    if (part.pma) {
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < pixels.data.length; i += 4)
        if (pixels.data[i + 3])
          for (let c = 0; c < 3; c++)
            pixels.data[i + c] = Math.min(
              255,
              Math.round((pixels.data[i + c] * 255) / pixels.data[i + 3]),
            );
      ctx.putImageData(pixels, 0, 0);
    }
    return canvas;
  } catch (error) {
    canvas.width = 1; canvas.height = 1;
    throw error;
  }
}

function drawReplacement(
  ctx,
  image,
  part,
  transform = identityTransform(),
) {
  const t = { ...identityTransform(), ...transform };
  const fit = part.nativePixels ? 1 : Math.min(
    part.originalWidth / image.width,
    part.originalHeight / image.height,
  );
  ctx.save();
  ctx.translate(part.originalWidth / 2 + t.x, part.originalHeight / 2 + t.y);
  ctx.rotate((t.rotation * Math.PI) / 180);
  ctx.scale(t.scaleX * (t.flipX ? -1 : 1), t.scaleY * (t.flipY ? -1 : 1));
  ctx.drawImage(
    image,
    (-image.width * fit) / 2,
    (-image.height * fit) / 2,
    image.width * fit,
    image.height * fit,
  );
  ctx.restore();
}

async function renderReplacement(part, edit, env) {
  const canvas = env.createCanvas(part.originalWidth, part.originalHeight),
    image = await env.loadImage(edit.image);
  try {
    drawReplacement(canvas.getContext("2d"), image, part, edit.transform);
    return canvas;
  } finally {
    closeImage(image);
  }
}

async function autoFit(bundle, part, bytes, env) {
  const reference = await extractPart(bundle, part, env),
    image = await env.loadImage(bytes);
  try {
    const canvas = env.createCanvas(image.width, image.height),
      ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const target = alphaBounds(
      reference
        .getContext("2d")
        .getImageData(0, 0, reference.width, reference.height),
    );
    const source = alphaBounds(
      ctx.getImageData(0, 0, canvas.width, canvas.height),
    );
    if (!source) throw new Error("替换图片完全透明。");
    if (!target) return identityTransform();
    const baseFit = Math.min(
      part.originalWidth / image.width,
      part.originalHeight / image.height,
    );
    const scale = Math.min(
      target.width / source.width,
      target.height / source.height,
    );
    return {
      ...identityTransform(),
      scaleX: scale / baseFit,
      scaleY: scale / baseFit,
      x:
        target.x +
        target.width / 2 -
        part.originalWidth / 2 -
        (source.x + source.width / 2 - image.width / 2) * scale,
      y:
        target.y +
        target.height / 2 -
        part.originalHeight / 2 -
        (source.y + source.height / 2 - image.height / 2) * scale,
    };
  } finally {
    closeImage(image);
  }
}

async function compilePages(bundle, edits, env) {
  const pages = {};
  for (const page of bundle.pages) {
    if (pages[page.file]) continue;
    const modified = bundle.parts.filter(
      (part) => part.pageFile === page.file && Object.hasOwn(edits, part.id),
    );
    if (!modified.length) continue;
    const original = await env.loadImage(bundle.files[page.file]);
    if (original.width !== page.width || original.height !== page.height) {
      closeImage(original);
      throw new Error(`贴图尺寸与 Atlas 不一致：${page.name}`);
    }
    const canvas = env.createCanvas(page.width, page.height),
      ctx = canvas.getContext("2d");
    ctx.drawImage(original, 0, 0);
    closeImage(original);
    for (const part of modified) {
      const material = await renderReplacement(part, edits[part.id], env);
      const crop = env.createCanvas(part.width, part.height),
        cropCtx = crop.getContext("2d");
      cropCtx.drawImage(
        material,
        part.offsetX,
        part.originalHeight - part.offsetY - part.height,
        part.width,
        part.height,
        0,
        0,
        part.width,
        part.height,
      );
      ctx.clearRect(part.x, part.y, part.packedWidth, part.packedHeight);
      ctx.save();
      if (part.degrees === 90) {
        ctx.translate(part.x, part.y + part.width);
        ctx.rotate(-Math.PI / 2);
        ctx.drawImage(crop, 0, 0);
      } else ctx.drawImage(crop, part.x, part.y);
      ctx.restore();
      if (page.pma) {
        const pixels = ctx.getImageData(
          part.x,
          part.y,
          part.packedWidth,
          part.packedHeight,
        );
        for (let i = 0; i < pixels.data.length; i += 4)
          for (let c = 0; c < 3; c++)
            pixels.data[i + c] = Math.round(
              (pixels.data[i + c] * pixels.data[i + 3]) / 255,
            );
        ctx.putImageData(pixels, part.x, part.y);
      }
    }
    pages[page.file] = await env.encode(canvas);
  }
  return pages;
}

function partClipping(part, transform) {
  return (
    Math.abs(transform.x) > part.originalWidth / 2 ||
    Math.abs(transform.y) > part.originalHeight / 2 ||
    transform.scaleX > 1.5 ||
    transform.scaleY > 1.5
  );
}

export { alphaBounds, autoFit, closeImage, compilePages, drawReplacement, extractPart, extractPartFromImage, identityTransform, partClipping, renderReplacement };
