#!/usr/bin/env python3
"""Manage teslabot's private ChatGPT tunnel using a Keychain runtime credential."""

import argparse
import ctypes
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["connect", "doctor", "status", "stop"])
parser.add_argument("--tunnel-id")
args = parser.parse_args()
binary = root / "secrets/tunnel-client/tunnel-client"
profiles = root / "secrets/tunnel-profiles"
alias = "teslabot"
if not binary.exists():
    raise SystemExit(
        "Install the official tunnel-client into secrets/tunnel-client first. See docs/CHATGPT_SETUP.md."
    )


def runtime_key():
    if os.environ.get("CONTROL_PLANE_API_KEY"):
        return os.environ["CONTROL_PLANE_API_KEY"]
    if sys.platform != "darwin":
        raise SystemExit("Supply CONTROL_PLANE_API_KEY through your secret manager.")
    lib = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
    find = lib.SecKeychainFindGenericPassword
    find.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_char_p,
        ctypes.c_uint32,
        ctypes.c_char_p,
        ctypes.POINTER(ctypes.c_uint32),
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.c_void_p,
    ]
    find.restype = ctypes.c_int32
    service, account = b"teslabot-openai-tunnel", b"runtime"
    size, data = ctypes.c_uint32(), ctypes.c_void_p()
    status = find(
        None,
        len(service),
        service,
        len(account),
        account,
        ctypes.byref(size),
        ctypes.byref(data),
        None,
    )
    if status:
        raise SystemExit(
            "Runtime credential unavailable in Keychain (status "
            + str(status)
            + "). Run scripts/configure-tunnel-key.py."
        )
    try:
        return ctypes.string_at(data, size.value).decode()
    finally:
        free = lib.SecKeychainItemFreeContent
        free.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        free(None, data)


command = [str(binary)]
if args.action == "connect":
    if not args.tunnel_id or not re.fullmatch(r"tunnel_[a-z0-9]{32}", args.tunnel_id):
        raise SystemExit("Provide a real --tunnel-id from your approved OpenAI tunnel.")
    bundle = root / "dist/teslabot/server/index.mjs"
    if not bundle.exists():
        raise SystemExit("Run npm run plugin:build first.")
    node = shutil.which("node")
    if not node:
        raise SystemExit("Node.js 22+ is required.")
    local_command = shlex.join(
        ["env", "TESLABOT_CONFIG=" + str(root / "secrets/mcp.json"), node, str(bundle)]
    )
    command += [
        "runtimes",
        "connect",
        "--alias",
        alias,
        "--profile",
        alias,
        "--profile-dir",
        str(profiles),
        "--tunnel-id",
        args.tunnel_id,
        "--runtime-api-key",
        "env:CONTROL_PLANE_API_KEY",
        "--mcp-command",
        local_command,
        "--json",
    ]
elif args.action == "doctor":
    command += [
        "doctor",
        "--profile",
        alias,
        "--profile-dir",
        str(profiles),
        "--explain",
    ]
elif args.action == "status":
    command += ["runtimes", "status", alias, "--json"]
else:
    command += ["runtimes", "stop", alias, "--json"]

env = os.environ.copy()
if args.action in ("connect", "doctor"):
    env["CONTROL_PLANE_API_KEY"] = runtime_key()
result = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True)
output = result.stdout + result.stderr
if env.get("CONTROL_PLANE_API_KEY"):
    output = output.replace(env["CONTROL_PLANE_API_KEY"], "[REDACTED]")
output = re.sub(r"sk-[A-Za-z0-9_-]{20,}", "[REDACTED]", output)
if args.action != "doctor" and result.returncode == 0:
    try:
        payload = json.loads(result.stdout)

        # Runtime JSON can include logs and environment metadata. Keep routine
        # output small; never echo its configuration or debug log tail.
        def summarize(value):
            if isinstance(value, dict):
                return {
                    key: summarize(item)
                    for key, item in value.items()
                    if key
                    in (
                        "alias",
                        "status",
                        "state",
                        "healthy",
                        "ready",
                        "running",
                        "pid",
                        "health_url",
                        "runtime",
                        "runtimes",
                        "name",
                        "connected",
                        "tunnel_id",
                        "message",
                        "result",
                        "process",
                    )
                }
            if isinstance(value, list):
                return [summarize(item) for item in value]
            return value

        print(
            json.dumps(
                {"action": args.action, "success": True, "runtime": summarize(payload)},
                indent=2,
            )
        )
    except json.JSONDecodeError:
        print("Tunnel action completed successfully.")
else:
    print(output, end="")
sys.exit(result.returncode)
