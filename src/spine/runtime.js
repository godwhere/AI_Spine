import { AnimationState } from "@esotericsoftware/spine-core";
import { AnimationStateData } from "@esotericsoftware/spine-core";
import { attachmentVertices } from "../../engine/spine/geometry.js";
import { decodeText } from "../../shared/codec/text.mjs";
import { GLTexture } from "@esotericsoftware/spine-webgl";
import { ManagedWebGLRenderingContext } from "@esotericsoftware/spine-webgl";
import { measurePreviewBounds } from "../../engine/spine/geometry.js";
import { parseSkeleton } from "../../engine/spine/parse.js";
import { Physics } from "@esotericsoftware/spine-core";
import { SceneRenderer } from "@esotericsoftware/spine-webgl";
import { Skeleton } from "@esotericsoftware/spine-core";
import { TextureAtlas } from "@esotericsoftware/spine-core";

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
