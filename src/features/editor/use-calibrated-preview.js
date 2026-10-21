import { useEffect, useRef, useState } from "react";

const EMPTY = Object.freeze(Object.create(null));
export function useCalibratedPreview({ bundle, edits, active, compile, onReady, onError }) {
  const [compiled, setCompiled] = useState(EMPTY), [processing, setProcessing] = useState(false);
  const callbacks = useRef({}); callbacks.current = { onReady, onError };
  useEffect(() => {
    if (!bundle || !active) { setProcessing(false); return; }
    let cancelled = false;
    setProcessing(true);
    const timer = setTimeout(() => {
      compile(bundle, edits).then((pages) => {
        if (!cancelled) { setCompiled(pages); callbacks.current.onReady?.(); }
      }).catch((error) => { if (!cancelled) callbacks.current.onError?.(error); })
        .finally(() => { if (!cancelled) setProcessing(false); });
    }, 90);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [bundle, edits, active, compile]);
  return { compiled, processing, setCompiled };
}
