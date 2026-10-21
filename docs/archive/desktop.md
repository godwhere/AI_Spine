# Historical macOS desktop delivery

Daily use now opens the [local browser workbench](../workbench.md). The former App's profile has been backed up and migrated to shared local storage; desktop binaries are retired. The sections below retain the earlier desktop delivery and acceptance record and do not describe the current launch path.

P3 source retirement (2026-10-21): the reusable HTTP server and API routes now live under `server/http/`, with Node composition and browser launching under `server/bootstrap/`. Electron main/preload/key adapters, App build/start scripts and their dependencies have been removed. Shared key protection, legacy migration inputs, exported archives and the evidence below are retained. Current backend and browser tests replace native App acceptance; frontend feature/session restructuring is still in progress.

iSpine packages the workbench in an independent Electron window. The current local target is macOS Apple Silicon. The app includes the frontend, 38 templates (37 characters and one animated effect), the complete editable Starberry character, the local production server, and the PNG decoding module. No web development server or separately installed Node.js is needed to run the packaged application.

The current installed build includes source-coordinate registration, independent facial attachments, seven-action authoring and non-looping terminal-frame playback. Reopening a resource restores its matching draft; conflicting drafts are independently retained. Native restart acceptance confirmed three resources (the completed 44-part pink mage, the 16-part swordsman and the original 49-part Wukong), 39 templates, empty trash and Codex connectivity without a Keychain prompt. Core 280, complete-Egg 9, production-serving 4 and actual-bundle desktop 9 checks passed; the mage's separate 547 artifact checks cover 1042 official-runtime samples and byte-identical ZIP roundtrip. See [validation](../validation.md) and the [current native library](../../outputs/pink-mage/evidence/native-resources-final.png).

## Open and browse

The light resource explorer uses horizontal navigation and a row list, central animation stage, and right inspector. Template type and category chips stay above the list: Character → Person/Monster and Effect → Spell. Counts describe actual atlas regions. Search, sort and list/grid modes use the same local resource records. Narrow viewports navigate from the list to preview and back instead of squeezing all columns together. Thumbnail transparency is cropped only for display; original data is preserved.

The template toolbar offers the unchanged one-column list and fixed three-column pictures in a compact left pane. A large center animation stage and independent right inspector retain the main workspace proportions. Names remain available through accessible labels and hover titles. On phones, selecting a thumbnail opens the preview and a return action restores the gallery. Short windows can scroll to reach creation controls. Image rows remain square and do not overlap. The resource library's list/grid settings remain independent.

Select a saved resource and choose “加入模板”. Set its name, character/effect type and categories, then save. The template library opens “我创建的” with the new template selected. Replacement images and calibration are baked into runtime texture pages; skeletons, actions, skins and atlas geometry stay intact. Saving the same resource again updates its existing template. Cancelling creates nothing. Templates use an independent IndexedDB database with atomic metadata/file writes; later edits, trashing or permanently deleting the source resource cannot change a saved template. Only custom templates offer deletion, with an explicit confirmation; the source and derived resources remain available.

Open `outputs/desktop/iSpine.app`, or double-click `启动桌面工作台.command`. The app owns a loopback server on port 4175 and stops it when the app exits. A second launch brings the existing window forward. A conflicting port produces an explicit startup error rather than silently changing the storage origin.

The first desktop launch seeds an empty resource library with the complete six-part Starberry character. Existing desktop projects are never replaced by this seed. Search and sort resources, single-click a thumbnail for a live animation preview, then double-click or choose “编辑与校准” to edit. The editor can focus on the edited character or show the synchronized original/current comparison.

Creating from a template opens a temporary draft. Animation/skin/zoom changes and opening or closing AI creation do not save an unchanged template copy. Written prompts, a rename, applied artwork or part edits start normal autosaving; explicit save or export can keep an unchanged template intentionally. Existing resources and imports still save normally, including after undoing all edits.

Choose “删除资源” in the selected resource's preview to open a confirmation dialog. Confirming moves the project to the persistent “回收站” tab. Its source files, replacements, calibration, and generation references remain available; “恢复资源” returns it to the active library. Cancelling leaves the library unchanged. Trash survives application restarts, and an empty active library does not re-create a sample when existing projects are in trash. Late autosaves cannot overwrite trashed projects. The existing profile directory and archive format remain stable across product-name changes.

The trash view offers “永久删除” for the selected resource and “清空回收站” for its current contents. A separate confirmation names the resource or count and states that recovery is unavailable. The final operation checks that every target is still trashed, atomically removes its character data, and retains only ID tombstones to reject stale saves. An intentionally emptied library does not re-seed the example. Independently exported files and generation history are managed separately.

Native menu shortcuts: Cmd+1 resource library, Cmd+2 templates, Cmd+O import, Cmd+S save, Cmd+Shift+E export. File imports and exports use the operating system's file dialogs. Closing or quitting waits for the current project to save; an unfinished calibration/import/export keeps the window open with an explanation. Window bounds are restored within the current display's work area.

“我的资源 → 新建角色” opens the independent humanoid rig workflow: illustration analysis, draggable joints, completed transparent parts, rigid or weighted-mesh binding, foot and weapon constraints, motion keyframes, preview and export. Unfinished rig drafts live in a separate local database and do not become resource-library entries. Cmd+S, navigation and close wait for draft writes; an open part-calibration dialog must be applied or cancelled first. Saved resources retain authoring data and individual PNGs, and “骨架与动作” reopens them with the current calibration. See [Rig authoring](../rig-authoring.md).

Export offers runtime resources, editable project backups, and Unity resources. The Unity option preserves the skeleton and baked atlas pixels while using `.atlas.txt` and, for binary skeletons, `.skel.bytes`. It includes version/transparency/import guidance. See [Unity export and Spine editing](../unity-export.md) for the editor and engine workflow.

## Local data and account

Projects use the app's persistent IndexedDB profile under `~/Library/Application Support/AI Spine`. The production origin remains `http://127.0.0.1:4175`. Codex job inputs/results are stored in this same application data folder under `generation/jobs`. The app menu can reveal the resource folder. Export editable ZIPs for portable backups.

The desktop app is an optional shell over the shared browser workbench. Editing capabilities and manual adjustment are implemented once in the frontend. Browser and native profiles retain separate local storage; there is no Send-to-App option or cross-origin receiver. Previously imported resources and independent rig drafts remain in their existing databases. Editable resource ZIP export/import remains available for portable backups; historical provider job queues are not migrated automatically.

The desktop server defaults to managed Codex authentication and the installed Codex CLI. The AI connection panel explains installation and sign-in, checks the current account, and can start the official browser login flow. An explicitly chosen OpenAI API provider accepts the user's own Key and image model. Remembered API keys use Electron system encryption and stay outside project exports; unsupported encryption environments retain keys only in memory. Startup and connection browsing leave saved API keys locked and do not call system protection. Explicit API validation or generation unlocks only the selected key; failed unlock/save preserves existing ciphertext. Connection changes are blocked while jobs run, and failed jobs never switch providers automatically. The header shows the current AI connection; the Spine version/readiness badge is omitted. No credits or billing system is implemented. See [AI connection setup and provider contracts](../ai-connections.md).

The editor and AI creation dialog display four linked workflow steps: appearance, template parts, calibration/preview, and export. A chosen or imported appearance can select the complete template for part generation. Candidates remain separate until applied. Interrupted and failed jobs offer an explicit continuation action that regenerates only missing parts from the original prompt and reference snapshot. Completed candidates remain available in their original records. Workflow counts reflect applied texture regions; they do not imply that manual calibration or every animation has been reviewed.

Part generation defaults to three simultaneous native Codex image turns, with a selectable limit of one to four. Appearance generation remains a single image. Progress lists every in-flight part; results retain their request indices and explicit part mapping even when they finish out of order. Cancelling aborts all in-flight turns. A failed image stops dispatching new parts while other in-flight results are retained, then the batch can continue from its missing parts with a different concurrency setting. Legacy requests without a concurrency field remain serial.

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

`pnpm desktop` runs the desktop shell from source after building the frontend. `pnpm build:desktop` produces `outputs/desktop/iSpine.app`. Packaging preserves native framework symlinks and applies a local ad-hoc signature. This is a local build; Developer ID notarization, Windows/Linux packages, and external distribution are outside the verified delivery.

`test:desktop` checks asset/worker serving, the origin boundary, path traversal, Codex service lifecycle on a port conflict, real rig-job routes without submitting AI, the complete starter backup, and the actual packaged Electron runtime with native PNG decoding, shared rig validation and the production backend. The final native UI checks are recorded in `validation.md` and `design-qa.md`.

The native save/open acceptance file is retained at `outputs/desktop/evidence/starberry-desktop-project.zip`; a desktop test compares its source files, six replacements and transforms, reference image, and prompts to the original full-character backup. All nine desktop checks passed on the packaged app, including a stored-ciphertext startup check that forbids any system key-protection access for either selected provider. The independent rig example and its actual runtime/authoring roundtrip evidence are retained under `outputs/rig-authoring/`.
