# ChatGPT

The private **teslabot** plugin is connected to this account through an OpenAI Secure MCP Tunnel. Its proactive workflow skill is saved in version 1.0.1. Open a new ChatGPT conversation with the plugin enabled after an update.

Try: “Use teslabot to list my authorized vehicles.” Then ask for battery status once a vehicle is available and selected in the dashboard.

## What is verified

- The private plugin and its App binding were saved and read back.
- The tunnel runtime was connected, and its configuration doctor passed.
- A local MCP client can invoke the deployed backend's read-only tools.

A tool invocation inside ChatGPT is still unverified. The authorized Tesla account currently lists no vehicles, so real battery readings remain blocked. Installing the plugin does not create a background schedule or authorize calendar access or notification delivery.

## Local runtime

The tunnel runs the bundled MCP server on this Mac. The Mac and runtime must remain online. It is not an always-on cloud agent, and automatic startup after reboot is not configured.

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

The approved OpenAI runtime key has only **Tunnels Read/Use** access and a 30-day expiry. It is stored in macOS Keychain under service `teslabot-openai-tunnel`, account `runtime`; it is supplied to the runtime environment, never bundled into the plugin. Renew it before expiry through the OpenAI API Keys page. The entry helper accepts hidden input and preserves an existing Keychain entry; manage replacement through Keychain Access. Other operating systems should supply `CONTROL_PLANE_API_KEY` through a secret manager.

## Reproduce on another machine

Use the [official Secure MCP Tunnels guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) to download the vendor's tunnel-client release and verify its published SHA-256 checksum. Place the binary at `secrets/tunnel-client/tunnel-client`; do not commit it. Create the tunnel in the intended organization and ChatGPT workspace, create a restricted Read/Use runtime key, and save it using `python3 scripts/configure-tunnel-key.py` on macOS.

Build the plugin and prepare the private `secrets/mcp.json` file as described in [MCP setup](MCP_SETUP.md). Run the connect helper. In ChatGPT, add a custom MCP server using that tunnel and connect it privately. Authentication is provided by the tunnel's OpenAI workspace access; the local stdio target has no separate OAuth server. Its backend requests still use the read-only MCP credential.

Use the host's existing calendar, routing and weather tools. Proactive delivery requires separate opt-in, a real host scheduler and a chosen notification channel. See [proactive behavior](PROACTIVE_PLUGIN.md). No vehicle commands are enabled.
