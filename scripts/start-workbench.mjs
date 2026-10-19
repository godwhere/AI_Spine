import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = 'http://127.0.0.1:4173';
try {
  const response = await fetch(url, { signal: AbortSignal.timeout(800) });
  if (response.ok && (await response.text()).includes('AI Spine')) {
    console.log(`工作台已在运行：${url}`);
    process.exit(0);
  }
} catch { /* Start the local service when it is not already running. */ }
if (!existsSync(resolve(root, 'node_modules/vite/bin/vite.js'))) {
  console.error('请先在项目目录安装依赖：pnpm install');
  process.exit(1);
}
try {
  const { createServer } = await import('vite');
  const server = await createServer({ root, server: { host: '127.0.0.1', port: 4173, strictPort: true } });
  await server.listen();
  console.log(`Spine 工作台已启动：${url}`);
} catch (error) {
  console.error(`工作台未能启动：${error.message}`);
  process.exitCode = 1;
}
