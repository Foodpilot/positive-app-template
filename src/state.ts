import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Installation {
    platform: string;
    installationId: string;
    handle: string;
    grantedScopes: string[];
    organizationIds: number[];
    /** Granted organisations and their descendants. Absent in state written before it existed. */
    coveredOrganizationIds?: number[];
    accessToken: string;
    /** Epoch milliseconds. */
    accessTokenExpiresAt: number;
    refreshToken: string;
    /** Signs this installation's webhooks. Given once, at activation. */
    webhookSecret: string | null;
    installedAt: string;
}

interface StateDocument {
    installations: Record<string, Installation>;
    /** `<platform>:<delivery id>` to epoch milliseconds. */
    deliveries: Record<string, number>;
}

const DELIVERY_RETENTION_MS = 7 * 24 * 3600 * 1000;

/** Everything the app remembers, in one JSON file. A real app would use a database. */
export class StateStore {
    private document: StateDocument = { installations: {}, deliveries: {} };
    private writing: Promise<void> = Promise.resolve();

    constructor(private readonly file: string) {
        try {
            const stored = JSON.parse(readFileSync(file, "utf-8")) as Partial<StateDocument>;
            this.document = { installations: stored.installations ?? {}, deliveries: stored.deliveries ?? {} };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
    }

    get(platform: string): Installation | undefined {
        return Object.hasOwn(this.document.installations, platform) ? this.document.installations[platform] : undefined;
    }

    async put(installation: Installation): Promise<void> {
        this.document.installations[installation.platform] = installation;
        await this.persist();
    }

    async remove(platform: string): Promise<void> {
        delete this.document.installations[platform];
        await this.persist();
    }

    /** True the first time a delivery id is seen for a platform, false for a replay. */
    async claimDelivery(platform: string, deliveryId: string, now: number): Promise<boolean> {
        const key = `${platform}:${deliveryId}`;
        if (Object.hasOwn(this.document.deliveries, key)) {
            return false;
        }
        for (const [seen, at] of Object.entries(this.document.deliveries)) {
            if (now - at > DELIVERY_RETENTION_MS) {
                delete this.document.deliveries[seen];
            }
        }
        this.document.deliveries[key] = now;
        await this.persist();

        return true;
    }

    /** Writes are queued and atomic (temporary file, then rename). */
    private persist(): Promise<void> {
        const snapshot = JSON.stringify(this.document, null, 2);
        this.writing = this.writing.then(() => {
            mkdirSync(dirname(this.file), { recursive: true });
            const temporary = `${this.file}.${process.pid}.tmp`;
            writeFileSync(temporary, snapshot, { mode: 0o600 });
            renameSync(temporary, this.file);
        });

        return this.writing;
    }
}
