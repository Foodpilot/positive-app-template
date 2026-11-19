import { randomBytes, createHash } from "node:crypto";
import { resolve } from "node:path";
import { SessionTokenError, verifySessionToken, type SessionTokenClaims } from "@foodpilot/app-bridge/server";
import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import { decodeJwt } from "jose";
import { constantTimeEqual, parseCookies, sign, unsign } from "./cookies.js";
import { BillingEvents, isBillingTopic } from "./billing.js";
import type { Config, PlatformConfig } from "./config.js";
import { escapeHtml, page } from "./html.js";
import { InstallationService } from "./installations.js";
import { exchangeCode, fetchInstallation, PlatformApiError } from "./platform-api.js";
import type { StateStore } from "./state.js";
import { verifyWebhook } from "./webhook-signature.js";

export interface Logger {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
    info: (message, fields) => console.log(JSON.stringify({ level: "info", message, ...fields })),
    warn: (message, fields) => console.warn(JSON.stringify({ level: "warn", message, ...fields })),
};

export interface ServerOptions {
    logger?: Logger;
    /** Serves `/app/*`. Default: the built page in `dist/client`. In dev, `index.ts` passes Vite's middleware. */
    appHandler?: RequestHandler;
    clientDir?: string;
}

const STATE_COOKIE = "sample_oauth_state";
const STATE_MAX_AGE_SECONDS = 600;

/** Extension pages (manifest `extensions`), built as separate HTML files next to the embedded page. */
const EXTENSION_PAGES = new Map([
    ["/extensions/product", "extensions/product.html"],
    ["/extensions/overview", "extensions/overview.html"],
]);

const isAppPath = (path: string): boolean => path === "/app" || path.startsWith("/app/");

function staticAppHandler(clientDir: string): RequestHandler {
    const router = express.Router();
    router.use("/app", express.static(clientDir, { index: false, redirect: false, fallthrough: true }));
    router.use("/app", (request, response, next) => {
        // Any path without a file extension is a route of the embedded page, except the extension pages.
        if ((request.method === "GET" || request.method === "HEAD") && !/\.[a-z0-9]+$/i.test(request.path)) {
            response.setHeader("Cache-Control", "no-store");
            const extension = EXTENSION_PAGES.get(request.path.replace(/\/$/, ""));
            response.sendFile(resolve(clientDir, extension ?? "index.html"));

            return;
        }
        next();
    });

    return router;
}

function singleValue(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function header(request: Request, name: string): string | undefined {
    const value = request.headers[name];

    return typeof value === "string" ? value : undefined;
}

function sendPage(response: Response, status: number, title: string, body: string): void {
    response.status(status).type("html").setHeader("Cache-Control", "no-store").send(page(title, body));
}

export function createServer(config: Config, store: StateStore, options: ServerOptions = {}): Express {
    const logger = options.logger ?? consoleLogger;
    const installations = new InstallationService(config, store);
    const billing = new BillingEvents();
    const secureCookies = config.appOrigin.startsWith("https://");
    const frameAncestors = [...new Set([...config.platforms.values()].map((platform) => platform.appOrigin))].join(" ");
    const app = express();
    app.disable("x-powered-by");

    // --- Install -----------------------------------------------------------------------------------------------

    app.get("/install", (request, response) => {
        const name = singleValue(request.query.platform);
        // Only platforms listed in PLATFORMS: a crafted name can never make the app trust another API or JWKS.
        const platform = name === undefined ? undefined : config.platforms.get(name);
        if (name === undefined || platform === undefined) {
            sendPage(response, 400, "Unknown platform", "<p>This app is not available for that platform.</p>");

            return;
        }
        const state = randomBytes(32).toString("base64url");
        const verifier = randomBytes(32).toString("base64url");
        const cookie = sign(
            config.cookieSecret,
            Buffer.from(JSON.stringify({ state, verifier, platform: name, at: Date.now() })).toString("base64url"),
        );
        response.append(
            "Set-Cookie",
            `${STATE_COOKIE}=${cookie}; Path=/oauth; HttpOnly; SameSite=Lax; Max-Age=${STATE_MAX_AGE_SECONDS}${secureCookies ? "; Secure" : ""}`,
        );
        const authorize = new URL("/admin/oauth/authorize", platform.appOrigin);
        authorize.search = new URLSearchParams({
            client_id: config.clientId,
            redirect_uri: `${config.appOrigin}/oauth/callback`,
            scope: config.scopes.join(" "),
            state,
            code_challenge: createHash("sha256").update(verifier).digest("base64url"),
            code_challenge_method: "S256",
        }).toString();
        response.setHeader("Cache-Control", "no-store");
        response.redirect(authorize.toString());
    });

    app.get("/oauth/callback", async (request, response) => {
        const clearCookie = `${STATE_COOKIE}=; Path=/oauth; HttpOnly; SameSite=Lax; Max-Age=0${secureCookies ? "; Secure" : ""}`;
        response.append("Set-Cookie", clearCookie);
        const refuse = (reason: string): void => {
            logger.warn("oauth callback refused", { reason });
            sendPage(
                response,
                400,
                "Installation failed",
                "<p>The installation could not be completed. Start again from Foodpilot.</p>",
            );
        };

        const signed = parseCookies(request.headers.cookie).get(STATE_COOKIE);
        const payload = signed === undefined ? null : unsign(config.cookieSecret, signed);
        let saved: { state: string; verifier: string; platform: string; at: number };
        try {
            saved = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf-8"));
        } catch {
            refuse("missing or invalid state cookie");

            return;
        }
        const state = singleValue(request.query.state);
        const code = singleValue(request.query.code);
        if (payload === null || state === undefined || !constantTimeEqual(saved.state, state)) {
            refuse("state mismatch");

            return;
        }
        if (typeof saved.at !== "number" || Date.now() - saved.at > STATE_MAX_AGE_SECONDS * 1000) {
            refuse("state expired");

            return;
        }
        const returned = singleValue(request.query.platform);
        if (returned !== undefined && returned !== saved.platform) {
            refuse("platform mismatch");

            return;
        }
        const platform = config.platforms.get(saved.platform);
        if (platform === undefined) {
            refuse("unknown platform");

            return;
        }
        if (code === undefined || code === "") {
            refuse(`no code (${singleValue(request.query.error) ?? "none"})`);

            return;
        }

        try {
            const tokens = await exchangeCode(config, platform, code, saved.verifier);
            const info = await fetchInstallation(platform, tokens.accessToken);
            if (info.platform !== saved.platform) {
                refuse("installation reports another platform");

                return;
            }
            await store.put(installations.withTokens(store.get(saved.platform), saved.platform, info, tokens));
            logger.info("installed", {
                platform: saved.platform,
                installationId: info.id,
                organizationIds: info.organizationIds,
            });
            sendPage(
                response,
                200,
                "Sample app installed",
                `<p>Installed on <strong>${escapeHtml(saved.platform)}</strong> for ${info.organizationIds.length} organisation(s).</p>` +
                    `<p><a href="${escapeHtml(platform.appOrigin)}/apps/${escapeHtml(info.handle)}">Open it in Foodpilot</a></p>`,
            );
        } catch (error) {
            logger.warn("oauth exchange failed", {
                platform: saved.platform,
                error: error instanceof Error ? error.message : "unknown",
            });
            sendPage(
                response,
                502,
                "Installation failed",
                "<p>The platform did not complete the installation. Try again.</p>",
            );
        }
    });

    // --- Webhooks ----------------------------------------------------------------------------------------------

    app.post("/webhooks", express.raw({ type: () => true, limit: "256kb" }), async (request, response) => {
        const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        const platform = header(request, "x-positive-platform") ?? "";
        const installation = store.get(platform);
        if (installation === undefined || installation.webhookSecret === null) {
            response.status(401).json({ error: "unknown_installation" });

            return;
        }
        const check = verifyWebhook({
            secret: installation.webhookSecret,
            timestamp: header(request, "x-positive-timestamp"),
            signatures: [
                header(request, "x-positive-signature-v2"),
                header(request, "x-positive-signature-v2-previous"),
            ],
            body,
            nowSeconds: Date.now() / 1000,
        });
        if (check !== "ok") {
            logger.warn("webhook refused", { platform, reason: check });
            response.status(401).json({ error: check });

            return;
        }
        const deliveryId = header(request, "x-positive-event-id");
        if (deliveryId === undefined || deliveryId === "" || deliveryId.length > 128) {
            response.status(400).json({ error: "missing_event_id" });

            return;
        }
        let envelope: Record<string, unknown>;
        try {
            envelope = JSON.parse(body.toString("utf-8")) as Record<string, unknown>;
        } catch {
            response.status(400).json({ error: "invalid_json" });

            return;
        }
        // Every delivery is a v1 envelope: the topic header says what the body is, and `data` carries the payload.
        const topic = header(request, "x-positive-topic") ?? "";
        const data = envelope.data;
        if (
            topic === "" ||
            envelope.topic !== topic ||
            envelope.apiVersion !== "v1" ||
            typeof data !== "object" ||
            data === null ||
            Array.isArray(data)
        ) {
            logger.warn("webhook refused: not a v1 envelope", {
                platform,
                headerTopic: topic,
                bodyTopic: typeof envelope.topic === "string" ? envelope.topic : null,
                apiVersion: typeof envelope.apiVersion === "string" ? envelope.apiVersion : null,
                hasData: typeof data === "object" && data !== null && !Array.isArray(data),
            });
            response.status(400).json({ error: "invalid_envelope" });

            return;
        }
        // A retried delivery carries the same event id: acknowledge it without acting twice.
        if (!(await store.claimDelivery(platform, deliveryId, Date.now()))) {
            response.status(200).json({ status: "duplicate" });

            return;
        }
        logger.info("webhook received", { platform, topic, deliveryId });
        if (envelope.installationId !== installation.installationId) {
            logger.warn("webhook for another installation", { platform, topic, deliveryId });
        } else if (topic === "app/uninstalled") {
            await store.remove(platform);
            billing.forget(platform);
            logger.info("installation forgotten", { platform, installationId: installation.installationId });
        } else if (isBillingTopic(topic)) {
            const recorded = billing.record(platform, topic, data as Record<string, unknown>);
            if (recorded === null) {
                logger.warn("billing webhook malformed", { platform, topic, deliveryId });
            } else {
                logger.info("billing status", { platform, topic, ...recorded });
            }
        }
        response.status(200).json({ status: "ok" });
    });

    // --- API for the embedded page -----------------------------------------------------------------------------

    app.get("/api/config", (_request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.json({
            allowedHosts: [...new Set([...config.platforms.values()].map((platform) => platform.appOrigin))],
        });
    });

    interface Session {
        platformName: string;
        platform: PlatformConfig;
        claims: SessionTokenClaims;
    }

    const sendPlatformError = (response: Response, platformName: string, error: unknown): void => {
        if (error instanceof SessionTokenError) {
            response.status(error.code === "jwks_unavailable" ? 503 : 401).json({ error: error.code });

            return;
        }
        logger.warn("platform call failed", {
            platform: platformName,
            error: error instanceof Error ? error.message : "unknown",
        });
        response
            .status(error instanceof PlatformApiError && error.status === 404 ? 401 : 502)
            .json({ error: "platform_unavailable" });
    };

    /** Verifies the session token against the recorded installation. Answers the error itself and returns null. */
    const authenticate = async (request: Request, response: Response): Promise<Session | null> => {
        response.setHeader("Cache-Control", "no-store");
        const match = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? "");
        if (match?.[1] === undefined) {
            response.status(401).json({ error: "missing_token" });

            return null;
        }
        const token = match[1];
        // The unverified `platform` claim only picks which recorded installation to verify against.
        let platformName: unknown;
        try {
            platformName = decodeJwt(token).platform;
        } catch {
            response.status(401).json({ error: "invalid_token" });

            return null;
        }
        const platform = typeof platformName === "string" ? config.platforms.get(platformName) : undefined;
        const installation = typeof platformName === "string" ? store.get(platformName) : undefined;
        if (typeof platformName !== "string" || platform === undefined || installation === undefined) {
            response.status(401).json({ error: "unknown_installation" });

            return null;
        }
        const verify = (current: typeof installation): Promise<SessionTokenClaims> =>
            verifySessionToken(token, {
                apiOrigin: platform.apiOrigin,
                appOrigin: platform.appOrigin,
                clientId: config.clientId,
                platform: platformName,
                installationId: current.installationId,
                organizationIds: current.coveredOrganizationIds ?? current.organizationIds,
            });

        try {
            try {
                return { platformName, platform, claims: await verify(installation) };
            } catch (error) {
                // The organisation may have been granted after install: refresh what we recorded, once.
                if (!(error instanceof SessionTokenError) || error.claim !== "org") {
                    throw error;
                }

                return {
                    platformName,
                    platform,
                    claims: await verify((await installations.readInstallation(platformName)).installation),
                };
            }
        } catch (error) {
            sendPlatformError(response, platformName, error);

            return null;
        }
    };

    app.get("/api/me", async (request, response) => {
        const session = await authenticate(request, response);
        if (session === null) {
            return;
        }
        try {
            const { info } = await installations.readInstallation(session.platformName);
            response.json({
                user: { id: session.claims.sub, locale: session.claims.locale },
                organizationId: session.claims.org,
                installation: info,
                // Track the token id (jti) if a token ever authorises a state change.
                tokenId: session.claims.jti,
            });
        } catch (error) {
            sendPlatformError(response, session.platformName, error);
        }
    });

    // --- Extension slots: small pages the platform shows inside its own screens -------------------------------
    // A slot token carries `slot` and `ctx` (the product of a product tab): the platform verified them for the user.

    app.get("/api/extension/product", async (request, response) => {
        const session = await authenticate(request, response);
        if (session === null) {
            return;
        }
        const productId = session.claims.ctx?.productId;
        if (session.claims.slot !== "product.details.tab" || productId === undefined) {
            response.status(403).json({ error: "wrong_slot" });

            return;
        }
        try {
            const product = await installations.appApi(
                session.platformName,
                "GET",
                `/api/app/v1/products/${productId}`,
            );
            response.json({
                id: productId,
                name: typeof product.name === "string" ? product.name : String(productId),
            });
        } catch (error) {
            if (error instanceof PlatformApiError && (error.status === 403 || error.status === 404)) {
                response.status(404).json({ error: "product_unavailable" });

                return;
            }
            sendPlatformError(response, session.platformName, error);
        }
    });

    app.get("/api/extension/overview", async (request, response) => {
        const session = await authenticate(request, response);
        if (session === null) {
            return;
        }
        if (session.claims.slot !== "organization.overview.card") {
            response.status(403).json({ error: "wrong_slot" });

            return;
        }
        response.json({
            organizationId: session.claims.org,
            installedAt: store.get(session.platformName)?.installedAt ?? null,
        });
    });

    // --- Billing: the page asks this server, which calls the platform with the installation's token ------------
    // The access token never reaches the browser; the page only proves who it is with its session token.

    const embeddedPageUrl = `${config.appOrigin}/app`;

    /** Authenticates, then runs a billing call. A change also burns the session token's `jti`: one use each. */
    const billingRoute =
        (
            change: boolean,
            call: (session: Session, request: Request) => Promise<Record<string, unknown>>,
            status = 200,
        ): RequestHandler =>
        async (request, response) => {
            const session = await authenticate(request, response);
            if (session === null) {
                return;
            }
            try {
                if (
                    change &&
                    !(await store.claimDelivery(session.platformName, `jti:${session.claims.jti}`, Date.now()))
                ) {
                    response.status(401).json({ error: "token_replayed" });

                    return;
                }
                response.status(status).json(await call(session, request));
            } catch (error) {
                if (
                    error instanceof PlatformApiError &&
                    error.status >= 400 &&
                    error.status < 500 &&
                    error.status !== 401
                ) {
                    // A business refusal (plan not sellable, subscription already live, ...): the page shows it.
                    response.status(error.status).json({ error: "billing_refused", ...error.problem });

                    return;
                }
                sendPlatformError(response, session.platformName, error);
            }
        };

    app.get(
        "/api/billing/plans",
        billingRoute(false, (session) =>
            installations.appApi(session.platformName, "GET", "/api/app/v1/billing/plans"),
        ),
    );

    app.post(
        "/api/billing/subscriptions",
        express.json({ limit: "4kb" }),
        billingRoute(
            true,
            (session, request) => {
                const planId = (request.body as { planId?: unknown } | undefined)?.planId;
                if (typeof planId !== "string" || planId === "") {
                    throw new PlatformApiError("planId is required.", 422, { detail: "planId is required." });
                }

                // The shopper comes back to this app's embedded page, which the platform checks against the manifest.
                return installations.appApi(session.platformName, "POST", "/api/app/v1/billing/subscriptions", {
                    planId,
                    returnUrl: embeddedPageUrl,
                });
            },
            201,
        ),
    );

    app.get(
        "/api/billing/subscription",
        billingRoute(false, async (session) => {
            let subscription: unknown = null;
            try {
                subscription = await installations.appApi(
                    session.platformName,
                    "GET",
                    "/api/app/v1/billing/subscriptions/current",
                );
            } catch (error) {
                if (!(error instanceof PlatformApiError) || error.status !== 404) {
                    throw error;
                }
            }

            return { subscription, webhook: billing.latest(session.platformName) };
        }),
    );

    app.post(
        "/api/billing/subscription/cancel",
        billingRoute(
            true,
            async (session) => ({
                subscription: await installations.appApi(
                    session.platformName,
                    "POST",
                    "/api/app/v1/billing/subscriptions/current/cancel",
                ),
            }),
            202,
        ),
    );

    // --- Embedded page -----------------------------------------------------------------------------------------

    app.use((request, response, next) => {
        if (isAppPath(request.path)) {
            // Only the known Foodpilot platform-app origins may frame the embedded page.
            response.setHeader("Content-Security-Policy", `frame-ancestors ${frameAncestors}`);
        }
        next();
    });
    const appHandler = options.appHandler ?? staticAppHandler(options.clientDir ?? resolve("dist/client"));
    app.use((request, response, next) => (isAppPath(request.path) ? appHandler(request, response, next) : next()));

    app.get("/healthz", (_request, response) => {
        response.json({ status: "ok" });
    });

    return app;
}
