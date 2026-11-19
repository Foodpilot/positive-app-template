import { resolve } from "node:path";
import { defineConfig } from "vite";

// The embedded page lives under /app/ (the manifest's app_url). In dev the server mounts Vite as middleware.
export default defineConfig({
    root: "client",
    base: "/app/",
    build: {
        outDir: "../dist/client",
        emptyOutDir: true,
        rollupOptions: {
            // The embedded page plus one small page per extension slot (see manifest `extensions`).
            input: {
                main: resolve("client/index.html"),
                product: resolve("client/extensions/product.html"),
                overview: resolve("client/extensions/overview.html"),
            },
        },
    },
});
