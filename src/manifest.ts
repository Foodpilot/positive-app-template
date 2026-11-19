import { SCOPES } from "./config.js";

/**
 * The app manifest for an origin.
 *
 * `app_url` is `<origin>/app` and the navigation paths start with `/app`: a path is resolved with
 * `new URL(path, app_url)`, so a leading slash goes to the origin root, and the result must stay under the
 * `app_url` path to be kept by Foodpilot.
 */
export function buildManifest(appOrigin: string) {
    return {
        manifest_version: 1,
        name: "Sample app",
        handle: "sample-app",
        install_url: `${appOrigin}/install`,
        app_url: `${appOrigin}/app`,
        redirect_urls: [`${appOrigin}/oauth/callback`],
        scopes: [...SCOPES],
        embedded: true,
        navigation: [
            { label: { en: "Home", fr: "Accueil" }, path: "/app" },
            { label: { en: "Reports", fr: "Rapports" }, path: "/app/reports" },
        ],
        extensions: [
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
        ],
        webhooks: [
            { topic: "app/uninstalled", uri: `${appOrigin}/webhooks` },
            { topic: "app_subscription/updated", uri: `${appOrigin}/webhooks` },
            { topic: "app_charge/updated", uri: `${appOrigin}/webhooks` },
        ],
    };
}
