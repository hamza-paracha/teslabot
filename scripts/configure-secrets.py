#!/usr/bin/env python3
"""Generate local secret material, collect Tesla credentials invisibly, optionally upload."""

import argparse
import base64
import getpass
import json
import os
import secrets
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--tesla", action="store_true")
parser.add_argument(
    "--local",
    action="store_true",
    help="Use a localhost origin for local development only",
)
parser.add_argument(
    "--upload",
    action="store_true",
    help="Upload sensitive keys to Cloudflare; requires approval",
)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
path = root / ".dev.vars"
os.umask(0o077)
values = {}
if path.exists():
    for line in path.read_text().splitlines():
        if line and not line.startswith("#"):
            key, raw = line.split("=", 1)
            values[key] = json.loads(raw)
values.setdefault(
    "TOKEN_ENCRYPTION_KEY", base64.b64encode(secrets.token_bytes(32)).decode()
)
values.setdefault("ADMIN_TOKEN", secrets.token_urlsafe(48))
values.setdefault("MCP_TOKEN", secrets.token_urlsafe(48))
values.setdefault("APP_ORIGIN", os.environ.get("TESLABOT_URL", "http://localhost:8787"))
if args.local:
    values["APP_ORIGIN"] = "http://localhost:8787"
if args.tesla:
    for key in ["TESLA_CLIENT_ID", "TESLA_CLIENT_SECRET"]:
        value = getpass.getpass(key + " (hidden): ").strip()
        if not value:
            raise SystemExit("Empty credential; no changes written.")
        values[key] = value
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write("# Local secrets. Never commit or print this file.\n")
    for key, value in values.items():
        f.write(key + "=" + json.dumps(value) + "\n")
os.chmod(path, 0o600)
print("Local secrets prepared with mode 0600. Existing secrets preserved.")
if args.upload:
    if (
        input(
            "Only after account inspection and deployment approval. Type UPLOAD to continue: "
        )
        != "UPLOAD"
    ):
        raise SystemExit("Upload cancelled; local secrets remain intact.")
    keys = [
        "TOKEN_ENCRYPTION_KEY",
        "ADMIN_TOKEN",
        "MCP_TOKEN",
        "TESLA_CLIENT_ID",
        "TESLA_CLIENT_SECRET",
    ]
    payload = {k: values[k] for k in keys if k in values}
    subprocess.run(
        ["npx", "wrangler", "secret", "bulk"],
        input=json.dumps(payload),
        text=True,
        cwd=root,
        check=True,
    )
    print("Cloudflare secret upload completed. No secret values printed.")
