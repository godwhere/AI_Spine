import { cp, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

export async function copyDesktopExamples(clientRoot) {
  const folder = join(clientRoot, "examples");
  await mkdir(folder, { recursive: true });
  await cp(resolve("outputs/egg-starberry/starberry-project.zip"), join(folder, "starberry-project.zip"));
  await cp(resolve("outputs/egg-starberry/appearance.png"), join(folder, "starberry.png"));
}
