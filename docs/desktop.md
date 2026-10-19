# macOS desktop workbench

AI Spine packages the existing workbench in an independent Electron window. The current local target is macOS Apple Silicon. The app includes the frontend, 22 reference templates, the complete editable Starberry character, the local production server, and the PNG decoding module. No web development server or separately installed Node.js is needed to run the packaged application.

## Open and browse

Open `outputs/desktop/AI Spine.app`, or double-click `启动桌面工作台.command`. The app owns a loopback server on port 4175 and stops it when the app exits. A second launch brings the existing window forward. A conflicting port produces an explicit startup error rather than silently changing the storage origin.

The first desktop launch seeds an empty resource library with the complete six-part Starberry character. Existing desktop projects are never replaced by this seed. Search and sort resources, single-click a thumbnail for a live animation preview, then double-click or choose “编辑与校准” to edit. The editor can focus on the edited character or show the synchronized original/current comparison.

Native menu shortcuts: Cmd+1 resource library, Cmd+2 templates, Cmd+O import, Cmd+S save, Cmd+Shift+E export. File imports and exports use the operating system's file dialogs. Closing or quitting waits for the current project to save; an unfinished calibration/import/export keeps the window open with an explanation. Window bounds are restored within the current display's work area.

## Local data and account

Projects use the app's persistent IndexedDB profile under `~/Library/Application Support/AI Spine`. The production origin remains `http://127.0.0.1:4175`. Codex job inputs/results are stored in this same application data folder under `generation/jobs`. The app menu can reveal the resource folder. Export editable ZIPs for portable backups.

The browser and desktop app have separate storage profiles. Export an editable backup from an existing browser project, then import it into the desktop app. The shipped Starberry backup already includes all six replacement images and transforms, the chosen appearance reference, and its prompts. Historical browser job queues are not migrated automatically.

The desktop server uses the existing managed Codex provider and installed Codex CLI. It does not copy credentials, add an account form, or use a paid API fallback. Generation requires the currently logged-in local Codex installation. No credits or billing are implemented.

The renderer has no Node integration. A sandboxed preload exposes only native menu notifications and a close-ready acknowledgement. The server only binds loopback, rejects cross-site/foreign-origin traffic, and restricts static files to the packaged client. Native PNG decoding is bundled for actual generation-result validation.

Implementation follows the official [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security) and [ES module startup requirements](https://www.electronjs.org/docs/latest/tutorial/esm). A synchronous CommonJS bootstrap sets up the persistent profile before loading the application modules.

## Build and checks

Use Node.js 22+ and pnpm:

```sh
pnpm install
node node_modules/electron/install.js
pnpm build:desktop
pnpm test:desktop
pnpm test
pnpm test:egg
pnpm test:sites
```

`pnpm desktop` runs the desktop shell from source after building the frontend. `pnpm build:desktop` produces `outputs/desktop/AI Spine.app`. Packaging preserves native framework symlinks and applies a local ad-hoc signature. This is a local build; Developer ID notarization, Windows/Linux packages, and external distribution are outside the verified delivery.

`test:desktop` checks asset/worker serving, the origin boundary, path traversal, Codex service lifecycle on a port conflict, the complete starter backup, and the actual packaged Electron runtime with native PNG decoding and the production backend. The final native UI checks are recorded in `validation.md` and `design-qa.md`.

The native save/open acceptance file is retained at `outputs/desktop/evidence/starberry-desktop-project.zip`; the seventh desktop test compares its source files, six replacements and transforms, reference image, and prompts to the original full-character backup. All seven desktop checks passed on the packaged app.
