import { buildManifest } from "../src/manifest.js";

const origin = process.env.APP_ORIGIN;
if (origin === undefined || origin === "") {
    console.error("APP_ORIGIN is required, for example https://sample-app.base.positive.test");
    process.exit(1);
}
try {
    if (new URL(origin).origin !== origin) {
        throw new Error("not a bare origin");
    }
} catch {
    console.error(`APP_ORIGIN must be a bare origin without path or trailing slash, got "${origin}".`);
    process.exit(1);
}

console.log(JSON.stringify(buildManifest(origin), null, 2));
