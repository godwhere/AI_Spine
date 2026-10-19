# Design QA — local Spine workbench

Date: 2026-10-19

## Scope and comparison target

Source: https://toolivaai.com/ai-studio/spine-workbench and the site's public calibration/detail-editor tutorial captures at https://toolivaai.com/zh/tutorials/spine-workbench-guide .

Implementation: http://127.0.0.1:4173 . The production artifact was also served temporarily at port 4174 and tested before that temporary server was stopped.

The scope covers template import, Codex-native character/part generation, replacement/calibration, real animation, and export/re-import. Billing and memberships are excluded. The local generation provider is implemented independently; no claim is made that the remote service backend is reproduced.

## Evidence and matching states

- Desktop source and implementation were captured at **1280 × 720**, dark theme, template view, Panda selected, attack selected. The combined image is [desktop-comparison.png](outputs/verification/desktop-comparison.png).
- Mobile source and implementation were captured at **390 × 844**, template view, Panda selected, attack selected. The combined image is [mobile-comparison.png](outputs/verification/mobile-comparison.png).
- Animated pose time differs between source and local captures; pose pixels are not treated as a static fidelity metric. Local paused/synchronized playback is checked separately.
- The source has no creations; the local app contains the validation projects. Resource counts and thumbnails therefore intentionally differ.
- Calibration reference: `work/evidence/source-calibration.webp` and `work/evidence/source-details.webp`. Live implementation evidence: [workbench-preview.png](outputs/workbench-preview.png) and [mobile-calibration.png](outputs/verification/mobile-calibration.png).
- Browser screenshots were captured at explicit viewport dimensions rather than comparing differently sized sidebar thumbnails. Both source and local images were opened in one combined image for each visual comparison.

## Visual and interaction findings / iterations

### Iteration 1 — blocked

**P1: template rows overlapped in the constrained scroll container.** The first live browser render exposed the issue. The grid's auto tracks shrank while square cards kept their width-derived height.

Fix: use explicit square wrapped cards in the scrolling pane. Post-fix browser measurement showed each card at approximately **296.42 × 296.42 px** at the desktop viewport, with distinct rows. The final desktop combined capture confirms the fix.

### Iteration 2 — blocked

**P2: a transient success message overlapped the mobile calibration footer.** Fix: hide background toasts while any dialog is open. Post-fix evidence is [mobile-calibration.png](outputs/verification/mobile-calibration.png); the action button's measured bounds were y=789–823, within the 844 px viewport, and no toast was present.

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

Browser console errors checked in development and production: no error/warn at final checks. Tests and build evidence are recorded in [docs/validation.md](docs/validation.md).

## Remaining acceptance limits

No external engine, physical device, full original-site interaction parity, or deployment acceptance is claimed. Native generation was checked on the partial Panda sample and the complete six-part Egg character. The other 20 templates have input and runtime tests, without live generation quality claims.

## AI generation extension — passed

The existing dark modal, green action colors and calibration anatomy are retained. A two-column AI panel has prompt/reference/part selection on the left and job progress/history/candidates on the right; it stacks and scrolls at 390 × 844. Generated candidates require an explicit application action.

Desktop form and result columns scroll independently so focusing a part search does not hide the candidate history. Mobile uses one continuous scrolling body with the return action fixed in the footer.

- Current account generated a real appearance and two transparent part images. Screenshots: [candidates](outputs/generation/candidates.png), [final preview](outputs/generation/workbench-preview.png), [mobile flow](outputs/generation/mobile-flow.png), [mobile AI calibration](outputs/generation/mobile-calibration.png).
- Batch application and single-candidate direct calibration both passed. A refresh restored the reference and pending job. The selected part IDs now restore with job history, preventing a fresh default selection from replacing the original batch selection.
- Production preview connected to the managed ChatGPT account, submitted/cancelled a job, imported the AI project, and downloaded both ZIP types. No browser error/warn at the final checks.
- Real downloaded project re-import restored appearance and manual transforms. Runtime output changed only the selected atlas regions, preserving skeleton/atlas bytes.

## Complete Egg character acceptance — passed

Template 19 was fully replaced with the generated Starberry Jelly Spirit: stem, rotated leaves, weighted-mesh body, both eyes, and mouth. All six were inspected and fitted in the calibration dialog. The body remains free of baked-in eyes/mouth; no duplicate facial features appear after assembly.

All five actions (`atk`, `jifei`, `std`, `std2`, `walk`) were checked at three points before export, after runtime import, and after editable-project import. All 45 browser poses were synchronized; all 30 imported character canvas comparisons were pixel-identical to their pre-export counterparts. Export/re-import restored every calibration and the appearance reference. The runtime ZIPs are byte-identical, and all six regions have changed texture pixels with no visible atlas crop loss.

Evidence and deliverables: [complete character](outputs/egg-starberry/README.md). The dedicated `pnpm test:egg` suite passed all nine checks, including 121 samples per action. Browser console: no error/warn.

final result: passed

## Standalone macOS resource workspace — passed

The workbench now opens in an independent desktop window with a draggable title bar, native menus, a fixed resource navigation sidebar, and the existing dark/green visual language. The resource library has searchable thumbnails beside a large live Spine preview; the selected project's part/action/replacement counts stay visible. The editor can focus on the edited character with a searchable parts sidebar or restore the synchronized template comparison.

The packaged Apple Silicon application was opened on this Mac. All 22 templates loaded, and the complete Starberry project was seeded with its six edits, five actions, calibration, appearance reference, and prompts. Native menu navigation, search, animation switching, calibration, template comparison, account connection, and native save/open dialogs were checked. The downloaded editable ZIP re-imported successfully and matched every source file, replacement image, transform, appearance, and prompt.

An immediate quit after changing the project name saved successfully; after a full application restart, both the starter and re-imported project remained available, with the new name and complete character. The resource service stopped with the application and restarted at the same origin. Window bounds restored within the current screen. The app remains open for the user.

Evidence: [resource library](outputs/desktop/evidence/resource-library.png), [focused editor](outputs/desktop/evidence/focused-editor.png), [native exported project](outputs/desktop/evidence/starberry-desktop-project.zip). Desktop checks 7/7, core 50/50, complete Egg 9/9, Sites 4/4; production build and local code-signature verification passed. No new AI image job, notarization, external release, or cross-platform validation is claimed for this wrapper change.
