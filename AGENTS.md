# Prototype Instructions

## Workbench scope

- Recreate the referenced Tooliva Spine workbench's dark layout and template/calibration/export workflow.
- Complete local template import, part replacement and calibration, real Spine animation playback, and export/re-import verification before AI generation.
- Do not implement credits, membership, payments, or billing.
- Keep user-imported assets local. Preserve skeleton animation, mesh, skin, and constraint data on export.
- Generation uses a local Codex App Server provider with managed ChatGPT authentication and native image generation. Never read or copy Codex account credentials into this application. Do not add a paid API fallback without the user's request.
- Preserve template fingerprints and explicit part mapping before applying generated images. Keep generated candidates separate until the user applies them.
- Full-character acceptance requires replacing every texture region, checking every template animation and each part's calibration, and re-importing actual downloaded runtime and editable exports. Keep complete-character evidence separate from partial material tests.
- Prefer a standalone macOS application for daily resource browsing. Keep a searchable resource library with large animation previews and a focused edited-character view; preserve template comparison, calibration, generation, and export. Do not require the user to start the browser server manually for desktop use.
- Keep the root README focused on the project's current features, workflow, formats, architecture, and usage. Do not describe it as inspired by, borrowed from, or a recreation of another project. Preserve third-party license and asset notices in their dedicated documents.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
