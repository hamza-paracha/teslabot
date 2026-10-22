#!/usr/bin/env python3
"""Store the separately approved tunnel runtime key in macOS Keychain."""
import ctypes
import getpass
import sys

SERVICE = b"teslabot-openai-tunnel"
ACCOUNT = b"runtime"
if sys.platform != "darwin":
    raise SystemExit("This helper uses macOS Keychain. On other systems supply CONTROL_PLANE_API_KEY through your secret manager.")
secret = getpass.getpass("Tunnel runtime key (hidden): ").strip()
if not secret.startswith("sk-") or len(secret) < 32:
    raise SystemExit("Invalid key format; nothing stored.")
value = secret.encode()
security = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
add = security.SecKeychainAddGenericPassword
add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_void_p]
add.restype = ctypes.c_int32
status = add(None, len(SERVICE), SERVICE, len(ACCOUNT), ACCOUNT, len(value), value, None)
secret = ""
value = b""
if status == -25299:
    raise SystemExit("A teslabot tunnel key already exists. Existing credentials were preserved.")
if status != 0:
    raise SystemExit("Keychain storage failed (status " + str(status) + "). No plaintext key was saved.")
print("Tunnel runtime key stored in macOS Keychain. No secret value was displayed or written to the project.")
