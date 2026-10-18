#!/usr/bin/env python3
"""Create a restricted MCP credential file without displaying any secret."""
import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlparse

parser = argparse.ArgumentParser()
parser.add_argument('--url', required=True, help='Deployed HTTPS backend origin')
args = parser.parse_args()
url = urlparse(args.url)
if url.scheme != 'https' or not url.hostname or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
    raise SystemExit('Provide a fixed HTTPS origin only.')
root = Path(__file__).resolve().parent.parent
values = {}
for line in (root / '.dev.vars').read_text().splitlines():
    if line.startswith('MCP_TOKEN='):
        values['token'] = json.loads(line.split('=', 1)[1])
if len(values.get('token', '')) < 32:
    raise SystemExit('Configure the backend MCP_TOKEN first.')
values['origin'] = args.url.rstrip('/')
os.umask(0o077)
folder = root / 'secrets'
folder.mkdir(exist_ok=True)
path = folder / 'mcp.json'
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as stream:
    json.dump(values, stream)
os.chmod(path, 0o600)
print('Private secrets/mcp.json prepared. It contains only the backend origin and read-only MCP credential.')
