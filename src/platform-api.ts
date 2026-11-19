import type { Config, PlatformConfig } from "./config.js";

/** The `type` and `detail` of an RFC 7807 problem body: all the app ever needs from a refusal. */
export interface ApiProblem {
    type?: string;
    detail?: string;
}

export class PlatformApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly problem?: ApiProblem,
    ) {
        super(message);
        this.name = "PlatformApiError";
    }
}

export interface TokenResponse {
    accessToken: string;
    refreshToken: string;
    expiresInSeconds: number;
    scope: string;
    /** Present on first activation only. */
    webhookSecret: string | null;
}

export interface InstallationInfo {
    id: string;
    handle: string;
    platform: string;
    grantedScopes: string[];
    organizationIds: number[];
    /** The granted organisations and their descendants: what a session token's `org` may name. */
    coveredOrganizationIds: number[];
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
    try {
        const body: unknown = await response.json();

        return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

async function tokenRequest(
    config: Config,
    platform: PlatformConfig,
    fields: Record<string, string>,
): Promise<TokenResponse> {
    const response = await fetch(`${platform.apiOrigin}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...fields }),
        signal: AbortSignal.timeout(10_000),
    });
    const body = await readJson(response);
    if (!response.ok) {
        throw new PlatformApiError(`Token request refused: ${String(body.error ?? response.status)}.`, response.status);
    }
    if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
        throw new PlatformApiError("The token response lacks a token.", 502);
    }

    return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : 3600,
        scope: typeof body.scope === "string" ? body.scope : "",
        webhookSecret:
            typeof body.webhook_secret === "string" && body.webhook_secret !== "" ? body.webhook_secret : null,
    };
}

export function exchangeCode(
    config: Config,
    platform: PlatformConfig,
    code: string,
    codeVerifier: string,
): Promise<TokenResponse> {
    return tokenRequest(config, platform, {
        grant_type: "authorization_code",
        code,
        redirect_uri: `${config.appOrigin}/oauth/callback`,
        code_verifier: codeVerifier,
    });
}

/** The refresh token rotates: store the new one, and never use the old one again. */
export function refreshTokens(config: Config, platform: PlatformConfig, refreshToken: string): Promise<TokenResponse> {
    return tokenRequest(config, platform, { grant_type: "refresh_token", refresh_token: refreshToken });
}

/** `GET /api/app/v1/installation`: the only way to learn the organisations granted to this installation. */
export async function fetchInstallation(platform: PlatformConfig, accessToken: string): Promise<InstallationInfo> {
    const response = await fetch(`${platform.apiOrigin}/api/app/v1/installation`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
    });
    const body = await readJson(response);
    if (!response.ok) {
        throw new PlatformApiError(`Installation request refused (${response.status}).`, response.status);
    }
    const { id, handle, platform: name, grantedScopes, organizationIds } = body;
    const covered = body.coveredOrganizationIds ?? organizationIds;
    if (
        typeof id !== "string" ||
        typeof handle !== "string" ||
        typeof name !== "string" ||
        !Array.isArray(grantedScopes) ||
        !Array.isArray(organizationIds) ||
        !organizationIds.every((value) => Number.isInteger(value)) ||
        !Array.isArray(covered) ||
        !covered.every((value) => Number.isInteger(value))
    ) {
        throw new PlatformApiError("The installation response is malformed.", 502);
    }

    return {
        id,
        handle,
        platform: name,
        grantedScopes: grantedScopes.map(String),
        organizationIds: organizationIds as number[],
        coveredOrganizationIds: covered as number[],
    };
}

/** A JSON call to the platform's app API (`/api/app/v1/...`) with an installation access token. */
export async function appApiRequest(
    platform: PlatformConfig,
    accessToken: string,
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
    if (body !== undefined) {
        headers["Content-Type"] = "application/json";
    }
    const response = await fetch(`${platform.apiOrigin}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
    });
    const document = await readJson(response);
    if (!response.ok) {
        throw new PlatformApiError(`App API refused ${method} ${path} (${response.status}).`, response.status, {
            type: typeof document.type === "string" ? document.type : undefined,
            detail: typeof document.detail === "string" ? document.detail : undefined,
        });
    }

    return document;
}
