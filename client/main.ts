import { AppBridgeError, createApp, type App } from "@foodpilot/app-bridge";

const element = <T extends HTMLElement>(id: string): T => {
    const found = document.getElementById(id);
    if (found === null) {
        throw new Error(`#${id} is missing`);
    }

    return found as T;
};

/** All text goes through textContent: nothing from the network is ever parsed as HTML. */
const setText = (id: string, text: string): void => {
    element(id).textContent = text;
};

const describe = (error: unknown): string =>
    error instanceof AppBridgeError ? `${error.code}: ${error.message}`
    : error instanceof Error ? error.message
    : "Unknown error";

let locale = "en";

async function loadIdentity(app: App): Promise<void> {
    const token = await app.getSessionToken();
    const response = await fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } });
    const body = (await response.json()) as { user?: { locale?: unknown } };
    setText("identity-json", JSON.stringify(body, null, 2));
    element("identity").hidden = false;
    if (!response.ok) {
        throw new Error(`/api/me answered ${response.status}`);
    }
    if (typeof body.user?.locale === "string") {
        locale = body.user.locale;
    }
}

interface Plan {
    id: string;
    kind: string;
    name: Record<string, string>;
    amount: number;
    currency: string;
    interval: string | null;
    trialDays: number;
}

interface Subscription {
    status: string;
    plan: Plan;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
}

const planName = (plan: Plan): string => plan.name[locale] ?? plan.name.en ?? plan.id;

const planPrice = (plan: Plan): string => {
    const price = new Intl.NumberFormat(locale, { style: "currency", currency: plan.currency.toUpperCase() }).format(
        plan.amount / 100,
    );

    return `${price} excl. VAT${plan.interval === null ? "" : ` / ${plan.interval}`}`;
};

/** A call to this app's server. The session token is the only credential the page holds. */
async function api(app: App, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await app.getSessionToken()}` };
    if (body !== undefined) {
        headers["Content-Type"] = "application/json";
    }
    const response = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const document = (await response.json()) as { detail?: string; error?: string };
    if (!response.ok) {
        throw new Error(document.detail ?? document.error ?? `${path} answered ${response.status}`);
    }

    return document;
}

function renderSubscription(subscription: Subscription | null): void {
    element("subscription").hidden = subscription === null;
    if (subscription === null) {
        return;
    }
    setText("subscription-status", subscription.status);
    setText("subscription-plan", `${planName(subscription.plan)} (${planPrice(subscription.plan)})`);
    setText(
        "subscription-period-end",
        subscription.currentPeriodEnd === null ?
            "-"
        :   new Date(subscription.currentPeriodEnd).toLocaleDateString(locale),
    );
    setText("subscription-cancel", subscription.cancelAtPeriodEnd ? "Yes" : "No");
    // A subscription that already ends has nothing left to cancel.
    element<HTMLButtonElement>("cancel-subscription").hidden =
        subscription.cancelAtPeriodEnd || subscription.status === "canceled";
}

async function loadBilling(app: App): Promise<void> {
    const [plans, current] = await Promise.all([
        api(app, "GET", "/api/billing/plans") as Promise<{ items: Plan[] }>,
        api(app, "GET", "/api/billing/subscription") as Promise<{ subscription: Subscription | null }>,
    ]);
    renderSubscription(current.subscription);

    const list = element("plans");
    list.replaceChildren();
    for (const plan of plans.items) {
        const item = document.createElement("li");
        item.append(
            `${planName(plan)}: ${planPrice(plan)}${plan.trialDays > 0 ? `, ${plan.trialDays} days free` : ""} `,
        );
        if (plan.kind === "recurring") {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = "Subscribe";
            button.addEventListener("click", () => void subscribe(app, plan.id));
            item.append(button);
        }
        list.append(item);
    }
    if (plans.items.length === 0) {
        setText("billing-status", "This app has no paid plan yet.");
    }
    element("billing").hidden = false;
}

async function subscribe(app: App, planId: string): Promise<void> {
    try {
        const created = (await api(app, "POST", "/api/billing/subscriptions", { planId })) as {
            confirmationUrl: string;
        };
        // The platform asks the user to confirm and pay, then sends them back here.
        await app.navigate.foodpilot(new URL(created.confirmationUrl).pathname);
    } catch (error) {
        setText("billing-status", `Subscribe failed: ${describe(error)}`);
    }
}

async function cancelSubscription(app: App): Promise<void> {
    try {
        if (
            !(await app.confirm({
                message: "Cancel the subscription at the end of the period?",
                confirmLabel: "Cancel subscription",
            }))
        ) {
            return;
        }
        const canceled = (await api(app, "POST", "/api/billing/subscription/cancel")) as { subscription: Subscription };
        renderSubscription(canceled.subscription);
        setText("billing-status", "The subscription will end at the end of the period.");
    } catch (error) {
        setText("billing-status", `Cancel failed: ${describe(error)}`);
    }
}

async function boot(): Promise<void> {
    const route = location.pathname.replace(/\/+$/, "").endsWith("/reports") ? "Reports" : "Home";
    setText("heading", `Sample app: ${route}`);

    const config = (await (await fetch("/api/config")).json()) as { allowedHosts: string[] };
    let app: App;
    try {
        // Only the known platform-app origins may host this page.
        app = createApp({ allowedHosts: config.allowedHosts });
    } catch (error) {
        setText("status", `Open this app from Foodpilot. (${describe(error)})`);

        return;
    }

    const run = (label: string, action: () => Promise<unknown>) => async () => {
        try {
            const outcome = await action();
            setText("result", outcome === undefined ? `${label}: done` : `${label}: ${JSON.stringify(outcome)}`);
        } catch (error) {
            setText("result", `${label} failed: ${describe(error)}`);
        }
    };

    await app.ready();
    await app.title(`Sample app: ${route}`);
    setText("status", `Connected to ${app.hostOrigin}.`);
    element("actions").hidden = false;

    element("toast").addEventListener(
        "click",
        run("toast", () => app.toast({ message: "Hello from the sample app", kind: "success" })),
    );
    element("confirm").addEventListener(
        "click",
        run("confirm", async () => ({
            confirmed: await app.confirm({ message: "Do you want to continue?", confirmLabel: "Continue" }),
        })),
    );
    element("goto-home").addEventListener(
        "click",
        run("navigate", () => app.navigate.app("/app")),
    );
    element("goto-reports").addEventListener(
        "click",
        run("navigate", () => app.navigate.app("/app/reports")),
    );
    element("goto-products").addEventListener(
        "click",
        run("navigate", () => app.navigate.foodpilot("/products")),
    );
    element("title").addEventListener(
        "click",
        run("title", () => app.title(`Sample app ${new Date().toLocaleTimeString()}`)),
    );
    element("loading").addEventListener(
        "click",
        run("loading", async () => {
            await app.loading(true);
            await new Promise((done) => setTimeout(done, 2000));
            await app.loading(false);
        }),
    );
    element("refresh").addEventListener(
        "click",
        run("identity", () => loadIdentity(app)),
    );

    element("cancel-subscription").addEventListener("click", () => void cancelSubscription(app));

    try {
        await loadIdentity(app);
    } catch (error) {
        setText("result", `Identity failed: ${describe(error)}`);
    }
    try {
        await loadBilling(app);
    } catch (error) {
        setText("billing-status", `Billing is not available: ${describe(error)}`);
        element("billing").hidden = false;
    }
}

boot().catch((error: unknown) => setText("status", `Something went wrong: ${describe(error)}`));
