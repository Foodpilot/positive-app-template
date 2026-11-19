import type { Config, PlatformConfig } from "./config.js";
import {
    appApiRequest,
    fetchInstallation,
    PlatformApiError,
    refreshTokens,
    type InstallationInfo,
    type TokenResponse,
} from "./platform-api.js";
import type { Installation, StateStore } from "./state.js";

const REFRESH_MARGIN_MS = 60_000;

/** Keeps each installation's access token fresh and calls the platform API with it. */
export class InstallationService {
    /** One refresh at a time per platform: a refresh token rotates, and reusing one revokes the whole family. */
    private readonly refreshing = new Map<string, Promise<Installation>>();

    constructor(
        private readonly config: Config,
        private readonly store: StateStore,
    ) {}

    withTokens(
        previous: Installation | undefined,
        platform: string,
        info: InstallationInfo,
        tokens: TokenResponse,
    ): Installation {
        return {
            platform,
            installationId: info.id,
            handle: info.handle,
            grantedScopes: info.grantedScopes,
            organizationIds: info.organizationIds,
            coveredOrganizationIds: info.coveredOrganizationIds,
            accessToken: tokens.accessToken,
            accessTokenExpiresAt: Date.now() + tokens.expiresInSeconds * 1000,
            refreshToken: tokens.refreshToken,
            // The secret arrives once per installation: keep it across a re-consent.
            webhookSecret:
                tokens.webhookSecret ?? (previous?.installationId === info.id ? previous.webhookSecret : null),
            installedAt: previous?.installationId === info.id ? previous.installedAt : new Date().toISOString(),
        };
    }

    private refresh(installation: Installation): Promise<Installation> {
        const running = this.refreshing.get(installation.platform);
        if (running !== undefined) {
            return running;
        }
        const platform = this.config.platforms.get(installation.platform);
        if (platform === undefined) {
            return Promise.reject(new PlatformApiError("Unknown platform.", 500));
        }
        const task = (async () => {
            const tokens = await refreshTokens(this.config, platform, installation.refreshToken);
            const updated: Installation = {
                ...installation,
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                accessTokenExpiresAt: Date.now() + tokens.expiresInSeconds * 1000,
            };
            await this.store.put(updated);

            return updated;
        })().finally(() => this.refreshing.delete(installation.platform));
        this.refreshing.set(installation.platform, task);

        return task;
    }

    /**
     * Runs a call with the stored access token, refreshing it first when it is about to expire and once more
     * when the platform answers 401 (nothing was processed then, so a retry is safe).
     */
    private async withAccessToken<T>(
        platformName: string,
        call: (platform: PlatformConfig, accessToken: string) => Promise<T>,
    ): Promise<{ installation: Installation; result: T }> {
        const platform = this.config.platforms.get(platformName);
        let installation = this.store.get(platformName);
        if (platform === undefined || installation === undefined) {
            throw new PlatformApiError("The app is not installed on this platform.", 404);
        }
        if (installation.accessTokenExpiresAt - Date.now() < REFRESH_MARGIN_MS) {
            installation = await this.refresh(installation);
        }
        try {
            return { installation, result: await call(platform, installation.accessToken) };
        } catch (error) {
            if (!(error instanceof PlatformApiError) || error.status !== 401) {
                throw error;
            }
            installation = await this.refresh(installation);

            return { installation, result: await call(platform, installation.accessToken) };
        }
    }

    /** A call to the platform's app API on behalf of the installation. The token never leaves this class. */
    async appApi(
        platformName: string,
        method: "GET" | "POST",
        path: string,
        body?: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
        return (
            await this.withAccessToken(platformName, (platform, token) =>
                appApiRequest(platform, token, method, path, body),
            )
        ).result;
    }

    /**
     * Reads `GET /api/app/v1/installation` with the stored token (see `withAccessToken`).
     * Records the organisations it reports.
     */
    async readInstallation(platformName: string): Promise<{ installation: Installation; info: InstallationInfo }> {
        const { installation: current, result: info } = await this.withAccessToken(platformName, fetchInstallation);
        if (info.id !== current.installationId || info.platform !== platformName) {
            throw new PlatformApiError("The platform reports another installation.", 502);
        }
        const updated: Installation = {
            ...current,
            handle: info.handle,
            grantedScopes: info.grantedScopes,
            organizationIds: info.organizationIds,
            coveredOrganizationIds: info.coveredOrganizationIds,
        };
        if (JSON.stringify(updated) !== JSON.stringify(current)) {
            await this.store.put(updated);
        }

        return { installation: updated, info };
    }
}
