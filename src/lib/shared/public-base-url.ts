// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Empty means unset or invalid. Never return URL credentials to a caller. */
export function normalizePublicBaseUrl(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) return '';
    const raw = value.trim();
    if (!/^https?:\/\//i.test(raw) || /[\s\\?#]/.test(raw)) return '';
    try {
        const url = new URL(raw);
        if (!url.hostname || url.username || url.password) return '';
        return url.href.replace(/\/+$/, '');
    } catch {
        return '';
    }
}

/** The public URL already includes the install base path. */
export function integrationRedirectUri(baseUrl: unknown, provider: 'trakt' | 'mal'): string {
    const base = normalizePublicBaseUrl(baseUrl);
    return base ? `${base}/api/integrations/${provider}/callback` : '';
}
