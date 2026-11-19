import { clearJwksCache } from "@foodpilot/app-bridge/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signatureV2 } from "../src/webhook-signature.js";
import {
    API,
    APP,
    bearer,
    INSTALLATION_ID,
    json,
    makeInstallation,
    makeServer,
    makeSigner,
    stubPlatform,
} from "./helpers.js";

let signer: Awaited<ReturnType<typeof makeSigner>>;

const PLAN = {
    id: "0190a1b2-aaaa-7000-8000-000000000001",
    kind: "recurring",
    name: { fr: "Pro", en: "Pro" },
    amount: 4900,
    currency: "eur",
    interval: "month",
    trialDays: 14,
};
const SUBSCRIPTION = {
    id: "0190a1b2-bbbb-7000-8000-000000000002",
    status: "active",
    plan: PLAN,
    trialEndsAt: null,
    currentPeriodEnd: "2026-12-13T10:00:00+00:00",
    cancelAtPeriodEnd: false,
    createdAt: "2026-11-13T10:00:00+00:00",
};

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
        ...extra,
    });
}

const auth = async () => `Bearer ${await signer.token()}`;
const callsTo = (mock: ReturnType<typeof stubPlatform>, method: string, path: string) =>
    mock.mock.calls.filter(([url, init]) => String(url) === `${API}${path}` && (init?.method ?? "GET") === method);

describe("billing routes: authentication", () => {
    it.each([
        ["GET", "/api/billing/plans"],
        ["POST", "/api/billing/subscriptions"],
        ["GET", "/api/billing/subscription"],
        ["POST", "/api/billing/subscription/cancel"],
    ])("%s %s refuses a request without a valid session token", async (method, path) => {
        const mock = platform();
        const { app, request } = await makeServer();
        const agent = request(app);
        const send = method === "GET" ? agent.get(path) : agent.post(path);
        expect((await send).status).toBe(401);
        const forged = method === "GET" ? agent.get(path) : agent.post(path);
        expect((await forged.set("Authorization", "Bearer not-a-jwt")).status).toBe(401);
        expect(callsTo(mock, "GET", "/api/app/v1/billing/plans")).toHaveLength(0);
    });
});

describe("GET /api/billing/plans", () => {
    it("proxies the plans with the stored access token", async () => {
        const mock = platform({ [`GET ${API}/api/app/v1/billing/plans`]: () => json({ items: [PLAN] }) });
        const { app, request } = await makeServer();
        const response = await request(app)
            .get("/api/billing/plans")
            .set("Authorization", await auth());

        expect(response.status).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.body).toEqual({ items: [PLAN] });
        const [call] = callsTo(mock, "GET", "/api/app/v1/billing/plans");
        expect(bearer(call?.[1])).toBe("Bearer access-1");
    });

    it("never hands the access token to the browser", async () => {
        platform({ [`GET ${API}/api/app/v1/billing/plans`]: () => json({ items: [PLAN] }) });
        const { app, request } = await makeServer();
        const response = await request(app)
            .get("/api/billing/plans")
            .set("Authorization", await auth());
        expect(JSON.stringify([response.body, response.headers])).not.toContain("access-1");
    });

    it("refreshes the token once when the platform answers 401", async () => {
        let first = true;
        const mock = platform({
            [`GET ${API}/api/app/v1/billing/plans`]: (_url, init) => {
                if (first) {
                    first = false;

                    return json({ error: "invalid_token" }, 401);
                }

                return bearer(init) === "Bearer access-2" ? json({ items: [] }) : json({}, 401);
            },
            [`POST ${API}/oauth/token`]: () =>
                json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }),
        });
        const { app, request } = await makeServer();
        const response = await request(app)
            .get("/api/billing/plans")
            .set("Authorization", await auth());
        expect(response.status).toBe(200);
        expect(callsTo(mock, "GET", "/api/app/v1/billing/plans")).toHaveLength(2);
    });

    it("answers 502 when the platform is down", async () => {
        platform({ [`GET ${API}/api/app/v1/billing/plans`]: () => json({ title: "down" }, 503) });
        const { app, request } = await makeServer();
        const response = await request(app)
            .get("/api/billing/plans")
            .set("Authorization", await auth());
        expect(response.status).toBe(502);
        expect(response.body).toEqual({ error: "platform_unavailable" });
    });
});

describe("POST /api/billing/subscriptions", () => {
    const created = {
        ...SUBSCRIPTION,
        status: "pending",
        confirmationUrl: "https://app.base.positive.test/marketplace/billing/confirm/subscription/x",
    };

    it("creates the subscription with this app's embedded page as return URL", async () => {
        const mock = platform({ [`POST ${API}/api/app/v1/billing/subscriptions`]: () => json(created, 201) });
        const { app, request } = await makeServer();
        const response = await request(app)
            .post("/api/billing/subscriptions")
            .set("Authorization", await auth())
            .send({ planId: PLAN.id, returnUrl: "https://evil.example/", installationId: "ignored" });

        expect(response.status).toBe(201);
        expect(response.body.confirmationUrl).toBe(created.confirmationUrl);
        const [call] = callsTo(mock, "POST", "/api/app/v1/billing/subscriptions");
        expect(JSON.parse(String(call?.[1]?.body))).toEqual({ planId: PLAN.id, returnUrl: `${APP}/app` });
        expect(bearer(call?.[1])).toBe("Bearer access-1");
    });

    it("requires a plan id, without calling the platform", async () => {
        const mock = platform();
        const { app, request } = await makeServer();
        const response = await request(app)
            .post("/api/billing/subscriptions")
            .set("Authorization", await auth())
            .send({});
        expect(response.status).toBe(422);
        expect(callsTo(mock, "POST", "/api/app/v1/billing/subscriptions")).toHaveLength(0);
    });

    it("passes a business refusal through with its problem type", async () => {
        platform({
            [`POST ${API}/api/app/v1/billing/subscriptions`]: () =>
                json(
                    { type: "https://example.test/errors/subscription-already-live", detail: "Already subscribed." },
                    409,
                ),
        });
        const { app, request } = await makeServer();
        const response = await request(app)
            .post("/api/billing/subscriptions")
            .set("Authorization", await auth())
            .send({ planId: PLAN.id });
        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            error: "billing_refused",
            type: "https://example.test/errors/subscription-already-live",
            detail: "Already subscribed.",
        });
    });

    it("accepts a session token once: a replay is refused", async () => {
        const mock = platform({ [`POST ${API}/api/app/v1/billing/subscriptions`]: () => json(created, 201) });
        const { app, request } = await makeServer();
        const token = `Bearer ${await signer.token({ jti: "fixed-jti" })}`;
        const send = () =>
            request(app).post("/api/billing/subscriptions").set("Authorization", token).send({ planId: PLAN.id });
        expect((await send()).status).toBe(201);
        const replay = await send();
        expect(replay.status).toBe(401);
        expect(replay.body).toEqual({ error: "token_replayed" });
        expect(callsTo(mock, "POST", "/api/app/v1/billing/subscriptions")).toHaveLength(1);
    });
});

describe("GET /api/billing/subscription", () => {
    it("returns the current subscription", async () => {
        platform({ [`GET ${API}/api/app/v1/billing/subscriptions/current`]: () => json(SUBSCRIPTION) });
        const { app, request } = await makeServer();
        const response = await request(app)
            .get("/api/billing/subscription")
            .set("Authorization", await auth());
        expect(response.status).toBe(200);
        expect(response.body.subscription).toEqual(SUBSCRIPTION);
    });

    it("returns null when the installation has none", async () => {
        platform({ [`GET ${API}/api/app/v1/billing/subscriptions/current`]: () => json({ title: "Not found" }, 404) });
        const { app, request } = await makeServer();
        const response = await request(app)
            .get("/api/billing/subscription")
            .set("Authorization", await auth());
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ subscription: null, webhook: { subscription: null, charges: [] } });
    });
});

describe("POST /api/billing/subscription/cancel", () => {
    it("cancels at period end through the platform", async () => {
        const canceled = { ...SUBSCRIPTION, cancelAtPeriodEnd: true };
        const mock = platform({
            [`POST ${API}/api/app/v1/billing/subscriptions/current/cancel`]: () => json(canceled, 202),
        });
        const { app, request } = await makeServer();
        const response = await request(app)
            .post("/api/billing/subscription/cancel")
            .set("Authorization", await auth());
        expect(response.status).toBe(202);
        expect(response.body).toEqual({ subscription: canceled });
        expect(callsTo(mock, "POST", "/api/app/v1/billing/subscriptions/current/cancel")).toHaveLength(1);
    });

    it("shows the refusal when there is nothing to cancel", async () => {
        platform({
            [`POST ${API}/api/app/v1/billing/subscriptions/current/cancel`]: () =>
                json({ detail: "No subscription." }, 404),
        });
        const { app, request } = await makeServer();
        const response = await request(app)
            .post("/api/billing/subscription/cancel")
            .set("Authorization", await auth());
        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({ error: "billing_refused", detail: "No subscription." });
    });
});

describe("billing webhooks", () => {
    const SECRET = "whsec_test";

    async function deliver(
        server: Awaited<ReturnType<typeof makeServer>>,
        topic: string,
        payload: Record<string, unknown>,
        overrides: { secret?: string; eventId?: string } = {},
    ) {
        const data = { installationId: INSTALLATION_ID, ...payload };
        const body = JSON.stringify({
            id: "evt",
            topic,
            apiVersion: "v1",
            occurredAt: new Date().toISOString(),
            platform: "base",
            installationId: data.installationId,
            organizationId: null,
            data,
        });
        const timestamp = String(Math.floor(Date.now() / 1000));

        return server
            .request(server.app)
            .post("/webhooks")
            .set({
                "Content-Type": "application/json",
                "X-Positive-Platform": "base",
                "X-Positive-Event-Id": overrides.eventId ?? crypto.randomUUID(),
                "X-Positive-Topic": topic,
                "X-Positive-Api-Version": "v1",
                "X-Positive-Timestamp": timestamp,
                "X-Positive-Signature-V2": signatureV2(overrides.secret ?? SECRET, timestamp, body),
            })
            .send(body);
    }

    async function latest(server: Awaited<ReturnType<typeof makeServer>>) {
        platform({ [`GET ${API}/api/app/v1/billing/subscriptions/current`]: () => json({}, 404) });
        const response = await server
            .request(server.app)
            .get("/api/billing/subscription")
            .set("Authorization", await auth());

        return response.body.webhook as { subscription: unknown; charges: unknown[] };
    }

    it("keeps the latest subscription status", async () => {
        const server = await makeServer();
        const base = {
            subscriptionId: SUBSCRIPTION.id,
            planId: PLAN.id,
            currentPeriodEnd: null,
            cancelAtPeriodEnd: false,
        };
        expect((await deliver(server, "app_subscription/updated", { ...base, status: "trialing" })).status).toBe(200);
        expect(
            (await deliver(server, "app_subscription/updated", { ...base, status: "active", cancelAtPeriodEnd: true }))
                .status,
        ).toBe(200);
        expect((await latest(server)).subscription).toEqual({
            subscriptionId: SUBSCRIPTION.id,
            status: "active",
            planId: PLAN.id,
            currentPeriodEnd: null,
            cancelAtPeriodEnd: true,
        });
    });

    it("keeps the latest status of each charge", async () => {
        const server = await makeServer();
        await deliver(server, "app_charge/updated", { chargeId: "c1", status: "checkout_started", planId: PLAN.id });
        await deliver(server, "app_charge/updated", { chargeId: "c1", status: "paid", planId: PLAN.id });
        await deliver(server, "app_charge/updated", { chargeId: "c2", status: "declined", planId: PLAN.id });
        expect((await latest(server)).charges).toEqual([
            { chargeId: "c1", status: "paid", planId: PLAN.id },
            { chargeId: "c2", status: "declined", planId: PLAN.id },
        ]);
    });

    it("refuses a bad signature and records nothing", async () => {
        const server = await makeServer();
        const response = await deliver(
            server,
            "app_subscription/updated",
            { subscriptionId: "s1", status: "active" },
            { secret: "wrong" },
        );
        expect(response.status).toBe(401);
        expect((await latest(server)).subscription).toBeNull();
    });

    it("acknowledges a retried delivery without acting twice", async () => {
        const server = await makeServer();
        const eventId = "evt-1";
        const payload = { subscriptionId: "s1", status: "active" };
        expect((await deliver(server, "app_subscription/updated", payload, { eventId })).body).toEqual({
            status: "ok",
        });
        await deliver(server, "app_subscription/updated", { subscriptionId: "s1", status: "canceled" }, { eventId });
        const retried = await deliver(server, "app_subscription/updated", payload, { eventId });
        expect(retried.body).toEqual({ status: "duplicate" });
        expect(((await latest(server)).subscription as { status: string }).status).toBe("active");
    });

    it("ignores an event for another installation or without its fields", async () => {
        const server = await makeServer();
        const other = await deliver(server, "app_subscription/updated", {
            installationId: "0190a1b2-ffff-7000-8000-000000000000",
            subscriptionId: "s1",
            status: "active",
        });
        const malformed = await deliver(server, "app_charge/updated", { status: "paid" });
        expect(other.status).toBe(200);
        expect(malformed.status).toBe(200);
        expect(await latest(server)).toEqual({ subscription: null, charges: [] });
    });

    it("forgets the billing state when the app is uninstalled", async () => {
        const server = await makeServer();
        await deliver(server, "app_subscription/updated", { subscriptionId: "s1", status: "active" });
        await deliver(server, "app/uninstalled", {});
        await server.store.put(makeInstallation());
        expect((await latest(server)).subscription).toBeNull();
    });
});
