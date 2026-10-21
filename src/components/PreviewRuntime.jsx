import { createContext, useContext } from "react";

const PreviewRuntime = createContext(null);
export function PreviewRuntimeProvider({ runtime, children }) {
  return <PreviewRuntime.Provider value={runtime}>{children}</PreviewRuntime.Provider>;
}
export function usePreviewRuntime() {
  const runtime = useContext(PreviewRuntime);
  if (!runtime) throw new Error("动画预览能力尚未组装。");
  return runtime;
}
