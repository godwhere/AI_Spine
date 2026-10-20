# Third-party notices

## Spine Runtimes

`@esotericsoftware/spine-webgl` and `spine-core`, version 4.3.13, are provided by Esoteric Software LLC under the **Spine Runtimes License Agreement**. They are not MIT-licensed. The included notice is in `licenses/Spine-Runtimes.txt` and the installed packages' source headers.

Official repository: https://github.com/EsotericSoftware/spine-runtimes

## Reference character and effect assets

The 38 reference templates (37 characters and one animated effect, verified on 2026-10-20) are downloaded from Tooliva's publicly accessible workbench for local interoperability and workbench verification. Their artwork, rigs, and animations are not authored by this project. No ownership or redistribution license is asserted. Sources, template classifications, and validation coverage are documented in `docs/reference-assets.md`; per-file SHA256 checks are recorded in `public/templates/download-manifest.json`. The animated effect includes a Spine skeleton, atlas, and packed texture sheet; it is not a separately licensed static skill-icon collection.

The binary test fixture comes from Esoteric Software's official Spineboy example. Its source and hashes are recorded in `tests/fixtures/binary/source.json`; it is used only for interoperability testing.

## Other dependencies

- React / React DOM: MIT, Meta Platforms, Inc. and affiliates.
- Vite / its React plugin: MIT, their contributors.
- fflate: MIT, Arjun Barrett.
- lucide-react: ISC, Lucide contributors. Used for UI icons matching the source's icon family.
- @napi-rs/canvas: MIT, its contributors; used for local image validation and included in the desktop runtime.
- Electron: MIT, OpenJS Foundation and Electron contributors. The desktop bundle retains Electron/Chromium license notices.
- @electron/packager: BSD-2-Clause, its contributors; desktop build dependency.
- fake-indexeddb: Apache-2.0, its contributors; IndexedDB test dependency.

Full package licenses remain in their respective installed distributions and production builds retain dependency notices where provided.
