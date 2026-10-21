const nextPower = (value) => 2 ** Math.ceil(Math.log2(Math.max(1, value)));

// Preserve the original shelf order and two-pixel border. Overflow starts a new
// page, never scales artwork or changes an attachment's region name.
function packRigAtlasRegions(parts, { maxPageSize = 8192 } = {}) {
  if (!Number.isInteger(maxPageSize) || maxPageSize < 8 || maxPageSize > 8192 || nextPower(maxPageSize) !== maxPageSize)
    throw new Error("Atlas 页边长必须是 8 至 8192 之间的 2 的幂。");
  const sizes = parts.map((part) => ({ id: part.id, width: Math.ceil(part.width), height: Math.ceil(part.height) }));
  for (const part of sizes) {
    if (![part.width, part.height].every((value) => Number.isFinite(value) && value > 0)) throw new Error(`部件尺寸无效：${part.id}`);
    if (part.width + 4 > maxPageSize || part.height + 4 > maxPageSize)
      throw new Error(`部件 ${part.id} 的原始尺寸 ${part.width} × ${part.height}（含边距）超过单页 Atlas ${maxPageSize} 像素，无法分页。`);
  }
  const area = sizes.reduce((sum, part) => sum + (part.width + 4) * (part.height + 4), 0);
  const widest = sizes.reduce((value, part) => Math.max(value, part.width + 4), 1);
  const width = Math.min(maxPageSize, nextPower(Math.max(Math.ceil(Math.sqrt(area)), widest)));
  const pages = [];
  let x = 2, y = 2, rowHeight = 0, regions = [];
  const finish = () => {
    if (regions.length) pages.push({ width, height: nextPower(y + rowHeight + 2), regions });
    x = 2; y = 2; rowHeight = 0; regions = [];
  };
  for (const part of sizes) {
    const wrap = x + part.width + 2 > width;
    const nextY = wrap ? y + rowHeight + 4 : y;
    if (nextY + part.height + 2 > maxPageSize) finish();
    else if (wrap) { x = 2; y = nextY; rowHeight = 0; }
    regions.push({ ...part, x, y });
    x += part.width + 4; rowHeight = Math.max(rowHeight, part.height);
  }
  finish();
  return pages;
}

export { packRigAtlasRegions };
