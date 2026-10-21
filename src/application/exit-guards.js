// The shell supplies browser targets; application code has no DOM globals.
export function attachSaveExitGuards(writer, { window, document }) {
  const flush = () => { if (writer.hasUnsaved()) void writer.flush(undefined, { retry: false }).catch(() => {}); };
  const beforeUnload = (event) => {
    if (!writer.hasUnsaved()) return;
    event.preventDefault(); event.returnValue = ""; flush();
  };
  const visibility = () => { if (document.visibilityState === "hidden") flush(); };
  window.addEventListener("beforeunload", beforeUnload); window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", visibility);
  return () => {
    window.removeEventListener("beforeunload", beforeUnload); window.removeEventListener("pagehide", flush);
    document.removeEventListener("visibilitychange", visibility);
  };
}
