# AGENTS.md

Instructions for coding agents working on an app built from this template: an app for the Positive marketplace, installed by customer platforms, that reads their data through the App API, receives webhooks and shows pages inside the platform.

## Documentation

- Index for agents: https://developers-staging.foodpilot.tech/llms.txt (every guide as Markdown, plus the machine-readable contract).
- App API: https://developers-staging.foodpilot.tech/openapi-3.0.json (OpenAPI 3.0).
- Manifest: https://developers-staging.foodpilot.tech/schemas/manifest.v1.schema.json (validate `manifest.json` against it).
- Webhook payloads: https://developers-staging.foodpilot.tech/schemas/webhooks/ (one JSON Schema per topic, listed in llms.txt).

Read the guide of a feature before changing it. Do not invent endpoints, scopes, headers or fields: if the docs and the contract do not have it, it does not exist.

## Layout

| Path | What |
|---|---|
| `src/app.ts` | The routes: install, OAuth callback, webhooks, embedded page, extension slots, billing |
| `src/platform-api.ts` | Calls to a platform: token exchange and refresh, installation, App API |
| `src/installations.ts` | Stored installations and token refresh |
| `src/webhook-signature.ts` | Webhook signature check |
| `src/state.ts` | The JSON state file: replace it with a database for production |
| `src/config.ts` | Environment variables |
| `src/manifest.ts`, `scripts/manifest.ts` | The manifest, printed for `APP_ORIGIN` by `npm run manifest` |
| `client/` | The embedded page and the two extension slots (App Bridge) |
| `test/` | Vitest and supertest |

## Rules

1. **Platforms.** Trust only the platforms in `PLATFORMS`. A platform name from a request is looked up there, never used to build a URL.
2. **Session tokens.** Every `/api/*` route used by the embedded pages verifies `Authorization: Bearer <session token>` with `verifySessionToken` from `@foodpilot/app-bridge/server`, against the recorded installation. Read the product of a product tab from the token's `ctx.productId`, never from the request. A route that changes data accepts each token's `jti` once.
3. **Webhooks.** Verify the signature on the raw body (`express.raw`), within 5 minutes, in constant time, before parsing. Then check the v1 envelope (topic header equals body topic, `apiVersion` is `v1`) and deduplicate on `X-Positive-Event-Id`. Answer 2xx fast; do the work after.
4. **Tokens.** Access tokens stay on the server; the browser never sees one. Store the new refresh token after every refresh: the old one is revoked, and reusing it revokes them all.
5. **Scopes.** Version 1 is read-only: never add a `write_*` scope. Ask only for the scopes the code uses; a `product.details.tab` extension needs `read_products`.
6. **Pages.** Write text with `textContent`, never `innerHTML`. Accept as host only the origins from `/api/config`. Keep `Content-Security-Policy: frame-ancestors` limited to the `appOrigin` of `PLATFORMS`.
7. **Secrets.** Only from the environment. Never commit `.env` or `var/`; never log tokens, secrets or session tokens.

## Commands

```bash
npm install
npm run dev                       # Express, with Vite serving the embedded page
npm run manifest > manifest.json  # the manifest for APP_ORIGIN
npm run prettier && npm run lint && npm run tsc && npm test && npm run build
```

Run the whole line above before you call a change done. Add or update a test in `test/` for every behaviour you change.
