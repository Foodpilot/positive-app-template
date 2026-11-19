import { clearJwksCache } from "@foodpilot/app-bridge/server";
import { UnsecuredJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
    API,
    bearer,
    INSTALLATION_ID,
    installationBody,
    json,
    makeInstallation,
    makeServer,
    makeSigner,
    stubPlatform,
} from "./helpers.js";

let signer: Awaited<ReturnType<typeof makeSigner>>;

beforeAll(async () => {
    signer = await makeSigner();
});

beforeEach(() => {
    clearJwksCache();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function platform(extra: Parameters<typeof stubPlatform>[0] = {}) {
    return stubPlatform({
        [`GET ${API}/.well-known/jwks.json`]: () => json({ keys: [signer.publicJwk] }),
        [`GET ${API}/api/app/v1/installation`]: () => json(installationBody()),
        ...extra,
    });
}

describe("GET /api/me", () => {
    it("returns the ids for a valid session token, calling the API with the stored token", async () => {
        const fetchMock = platform();
        const { app, request } = await makeServer();
        const response = await request(app)
            .get("/api/me")
            .set("Authorization", `Bearer ${await signer.token()}`);

        expect(response.status).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.body).toMatchObject({
            user: { id: "0190a1b2-0000-7000-8000-000000000001", locale: "fr" },
            organizationId: 7,
            installation: { id: INSTALLATION_ID, handle: "sample-app", organizationIds: [7] },
        });
        const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/app/v1/installation"));
        expect(bearer(call?.[1])).toBe("Bearer access-1");
    });

    it("refuses a request without a bearer token", async () => {
        platform();
        const { app, request } = await makeServer();
        expect((await request(app).get("/api/me")).status).toBe(401);
        expect((await request(app).get("/api/me").set("Authorization", "Basic abc")).status).toBe(401);
        expect((await request(app).get("/api/me").set("Authorization", "Bearer not-a-jwt")).body).toEqual({
            error: "invalid_token",
        });
    });

    it.each([
        ["aud", { aud: "another-app" }],
        ["iss", { iss: "https://api.evil.example" }],
        ["dest", { dest: "https://evil.example" }],
        ["inst", { inst: "0190a1b2-ffff-7000-8000-000000000000" }],
        ["org", { org: 8 }],
    ])("refuses a wrong %s claim", async (_claim, override) => {
        platform();
        const { app, request } = await makeServer();
        const response = await request(app)
            .get("/api/me")
            .set("Authorization", `Bearer ${await signer.token(override)}`);
        expect(response.status).toBe(401);
        expect(response.body).toEqual({ error: "claim_mismatch" });
    });

    it("refuses a platform that is not recorded", async () => {
        platform();
        const { app, request } = await makeServer();
        const response = await request(app)
            .get("/api/me")
            .set("Authorization", `Bearer ${await signer.token({ platform: "other" })}`);
        expect(response.status).toBe(401);
        expect(response.body).toEqual({ error: "unknown_installation" });
        const proto = await request(app)
            .get("/api/me")
            .set("Authorization", `Bearer ${await signer.token({ platform: "__proto__" })}`);
        expect(proto.status).toBe(401);
    });

    it("refuses when the app is not installed on the platform", async () => {
        platform();
        const { app, request } = await makeServer({ installed: false });
        const response = await request(app)
            .get("/api/me")
            .set("Authorization", `Bearer ${await signer.token()}`);
        expect(response.status).toBe(401);
    });

    it("refuses an expired token", async () => {
        platform();
        const { app, request } = await makeServer();
        const now = Math.floor(Date.now() / 1000);
        const token = await signer.token({ iat: now - 300, nbf: now - 300, exp: now - 240 });
        const response = await request(app).get("/api/me").set("Authorization", `Bearer ${token}`);
        expect(response.status).toBe(401);
        expect(response.body).toEqual({ error: "expired" });
    });

    it("refuses an unknown kid", async () => {
        platform();
        const { app, request } = await makeServer();
        const token = await signer.token({}, { alg: "RS256", kid: "rotated-away" });
        const response = await request(app).get("/api/me").set("Authorization", `Bearer ${token}`);
        expect(response.status).toBe(401);
        expect(response.body).toEqual({ error: "invalid_token" });
    });

    it("refuses HS256 and alg none", async () => {
        platform();
        const { app, request } = await makeServer();
        const hs256 = await signer.token(
            {},
            { alg: "HS256", kid: "key-1" },
            new TextEncoder().encode("secret-secret-secret-secret-1234"),
        );
        expect((await request(app).get("/api/me").set("Authorization", `Bearer ${hs256}`)).body).toEqual({
            error: "invalid_token",
        });
        const now = Math.floor(Date.now() / 1000);
        const none = new UnsecuredJWT({
            iss: API,
            dest: "https://app.base.positive.test",
            aud: "sample-app",
            sub: "x",
            org: 7,
            inst: INSTALLATION_ID,
            platform: "base",
            jti: "j",
            iat: now,
            nbf: now,
            exp: now + 60,
        }).encode();
        expect((await request(app).get("/api/me").set("Authorization", `Bearer ${none}`)).body).toEqual({
            error: "invalid_token",
        });
    });

    it("answers 503 when the platform's keys cannot be fetched", async () => {
        platform({ [`GET ${API}/.well-known/jwks.json`]: () => new Response("down", { status: 503 }) });
        const { app, request } = await makeServer();
        const response = await request(app)
            .get("/api/me")
            .set("Authorization", `Bearer ${await signer.token()}`);
        expect(response.status).toBe(503);
    });

    it("refreshes an access token that is about to expire, and stores the rotated refresh token", async () => {
        const fetchMock = platform({
            [`POST ${API}/oauth/token`]: () =>
                json({
                    access_token: "access-2",
                    refresh_token: "refresh-2",
                    expires_in: 3600,
                    scope: "read_products",
                }),
        });
        const { app, request, store } = await makeServer();
        await store.put(makeInstallation({ accessTokenExpiresAt: Date.now() + 5_000 }));
        const response = await request(app)
            .get("/api/me")
            .set("Authorization", `Bearer ${await signer.token()}`);

        expect(response.status).toBe(200);
        const refresh = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/oauth/token"));
        const form = new URLSearchParams(String(refresh?.[1]?.body));
        expect(Object.fromEntries(form)).toMatchObject({
            grant_type: "refresh_token",
            refresh_token: "refresh-1",
            client_id: "sample-app",
            client_secret: "test-client-secret",
        });
        expect(store.get("base")).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
        const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/app/v1/installation"));
        expect(bearer(call?.[1])).toBe("Bearer access-2");
    });

    it("refreshes once and retries when the platform answers 401", async () => {
        let attempts = 0;
        const fetchMock = platform({
            [`GET ${API}/api/app/v1/installation`]: (_url, init) => {
                attempts += 1;

                return bearer(init) === "Bearer access-2" ? json(installationBody()) : json({ error: "expired" }, 401);
            },
            [`POST ${API}/oauth/token`]: () =>
                json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, scope: "" }),
        });
        const { app, request } = await makeServer();
        const response = await request(app)
            .get("/api/me")
            .set("Authorization", `Bearer ${await signer.token()}`);
        expect(response.status).toBe(200);
        expect(attempts).toBe(2);
        expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/oauth/token"))).toHaveLength(1);
    });

    it("shares one refresh between concurrent requests", async () => {
        const fetchMock = platform({
            [`POST ${API}/oauth/token`]: async () => {
                await new Promise((done) => setTimeout(done, 20));

                return json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, scope: "" });
            },
        });
        const { app, request, store } = await makeServer();
        await store.put(makeInstallation({ accessTokenExpiresAt: Date.now() + 1_000 }));
        const token = await signer.token();
        const responses = await Promise.all(
            [1, 2, 3].map(() => request(app).get("/api/me").set("Authorization", `Bearer ${token}`)),
        );
        expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
        expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/oauth/token"))).toHaveLength(1);
    });

    it("learns an organisation granted after install", async () => {
        platform({ [`GET ${API}/api/app/v1/installation`]: () => json(installationBody([7, 9])) });
        const { app, request, store } = await makeServer();
        const response = await request(app)
            .get("/api/me")
            .set("Authorization", `Bearer ${await signer.token({ org: 9 })}`);
        expect(response.status).toBe(200);
        expect(response.body.organizationId).toBe(9);
        expect(store.get("base")?.organizationIds).toEqual([7, 9]);
    });

    it("accepts a descendant of a granted organisation", async () => {
        platform({
            [`GET ${API}/api/app/v1/installation`]: () =>
                json({ ...installationBody([7]), coveredOrganizationIds: [7, 12] }),
        });
        const { app, request, store } = await makeServer();
        const response = await request(app)
            .get("/api/me")
            .set("Authorization", `Bearer ${await signer.token({ org: 12 })}`);
        expect(response.status).toBe(200);
        expect(response.body.organizationId).toBe(12);
        expect(store.get("base")?.coveredOrganizationIds).toEqual([7, 12]);
    });

    it("answers 502 when the platform API is down", async () => {
        platform({ [`GET ${API}/api/app/v1/installation`]: () => new Response("boom", { status: 500 }) });
        const { app, request } = await makeServer();
        const response = await request(app)
            .get("/api/me")
            .set("Authorization", `Bearer ${await signer.token()}`);
        expect(response.status).toBe(502);
    });
});
