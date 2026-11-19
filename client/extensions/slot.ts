import { createApp, type App } from "@foodpilot/app-bridge";

/** All text goes through textContent: nothing from the network is ever parsed as HTML. */
export function setText(id: string, text: string): void {
    const element = document.getElementById(id);
    if (element === null) {
        throw new Error(`#${id} is missing`);
    }
    element.textContent = text;
}

/**
 * Starts a slot page: connects to the host, follows the document height, tells the host the page is ready,
 * then fetches this app's server with a fresh session token and hands the answer to `show`.
 */
export async function startSlotPage<T>(path: string, show: (data: T) => string): Promise<void> {
    let app: App;
    try {
        const config = (await (await fetch("/api/config")).json()) as { allowedHosts: string[] };
        app = createApp({ allowedHosts: config.allowedHosts });
    } catch {
        setText("line", "Open this page from Foodpilot.");

        return;
    }
    app.autoResize();
    try {
        await app.ready();
        const response = await fetch(path, { headers: { Authorization: `Bearer ${await app.getSessionToken()}` } });
        if (!response.ok) {
            throw new Error(`${path} answered ${response.status}`);
        }
        setText("line", show((await response.json()) as T));
    } catch {
        setText("line", "This information is not available.");
    }
}
