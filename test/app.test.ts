import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { buildManifest } from "../src/manifest.js";
import { StateStore } from "../src/state.js";
import { HOST, makeConfig, makeServer, silentLogger } from "./helpers.js";
import manifestFile from "../manifest.json" with { type: "json" };

describe("embedded page serving", () => {
    function withClient() {
        const clientDir = mkdtempSync(join(tmpdir(), "sample-client-"));
        mkdirSync(join(clientDir, "assets"));
        writeFileSync(join(clientDir, "index.html"), "<!doctype html><title>page</title>");
        mkdirSync(join(clientDir, "extensions"));
        writeFileSync(join(clientDir, "extensions", "product.html"), "<!doctype html><title>product slot</title>");
        writeFileSync(join(clientDir, "extensions", "overview.html"), "<!doctype html><title>overview slot</title>");
        writeFileSync(join(clientDir, "assets", "main.js"), "console.log(1)");
        const config = makeConfig({
            platforms: new Map([
                ["base", { apiOrigin: "https://api.base.positive.test", appOrigin: HOST }],
                ["acme", { apiOrigin: "https://api.acme.example", appOrigin: "https://app.acme.example" }],
            ]),
        });

        return {
            clientDir,
            app: createServer(config, new StateStore(config.stateFile), { clientDir, logger: silentLogger }),
        };
    }

    it("serves the page for /app and every route under it, with frame-ancestors for the known platforms only", async () => {
        const { clientDir, app } = withClient();
        const { default: request } = await import("supertest");
        for (const path of ["/app", "/app/", "/app/reports", "/app/reports/2"]) {
            const response = await request(app).get(path).redirects(0);
            expect(response.status, path).toBe(200);
            expect(response.text).toContain("<title>page</title>");
            expect(response.headers["content-security-policy"]).toBe(
                `frame-ancestors ${HOST} https://app.acme.example`,
            );
        }
        const asset = await request(app).get("/app/assets/main.js");
        expect(asset.status).toBe(200);
        expect(asset.headers["content-security-policy"]).toContain("frame-ancestors");
        expect((await request(app).get("/app/assets/missing.js")).status).toBe(404);
        expect(clientDir).toBeTruthy();
    });

    it("serves each extension page at its manifest path, framed only by the known platforms", async () => {
        const { app } = withClient();
        const { default: request } = await import("supertest");
        for (const [path, title] of [
            ["/app/extensions/product", "product slot"],
            ["/app/extensions/overview", "overview slot"],
        ] as const) {
            const response = await request(app).get(path).redirects(0);
            expect(response.status, path).toBe(200);
            expect(response.text).toContain(`<title>${title}</title>`);
            expect(response.headers["content-security-policy"]).toContain("frame-ancestors");
        }
    });

    it("does not serve the page outside /app, nor give other routes the frame policy", async () => {
        const { app } = withClient();
        const { default: request } = await import("supertest");
        expect((await request(app).get("/application")).status).toBe(404);
        expect((await request(app).get("/application")).headers["content-security-policy"]).not.toContain(
            "frame-ancestors",
        );
        expect((await request(app).get("/healthz")).headers["content-security-policy"]).toBeUndefined();
    });

    it("exposes the known platform-app origins to the page", async () => {
        const { app, request } = await makeServer();
        const response = await request(app).get("/api/config");
        expect(response.body).toEqual({ allowedHosts: [HOST] });
    });
});

describe("loadConfig", () => {
    const env = {
        CLIENT_ID: "sample-app",
        CLIENT_SECRET: "secret",
        APP_ORIGIN: "https://sample-app.base.positive.test",
        PLATFORMS: JSON.stringify({ base: { apiOrigin: "https://api.base.positive.test", appOrigin: HOST } }),
        COOKIE_SECRET: "x".repeat(32),
    };

    it("reads a valid environment", () => {
        const config = loadConfig(env);
        expect(config.platforms.get("base")).toEqual({ apiOrigin: "https://api.base.positive.test", appOrigin: HOST });
        expect(config.port).toBe(3000);
    });

    it.each([
        ["a missing client id", { CLIENT_ID: "" }],
        ["a short cookie secret", { COOKIE_SECRET: "short" }],
        ["an app origin with a path", { APP_ORIGIN: "https://sample.example/app" }],
        ["a trailing slash", { APP_ORIGIN: "https://sample.example/" }],
        ["PLATFORMS that is not JSON", { PLATFORMS: "base" }],
        ["no platform", { PLATFORMS: "{}" }],
        ["a platform without origins", { PLATFORMS: '{"base":{}}' }],
        [
            "an API origin with a path",
            { PLATFORMS: JSON.stringify({ base: { apiOrigin: "https://api.example/x", appOrigin: HOST } }) },
        ],
        [
            "an invalid platform name",
            { PLATFORMS: JSON.stringify({ "Bad Name": { apiOrigin: "https://a.example", appOrigin: HOST } }) },
        ],
        ["a bad port", { PORT: "99999" }],
    ])("refuses %s", (_name, override) => {
        expect(() => loadConfig({ ...env, ...override })).toThrow();
    });
});

describe("manifest", () => {
    it("manifest.json is what `npm run manifest` prints for the local origin", () => {
        expect(manifestFile).toEqual(buildManifest("https://sample-app.base.positive.test"));
    });

    it("keeps every navigation path under the app_url path, by the resolver rule of the design", () => {
        const manifest = buildManifest("https://sample-app.base.positive.test");
        const appUrl = new URL(manifest.app_url);
        expect(manifest).toMatchObject({
            embedded: true,
            handle: "sample-app",
            scopes: ["read_products", "read_organizations"],
        });
        expect(manifest.navigation).toHaveLength(2);
        for (const { path } of manifest.navigation) {
            const resolved = new URL(path, manifest.app_url);
            expect(resolved.origin).toBe(appUrl.origin);
            expect(resolved.pathname === appUrl.pathname || resolved.pathname.startsWith(`${appUrl.pathname}/`)).toBe(
                true,
            );
        }
        expect(manifest.scopes).toContain("read_products");
        expect(manifest.extensions).toEqual([
            {
                slot: "product.details.tab",
                path: "/app/extensions/product",
                label: { en: "Sample facts", fr: "Infos exemple" },
            },
            {
                slot: "organization.overview.card",
                path: "/app/extensions/overview",
                label: { en: "Sample summary", fr: "Résumé exemple" },
            },
        ]);
        for (const { path } of manifest.extensions) {
            expect(new URL(path, manifest.app_url).pathname.startsWith(`${appUrl.pathname}/`)).toBe(true);
        }
        expect(manifest.webhooks).toEqual([
            { topic: "app/uninstalled", uri: "https://sample-app.base.positive.test/webhooks" },
            { topic: "app_subscription/updated", uri: "https://sample-app.base.positive.test/webhooks" },
            { topic: "app_charge/updated", uri: "https://sample-app.base.positive.test/webhooks" },
        ]);
        expect(manifest.redirect_urls).toEqual(["https://sample-app.base.positive.test/oauth/callback"]);
    });
});
