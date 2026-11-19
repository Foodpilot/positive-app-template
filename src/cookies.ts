import { createHmac, timingSafeEqual } from "node:crypto";

export function sign(secret: string, value: string): string {
    const mac = createHmac("sha256", secret).update(value).digest("base64url");

    return `${value}.${mac}`;
}

/** Returns the value when the MAC is valid, otherwise null. */
export function unsign(secret: string, signed: string): string | null {
    const dot = signed.lastIndexOf(".");
    if (dot < 1) {
        return null;
    }
    const value = signed.slice(0, dot);
    const expected = Buffer.from(sign(secret, value));
    const actual = Buffer.from(signed);

    return expected.length === actual.length && timingSafeEqual(expected, actual) ? value : null;
}

export function parseCookies(header: string | undefined): Map<string, string> {
    const cookies = new Map<string, string>();
    for (const part of (header ?? "").split(";")) {
        const equals = part.indexOf("=");
        if (equals > 0) {
            cookies.set(part.slice(0, equals).trim(), part.slice(equals + 1).trim());
        }
    }

    return cookies;
}

export function constantTimeEqual(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);

    return a.length === b.length && timingSafeEqual(a, b);
}
