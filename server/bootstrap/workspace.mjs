import { WorkspaceRepository } from "../workspace/repository.mjs";
import { WorkspaceService } from "../application/workspace-service.mjs";

export function createWorkspaceStore(root) {
  return new WorkspaceService(new WorkspaceRepository(root));
}
