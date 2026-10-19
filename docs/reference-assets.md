# Reference template assets

These files are public reference templates downloaded for local recreation and
verification of the AI Spine workbench. Downloading them does not grant ownership
of the source artwork, character IP, animations, or other original-site assets.
Confirm the applicable rights before redistributing these templates or using them
in a published product. The independently implemented application does not copy
the original site's business JavaScript.

- Source workbench: <https://toolivaai.com/ai-studio/spine-workbench>
- Public catalog API: <https://gametoolsapi.toolivaai.com/api/ai-studio/spine/templates?page=1&limit=50&type=all>
- Asset origin: `gametoolcdn.toolivaai.com`, as returned by the public template API.
- Download/verification time (Asia/Shanghai): 2026-10-19T19:06:32+08:00
- Coverage: **22 templates**, all public entries returned by the catalog at this time.
- Local asset files plus catalog: **89 files, 18,998,287 bytes (18.12 MiB)**.
- Template Spine versions: 4.3.23.

`public/templates/catalog.json` is an array. Every asset reference is local.
`folder` and `thumbnail` are root-relative browser URLs; `skeletonFile`,
`atlasFiles`, `textureFiles`, and `roleFile` are paths relative to `folder`.
When a template's reference image is also its thumbnail, both fields refer to the
same downloaded file. API responses, temporary signed URLs, account information,
and payment/points fields are not retained in the catalog.

The sync script verifies required asset presence, nonempty content, SHA256 hashes
where supplied, valid Spine JSON, and manifest texture-page presence. Skeleton
bone and animation counts are computed from the downloaded JSON. Part counts are
the template manifest's attachment count; attachments can share texture regions.
This data validation does not by itself establish animation rendering or export
compatibility; those are verified separately in the application workflow.

Refresh with `python3 scripts/sync-reference-templates.py`. At most four templates
are downloaded concurrently. Existing matching assets are reused; `--force`
downloads them again. The API metadata is refreshed on every run. Only the
catalog's explicitly selected fields are written to disk.

| ID | Template | Version ID | Bones | Animations | Attachments | Asset bytes |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 22 | 功夫熊猫 | 24 | 145 | 7 | 143 | 1,137,538 |
| 21 | 牛头 | 23 | 27 | 5 | 11 | 460,526 |
| 20 | 蛋仔 | 21 | 7 | 5 | 3 | 289,061 |
| 19 | 蛋仔 | 22 | 14 | 5 | 6 | 231,157 |
| 18 | 女魔王 | 20 | 41 | 5 | 16 | 330,213 |
| 17 | 矮人展示 | 19 | 41 | 8 | 67 | 544,804 |
| 16 | 法师 | 18 | 15 | 11 | 15 | 286,160 |
| 15 | 树精灵 | 17 | 45 | 7 | 28 | 600,940 |
| 14 | 三花妖女 | 16 | 377 | 7 | 114 | 1,800,809 |
| 13 | 女巫师 | 13 | 116 | 7 | 66 | 1,047,047 |
| 12 | 蛇枪 | 12 | 65 | 7 | 58 | 555,773 |
| 11 | 长矛手 | 11 | 15 | 11 | 15 | 514,102 |
| 10 | 冰霜锤手 | 10 | 53 | 5 | 40 | 2,357,121 |
| 9 | 路飞 | 9 | 69 | 8 | 47 | 771,778 |
| 8 | 花仙子 | 8 | 39 | 8 | 21 | 765,181 |
| 7 | 恶魔猎手 | 7 | 59 | 5 | 22 | 1,183,966 |
| 6 | 持骨巨人 | 6 | 31 | 8 | 21 | 933,108 |
| 5 | 翡翠蛇弓手 | 5 | 73 | 8 | 60 | 977,411 |
| 4 | 术士 | 4 | 67 | 8 | 34 | 710,416 |
| 3 | 秘书 | 3 | 31 | 4 | 20 | 322,276 |
| 2 | 机械将军 | 2 | 26 | 7 | 43 | 990,622 |
| 1 | 弓箭手 | 1 | 15 | 11 | 15 | 2,177,188 |
