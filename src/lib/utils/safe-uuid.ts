// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Generate a UUID that works in INSECURE browser contexts too.
 *
 * `crypto.randomUUID()` is only exposed in a *secure context* (HTTPS or
 * localhost). Many self-hosters reach the app over plain HTTP on a LAN IP
 * (e.g. http://10.0.0.3:8088), where `crypto.randomUUID` is `undefined` and
 * calling it throws `TypeError: crypto.randomUUID is not a function` — which
 * was crashing the video player on mount.
 *
 * `crypto.getRandomValues()` is NOT gated to secure contexts, so we prefer
 * `randomUUID`, fall back to a `getRandomValues`-based RFC-4122 v4 UUID, and
 * only as a last resort use a non-cryptographic `Math.random` UUID. Works in
 * the browser and in Node.
 */
export function safeRandomUUID(): string {
    const c: Crypto | undefined =
        typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined;

    if (c && typeof c.randomUUID === 'function') {
        return c.randomUUID();
    }

    if (c && typeof c.getRandomValues === 'function') {
        const b = c.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40; // version 4
        b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
        const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
        return (
            `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-` +
            `${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`
        );
    }

    // Last-resort, non-cryptographic fallback (no crypto API at all).
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
        const r = (Math.random() * 16) | 0;
        const v = ch === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
