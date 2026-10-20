import {
  TextureAtlas,
  AtlasAttachmentLoader,
  SkeletonJson,
  SkeletonBinary,
  Skeleton,
  AnimationState,
  AnimationStateData,
  Physics,
  GLTexture,
  ManagedWebGLRenderingContext,
  SceneRenderer,
  RegionAttachment,
  MeshAttachment,
} from "@esotericsoftware/spine-webgl";
import { decodeText } from "../core/archive.js";

// HTMLImageElement honors WebGL's UNPACK_PREMULTIPLY_ALPHA_WEBGL. ImageBitmap
// ignores that switch, which would darken premultiplied-alpha atlas pages.
function loadTextureImage(bytes) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes])),
      image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("贴图无法解码。"));
    };
    image.src = url;
  });
}

export function parseSkeleton(
  bundle,
  atlas = new TextureAtlas(
    bundle.atlasPaths.map((p) => decodeText(bundle.files[p])).join("\n\n"),
  ),
) {
  const loader = new AtlasAttachmentLoader(atlas);
  const reader = bundle.binary
    ? new SkeletonBinary(loader)
    : new SkeletonJson(loader);
  const data = reader.readSkeletonData(
    bundle.binary ? bundle.files[bundle.skeletonPath] : bundle.json,
  );
  if (!data.version?.startsWith("4.3."))
    throw new Error(
      `当前运行库支持 Spine 4.3.x，文件是 ${data.version || "未知版本"}。`,
    );
  return { atlas, data };
}

export function attachmentVertices(skeleton, slot) {
  const pose = slot.appliedPose,
    attachment = pose.attachment;
  if (attachment instanceof RegionAttachment) {
    const vertices = new Float32Array(8);
    attachment.computeWorldVertices(
      slot,
      attachment.getOffsets(pose),
      vertices,
      0,
      2,
    );
    return { attachment, vertices };
  }
  if (attachment instanceof MeshAttachment) {
    const vertices = new Float32Array(attachment.worldVerticesLength);
    attachment.computeWorldVertices(
      skeleton,
      slot,
      0,
      vertices.length,
      vertices,
      0,
      2,
    );
    return { attachment, vertices };
  }
  return null;
}

export function measureAnimation(data, animation, skin) {
  const skeleton = new Skeleton(data);
  if (skin) skeleton.setSkin(skin);
  skeleton.setupPose();
  const state = new AnimationState(new AnimationStateData(data));
  const target = animation ? data.findAnimation(animation) : null,
    track = target ? state.setAnimation(0, target, false) : null;
  let x = Infinity,
    y = Infinity,
    right = -Infinity,
    top = -Infinity;
  for (let step = 0; step <= 16; step++) {
    skeleton.setupPose();
    if (track) {
      track.trackTime = (target.duration * step) / 16;
      state.apply(skeleton);
    }
    skeleton.updateWorldTransform(Physics.none);
    const bounds = skeleton.getBoundsRect();
    if (Number.isFinite(bounds.x) && bounds.width > 0 && bounds.height > 0) {
      x = Math.min(x, bounds.x);
      y = Math.min(y, bounds.y);
      right = Math.max(right, bounds.x + bounds.width);
      top = Math.max(top, bounds.y + bounds.height);
    }
  }
  return Number.isFinite(x)
    ? { x, y, width: right - x, height: top - y }
    : { x: -200, y: 0, width: 400, height: 400 };
}

export function measurePreviewBounds(data, skin) {
  const actions = data.animations.length ? data.animations : [null];
  let x = Infinity,
    y = Infinity,
    right = -Infinity,
    top = -Infinity;
  for (const action of actions) {
    const bounds = measureAnimation(data, action?.name, skin);
    x = Math.min(x, bounds.x);
    y = Math.min(y, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    top = Math.max(top, bounds.y + bounds.height);
  }
  return { x, y, width: right - x, height: top - y };
}

export async function createSpineScene(bundle, canvas) {
  let context, renderer, atlas;
  const bitmaps = new Set();
  try {
    context = new ManagedWebGLRenderingContext(canvas, {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer = new SceneRenderer(canvas, context, true);
    renderer.skeletonRenderer.pmaAdditiveBatching = false;
    atlas = new TextureAtlas(
      bundle.atlasPaths.map((p) => decodeText(bundle.files[p])).join("\n\n"),
    );
    const images = await Promise.all(
      bundle.pages.map((page) => loadTextureImage(bundle.files[page.file])),
    );
    images.forEach((image) => bitmaps.add(image));
    for (let index = 0; index < atlas.pages.length; index++) {
      const page = atlas.pages[index],
        image = images[index];
      if (image.width !== page.width || image.height !== page.height)
        throw new Error(`贴图尺寸与 Atlas 不一致：${page.name}`);
      page.setTexture(new GLTexture(context, image, page.pma));
    }
    const { data } = parseSkeleton(bundle, atlas),
      skeleton = new Skeleton(data);
    const state = new AnimationState(new AnimationStateData(data));
    let activeAnimation,
      activeSkin,
      track,
      bounds,
      lastTime = 0,
      shapes = [],
      disposed = false,
      pageRevision = 0;
    const fitCache = new Map();
    return {
      data,
      skeleton,
      get shapes() {
        return shapes;
      },
      async updatePages(files) {
        const revision = ++pageRevision;
        const images = await Promise.all(
          bundle.pages.map((p) =>
            loadTextureImage(files[p.file] || bundle.files[p.file]),
          ),
        );
        if (disposed || revision !== pageRevision) return;
        images.forEach((image) => bitmaps.add(image));
        for (let index = 0; index < atlas.pages.length; index++) {
          const page = atlas.pages[index],
            old = page.texture,
            oldImage = old?.getImage();
          page.setTexture(new GLTexture(context, images[index], page.pma));
          old?.dispose();
          oldImage?.close?.();
          bitmaps.delete(oldImage);
        }
      },
      render({
        animation,
        loop = true,
        skin,
        time,
        zoom = 1,
        pan = { x: 0, y: 0 },
        bones = false,
      }) {
        if (disposed || context.gl.isContextLost()) return [];
        if (!bounds || animation !== activeAnimation || skin !== activeSkin) {
          activeAnimation = animation;
          activeSkin = skin;
          skeleton.setSkin(skin || data.defaultSkin || data.skins[0] || null);
          skeleton.setupPose();
          state.clearTracks();
          track = animation && data.findAnimation(animation)
            ? state.setAnimation(0, animation, loop)
            : null;
          // Share a camera across actions so compact poses do not appear larger.
          const key = skin || "";
          if (!fitCache.has(key))
            fitCache.set(key, measurePreviewBounds(data, skin));
          bounds = fitCache.get(key);
          lastTime = time;
        }
        const resolvedTime = track && !loop
          ? Math.max(0, Math.min(time, track.animationEnd - track.animationStart))
          : time;
        if (track) {
          track.loop = loop;
          track.trackTime = resolvedTime;
        }
        state.apply(skeleton);
        const delta = Math.max(0, Math.min(0.05, resolvedTime - lastTime));
        lastTime = resolvedTime;
        skeleton.update(delta);
        skeleton.updateWorldTransform(Physics.update);
        const width = Math.max(1, canvas.clientWidth),
          height = Math.max(1, canvas.clientHeight),
          ratio = Math.min(window.devicePixelRatio || 1, 2);
        if (
          canvas.width !== Math.round(width * ratio) ||
          canvas.height !== Math.round(height * ratio)
        ) {
          canvas.width = Math.round(width * ratio);
          canvas.height = Math.round(height * ratio);
        }
        context.gl.viewport(0, 0, canvas.width, canvas.height);
        const scale = Math.max(
          0.0001,
          Math.min((width - 48) / bounds.width, (height - 48) / bounds.height) *
            zoom,
        );
        const centerX = bounds.x + bounds.width / 2 - pan.x / scale,
          centerY = bounds.y + bounds.height / 2 + pan.y / scale;
        renderer.camera.setViewport(width / scale, height / scale);
        renderer.camera.position.set(centerX, centerY, 0);
        renderer.camera.update();
        context.gl.clearColor(0, 0, 0, 0);
        context.gl.clear(context.gl.COLOR_BUFFER_BIT);
        renderer.begin();
        renderer.drawSkeleton(skeleton);
        if (bones) renderer.drawSkeletonDebug(skeleton);
        renderer.end();
        shapes = [];
        let checksum = 0;
        for (const slot of skeleton.drawOrder.appliedPose) {
          const info = attachmentVertices(skeleton, slot);
          if (!info) continue;
          const sequence = info.attachment.sequence;
          const region =
            sequence.regions[sequence.resolveIndex(slot.appliedPose)];
          if (!region) continue;
          const points = [];
          for (let i = 0; i < info.vertices.length; i += 2) {
            const x = (info.vertices[i] - centerX) * scale + width / 2,
              y = height / 2 - (info.vertices[i + 1] - centerY) * scale;
            points.push({ x, y });
            checksum += info.vertices[i] * (i + 1) + info.vertices[i + 1];
          }
          shapes.push({
            id: region.name,
            points,
            triangles: info.attachment.triangles || [0, 1, 2, 2, 3, 0],
          });
        }
        canvas.dataset.animationTime = resolvedTime.toFixed(3);
        canvas.dataset.poseChecksum = checksum.toFixed(3);
        canvas.dataset.animation = animation;
        canvas.dataset.skin = skin || "";
        canvas.dataset.viewScale = scale.toFixed(6);
        canvas.dataset.viewCenter = `${centerX.toFixed(6)},${centerY.toFixed(6)}`;
        return shapes;
      },
      dispose() {
        disposed = true;
        pageRevision++;
        atlas?.dispose();
        renderer?.dispose();
        context?.dispose();
        bitmaps.forEach((image) => image.close?.());
        bitmaps.clear();
      },
    };
  } catch (error) {
    atlas?.dispose();
    renderer?.dispose();
    context?.dispose();
    bitmaps.forEach((image) => image.close?.());
    throw new Error(`Spine 资源加载失败：${error.message}`);
  }
}

export function pointInTriangle(point, a, b, c) {
  const sign = (p, q, r) =>
    (p.x - r.x) * (q.y - r.y) - (q.x - r.x) * (p.y - r.y);
  const d1 = sign(point, a, b),
    d2 = sign(point, b, c),
    d3 = sign(point, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

export function pickPart(shapes, point) {
  for (const shape of [...shapes].reverse()) {
    for (let i = 0; i < shape.triangles.length; i += 3) {
      const [a, b, c] = shape.triangles
        .slice(i, i + 3)
        .map((index) => shape.points[index]);
      if (a && b && c && pointInTriangle(point, a, b, c)) return shape.id;
    }
  }
  return null;
}
