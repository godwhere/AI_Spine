export function saveDownload(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" })), anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
