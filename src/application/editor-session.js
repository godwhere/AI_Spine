// The session key, not a resource ID, owns local revisions and persisted policy.
export function createEditorSession({ key, entityId, sameContent }) {
  let snapshot, localRevision = 0;
  return { key, entityId, leaving: false,
    update(next) {
      if (snapshot && !sameContent(snapshot, next)) localRevision++;
      snapshot = next;
      return { sessionKey: key, entityId, localRevision, snapshot };
    },
  };
}
