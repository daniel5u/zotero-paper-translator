"""Generate Zotero's update feed from the exact XPI uploaded to a release."""

import argparse
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import quote
import zipfile


def generate_update(xpi, repository, tag):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Repository must use the owner/repository format.")
    xpi = Path(xpi)
    with zipfile.ZipFile(xpi) as archive:
        manifest = json.loads(archive.read("manifest.json"))
    version = manifest["version"]
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag) or tag != f"v{version}":
        raise ValueError(f"Release tag {tag} must match manifest version v{version}.")
    addon_id = manifest["applications"]["zotero"]["id"]
    return {"addons": {addon_id: {"updates": [{
        "version": version,
        "update_link": f"https://github.com/{repository}/releases/download/{quote('v' + version, safe='')}/{quote(xpi.name, safe='')}",
        "update_hash": "sha256:" + hashlib.sha256(xpi.read_bytes()).hexdigest(),
    }]}}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("xpi", type=Path)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--output", type=Path, default=Path("build/update.json"))
    args = parser.parse_args()
    try:
        update = generate_update(args.xpi, args.repository, args.tag)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(update, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    except (ValueError, KeyError, OSError, zipfile.BadZipFile) as error:
        parser.exit(1, f"Could not generate update manifest: {error}\n")


if __name__ == "__main__":
    main()
