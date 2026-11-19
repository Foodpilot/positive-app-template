import type { RequestHandler } from "express";
import { createServer } from "./app.js";
import { loadConfig } from "./config.js";
import { StateStore } from "./state.js";

const config = loadConfig(process.env);
const store = new StateStore(config.stateFile);

let appHandler: RequestHandler | undefined;
if (process.env.NODE_ENV !== "production") {
    // Development: Vite serves the embedded page from the same process, no hot-reload socket needed.
    const { createServer: createVite } = await import("vite");
    const vite = await createVite({
        configFile: "vite.config.ts",
        appType: "spa",
        server: { middlewareMode: true, hmr: false, allowedHosts: true },
    });
    appHandler = vite.middlewares;
}

const app = createServer(config, store, appHandler === undefined ? {} : { appHandler });
app.listen(config.port, () => {
    console.log(`Sample app listening on :${config.port} for ${config.appOrigin}`);
});
