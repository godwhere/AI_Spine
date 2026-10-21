# Historical design QA — iSpine

This archive preserves earlier visual checks and delivery records. Current browser workflows are documented in the [project overview](../../README.md), [workbench guide](../workbench.md) and [validation record](../validation.md); old App packaging and launch steps below describe their original delivery only.


## Pink star-staff mage: completed template workflow — 2026-10-20

The user chose a mature humanoid template and requested completion before further aesthetic refinement. The completed character is now in the native library as “粉发星杖法师”. The previous independent-rig study and original artwork remain preserved.

Visible in-app Codex generation produced one coherent appearance, 15 mapped candidates and a dedicated hurt/death head. The result replaces 13 character regions and the ground shadow, retains the original transparent 1×1 helper, and adds one named head variant: 15 bones, 16 Atlas regions and 11 existing motions. Hurt and defeat use the painful closed-eye head; the other motions explicitly restore the neutral head. The original death throw and alpha fade are preserved.

All three actual export formats were imported through the UI, checked across 11 actions and exported again. Region RGBA pixels, UV/page mappings, skeleton motion, variant provenance and native head bytes are exact across those real packages. The editable roundtrip retains all 15 calibrated edits. Each package has 1377 official-runtime samples. Separate NAPI downsampling differs from the product browser and remains a failed cross-engine diagnostic; it does not relax the pixel-exact real UI roundtrip requirement.

Core/UI 426, complete-Egg 9, Sites 4 and actual-desktop 9 checks pass. The updated signed desktop application was installed, imported the final character once, played all 11 actions and restarted with four resources, 39 templates, empty trash and Codex connected. No startup key unlock was required. The three previous resources remain intact. A final enlarged review caught finger-like sleeve artwork; one in-app regeneration replaced it with a smooth sleeve, without importing another resource. The other 15 regions and skeleton/Atlas bytes are unchanged, and the corrected three-package UI roundtrips pass again. Agent visual review found no major assembly gaps; further user aesthetic refinement, official Spine Editor and Unity Editor acceptance remain separate.

Evidence: `work/template-pink-mage-final/cuff-corrected/report.json`, `ui/ui-validation.json`, `ui/editable-calibration-check.json`, `ui/native-motions.json` and `desktop-delivery.json`.


## Pink mage pose references and continuous rig remake — in progress, 2026-10-20

The user rejected the first version's non-idle action quality: attack, hit, run, skill and victory had visual problems, defeat was especially distorted, and hit retained a smile. The earlier numeric/export checks remain evidence of those specific contracts, not aesthetic acceptance. The accepted idle and base illustration are protected in the remake.

All six studies reached reviewed visible-region segmentation and real Spine playback, with 44 base parts, 25 bones and 922 pose regions. The 966 total texture regions do not represent 966 body components. Actual runtime and editable downloads were retained as superseded checks after the user identified an enlarged side-fall reference at 0.65 seconds. That image has been individually resubmitted through iSpine. Equal canvas dimensions and exact pixel reconstruction did not establish equal physical scale.

The user approved complete overlapping components and skeletal interpolation: full blank face beneath separate facial features, rounded joint overlaps, complete hair and garments, with image poses as references. Sparse stepped images remain an intermediate study. Current source checks are 411/411, complete-Egg 9/9 and serving 4/4. The independent continuous artifact validator passes 8/8 synthetic regressions; it has not accepted the pending real packages. The in-app continuous attack is applied, and face/hair calibration is being reviewed through shared images. Full motion acceptance, final export/re-import and updated packaged desktop delivery remain pending.

Part annotations use a compact action/time-to-grid mapping. Selecting a range pauses at its actual time, outlines the selected part in a 32-pixel source grid, and reports its center/cell or hidden state. Cross-motion navigation preserves time and leaves authored data unchanged. Bones, dimensions and layer details are collapsed.

## Pink mage, source coordinates and seven actions — 2026-10-20

The in-app Codex workflow generated a cel-shaded Q-version mage from the supplied reference, with a staff, 25 joints, 44 independent parts and five facial attachment groups. A shared source grid, editable polygons, explicit bounds expansion and stable inpainting bases correct the narrow clothing and legs while preserving source-visible pixels. The final setup silhouette has IoU 1 and zero missing or extra source pixels; closed and hurt eyes retain skin underneath without the original iris.

All seven authored motions were previewed. Run contact timing and the death release pose were corrected through the visible controls. Actual export validation exposed early foot movement across a discrete constraint-release boundary; the compiler now protects that boundary. Non-looping authoring playback holds the final real Spine pose and attachments. Reopening a matching resource restores its independent draft rather than replacing it with archived artwork; conflicting drafts are separately retained.

Core 280, complete-Egg 9, production-serving 4 and actual-package desktop 9 checks passed. Separately, 547 actual-artifact checks cover 1042 official-runtime samples, all facial groups and staff grips, source provenance and a byte-identical runtime ZIP roundtrip. The native library was restarted with three resources, 39 templates, empty trash and Codex connected, retaining Wukong and the swordsman. Official Spine Editor and Unity Editor acceptance remain unverified.

Evidence: [native library](../../outputs/pink-mage/evidence/native-resources-final.png), [same-scale comparison](../../outputs/pink-mage/evidence/source-registration-comparison.png), [runtime report](../../outputs/pink-mage/evidence/runtime-validation.json), [native terminal frame](../../outputs/pink-mage/evidence/native-death-terminal.png). Earlier sections retain their milestone scope.

## Independent humanoid rig workflow — 2026-10-20

The resource library now offers “新建角色” and a resumable local draft picker. A five-step workspace connects illustration analysis, joint editing, independent part inpainting, rigid/weighted binding, keyframes and validation. Saved authored rigs are labeled “自建骨架” with their bone count; their prepared parts are not presented as zero template replacements. The existing light/violet explorer and resource workflows remain in place.

Live in-app acceptance used an illustration to produce a new 19-joint, 16-part rig and three actions through the signed-in Codex provider. Joint dragging/undo, vertex weight editing, left-hand sword grip, selected-action regeneration, candidate application, 12 image calibrations, draft reload and artifact re-import passed. Calibration retains edits on failure; its error is rendered inside the modal. The normal editor opens authored rigs in its large resource view, and the part workflow returns to the bone editor. AI output remains an editable draft requiring visual review; numerical checks do not constitute production art approval.

The installed native app was reopened with two resources, 39 templates, zero trash and Codex connected, preserving the original 49-part Wukong. The three new actions and constraint reports were checked in the desktop workspace. Core 197, complete-Egg 9, production-serving 4 and actual-package desktop 9 checks passed. Separately, 124 actual-artifact checks covered 363 official-runtime poses and a byte-identical ZIP roundtrip. Official Spine Editor and Unity Editor acceptance remain unverified.

Evidence: [native workspace](../../outputs/rig-authoring/evidence/native-workbench-final.png), [native resources](../../outputs/rig-authoring/evidence/native-resources-final.png), [runtime report](../../outputs/rig-authoring/evidence/runtime-validation.json), [UI checkpoints](../../outputs/rig-authoring/evidence/ui-validation.json). Earlier sections below retain their original milestone scope and counts.

## Selected explorer layout, direct categories, and image gallery — 2026-10-20

**Final result: browser and packaged macOS checks passed; the final app launched and reopened without a Keychain prompt.** The selected target is the third generated mock displayed to the user: light surfaces, violet selection, horizontal navigation, resource rows, central animation and a right inspector. The source image and implementation were inspected at a matching 1440 × 1024 browser viewport with Panda/idle selected. The existing system/PingFang font stack and Lucide outline icons match the target's hierarchy and density. Real template art, real Atlas-region counts and the shared all-action camera are retained.

The user's subsequent changes are intentional adaptations: persistent type/category chips above the template library, 38 built-in templates instead of the mock's 22, and an image-only display mode. The final template display has only two choices: the unchanged one-column list and fixed three-column pictures in the compact left pane. The center animation and right inspector retain the shared workspace proportions. At 1440 × 826, the left pane measures about 418 pixels, the stage 720 pixels and the canvas 459 pixels high. Names and statistics are hidden in the pictures while accessible labels and hover names remain. Selection, search, Character → Person and Effect → Spell filtering, animation seeking and mobile preview/return passed live checks.

Two findings were repaired before acceptance: gallery tracks initially compressed and overlapped; `grid-auto-rows: max-content` now preserves square images and 10–14-pixel row gaps. Short inspector panes now scroll, and keyboard focus reached the fully visible creation control at 1024 × 768 and 800 × 740. Button hover contrast was corrected across the light editor/dialogs. No unresolved P0/P1 visual or interaction finding remains in this scope.

The user's follow-up removed the compact grid choice and changed the gallery from five to three columns. A later correction reduced the gallery's width so it no longer squeezes the animation into a small stacked preview. The one-column list retains its original anatomy and content. The resource library's separate grid mode is preserved.

Native acceptance of the final build confirmed one active Wukong resource and zero trash, 49 replacements, seven actions and Codex connectivity. The installed signed bundle passed eight desktop checks. Startup now leaves encrypted API keys locked; two launches completed without any manual authentication. Explicit API validation/generation can still request normal system confirmation. No authentication prompt was automated.

The selected resource now offers “加入模板” (or “更新模板” after saving), with explicit name/type/categories. Cancel leaves the catalog unchanged. Saved templates appear under “我创建的”, use compact alpha-cropped display thumbnails and retain a large real animation preview. Native Wukong save and restart persistence passed. In the isolated browser flow, all 49 regions, seven actions and two skins survived custom-template creation, reuse, export and re-import; every runtime file matched the original Wukong export byte-for-byte. Source resources and template snapshots remain independent. Custom-only deletion requires a separate in-app confirmation; its actual removal is covered by storage tests, while live UI acceptance cancels the dialog.

Evidence: [final native gallery](../../outputs/desktop/evidence/explorer/native-templates-balanced.png), [native custom template](../../outputs/desktop/evidence/explorer/native-custom-template.png), [custom-template byte validation](../../outputs/desktop/evidence/explorer/custom-template-export-validation.json), [final layout measurements](../../outputs/desktop/evidence/explorer/rebalanced-layout-validation.json), [short-window/mobile access](../../outputs/desktop/evidence/explorer/rebalanced-access-validation.json), [mobile gallery](../../outputs/desktop/evidence/explorer/templates-balanced-mobile.png), [effect animation](../../outputs/desktop/evidence/explorer/frost-effect.png).

Current checks: 121 core, nine complete-Egg, four production-serving and seven actual-bundle desktop checks passed; production build and bundle-signature verification passed. The actual Unity download → isolated import → second download is byte-identical. Unity Editor import and real external API Key generation remain separate, unverified acceptance boundaries. Earlier milestones below retain their original counts, screenshots and visual targets.

## AI setup, permanent trash, and temporary drafts — 2026-10-20

The header now exposes AI connectivity and setup without the Spine version/readiness badge. Codex is the default; API Key setup explains model access, account usage, encrypted desktop storage and session-only fallback. Desktop and narrow browser settings were checked. Permanent trash removal has a separate irreversible-action confirmation and atomic storage guards. Unchanged template drafts do not create library resources when AI creation is opened and closed. The exact return flow preserved browser counts 16/16 after reload and native counts 1/1. Production build, 101 automated checks and seven actual-bundle desktop checks passed. Real external API Key generation remains unverified; native Codex connectivity was verified. Existing Wukong artwork remains present with all 49 replacements.

Date: 2026-10-19

## In-app workflow, parallel generation, and complete Wukong character

The editor and AI dialog expose linked appearance, template-part, calibration/preview, and export steps. A confirmed reference can select the entire template, and the generation action remains visible while the form scrolls. Interrupted jobs can continue only their missing parts from the original prompt/reference snapshot. Part generation offers one to four simultaneous native turns, defaults to three, and lists all in-flight parts.

The desktop app generated all 49 Wukong texture regions through its managed Codex provider. Three real image turns overlapped and returned correctly mapped outputs; ordering, cancellation, partial failure, and native thread isolation passed automated checks. All 49 regions passed calibration bounds, all seven animations were inspected under both skins, and 1,694 CPU poses preserved source geometry. Browser acceptance captured 126 poses with 84 pixel-identical roundtrip comparisons. Actual runtime and editable ZIP downloads remained byte-identical after import/export. Workbench checks: 82/82, no skips. The app's existing resources and trash remain available.

Evidence: [finished resource](../../outputs/panda-wukong/evidence/finished-resource.png), [parallel turns](../../outputs/panda-wukong/evidence/native-parallel-three.png), [all native actions](../../outputs/panda-wukong/evidence/native-actions-contact.png), [complete calibration](../../outputs/panda-wukong/evidence/calibration-all49.png), [verification data](../../outputs/panda-wukong/validation.json).

## iSpine naming and resource trash

The product name is iSpine in the application bundle, native menus, title bar, web title, and README. The existing profile location, bundle identifier, IndexedDB name, and editable archive metadata paths are retained. All three pre-existing resources were observed after launching the renamed app.

The resource inspector has a deletion action with confirmation and cancellation. Resource tabs expose persistent trash and a restore action; discarded projects retain all binary assets, calibration, and appearance references. Native UI checks covered cancellation, deletion, count updates, and trash persistence after restarting. Six storage tests cover restoration fidelity, stale autosave protection, missing IDs, and prevention of automatic sample re-seeding when every resource is in trash. All 76 tests passed, with no skipped checks. Native restore clicks were left to the user after they took control of the app.

Current interface: [iSpine resources](../../outputs/desktop/evidence/ispine-resources.png).

## Scope and comparison target

Source: https://toolivaai.com/ai-studio/spine-workbench and the site's public calibration/detail-editor tutorial captures at https://toolivaai.com/zh/tutorials/spine-workbench-guide .

Implementation: http://127.0.0.1:4173 . The production artifact was also served temporarily at port 4174 and tested before that temporary server was stopped.

The scope covers template import, Codex-native character/part generation, replacement/calibration, real animation, and export/re-import. Billing and memberships are excluded. The local generation provider is implemented independently; no claim is made that the remote service backend is reproduced.

## Evidence and matching states

- Desktop source and implementation were captured at **1280 × 720**, dark theme, template view, Panda selected, attack selected. The combined image is [desktop-comparison.png](../../outputs/verification/desktop-comparison.png).
- Mobile source and implementation were captured at **390 × 844**, template view, Panda selected, attack selected. The combined image is [mobile-comparison.png](../../outputs/verification/mobile-comparison.png).
- Animated pose time differs between source and local captures; pose pixels are not treated as a static fidelity metric. Local paused/synchronized playback is checked separately.
- The source has no creations; the local app contains the validation projects. Resource counts and thumbnails therefore intentionally differ.
- Calibration reference: `work/evidence/source-calibration.webp` and `work/evidence/source-details.webp`. Live implementation evidence: [workbench-preview.png](../../outputs/workbench-preview.png) and [mobile-calibration.png](../../outputs/verification/mobile-calibration.png).
- Browser screenshots were captured at explicit viewport dimensions rather than comparing differently sized sidebar thumbnails. Both source and local images were opened in one combined image for each visual comparison.

## Visual and interaction findings / iterations

### Iteration 1 — blocked

**P1: template rows overlapped in the constrained scroll container.** The first live browser render exposed the issue. The grid's auto tracks shrank while square cards kept their width-derived height.

Fix: use explicit square wrapped cards in the scrolling pane. Post-fix browser measurement showed each card at approximately **296.42 × 296.42 px** at the desktop viewport, with distinct rows. The final desktop combined capture confirms the fix.

### Iteration 2 — blocked

**P2: a transient success message overlapped the mobile calibration footer.** Fix: hide background toasts while any dialog is open. Post-fix evidence is [mobile-calibration.png](../../outputs/verification/mobile-calibration.png); the action button's measured bounds were y=789–823, within the 844 px viewport, and no toast was present.

**P2: header icon buttons lost their names when responsive CSS hid their text.** Fix: explicit accessible names for import and guide controls. The mobile browser confirmed a named import button.

**P2: archive processing could block immediate follow-up interaction.** Fix: move ZIP decode/encode and roundtrip verification to a module worker, show an import progress overlay, and remount the editor for a newly imported bundle. Re-importing an editable package inside an open editor and continuing calibration passed; the production build's worker import/export also passed.

### Final comparison — passed

The dark colors, bordered panels, green selection states, template artwork, two-column desktop layout and side-by-side calibration structure follow the source. No remaining actionable P0/P1/P2 finding in the scoped workflow.

Intentional scope adaptations:

- Local import/save/export replace service account controls.
- The source's mobile layout clips its wide desktop layout; the local version stacks preview, resources and templates and supports a scrollable calibration dialog.
- Local guidance uses a four-step dialog. AI creation follows appearance reference → selected template parts → calibration. Paid controls, publishing, and advanced Warp/selection screens remain outside this milestone.

## Primary interactions exercised

Template filter/search/reset; five representative template renderings including weighted mesh/path/clipping; create/open/save; uploaded replacement; numeric calibration, pointer drag, keyboard nudge, mirror, alpha fit, undo/redo; action/skin/speed/pause/reset/seek; synchronized pose timing; project ZIP download/re-import and parameter restoration; runtime ZIP download; production worker import/export; binary multi-file import; missing-Atlas errors; mobile dialog controls and footer visibility.

Browser console errors checked in development and production: no error/warn at final checks. Tests and build evidence are recorded in [docs/validation.md](../validation.md).

## Remaining acceptance limits

No external engine, physical device, full original-site interaction parity, or deployment acceptance is claimed. Native generation was checked on the partial Panda sample and the complete six-part Egg character. The other 20 templates have input and runtime tests, without live generation quality claims.

## AI generation extension — passed

The existing dark modal, green action colors and calibration anatomy are retained. A two-column AI panel has prompt/reference/part selection on the left and job progress/history/candidates on the right; it stacks and scrolls at 390 × 844. Generated candidates require an explicit application action.

Desktop form and result columns scroll independently so focusing a part search does not hide the candidate history. Mobile uses one continuous scrolling body with the return action fixed in the footer.

- Current account generated a real appearance and two transparent part images. Screenshots: [candidates](../../outputs/generation/candidates.png), [final preview](../../outputs/generation/workbench-preview.png), [mobile flow](../../outputs/generation/mobile-flow.png), [mobile AI calibration](../../outputs/generation/mobile-calibration.png).
- Batch application and single-candidate direct calibration both passed. A refresh restored the reference and pending job. The selected part IDs now restore with job history, preventing a fresh default selection from replacing the original batch selection.
- Production preview connected to the managed ChatGPT account, submitted/cancelled a job, imported the AI project, and downloaded both ZIP types. No browser error/warn at the final checks.
- Real downloaded project re-import restored appearance and manual transforms. Runtime output changed only the selected atlas regions, preserving skeleton/atlas bytes.

## Complete Egg character acceptance — passed

Template 19 was fully replaced with the generated Starberry Jelly Spirit: stem, rotated leaves, weighted-mesh body, both eyes, and mouth. All six were inspected and fitted in the calibration dialog. The body remains free of baked-in eyes/mouth; no duplicate facial features appear after assembly.

All five actions (`atk`, `jifei`, `std`, `std2`, `walk`) were checked at three points before export, after runtime import, and after editable-project import. All 45 browser poses were synchronized; all 30 imported character canvas comparisons were pixel-identical to their pre-export counterparts. Export/re-import restored every calibration and the appearance reference. The runtime ZIPs are byte-identical, and all six regions have changed texture pixels with no visible atlas crop loss.

Evidence and deliverables: [complete character](../../outputs/egg-starberry/README.md). The dedicated `pnpm test:egg` suite passed all nine checks, including 121 samples per action. Browser console: no error/warn.

final result: passed

## Standalone macOS resource workspace — passed

The workbench now opens in an independent desktop window with a draggable title bar, native menus, a fixed resource navigation sidebar, and the existing dark/green visual language. The resource library has searchable thumbnails beside a large live Spine preview; the selected project's part/action/replacement counts stay visible. The editor can focus on the edited character with a searchable parts sidebar or restore the synchronized template comparison.

The packaged Apple Silicon application was opened on this Mac. All 22 templates loaded, and the complete Starberry project was seeded with its six edits, five actions, calibration, appearance reference, and prompts. Native menu navigation, search, animation switching, calibration, template comparison, account connection, and native save/open dialogs were checked. The downloaded editable ZIP re-imported successfully and matched every source file, replacement image, transform, appearance, and prompt.

An immediate quit after changing the project name saved successfully; after a full application restart, both the starter and re-imported project remained available, with the new name and complete character. The resource service stopped with the application and restarted at the same origin. Window bounds restored within the current screen. The app remains open for the user.

Evidence: [resource library](../../outputs/desktop/evidence/resource-library.png), [focused editor](../../outputs/desktop/evidence/focused-editor.png), [native exported project](../../outputs/desktop/evidence/starberry-desktop-project.zip). Desktop checks 7/7, core 50/50, complete Egg 9/9, Sites 4/4; production build and local code-signature verification passed. No new AI image job, notarization, external release, or cross-platform validation is claimed for this wrapper change.
