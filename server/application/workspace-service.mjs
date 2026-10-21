const reads = { projects: ["summary", "list", "get", "read"], drafts: ["list", "get"], templates: ["list", "get"] };

// The repository is injected by bootstrap. Command classification, compatible
// protocol dispatch and the public HTTP port have one service owner.
export class WorkspaceService {
  constructor(repository) { this.repository = repository; }
  status() { return this.repository.status(); }
  call(collection, operation, args = []) {
    if (!Array.isArray(args)) throw new Error("本机存储参数无效。");
    if (!Object.hasOwn(reads, collection)) throw new Error("本机数据分类不存在。");
    const readOnly = reads[collection].includes(operation);
    return this.repository.transaction(() => this.repository.dispatch(collection, operation, args, { readOnly }), { readOnly });
  }
  callV2(collection, body) { return this.repository.nativeCommand(collection, body, (...args) => this.call(...args)); }
  callLegacy(collection, operation, args) { return this.repository.compatibleCommand(collection, operation, args, (...values) => this.call(...values)); }
  migrate(source, snapshot) { return this.repository.migrate(source, snapshot); }
  hasAssets() { return Boolean(this.repository.v2); }
  asset(hash, leaseId) { return this.repository.asset(hash, leaseId); }
  uploadAsset(hash, bytes, leaseId) { return this.repository.uploadAsset(hash, bytes, leaseId); }
  queryAssets(hashes, leaseId) { return this.repository.queryAssets(hashes, leaseId); }
  getProjectThumbnail(id, hash) { return this.repository.getProjectThumbnail(id, hash); }
  close() { return this.repository.close(); }

  // Explicit local inspection/maintenance ports retained for migration tools
  // and fault-injection fixtures. HTTP routes never receive database commands.
  get db() { return this.repository.db; }
  get v2() { return this.repository.v2; }
  get activeFormat() { return this.repository.activeFormat; }
  get projectIndex() { return this.repository.projectIndex; }
  get(...args) { return this.repository.get(...args); }
  all(...args) { return this.repository.all(...args); }
  put(...args) { return this.repository.put(...args); }
  remove(...args) { return this.repository.remove(...args); }
  transaction(...args) { return this.repository.transaction(...args); }
  initializeEmptyV2() { return this.repository.initializeEmptyV2(); }
  checkProjectIndex() { return this.repository.checkProjectIndex(); }
  rebuildProjectIndex() { return this.repository.rebuildProjectIndex(); }
}
