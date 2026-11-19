import { clearJwksCache } from "@foodpilot/app-bridge/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { API, bearer, installationBody, json, makeServer, makeSigner, stubPlatform } from "./helpers.js";

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

const PRODUCT = {
    id: 42,
    organizationId: 7,
    name: "Tomato sauce",
    reference: "TS-42",
    brand: null,
    category: null,
    status: "active",
    createdAt: "2026-01-01T00:00:00+00:00",
    updatedAt: "2026-01-02T00:00:00+00:00",
};

const productToken = (override: Record<string, unknown> = {}) =>
    signer.token({ slot: "product.details.tab", ctx: { productId: 42 }, ...override });

describe("GET /api/extension/product", () => {
    it("returns the product named by the token's ctx, fetched with the installation token", async () => {
        const fetchMock = platform({ [`GET ${API}/api/app/v1/products/42`]: () => json(PRODUCT) });
        const { app, request } = await makeServer();
        const response = await request(app)
            .get("/api/extension/product")
            .set("Authorization", `Bearer ${await productToken()}`);

        expect(response.status).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.body).toEqual({ id: 42, name: "Tomato sauce" });
        const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/app/v1/products/42"));
        expect(bearer(call?.[1])).toBe("Bearer access-1");
    });

    it("refuses a token without the product slot or without a product", async () => {
        platform();
        const { app, request } = await makeServer();
        for (const token of [
            await signer.token(),
            await signer.token({ slot: "organization.overview.card" }),
            await signer.token({ slot: "product.details.tab" }),
        ]) {
            const response = await request(app).get("/api/extension/product").set("Authorization", `Bearer ${token}`);
            expect(response.status).toBe(403);
            expect(response.body).toEqual({ error: "wrong_slot" });
        }
    });

    it("refuses a missing or wrong token", async () => {
        platform();
        const { app, request } = await makeServer();
        expect((await request(app).get("/api/extension/product")).status).toBe(401);
        const response = await request(app)
            .get("/api/extension/product")
            .set("Authorization", `Bearer ${await productToken({ aud: "another-app" })}`);
        expect(response.status).toBe(401);
    });

    it("answers 404 when the platform hides the product", async () => {
        platform({ [`GET ${API}/api/app/v1/products/42`]: () => json({}, 404) });
        const { app, request } = await makeServer();
        const response = await request(app)
            .get("/api/extension/product")
            .set("Authorization", `Bearer ${await productToken()}`);
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: "product_unavailable" });
    });
});

describe("GET /api/extension/overview", () => {
    it("returns the organisation and the installation date", async () => {
        platform();
        const { app, request } = await makeServer();
        const response = await request(app)
            .get("/api/extension/overview")
            .set("Authorization", `Bearer ${await signer.token({ slot: "organization.overview.card" })}`);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ organizationId: 7, installedAt: "2026-01-01T00:00:00.000Z" });
    });

    it("refuses another slot and a missing token", async () => {
        platform();
        const { app, request } = await makeServer();
        const response = await request(app)
            .get("/api/extension/overview")
            .set("Authorization", `Bearer ${await productToken()}`);
        expect(response.status).toBe(403);
        expect((await request(app).get("/api/extension/overview")).status).toBe(401);
    });
});
