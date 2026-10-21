// Each queue still runs one job at a time. Its handler owns bounded part/frame
// concurrency. Template and rig queues have independent budgets.
export class JobQueue {
  constructor({ jobs, manifests, active, run, start, complete, fail, cleanup, cancel = () => {}, ready, closedMessage }) {
    Object.assign(this, { jobs, manifests, active, run, start, complete, fail, cleanup, onCancel: cancel, ready, closedMessage });
    this.admissions = new Set(); this.closed = false; this.draining = false;
  }
  assertOpen() { if (this.closed) throw new Error(this.closedMessage); }
  async admit(action) {
    this.assertOpen();
    const pending = Promise.resolve().then(() => { this.assertOpen(); return action(); });
    this.admissions.add(pending);
    try { return await pending; } finally { this.admissions.delete(pending); }
  }
  async enqueue(job) {
    this.assertOpen();
    // Do not expose a queued job to another admission's drain before its first
    // manifest is durable. Failed creation must never trigger an unseen turn.
    await this.manifests.save(job);
    if (this.closed) {
      this.fail(job, new Error(this.closedMessage), true); this.cleanup(job);
      await this.manifests.save(job); this.jobs.set(job.id, job); this.assertOpen();
    }
    this.jobs.set(job.id, job); this.kick();
  }
  kick() {
    if (this.draining || this.closed) return;
    void this.drain().catch(() => {});
  }
  drain() {
    if (this.draining || this.closed) return this.drainingPromise || Promise.resolve();
    this.drainingPromise = this.runQueued(); return this.drainingPromise;
  }
  async runQueued() {
    this.draining = true;
    try {
      for (const job of this.jobs.values()) {
        if (job.status !== "queued" || this.closed) continue;
        job.controller = new AbortController();
        try {
          this.start(job); await this.manifests.save(job); job.controller.signal.throwIfAborted();
          await this.run(job); job.controller.signal.throwIfAborted(); this.complete(job);
        } catch (error) { this.fail(job, error, this.closed); }
        finally { this.cleanup(job); await this.manifests.save(job); }
      }
    } finally { this.draining = false; }
  }
  async cancel(id) {
    this.assertOpen();
    const job = this.jobs.get(id); if (!job) return null;
    if (this.active.has(job.status)) {
      job.status = "cancelled"; this.onCancel(job); job.controller?.abort(); await this.manifests.save(job);
    }
    return job;
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true; for (const job of this.jobs.values()) job.controller?.abort();
    return this.closing = (async () => {
      await this.ready?.();
      await Promise.allSettled([...this.admissions]);
      await this.drainingPromise?.catch(() => {});
      for (const job of this.jobs.values()) if (this.active.has(job.status)) {
        this.fail(job, new Error(this.closedMessage), true); this.cleanup(job); await this.manifests.save(job);
      }
      await this.manifests.flush();
    })();
  }
}
