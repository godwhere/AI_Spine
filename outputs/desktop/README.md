# AI Spine macOS app

Open `AI Spine.app`, or double-click `../../启动桌面工作台.command` from the project. This is the local macOS Apple Silicon build (version 0.1.0). It starts its own resource and Codex service; a separate Node.js installation or browser server is not required by the packaged app.

“我的资源” contains the complete Starberry character. Single-click to preview, then use “编辑与校准” or double-click to edit. The native UI acceptance also left an independently imported copy named “星莓果冻精灵 · 桌面已验证”. Both have all six replacements and five animations.

The app stores projects separately from browser profiles under `~/Library/Application Support/AI Spine`. Other browser projects can be transferred by exporting and importing an editable ZIP. The installed, signed-in local Codex app is needed for new AI generation. Credits and billing are absent.

Validation passed: desktop 7/7, core 50/50, complete Egg 9/9, Sites 4/4. The native resource library, search, template navigation, preview, calibration, template comparison, current Codex connection, save/open dialogs, export/re-import, and quit/restart persistence were checked. See [desktop.md](../../docs/desktop.md) and [validation.md](../../docs/validation.md).

Evidence: [resource library](evidence/resource-library.png), [focused editor](evidence/focused-editor.png), [native saved editable project](evidence/starberry-desktop-project.zip). The app uses a local ad-hoc code signature. No Developer ID notarization, public release, Windows/Linux build, or new desktop-specific image-generation job is asserted.
