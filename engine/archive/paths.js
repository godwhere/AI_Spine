function cleanPath(path) {
  const value = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !value ||
    value.startsWith("/") ||
    /^[a-z]:/i.test(value) ||
    value.split("/").some((p) => p === ".." || p === ".")
  ) {
    throw new Error(`资源路径无效：${path}`);
  }
  return value;
}

const dirname = (path) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";

const basename = (path) => path.split("/").at(-1);

function resolveFile(files, owner, reference) {
  const wanted = cleanPath(dirname(owner) + reference);
  if (files[wanted]) return wanted;
  const matches = Object.keys(files).filter(
    (p) => p.toLowerCase() === wanted.toLowerCase(),
  );
  if (matches.length === 1) return matches[0];
  const loose = Object.keys(files).filter(
    (p) => basename(p).toLowerCase() === basename(reference).toLowerCase(),
  );
  if (loose.length === 1) return loose[0];
  throw new Error(
    `找不到贴图：${reference}。请一起导入 JSON / Atlas / 所有贴图。`,
  );
}

export { cleanPath, dirname, resolveFile };
