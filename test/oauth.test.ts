import { afterEach, describe, expect, it, vi } from "vitest";
import { sign } from "../src/cookies.js";
import { API, APP, HOST, INSTALLATION_ID, installationBody, json, makeServer, stubPlatform } from "./helpers.js";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

async function startInstall(server: Awaited<ReturnType<typeof makeServer>>, query = "?platform=base") {
    const response = await server.request(server.app).get(`/install${query}`);
    const location = response.headers.location ? new URL(response.headers.location) : null;
    const cookie = (response.headers["set-cookie"] as unknown as string[] | undefined)?.[0]?.split(";")[0];

    return { response, location, cookie };
}

function tokenRoutes(overrides: Record<string, () => Response> = {}) {
    return stubPlatform({
        [`POST ${API}/oauth/token`]: () =>
            json({
                access_token: "access-1",
                refresh_token: "refresh-1",
                expires_in: 3600,
                scope: "read_products read_organizations",
                webhook_secret: "whsec_new",
            }),
        [`GET ${API}/api/app/v1/installation`]: () => json(installationBody([7, 8])),
        ...overrides,
    });
}

describe("GET /install", () => {
    it("redirects to the platform's consent page with a state kept in a signed cookie", async () => {
        const server = await makeServer({ installed: false });
        const { response, location, cookie } = await startInstall(server);

        expect(response.status).toBe(302);
        expect(location?.origin).toBe(HOST);
        expect(location?.pathname).toBe("/admin/oauth/authorize");
        expect(Object.fromEntries(location?.searchParams ?? [])).toMatchObject({
            client_id: "sample-app",
            redirect_uri: `${APP}/oauth/callback`,
            scope: "read_products read_organizations",
            code_challenge_method: "S256",
        });
        expect(location?.searchParams.get("state")?.length).toBeGreaterThanOrEqual(40);
        expect(location?.searchParams.get("code_challenge")).toBeTruthy();
        const setCookie = String((response.headers["set-cookie"] as unknown as string[])[0]);
        expect(setCookie).toMatch(/HttpOnly/);
        expect(setCookie).toMatch(/SameSite=Lax/);
        expect(setCookie).toMatch(/Secure/);
        expect(cookie).toMatch(/^sample_oauth_state=/);
    });

    it.each([
        ["no platform", ""],
        ["unknown", "?platform=evil"],
        ["prototype key", "?platform=__proto__"],
        ["array", "?platform=base&platform=base"],
        ["constructor", "?platform=constructor"],
    ])("refuses %s", async (_name, query) => {
        const server = await makeServer({ installed: false });
        const { response } = await startInstall(server, query);
        expect(response.status).toBe(400);
        expect(response.headers.location).toBeUndefined();
        expect(response.headers["set-cookie"]).toBeUndefined();
    });
});

describe("GET /oauth/callback", () => {
    it("checks the state, exchanges the code, and records the installation", async () => {
        const fetchMock = tokenRoutes();
        const server = await makeServer({ installed: false });
        const { location, cookie } = await startInstall(server);
        const state = location?.searchParams.get("state");

        const response = await server
            .request(server.app)
            .get(`/oauth/callback?code=the-code&state=${state}&platform=base`)
            .set("Cookie", cookie ?? "");

        expect(response.status).toBe(200);
        expect(response.text).toContain("installed");
        const exchange = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/oauth/token"));
        const form = Object.fromEntries(new URLSearchParams(String(exchange?.[1]?.body)));
        expect(form).toMatchObject({
            grant_type: "authorization_code",
            code: "the-code",
            client_id: "sample-app",
            client_secret: "test-client-secret",
            redirect_uri: `${APP}/oauth/callback`,
        });
        expect(form.code_verifier?.length).toBeGreaterThanOrEqual(40);
        const stored = server.store.get("base");
        expect(stored).toMatchObject({
            installationId: INSTALLATION_ID,
            organizationIds: [7, 8],
            accessToken: "access-1",
            refreshToken: "refresh-1",
            webhookSecret: "whsec_new",
        });
        expect(String((response.headers["set-cookie"] as unknown as string[]).at(-1))).toMatch(/Max-Age=0/);
    });

    async function refused(options: {
        code?: string;
        state?: (real: string) => string;
        cookie?: (real: string) => string | undefined;
        platform?: string;
    }) {
        const fetchMock = tokenRoutes();
        const server = await makeServer({ installed: false });
        const { location, cookie } = await startInstall(server);
        const realState = location?.searchParams.get("state") ?? "";
        const state = options.state?.(realState) ?? realState;
        const usedCookie = options.cookie === undefined ? cookie : options.cookie(cookie ?? "");
        const request = server
            .request(server.app)
            .get(
                `/oauth/callback?code=${options.code ?? "the-code"}&state=${state}${options.platform === undefined ? "" : `&platform=${options.platform}`}`,
            );
        const response = await (usedCookie === undefined ? request : request.set("Cookie", usedCookie));

        return { response, fetchMock, store: server.store };
    }

    it.each([
        ["a wrong state", { state: () => "forged-state" }],
        ["a missing cookie", { cookie: () => undefined }],
        ["a tampered cookie", { cookie: (cookie: string) => cookie.slice(0, -2) + "xx" }],
        [
            "a cookie signed with another secret",
            {
                cookie: () =>
                    `sample_oauth_state=${sign("another-secret-another-secret-123", Buffer.from("{}").toString("base64url"))}`,
            },
        ],
        ["a platform that differs from the one started", { platform: "other" }],
        ["a missing code", { code: "" }],
    ])("refuses %s, without calling the platform", async (_name, options) => {
        const { response, fetchMock, store } = await refused(options);
        expect(response.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(store.get("base")).toBeUndefined();
    });

    it("refuses an expired state", async () => {
        tokenRoutes();
        const server = await makeServer({ installed: false });
        const { location, cookie } = await startInstall(server);
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 11 * 60 * 1000);
        const response = await server
            .request(server.app)
            .get(`/oauth/callback?code=c&state=${location?.searchParams.get("state")}`)
            .set("Cookie", cookie ?? "");
        expect(response.status).toBe(400);
        expect(server.store.get("base")).toBeUndefined();
    });

    it("stores nothing when the code exchange fails", async () => {
        tokenRoutes({ [`POST ${API}/oauth/token`]: () => json({ error: "invalid_grant" }, 400) });
        const server = await makeServer({ installed: false });
        const { location, cookie } = await startInstall(server);
        const response = await server
            .request(server.app)
            .get(`/oauth/callback?code=c&state=${location?.searchParams.get("state")}`)
            .set("Cookie", cookie ?? "");
        expect(response.status).toBe(502);
        expect(server.store.get("base")).toBeUndefined();
    });

    it("keeps the webhook secret across a re-consent of the same installation", async () => {
        tokenRoutes({
            [`POST ${API}/oauth/token`]: () =>
                json({ access_token: "access-9", refresh_token: "refresh-9", expires_in: 3600, scope: "" }),
        });
        const server = await makeServer();
        const { location, cookie } = await startInstall(server);
        await server
            .request(server.app)
            .get(`/oauth/callback?code=c&state=${location?.searchParams.get("state")}`)
            .set("Cookie", cookie ?? "");
        expect(server.store.get("base")).toMatchObject({ accessToken: "access-9", webhookSecret: "whsec_test" });
    });
});
