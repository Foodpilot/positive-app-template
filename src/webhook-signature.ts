import { createHmac } from "node:crypto";
import { constantTimeEqual } from "./cookies.js";

export const TOLERANCE_SECONDS = 300;

export type SignatureCheck = "ok" | "bad_timestamp" | "stale_timestamp" | "bad_signature";

/** Signature v2 as platform-api signs it: `v1=` + base64(HMAC-SHA256(secret, timestamp + "." + body)). */
export function signatureV2(secret: string, timestamp: string, body: Buffer | string): string {
    const mac = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("base64");

    return `v1=${mac}`;
}

/**
 * Verifies a delivery. `signatures` holds `X-Positive-Signature-V2` and, during a secret rotation,
 * `X-Positive-Signature-V2-Previous`: either may match.
 */
export function verifyWebhook(options: {
    secret: string;
    timestamp: string | undefined;
    signatures: ReadonlyArray<string | undefined>;
    body: Buffer;
    nowSeconds: number;
}): SignatureCheck {
    const { secret, timestamp, signatures, body, nowSeconds } = options;
    if (timestamp === undefined || !/^\d{1,12}$/.test(timestamp)) {
        return "bad_timestamp";
    }
    if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) {
        return "stale_timestamp";
    }
    const expected = signatureV2(secret, timestamp, body);
    // Compare every candidate, without stopping at the first match.
    let matched = false;
    for (const candidate of signatures) {
        if (candidate !== undefined && constantTimeEqual(expected, candidate)) {
            matched = true;
        }
    }

    return matched ? "ok" : "bad_signature";
}
