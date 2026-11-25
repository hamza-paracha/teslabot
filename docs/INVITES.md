# Invite-only accounts

teslabot is invite-only. The installation operator (whoever holds `ADMIN_TOKEN`) creates single-use invite links. Each person who accepts one becomes a driver account with its own Tesla connection, vehicle, data, alerts, trip plans and MCP credentials.

## Accounts

- **Operator.** Signs in with the administrator credential under "Operator access" on the dashboard. The operator's own car is the original single-owner account. Its data is unchanged by the upgrade, and it keeps working with the installation `MCP_TOKEN`. Only the operator can create invites, register the partner application, and disable or delete driver accounts.
- **Drivers.** Join from an invite link with "Accept with Tesla", and return later with "Sign in with Tesla". The Tesla account is the login. teslabot stores a hash of Tesla's account identifier, never the identifier itself or the ID token. Signing in with a Tesla account that has no invite is refused, and nothing is stored.

## Inviting someone

1. In the dashboard's **Invites** section, enter who it is for and how many days it stays valid (1 to 30), then click **Create invite link**.
2. Send the link. It is shown once, and only its hash is stored. It works once.
3. When they accept, they sign in to Tesla, approve Vehicle Information, and land on their own dashboard. There they select their car, set alerts and create assistant credentials.

An invite can be revoked until it is used. The invite is marked used only when the new account and its encrypted Tesla grant are both saved. If the save fails, the driver can start again from the same invite while it remains valid. Signing in to an already-linked Tesla account does not spend another invite.

The **Drivers** list shows each account, whether its Tesla connection is active, and whether live data is on. **Disable** ends the driver's sessions and blocks their credentials and alerts immediately. **Delete** removes everything stored for the account, and turns off its car's telemetry configuration first. Drivers can delete their own account from the Connection section.

## Assistants

Each driver creates credentials in **Assistant access**. Any assistant that supports remote MCP servers connects to `https://<your domain>/mcp` with the header `Authorization: Bearer tbm_…`. A credential reaches only its own account's car. It reads data and saves trip plans and briefings, but cannot change settings, select a car or reach another account. A driver can hold up to 10 credentials and can revoke any of them.

## Limits and costs

- Each account has its own daily request cap (`MAX_REQUESTS_PER_DAY`) and its own rate limit of 120 requests per minute.
- `MAX_ESTIMATED_MONTHLY_SPEND_USD` caps estimated Fleet API spend across the whole installation, because Tesla bills the application.
- The alert cron checks accounts five at a time, each independently, so a slow car or a failing notification destination affects only that driver.

## Upgrading an existing installation

Apply migration `0003_accounts.sql` before deploying this version:

```sh
npx wrangler d1 migrations apply teslabot-production --remote
```

It creates the account, invite, credential and telemetry tables. It moves existing sessions, usage and pending sign-ins to the owner account, and leaves stored records untouched.
