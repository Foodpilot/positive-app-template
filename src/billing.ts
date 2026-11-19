/** What the last billing webhook said, kept in memory (a real app would store it). */
export interface SubscriptionEvent {
    subscriptionId: string;
    status: string;
    planId: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
}

export interface ChargeEvent {
    chargeId: string;
    status: string;
    planId: string | null;
}

export const BILLING_TOPICS = ["app_subscription/updated", "app_charge/updated"] as const;
export type BillingTopic = (typeof BILLING_TOPICS)[number];

export const isBillingTopic = (topic: string): topic is BillingTopic =>
    (BILLING_TOPICS as readonly string[]).includes(topic);

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** Latest subscription and charge statuses per platform. Lost on restart: the API is the source of truth. */
export class BillingEvents {
    private readonly subscriptions = new Map<string, SubscriptionEvent>();
    private readonly charges = new Map<string, Map<string, ChargeEvent>>();

    /** Returns the stored event, or null when the payload lacks the fields the topic promises. */
    record(
        platform: string,
        topic: BillingTopic,
        payload: Record<string, unknown>,
    ): SubscriptionEvent | ChargeEvent | null {
        if (topic === "app_subscription/updated") {
            const subscriptionId = text(payload.subscriptionId);
            const status = text(payload.status);
            if (subscriptionId === null || status === null) {
                return null;
            }
            const event: SubscriptionEvent = {
                subscriptionId,
                status,
                planId: text(payload.planId),
                currentPeriodEnd: text(payload.currentPeriodEnd),
                cancelAtPeriodEnd: payload.cancelAtPeriodEnd === true,
            };
            this.subscriptions.set(platform, event);

            return event;
        }
        const chargeId = text(payload.chargeId);
        const status = text(payload.status);
        if (chargeId === null || status === null) {
            return null;
        }
        const event: ChargeEvent = { chargeId, status, planId: text(payload.planId) };
        const known = this.charges.get(platform) ?? new Map<string, ChargeEvent>();
        known.set(chargeId, event);
        this.charges.set(platform, known);

        return event;
    }

    latest(platform: string): { subscription: SubscriptionEvent | null; charges: ChargeEvent[] } {
        return {
            subscription: this.subscriptions.get(platform) ?? null,
            charges: [...(this.charges.get(platform)?.values() ?? [])],
        };
    }

    forget(platform: string): void {
        this.subscriptions.delete(platform);
        this.charges.delete(platform);
    }
}
