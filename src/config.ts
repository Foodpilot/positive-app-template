export interface PlatformConfig {
    apiOrigin: string;
    appOrigin: string;
}

export interface Config {
    clientId: string;
    clientSecret: string;
    /** Public origin of this app. */
    appOrigin: string;
    /** The only platforms this app trusts, by name. A Map, so a crafted name never reaches a prototype. */
    platforms: ReadonlyMap<string, PlatformConfig>;
    cookieSecret: string;
    port: number;
    stateFile: string;
    /** Scopes requested at install: keep equal to the manifest's `scopes`. */
    scopes: readonly string[];
}

export const SCOPES = ["read_products", "read_organizations"] as const;

const PLATFORM_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function required(env: NodeJS.ProcessEnv, name: string): string {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
        throw new Error(`${name} is required (see .env.example).`);
    }

    return value.trim();
}

function origin(name: string, value: string): string {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error(`${name} must be an origin such as https://example.com, got "${value}".`);
    }
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.origin !== value) {
        throw new Error(`${name} must be a bare http(s) origin without path or trailing slash, got "${value}".`);
    }

    return value;
}

function parsePlatforms(raw: string): Map<string, PlatformConfig> {
    let document: unknown;
    try {
        document = JSON.parse(raw);
    } catch {
        throw new Error('PLATFORMS must be JSON: {"<name>": {"apiOrigin": "...", "appOrigin": "..."}}.');
    }
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
        throw new Error("PLATFORMS must be a JSON object keyed by platform name.");
    }
    const platforms = new Map<string, PlatformConfig>();
    for (const [name, value] of Object.entries(document)) {
        if (!PLATFORM_NAME.test(name)) {
            throw new Error(`PLATFORMS: "${name}" is not a valid platform name.`);
        }
        const entry = value as Partial<PlatformConfig> | null;
        if (typeof entry?.apiOrigin !== "string" || typeof entry.appOrigin !== "string") {
            throw new Error(`PLATFORMS.${name} needs apiOrigin and appOrigin.`);
        }
        platforms.set(name, {
            apiOrigin: origin(`PLATFORMS.${name}.apiOrigin`, entry.apiOrigin),
            appOrigin: origin(`PLATFORMS.${name}.appOrigin`, entry.appOrigin),
        });
    }
    if (platforms.size === 0) {
        throw new Error("PLATFORMS lists no platform.");
    }

    return platforms;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
    const cookieSecret = required(env, "COOKIE_SECRET");
    if (cookieSecret.length < 32) {
        throw new Error("COOKIE_SECRET must be at least 32 characters.");
    }
    const port = Number(env.PORT ?? "3000");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("PORT must be a port number.");
    }

    return {
        clientId: required(env, "CLIENT_ID"),
        clientSecret: required(env, "CLIENT_SECRET"),
        appOrigin: origin("APP_ORIGIN", required(env, "APP_ORIGIN")),
        platforms: parsePlatforms(required(env, "PLATFORMS")),
        cookieSecret,
        port,
        stateFile: env.STATE_FILE ?? "var/state.json",
        scopes: SCOPES,
    };
}
