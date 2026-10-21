import { mkdir, readdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";

// One store belongs to one configured job root. A snapshot is captured before
// joining the per-job write queue; sibling jobs never share temporary files.
export class JobManifests {
  constructor(root) { this.root = resolve(root); this.writes = new Map(); this.failures = new Map(); }
  async load({ accept = () => true, recover = async () => {} } = {}) {
    await mkdir(this.root, { recursive: true });
    const jobs = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[\w-]{36}$/.test(entry.name)) continue;
      let job;
      try { job = JSON.parse(await readFile(join(this.root, entry.name, "job.json"), "utf8")); }
      catch { continue; } // Incomplete manifests cannot become completed jobs.
      if (job.id !== entry.name || !accept(job)) continue;
      await recover(job); jobs.push(job);
    }
    return jobs;
  }
  async save(job) {
    job.updatedAt = new Date().toISOString();
    const snapshot = JSON.stringify({ ...job, controller: undefined });
    const pending = (this.writes.get(job.id) || Promise.resolve()).catch(() => {}).then(async () => {
      const folder = join(this.root, job.id); await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "job.json.tmp"), snapshot, { mode: 0o600 });
      await rename(join(folder, "job.json.tmp"), join(folder, "job.json"));
    });
    this.writes.set(job.id, pending);
    try { await pending; this.failures.delete(job.id); }
    catch (error) { this.failures.set(job.id, error); throw error; }
    finally { if (this.writes.get(job.id) === pending) this.writes.delete(job.id); }
  }
  async flush() {
    while (this.writes.size) await Promise.allSettled([...this.writes.values()]);
    if (this.failures.size) throw new AggregateError([...this.failures.values()], "任务记录未完成保存。");
  }
}
