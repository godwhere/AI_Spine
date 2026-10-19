#!/bin/zsh
set -e
cd "$(dirname "$0")"
for spine_node in "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [[ -x "$spine_node" ]]; then
    if [[ ! -f node_modules/vite/bin/vite.js ]]; then
      print '请先在此目录安装依赖：pnpm install'
      read -k 1
      exit 1
    fi
    print 'Spine 工作台：http://127.0.0.1:4173'
    exec "$spine_node" scripts/start-workbench.mjs
  fi
done
print '请先安装 Node.js 22 或更新版本。'
read -k 1
exit 1
