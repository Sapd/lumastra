// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Fetch hides DNS/TLS/socket errors behind "fetch failed". Only allow known
// codes; upstream messages, URLs and headers may contain credentials.
const SAFE_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
]);

export function tmdbTransportCodes(error: unknown): string[] {
    const codes = new Set<string>();
    const seen = new Set<object>();
    const visit = (value: unknown, depth: number): void => {
        if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) return;
        seen.add(value);
        const item = value as { code?: unknown; cause?: unknown; errors?: unknown };
        if (typeof item.code === 'string' && SAFE_CODES.has(item.code)) codes.add(item.code);
        visit(item.cause, depth + 1);
        if (Array.isArray(item.errors)) {
            for (const nested of item.errors.slice(0, 16)) visit(nested, depth + 1);
        }
    };
    visit(error, 0);
    return [...codes].sort();
}
