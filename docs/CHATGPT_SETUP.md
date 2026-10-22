# ChatGPT

Connect teslabot to ChatGPT through an OpenAI Secure MCP Tunnel using the setup below. After a plugin update, open a new conversation with the plugin enabled.

Try: “Use teslabot to list my authorized vehicles.” Then ask for battery status once a vehicle is available and selected in the dashboard.

Installing the plugin does not create a background schedule or authorize calendar access or notification delivery. Configure those separately in the host.

## Local runtime

The tunnel runs the bundled MCP server on the host machine. Keep the host and runtime online while using the connection. Configure startup separately if needed.

```sh
npm run plugin:build
python3 scripts/chatgpt-tunnel.py doctor
python3 scripts/chatgpt-tunnel.py status
```

To connect after stopping or rebooting, copy your existing tunnel ID from the OpenAI Tunnels page:

```sh
python3 scripts/chatgpt-tunnel.py connect --tunnel-id YOUR_EXISTING_TUNNEL_ID
```

Stop only this runtime with `python3 scripts/chatgpt-tunnel.py stop`. After rebuilding, stop and reconnect to load the new bundle.

Use a restricted **Tunnels Read/Use** runtime key and store it in a secret manager. On macOS, the helper uses Keychain service `teslabot-openai-tunnel`, account `runtime`. The key is supplied to the runtime environment and never bundled into the plugin. The entry helper accepts hidden input and preserves an existing Keychain entry; manage replacement through Keychain Access. Other operating systems should supply `CONTROL_PLANE_API_KEY` through a secret manager. Renew the key before its configured expiry.

## Configure the connection

Use the [official Secure MCP Tunnels guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) to download the vendor's tunnel-client release and verify its published SHA-256 checksum. Place the binary at `secrets/tunnel-client/tunnel-client`; do not commit it. Create the tunnel in the intended organization and ChatGPT workspace, create a restricted Read/Use runtime key, and save it using `python3 scripts/configure-tunnel-key.py` on macOS.

Build the plugin and prepare the private `secrets/mcp.json` file as described in [MCP setup](MCP_SETUP.md). Run the connect helper. In ChatGPT, add a custom MCP server using that tunnel and connect it privately. Authentication is provided by the tunnel's OpenAI workspace access; the local stdio target has no separate OAuth server. Its backend requests still use the read-only MCP credential.

Use the host's existing calendar, routing and weather tools. Proactive delivery requires separate opt-in, a real host scheduler and a chosen notification channel. See [proactive behavior](PROACTIVE_PLUGIN.md). No vehicle commands are enabled.
