#!/usr/bin/env python3
"""Upload approved final MP4s through the MOVA admin API and publish their mappings.

The current MOVA console uses ``action=upload_media`` multipart uploads followed by
``action=approve_media``. Approval maps standard assets to ``demo_asset_url`` and
easier assets to ``easier_demo_asset_url`` for every session that uses a movement.
"""
from __future__ import annotations

import argparse
import csv
import json
import mimetypes
import os
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_READ_API = "https://nslfyglqamrhbqfdwftr.supabase.co/functions/v1/mova-console?key=mova_console_demo_v1&mode=admin"


def multipart(fields: dict[str, str], file_path: Path) -> tuple[bytes, str]:
    boundary = f"----mova-factory-{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend((f"--{boundary}\r\n".encode(), f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(), value.encode(), b"\r\n"))
    mime = mimetypes.guess_type(file_path.name)[0] or "video/mp4"
    chunks.extend((f"--{boundary}\r\n".encode(), f'Content-Disposition: form-data; name="file"; filename="{file_path.name}"\r\n'.encode(), f"Content-Type: {mime}\r\n\r\n".encode(), file_path.read_bytes(), b"\r\n", f"--{boundary}--\r\n".encode()))
    return b"".join(chunks), boundary


def request_json(request: Request) -> tuple[int, dict]:
    try:
        with urlopen(request, timeout=180) as response:
            payload = response.read().decode("utf-8")
            return response.status, json.loads(payload) if payload else {}
    except HTTPError as error:
        return error.code, {"error": error.read().decode("utf-8", errors="replace")}
    except URLError as error:
        return 0, {"error": str(error)}


def upload(endpoint: str, key: str, row: dict[str, str], asset: Path) -> tuple[bool, dict]:
    body, boundary = multipart({"action": "upload_media", "movement_code": row["movement_code"], "variant": row["variant"]}, asset)
    request = Request(endpoint, data=body, method="POST", headers={"x-mova-admin-key": key, "Content-Type": f"multipart/form-data; boundary={boundary}", "Accept": "application/json"})
    status, response = request_json(request)
    if not 200 <= status < 300:
        return False, response
    payload = json.dumps({"action": "approve_media", "movement_code": row["movement_code"], "variant": row["variant"]}).encode()
    approval = Request(endpoint, data=payload, method="POST", headers={"x-mova-admin-key": key, "Content-Type": "application/json", "Accept": "application/json"})
    status, response = request_json(approval)
    return 200 <= status < 300, response


def main() -> int:
    factory = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=factory / "movements.csv")
    parser.add_argument("--asset-root", type=Path, default=factory.parent, help="IG repository root containing media/...")
    parser.add_argument("--api-endpoint", default=os.getenv("MOVA_ADMIN_API_URL", ""), help="MOVA admin-write function URL")
    parser.add_argument("--api-key-env", default="MOVA_ADMIN_KEY")
    parser.add_argument("--read-api-url", default=os.getenv("MOVA_ADMIN_READ_URL", DEFAULT_READ_API))
    parser.add_argument("--mode", choices=("dry-run", "upload", "verify"), default="dry-run")
    args = parser.parse_args()
    with args.manifest.open(newline="", encoding="utf-8") as handle:
        rows = [row for row in csv.DictReader(handle) if row.get("qc_status") == "approved"]
    if not rows:
        print("No approved assets to upload or verify.")
        return 0
    key = os.getenv(args.api_key_env, "")
    if args.mode == "upload" and (not args.api_endpoint or not key):
        parser.error("upload requires --api-endpoint/MOVA_ADMIN_API_URL and MOVA_ADMIN_KEY")
    live = {}
    if args.mode == "verify":
        status, payload = request_json(Request(args.read_api_url, headers={"Accept": "application/json"}))
        if not 200 <= status < 300:
            print(f"Could not read MOVA library: {payload}")
            return 1
        live = {item.get("code"): item for item in payload.get("movements", [])}
    failures = 0
    for row in rows:
        asset = args.asset_root / row["output_path"]
        if args.mode == "dry-run":
            print(json.dumps({"would_upload": str(asset), "movement_code": row["movement_code"], "variant": row["variant"], "then": "approve_media"}))
            continue
        if args.mode == "verify":
            field = "demo_asset_url" if row["variant"] == "standard" else "easier_demo_asset_url"
            value = live.get(row["movement_code"], {}).get(field, "")
            ok = bool(value) and "/media/motion.html" not in value
            print(f"{row['movement_code']} {row['variant']}: {'ok' if ok else 'MISSING'}")
        elif not asset.is_file() or asset.stat().st_size == 0:
            ok = False
            print(f"{row['movement_code']} {row['variant']}: MISSING {asset}")
        else:
            ok, response = upload(args.api_endpoint, key, row, asset)
            print(f"{row['movement_code']} {row['variant']}: {'uploaded + approved' if ok else 'FAILED'}")
            if not ok:
                print(json.dumps(response))
        failures += not ok
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
