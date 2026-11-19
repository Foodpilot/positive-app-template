import { startSlotPage } from "./slot.js";

// Organisation overview card: one line.
void startSlotPage<{ organizationId: number; installedAt: string | null }>("/api/extension/overview", (summary) =>
    summary.installedAt === null ?
        `Organisation ${summary.organizationId}`
    :   `Organisation ${summary.organizationId}, installed on ${new Date(summary.installedAt).toLocaleDateString()}`,
);
