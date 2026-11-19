import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signatureV2, verifyWebhook } from "../src/webhook-signature.js";
import { INSTALLATION_ID, makeServer } from "./helpers.js";

const SECRET = "whsec_test";

interface Delivery {
    body?: string;
    /** Overrides the installation id of the default envelope. */
    installationId?: string;
    topic?: string;
    /** Overrides the topic header only (the body keeps `topic`). */
    headerTopic?: string;
    eventId?: string;
    timestamp?: string;
    secret?: string;
    previousSecret?: string;
    platform?: string;
    signature?: string | null;
}

function build(delivery: Delivery = {}) {
    const topic = delivery.topic ?? "app/uninstalled";
    const installationId = delivery.installationId ?? INSTALLATION_ID;
    const body =
        delivery.body ??
        JSON.stringify({
            id: "evt",
            topic,
            apiVersion: "v1",
            occurredAt: new Date().toISOString(),
            platform: "base",
            installationId,
            organizationId: null,
            data: { installationId, scopes: ["read_products"], organizationIds: [7] },
        });
    const timestamp = delivery.timestamp ?? String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Positive-Platform": delivery.platform ?? "base",
        "X-Positive-Event-Id": delivery.eventId ?? crypto.randomUUID(),
        "X-Positive-Topic": delivery.headerTopic ?? topic,
        "X-Positive-Api-Version": "v1",
        "X-Positive-Timestamp": timestamp,
    };
    if (delivery.signature !== null) {
        headers["X-Positive-Signature-V2"] =
            delivery.signature ?? signatureV2(delivery.secret ?? SECRET, timestamp, body);
    }
    if (delivery.previousSecret !== undefined) {
        headers["X-Positive-Signature-V2-Previous"] = signatureV2(delivery.previousSecret, timestamp, body);
    }

    return { body, headers };
}

async function post(delivery: Delivery = {}, options?: Parameters<typeof makeServer>[0]) {
    const server = await makeServer(options);
    const { body, headers } = build(delivery);
    const response = await server.request(server.app).post("/webhooks").set(headers).send(body);

    return { ...server, response };
}

describe("signature v2", () => {
    it("matches the platform's format: v1= + base64 HMAC-SHA256 of timestamp + '.' + body", () => {
        // Computed independently: printf '1700000000.{"a":1}' | openssl dgst -sha256 -hmac whsec -binary | base64
        expect(signatureV2("whsec", "1700000000", '{"a":1}')).toBe("v1=itN7oVYEiuDgpVM8dc3yb+6IsH+Ty1fuTICtsFMBIDI=");
        const mac = createHmac("sha256", "whsec").update('1700000000.{"a":1}').digest("base64");
        expect(signatureV2("whsec", "1700000000", Buffer.from('{"a":1}'))).toBe(`v1=${mac}`);
    });

    it("verifies, with a 5 minute window", () => {
        const body = Buffer.from("{}");
        const now = 1_700_000_000;
        const sign = (timestamp: number) => signatureV2(SECRET, String(timestamp), body);
        const check = (timestamp: number, signature: string) =>
            verifyWebhook({
                secret: SECRET,
                timestamp: String(timestamp),
                signatures: [signature],
                body,
                nowSeconds: now,
            });

        expect(check(now, sign(now))).toBe("ok");
        expect(check(now - 300, sign(now - 300))).toBe("ok");
        expect(check(now - 301, sign(now - 301))).toBe("stale_timestamp");
        expect(check(now + 301, sign(now + 301))).toBe("stale_timestamp");
        expect(check(now, sign(now - 1))).toBe("bad_signature");
        expect(verifyWebhook({ secret: SECRET, timestamp: "abc", signatures: [], body, nowSeconds: now })).toBe(
            "bad_timestamp",
        );
        expect(verifyWebhook({ secret: SECRET, timestamp: undefined, signatures: [], body, nowSeconds: now })).toBe(
            "bad_timestamp",
        );
    });

    it("rejects a signature of another length without throwing", () => {
        const check = verifyWebhook({
            secret: SECRET,
            timestamp: "1700000000",
            signatures: ["v1=short", ""],
            body: Buffer.from("{}"),
            nowSeconds: 1_700_000_000,
        });
        expect(check).toBe("bad_signature");
    });
});

describe("POST /webhooks", () => {
    it("accepts a valid delivery and forgets the installation on app/uninstalled", async () => {
        const { response, store } = await post();
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: "ok" });
        expect(store.get("base")).toBeUndefined();
    });

    it("keeps the installation for other topics", async () => {
        const { response, store } = await post({ topic: "app/scopes_updated" });
        expect(response.status).toBe(200);
        expect(store.get("base")).toBeDefined();
    });

    it("ignores an uninstall that names another installation", async () => {
        const { response, store } = await post({ installationId: "someone-else" });
        expect(response.status).toBe(200);
        expect(store.get("base")).toBeDefined();
    });

    describe("v1 envelope", () => {
        const envelope = (overrides: Record<string, unknown>) =>
            JSON.stringify({
                id: "evt",
                topic: "app/uninstalled",
                apiVersion: "v1",
                occurredAt: "2026-01-01T00:00:00+00:00",
                platform: "base",
                installationId: INSTALLATION_ID,
                organizationId: null,
                data: { installationId: INSTALLATION_ID },
                ...overrides,
            });

        it("refuses a body whose topic differs from the X-Positive-Topic header", async () => {
            const { response, store } = await post({ headerTopic: "app/scopes_updated" });
            expect(response.status).toBe(400);
            expect(response.body).toEqual({ error: "invalid_envelope" });
            expect(store.get("base")).toBeDefined();
        });

        it("refuses another apiVersion", async () => {
            const { response, store } = await post({ body: envelope({ apiVersion: "v2" }) });
            expect(response.status).toBe(400);
            expect(store.get("base")).toBeDefined();
        });

        it("refuses a body without data, or with data that is not an object", async () => {
            for (const data of [undefined, null, "x", [1]]) {
                const { response } = await post({ body: envelope({ data }) });
                expect(response.status).toBe(400);
            }
        });

        it("refuses the legacy flat payload", async () => {
            const { response } = await post({ body: JSON.stringify({ installationId: INSTALLATION_ID }) });
            expect(response.status).toBe(400);
        });

        it("does not consume the event id of a refused envelope", async () => {
            const server = await makeServer();
            const bad = build({ eventId: "evt-3", headerTopic: "app/scopes_updated" });
            expect((await server.request(server.app).post("/webhooks").set(bad.headers).send(bad.body)).status).toBe(
                400,
            );
            const good = build({ eventId: "evt-3" });
            expect((await server.request(server.app).post("/webhooks").set(good.headers).send(good.body)).body).toEqual(
                { status: "ok" },
            );
        });
    });

    it("refuses a bad signature, and does not forget the installation", async () => {
        const { response, store } = await post({ signature: "v1=AAAA" });
        expect(response.status).toBe(401);
        expect(response.body).toEqual({ error: "bad_signature" });
        expect(store.get("base")).toBeDefined();
    });

    it("refuses a signature made with another secret", async () => {
        expect((await post({ secret: "not-the-secret" })).response.status).toBe(401);
    });

    it("refuses a missing signature", async () => {
        expect((await post({ signature: null })).response.status).toBe(401);
    });

    it("refuses a body that was altered after signing", async () => {
        const server = await makeServer();
        const { headers } = build();
        const response = await server.request(server.app).post("/webhooks").set(headers).send('{"installationId":"x"}');
        expect(response.status).toBe(401);
    });

    it("refuses a stale timestamp even with a valid signature", async () => {
        const { response, store } = await post({ timestamp: String(Math.floor(Date.now() / 1000) - 301) });
        expect(response.status).toBe(401);
        expect(response.body).toEqual({ error: "stale_timestamp" });
        expect(store.get("base")).toBeDefined();
    });

    it("refuses a missing or malformed timestamp", async () => {
        expect((await post({ timestamp: "yesterday", signature: "v1=AAAA" })).response.body).toEqual({
            error: "bad_timestamp",
        });
    });

    it("accepts a delivery whose previous-secret signature matches during a rotation", async () => {
        const { response } = await post({
            secret: "the-new-secret-we-do-not-hold",
            previousSecret: SECRET,
            topic: "app/scopes_updated",
        });
        expect(response.status).toBe(200);
    });

    it("acknowledges a replayed delivery id without acting twice", async () => {
        const server = await makeServer();
        const send = async () => {
            const { body, headers } = build({ eventId: "evt-1", topic: "app/scopes_updated" });

            return server.request(server.app).post("/webhooks").set(headers).send(body);
        };
        expect((await send()).body).toEqual({ status: "ok" });
        expect((await send()).body).toEqual({ status: "duplicate" });
    });

    it("does not record a delivery whose signature is bad, so the genuine retry still acts", async () => {
        const server = await makeServer();
        const forged = build({ eventId: "evt-2", signature: "v1=AAAA" });
        expect((await server.request(server.app).post("/webhooks").set(forged.headers).send(forged.body)).status).toBe(
            401,
        );
        const genuine = build({ eventId: "evt-2" });
        expect(
            (await server.request(server.app).post("/webhooks").set(genuine.headers).send(genuine.body)).body,
        ).toEqual({
            status: "ok",
        });
        expect(server.store.get("base")).toBeUndefined();
    });

    it("refuses an unknown platform, and an installation without a secret", async () => {
        expect((await post({ platform: "other" })).response.status).toBe(401);
        expect((await post({ platform: "__proto__" })).response.status).toBe(401);
        expect((await post({}, { installed: false })).response.status).toBe(401);
    });

    it("refuses a delivery without an event id", async () => {
        const server = await makeServer();
        const { body, headers } = build();
        delete headers["X-Positive-Event-Id"];
        expect((await server.request(server.app).post("/webhooks").set(headers).send(body)).status).toBe(400);
    });
});
