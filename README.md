# Positive app template

A working app for the Positive marketplace, to run as it is or to start yours from. Node.js 22, TypeScript, Express, [`jose`](https://github.com/panva/jose) and [`@foodpilot/app-bridge`](https://www.npmjs.com/package/@foodpilot/app-bridge).

It shows the whole life of an app:

1. **Install**: the OAuth authorization code flow with PKCE, ending with the installation id, the granted organizations and a webhook secret.
2. **Webhooks**: signature v2, a 5-minute replay window, deduplication, `app/uninstalled`, billing events.
3. **Embedded page**: opened inside the platform, it learns who is there from a session token, and uses toast, confirm, navigation, title and loading through App Bridge.
4. **Extension slots**: a product tab and an organization overview card.
5. **Billing**: plans, a subscription, its cancellation.

The guides that explain each part are on the developer portal: **https://developers-staging.foodpilot.tech**. Start with [Run the sample app](https://developers-staging.foodpilot.tech/get-started/sample-app).

## Start

Click **Use this template** on GitHub, or clone this repository, then:

```bash
npm install
cp .env.example .env
```

| Variable | Meaning |
|---|---|
| `CLIENT_ID`, `CLIENT_SECRET` | Your app's OAuth client, from the partner space. The secret is shown once |
| `APP_ORIGIN` | The public HTTPS origin the app is served from, without a path |
| `PLATFORMS` | JSON, the only platforms the app trusts: `{"<name>": {"apiOrigin": "...", "appOrigin": "..."}}`. `apiOrigin` is where tokens and the session-token keys come from; `appOrigin` is the web app that frames your pages |
| `COOKIE_SECRET` | 32 characters or more: `openssl rand -base64 32` |
| `PORT` | Default `3000` |
| `STATE_FILE` | Default `var/state.json` |

```bash
npm run manifest > manifest.json   # the manifest for your APP_ORIGIN, to paste in the partner space
npm run dev                        # Express, with Vite serving the embedded page
```

Serve it on `APP_ORIGIN` over HTTPS: the platform only calls public HTTPS addresses.

## Routes

| Route | What it does |
|---|---|
| `GET /install?platform=` | Redirects to the platform's consent page, with a PKCE challenge and a signed `state` cookie |
| `GET /oauth/callback` | Exchanges the code, reads the installation, records tokens and the webhook secret |
| `POST /webhooks` | Verifies the signature, checks the v1 envelope, deduplicates, acts on the topic |
| `GET /app/*` | The embedded page, framable only by the `appOrigin` of `PLATFORMS` |
| `GET /api/me` | Verifies the session token and returns the user, organization and installation |
| `GET /api/extension/product`, `GET /api/extension/overview` | The two extension slots |
| `/api/billing/*` | Plans, subscribe, current subscription, cancel |
| `GET /healthz` | Liveness |

## Make it yours

- Keep `PLATFORMS` explicit: a platform name from a request is only ever looked up there.
- Replace the JSON state file with a database, and keep: installation id, organizations, tokens (encrypted at rest), webhook secret, handled event ids.
- A route that changes data on a session token's word remembers its `jti` and refuses a second use.

## Checks

```bash
npm run prettier && npm run lint && npm run tsc && npm test && npm run build
```

Production image:

```bash
docker build --target prod-stage -t my-positive-app .
docker run --env-file .env -v app-state:/app/var -p 3000:3000 my-positive-app
```

## License

MIT, see [LICENSE](LICENSE).
