# Cloudflare setup

Use a dedicated HTTPS subdomain in an active Cloudflare-managed zone. Keep existing sites, DNS and email records unchanged. A nameserver migration is a separate operation requiring a full record inventory and explicit owner approval; this repository does not automate it.

1. Copy `wrangler.example.jsonc` to ignored `wrangler.jsonc`.
2. Run `npx wrangler login` and `npx wrangler whoami`; confirm the intended account. Set `account_id` if you have more than one account.
3. Confirm the Worker name and intended hostname are unused before creating resources.
4. Run `npx wrangler d1 create evintelligence-production` and put the returned ID in `d1_databases[0].database_id`.
5. Set `routes[0].pattern` and `vars.APP_ORIGIN` to your actual dedicated HTTPS hostname/origin. Keep commands, location and wakes disabled.
6. Apply `npx wrangler d1 migrations apply evintelligence-production --remote` only to the new database.
7. Generate keys with `npm run keys`. Generate secrets with `EVINTELLIGENCE_URL=https://tesla.your-domain.tld python3 scripts/configure-secrets.py`, then upload with its `--upload` option. Existing secret values are preserved; verify the local origin and environment before uploading. Never overwrite a live encryption key casually.
8. Review the config, then run `npx wrangler deploy`. Cloudflare manages the Custom Domain and HTTPS certificate. The hostname must belong to an active zone in this account.
9. Run `EVINTELLIGENCE_URL=https://tesla.your-domain.tld npm run smoke`. This checks HTTPS health, exact public-key matching and unauthenticated protection without calling Tesla.

The private key remains under ignored `secrets/`; only the generated public key under `public/` becomes an asset. Cloudflare Secrets hold ADMIN_TOKEN, MCP_TOKEN, TOKEN_ENCRYPTION_KEY, TESLA_CLIENT_ID and TESLA_CLIENT_SECRET. No cron triggers or public preview URLs are configured.

Keep the same database and encryption key across deployments. Use separate Worker names, D1 databases and credentials for development/staging. See [security](SECURITY.md) for backup and recovery limitations.

Sources: [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).
