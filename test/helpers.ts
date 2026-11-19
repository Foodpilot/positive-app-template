import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { vi } from "vitest";
import { createServer, type Logger } from "../src/app.js";
import { SCOPES, type Config } from "../src/config.js";
import { StateStore, type Installation } from "../src/state.js";

export const API = "https://api.base.positive.test";
export const HOST = "https://app.base.positive.test";
export const APP = "https://sample-app.base.positive.test";
export const CLIENT_ID = "sample-app";
export const INSTALLATION_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
export const KID = "key-1";

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined };

export function makeConfig(overrides: Partial<Config> = {}): Config {
    return {
        clientId: CLIENT_ID,
        clientSecret: "test-client-secret",
        appOrigin: APP,
        platforms: new Map([["base", { apiOrigin: API, appOrigin: HOST }]]),
        cookieSecret: "test-cookie-secret-test-cookie-secret",
        port: 3000,
        stateFile: join(mkdtempSync(join(tmpdir(), "sample-app-")), "state.json"),
        scopes: SCOPES,
        ...overrides,
    };
}

export function makeInstallation(overrides: Partial<Installation> = {}): Installation {
    return {
        platform: "base",
        installationId: INSTALLATION_ID,
        handle: "sample-app",
        grantedScopes: ["read_products", "read_organizations"],
        organizationIds: [7],
        accessToken: "access-1",
        accessTokenExpiresAt: Date.now() + 3_600_000,
        refreshToken: "refresh-1",
        webhookSecret: "whsec_test",
        installedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}

export async function makeServer(options: { installed?: boolean; config?: Partial<Config> } = {}) {
    const config = makeConfig(options.config);
    const store = new StateStore(config.stateFile);
    if (options.installed !== false) {
        await store.put(makeInstallation());
    }
    const { default: request } = await import("supertest");

    return { config, store, app: createServer(config, store, { logger: silentLogger }), request };
}

/** A platform signing key and the helpers to mint tokens with it. */
export async function makeSigner() {
    const pair = await generateKeyPair("RS256", { extractable: true });
    const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };

    return {
        publicJwk,
        privateKey: pair.privateKey,
        async token(
            overrides: Record<string, unknown> = {},
            header: { alg: string; kid?: string } = { alg: "RS256", kid: KID },
            key: CryptoKey | Uint8Array = pair.privateKey,
        ): Promise<string> {
            const now = Math.floor(Date.now() / 1000);

            return new SignJWT({
                iss: API,
                dest: HOST,
                aud: CLIENT_ID,
                sub: "0190a1b2-0000-7000-8000-000000000001",
                org: 7,
                inst: INSTALLATION_ID,
                platform: "base",
                locale: "fr",
                jti: crypto.randomUUID(),
                iat: now,
                nbf: now,
                exp: now + 60,
                ...overrides,
            } as never)
                .setProtectedHeader(header)
                .sign(key);
        },
    };
}

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

/** Replaces `fetch` with a router over the platform's endpoints. Returns the mock, for assertions. */
export function stubPlatform(routes: Record<string, Handler>) {
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        const handler = routes[`${init?.method ?? "GET"} ${url.origin}${url.pathname}`];
        if (handler === undefined) {
            return new Response("not stubbed", { status: 599 });
        }

        return handler(url, init);
    });
    vi.stubGlobal("fetch", mock);

    return mock;
}

export const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const installationBody = (organizationIds: number[] = [7]) => ({
    id: INSTALLATION_ID,
    handle: "sample-app",
    platform: "base",
    grantedScopes: ["read_products", "read_organizations"],
    organizationIds,
});

export function bearer(init: RequestInit | undefined): string | undefined {
    const headers = new Headers(init?.headers);

    return headers.get("authorization") ?? undefined;
}
