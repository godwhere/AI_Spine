# Reference template assets

These public reference character and effect templates are retained for local
interoperability and workbench verification. Downloading them does not grant ownership
of the source artwork, character IP, animations, or other original-site assets.
Confirm the applicable rights before redistributing these templates or using them
in a published product. The independently implemented application does not copy
the original site's business JavaScript.

- Source workbench: <https://toolivaai.com/ai-studio/spine-workbench>
- Public catalog API: <https://gametoolsapi.toolivaai.com/api/ai-studio/spine/templates?page=1&limit=50&type=all>
- Asset origin: `gametoolcdn.toolivaai.com`, as returned by the public template API.
- Download/verification time (Asia/Shanghai): 2026-10-20T01:16:42+08:00
- Coverage: **38 templates**, all public entries returned by the catalog at this time.
- Types: **1 effect**, **37 role**.
- Local asset files plus catalog: **153 files, 29,752,890 bytes (28.37 MiB)**.
- Template Spine versions: 4.3.23.

`public/templates/catalog.json` is an array. Every asset reference is local.
`folder` and `thumbnail` are root-relative browser URLs; `skeletonFile`,
`atlasFiles`, `textureFiles`, and `roleFile` are paths relative to `folder`.
When a template's reference image is also its thumbnail, both fields refer to the
same downloaded file. API responses, temporary signed URLs, account information,
and payment/points fields are not retained in the catalog.

The sync script verifies required asset presence, nonempty content, SHA256 hashes
where supplied, valid Spine JSON, manifest texture-page presence, and actual atlas
page references. `download-manifest.json` records a computed SHA256 for every local
asset and identifies the files also verified against an upstream SHA256. Skeleton
bone and animation counts are computed from the downloaded JSON. Part counts are
the template manifest's attachment count; attachments can share texture regions.
This data validation does not by itself establish animation rendering or export
compatibility; those are verified separately in the application workflow.

Refresh with `python3 scripts/sync-reference-templates.py`. At most four templates
are downloaded concurrently. Existing assets matching an upstream SHA256 are
reused; assets without a verifiable SHA256 are refreshed. `--force` downloads all
assets again. The API metadata is refreshed on every run. Only the
catalog's explicitly selected fields are written to disk.

## Latest synchronization

- Previous catalog: 22 templates.
- Newly added: 16 — 38 冰霜攻击, 37 青牙重刃战士, 36 金羽精灵弓手, 35 金甲圣盾骑士, 34 烈焰装甲怪, 33 金发狮徽剑士, 32 短刃熊猫战士, 31 绿皮双刃魔战士, 30 装甲战士, 29 蓝晶圣盾法师, 28 翠羽长弓游侠, 27 绿皮怪物, 26 碧皮骨爪怪, 25 花杖少女, 24 机车棍棒战士, 23 剑士.
- Existing template version changes: 0 — none.
- Stable source IDs are preserved; this synchronization does not import resources
  into the user's library or modify existing authored projects.

## Effect classification

- ID 38, **冰霜攻击**: `type=effect`, category keys `fate` (display: 法术); 6 bones, 9 attachments, animation names `action`. Runtime source: `lrsc792.json`, `lrsc792.atlas`, `lrsc792.png`.

These effect entries contain Spine skeleton timelines, atlas regions, and texture
pages. They are animation templates, not standalone static skill icons. A PNG used
as the source thumbnail or reference may be the packed texture sheet; that PNG
alone is not the animated effect. Preview the declared animation using the
skeleton and atlas. The public catalog currently exposes the types and categories
listed above; no additional skill-icon library is asserted.

## Template coverage

| ID | Template | Type | Categories | Version ID | Bones | Animations | Attachments | Atlas regions | Asset bytes |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 38 | 冰霜攻击 | effect | 法术 | 41 | 6 | 1 | 9 | 6 | 603,508 |
| 37 | 青牙重刃战士 | role | 怪物 | 39 | 51 | 7 | 54 | 22 | 673,390 |
| 36 | 金羽精灵弓手 | role | 人物 | 38 | 76 | 7 | 83 | 36 | 738,584 |
| 35 | 金甲圣盾骑士 | role | 人物 | 37 | 63 | 7 | 50 | 25 | 697,551 |
| 34 | 烈焰装甲怪 | role | 怪物 | 36 | 40 | 7 | 50 | 25 | 670,876 |
| 33 | 金发狮徽剑士 | role | 人物 | 35 | 45 | 7 | 43 | 23 | 406,781 |
| 32 | 短刃熊猫战士 | role | 怪物 | 34 | 44 | 8 | 27 | 13 | 462,957 |
| 31 | 绿皮双刃魔战士 | role | 怪物 | 40 | 26 | 7 | 43 | 21 | 1,911,375 |
| 30 | 装甲战士 | role | 人物 | 32 | 35 | 7 | 37 | 28 | 403,941 |
| 29 | 蓝晶圣盾法师 | role | 人物 | 31 | 70 | 8 | 74 | 33 | 827,590 |
| 28 | 翠羽长弓游侠 | role | 人物 | 30 | 126 | 7 | 76 | 34 | 1,095,664 |
| 27 | 绿皮怪物 | role | 怪物 | 29 | 30 | 6 | 24 | 23 | 417,217 |
| 26 | 碧皮骨爪怪 | role | 怪物 | 28 | 37 | 7 | 30 | 15 | 438,096 |
| 25 | 花杖少女 | role | 人物 | 27 | 58 | 8 | 32 | 27 | 419,240 |
| 24 | 机车棍棒战士 | role | 人物 | 26 | 29 | 7 | 19 | 17 | 368,061 |
| 23 | 剑士 | role | 人物 | 25 | 15 | 11 | 15 | 15 | 549,925 |
| 22 | 功夫熊猫 | role | 人物 / 怪物 | 24 | 145 | 7 | 143 | 49 | 1,137,538 |
| 21 | 牛头 | role | 怪物 | 23 | 27 | 5 | 11 | 11 | 460,526 |
| 20 | 蛋仔 | role | 怪物 | 21 | 7 | 5 | 3 | 2 | 289,061 |
| 19 | 蛋仔 | role | 怪物 | 22 | 14 | 5 | 6 | 6 | 231,157 |
| 18 | 女魔王 | role | 怪物 | 20 | 41 | 5 | 16 | 16 | 330,213 |
| 17 | 矮人展示 | role | 怪物 | 19 | 41 | 8 | 67 | 32 | 544,804 |
| 16 | 法师 | role | 人物 | 18 | 15 | 11 | 15 | 15 | 286,160 |
| 15 | 树精灵 | role | 人物 / 怪物 | 17 | 45 | 7 | 28 | 14 | 600,940 |
| 14 | 三花妖女 | role | 怪物 | 16 | 377 | 7 | 114 | 54 | 1,800,809 |
| 13 | 女巫师 | role | 人物 / 怪物 | 13 | 116 | 7 | 66 | 31 | 1,047,047 |
| 12 | 蛇枪 | role | 人物 / 怪物 | 12 | 65 | 7 | 58 | 25 | 555,773 |
| 11 | 长矛手 | role | 人物 | 11 | 15 | 11 | 15 | 15 | 514,102 |
| 10 | 冰霜锤手 | role | 怪物 | 10 | 53 | 5 | 40 | 40 | 2,357,121 |
| 9 | 路飞 | role | 人物 | 9 | 69 | 8 | 47 | 30 | 771,778 |
| 8 | 花仙子 | role | 怪物 | 8 | 39 | 8 | 21 | 19 | 765,181 |
| 7 | 恶魔猎手 | role | 怪物 | 7 | 59 | 5 | 22 | 22 | 1,183,966 |
| 6 | 持骨巨人 | role | 人物 / 怪物 | 6 | 31 | 8 | 21 | 20 | 933,108 |
| 5 | 翡翠蛇弓手 | role | 人物 / 怪物 | 5 | 73 | 8 | 60 | 39 | 977,411 |
| 4 | 术士 | role | 人物 | 4 | 67 | 8 | 34 | 33 | 710,416 |
| 3 | 秘书 | role | 人物 | 3 | 31 | 4 | 20 | 20 | 322,276 |
| 2 | 机械将军 | role | 人物 / 怪物 | 2 | 26 | 7 | 43 | 21 | 990,622 |
| 1 | 弓箭手 | role | 人物 | 1 | 15 | 11 | 15 | 15 | 2,177,188 |
