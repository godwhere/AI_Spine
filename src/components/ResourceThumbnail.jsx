import { useEffect, useState } from "react";
import { compactThumbnail } from "../../engine/images/thumbnail.js";

export function ResourceThumbnail({ src, alt = "" }) {
  const [display, setDisplay] = useState(null);
  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      let url = src;
      try { url = compactThumbnail(image, () => document.createElement("canvas"))?.toDataURL("image/png") || src; }
      catch { /* Opaque, unreadable or unsupported images keep their original display. */ }
      if (!cancelled) setDisplay({ source: src, url });
    };
    image.onerror = () => { if (!cancelled) setDisplay({ source: src, url: src }); };
    image.src = src;
    return () => { cancelled = true; image.onload = null; image.onerror = null; };
  }, [src]);
  return <img src={display?.source === src ? display.url : src} alt={alt} />;
}
