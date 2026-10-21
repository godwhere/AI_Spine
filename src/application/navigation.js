export function createNavigation({ onPending = () => {} } = {}) {
  let pending = false;
  return {
    get pending() { return pending; },
    async run(action) {
      if (pending) return false;
      pending = true; onPending(true);
      try { await action(); return true; }
      finally { pending = false; onPending(false); }
    },
  };
}
