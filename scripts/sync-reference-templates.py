#!/usr/bin/env python3
"""Mirror public reference templates for local workbench verification.

Only asset data is mirrored. The generated catalog contains local paths and
selected template metadata; remote task, account, and billing data is omitted.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path, PurePosixPath
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse
from urllib.request import Request, urlopen


PROJECT_ROOT = Path(__file__).resolve().parents[1]
API_ROOT = "https://gametoolsapi.toolivaai.com/api/ai-studio/spine"
CATALOG_URL = f"{API_ROOT}/templates?page=1&limit=50&type=all"
REQUEST_HEADERS = {"User-Agent": "AI-Spine-local-reference-sync/1.0"}


def fetch_bytes(url: str) -> bytes:
    """Retry transient public asset failures without increasing concurrency."""
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers=REQUEST_HEADERS), timeout=60) as response:
                return response.read()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1 + attempt * 2)
    raise AssertionError("unreachable")


def fetch_data(url: str) -> dict:
    envelope = json.loads(fetch_bytes(url))
    if envelope.get("code") != 1 or not isinstance(envelope.get("data"), dict):
        raise ValueError("Reference API returned an unsuccessful response")
    return envelope["data"]


def safe_relative_path(value: str) -> Path:
    value = value.replace("\\", "/")
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or any(part in ("..", ".") for part in path.parts):
        raise ValueError(f"Unsafe asset path: {value!r}")
    return Path(*path.parts)


def valid_hash(data: bytes, expected: str | None) -> bool:
    # Some image records expose a non-SHA256 legacy identifier. Only compare
    # hashes whose format identifies the actual SHA256 checksum.
    if not expected or len(expected) != 64:
        return True
    return hashlib.sha256(data).hexdigest().lower() == expected.lower()


def write_asset(folder: Path, name: str, url: str, expected_hash: str | None, force: bool) -> str:
    relative = safe_relative_path(name)
    target = folder / relative
    if not force and target.is_file():
        existing = target.read_bytes()
        if existing and valid_hash(existing, expected_hash):
            return relative.as_posix()
    data = fetch_bytes(url)
    if not data or not valid_hash(data, expected_hash):
        raise ValueError(f"Empty asset or checksum mismatch: {name}")
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.with_name(target.name + ".download")
    staging.write_bytes(data)
    staging.replace(target)
    return relative.as_posix()


def localize_name(value: str | dict | None, language: str, fallback: str = "") -> str:
    if isinstance(value, dict):
        return str(value.get(language) or value.get("zh-CN") or value.get("en-US") or fallback)
    return str(value or fallback)


def sync_template(item: dict, output: Path, force: bool) -> dict:
    template_id = str(item["id"])
    version_id = str(item["versionId"])
    detail = fetch_data(f"{API_ROOT}/templates/{template_id}?version_id={version_id}")
    manifest = detail.get("manifest", {})
    folder = output / safe_relative_path(template_id)
    folder.mkdir(parents=True, exist_ok=True)
    by_role: dict[str, list[str]] = {}
    by_url: dict[str, str] = {}
    for asset in detail.get("assets", []):
        role = asset.get("role")
        if role not in {"skeleton", "atlas", "texture", "role"}:
            continue
        name = write_asset(folder, asset["fileName"], asset["url"], asset.get("hash"), force)
        by_role.setdefault(role, []).append(name)
        by_url[asset["url"]] = name
    for required in ("skeleton", "atlas", "texture"):
        if not by_role.get(required):
            raise ValueError(f"Template {template_id} has no {required} asset")
    if len(by_role["skeleton"]) != 1:
        raise ValueError(f"Template {template_id} has multiple skeletons")
    skeleton_file = by_role["skeleton"][0]
    skeleton = json.loads((folder / skeleton_file).read_text(encoding="utf-8-sig"))
    if not isinstance(skeleton.get("bones"), list) or not isinstance(skeleton.get("animations"), dict):
        raise ValueError(f"Template {template_id} is not a Spine JSON skeleton")
    for texture in manifest.get("texturePages", []):
        if not (folder / safe_relative_path(texture)).is_file():
            raise ValueError(f"Template {template_id} is missing atlas page {texture}")
    for atlas in by_role["atlas"]:
        if not (folder / atlas).read_text(encoding="utf-8-sig").strip():
            raise ValueError(f"Template {template_id} has an empty atlas")
    thumbnail_url = item.get("thumbnailUrl")
    thumbnail_file = by_url.get(thumbnail_url)
    if thumbnail_url and not thumbnail_file:
        extension = Path(urlparse(thumbnail_url).path).suffix.lower()
        if extension not in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
            extension = ".png"
        thumbnail_file = write_asset(folder, "thumbnail" + extension, thumbnail_url, None, force)
    if not thumbnail_file:
        thumbnail_file = next(iter(by_role.get("role", [])), None)
    if not thumbnail_file:
        raise ValueError(f"Template {template_id} has no thumbnail")
    local_folder = f"/templates/{template_id}/"
    record = {
        "id": template_id,
        "name": localize_name(detail.get("name") or item.get("name"), "zh-CN", template_id),
        "nameEn": localize_name(detail.get("name") or item.get("name"), "en-US", template_id),
        "type": detail.get("type", item.get("type", "role")),
        "categories": [localize_name(category.get("name"), "zh-CN", category.get("key", ""))
                       for category in detail.get("categories", item.get("categories", []))],
        "spineVersion": skeleton.get("skeleton", {}).get("spine") or manifest.get("spineVersion"),
        "animationCount": len(skeleton["animations"]),
        "partCount": int(manifest.get("attachmentCount", item.get("partCount", 0))),
        "boneCount": len(skeleton["bones"]),
        "versionId": version_id,
        "folder": local_folder,
        "skeletonFile": skeleton_file,
        "atlasFiles": by_role["atlas"],
        "textureFiles": by_role["texture"],
        "thumbnail": local_folder + thumbnail_file,
        "roleFile": next(iter(by_role.get("role", [])), None),
    }
    validate_record(record, output)
    return record


def validate_record(record: dict, output: Path) -> None:
    folder = output / record["id"]
    files = [record["skeletonFile"], *record["atlasFiles"], *record["textureFiles"]]
    if record["roleFile"]:
        files.append(record["roleFile"])
    for name in files:
        target = folder / safe_relative_path(name)
        if not target.is_file() or target.stat().st_size == 0:
            raise ValueError(f"Missing local asset: {record['id']}/{name}")
    thumbnail = output / safe_relative_path(record["thumbnail"].removeprefix("/templates/"))
    if not thumbnail.is_file() or thumbnail.stat().st_size == 0:
        raise ValueError(f"Missing local thumbnail: {record['id']}")
    serialized = json.dumps(record)
    if "https://" in serialized or "http://" in serialized:
        raise ValueError("Remote asset URL leaked into local catalog")


def write_documentation(records: list[dict], output: Path, path: Path) -> None:
    timestamp = datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")
    files = [file for file in output.rglob("*") if file.is_file()]
    total_bytes = sum(file.stat().st_size for file in files)
    rows = []
    for record in records:
        size = sum(file.stat().st_size for file in (output / record["id"]).rglob("*") if file.is_file())
        rows.append(f"| {record['id']} | {record['name']} | {record['versionId']} | {record['boneCount']} | "
                    f"{record['animationCount']} | {record['partCount']} | {size:,} |")
    content = f"""# Reference template assets

These files are public reference templates downloaded for local recreation and
verification of the AI Spine workbench. Downloading them does not grant ownership
of the source artwork, character IP, animations, or other original-site assets.
Confirm the applicable rights before redistributing these templates or using them
in a published product. The independently implemented application does not copy
the original site's business JavaScript.

- Source workbench: <https://toolivaai.com/ai-studio/spine-workbench>
- Public catalog API: <{CATALOG_URL}>
- Asset origin: `gametoolcdn.toolivaai.com`, as returned by the public template API.
- Download/verification time (Asia/Shanghai): {timestamp}
- Coverage: **{len(records)} templates**, all public entries returned by the catalog at this time.
- Local asset files plus catalog: **{len(files)} files, {total_bytes:,} bytes ({total_bytes / 1024 / 1024:.2f} MiB)**.
- Template Spine versions: {', '.join(sorted({str(record['spineVersion']) for record in records}))}.

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
{chr(10).join(rows)}
"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=PROJECT_ROOT / "public" / "templates")
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=4)
    parser.add_argument("--force", action="store_true", help="Download existing files again")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    listing = fetch_data(CATALOG_URL)
    items = listing.get("items", [])
    if not items or len(items) != int(listing.get("total", len(items))):
        raise ValueError("Public catalog is empty or exceeds this request's page limit")
    results: dict[str, dict] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(sync_template, item, output, args.force): str(item["id"]) for item in items}
        for future in concurrent.futures.as_completed(futures):
            template_id = futures[future]
            try:
                record = future.result()
            except Exception as error:
                raise RuntimeError(f"Template {template_id} sync failed: {error}") from error
            results[template_id] = record
            print(f"Verified template {template_id}: {record['name']}", flush=True)
    records = [results[str(item["id"])] for item in items]
    catalog_file = output / "catalog.json"
    staging = catalog_file.with_suffix(".json.download")
    staging.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    staging.replace(catalog_file)
    write_documentation(records, output, PROJECT_ROOT / "docs" / "reference-assets.md")
    print(f"Complete: {len(records)} templates; all catalog asset references exist locally.")


if __name__ == "__main__":
    main()
