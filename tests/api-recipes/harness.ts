// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { isIP } from 'node:net';
// Test-harness login; a real third-party client uses the OAuth device flow.
export const BASE = process.env.RECIPES_BASE_URL ?? 'http://127.0.0.1:3000';
export function safeTarget(value = BASE): URL {
    const url = new URL(value, BASE);
    if (!['127.0.0.1', 'localhost', 'preprod.warp10.cc'].includes(url.hostname)) {
        throw new Error('Safety net only permits loopback or preprod.warp10.cc');
    }
    return url;
}
safeTarget();
export function redact(value: unknown, key = ''): unknown {
    if (Array.isArray(value)) return value.map((v) => redact(v, key));
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
    if (typeof value !== 'string') return value;
    if (isIP(value)) return '[ip]';
    if (
        /^(?:path|filePath|file_path|folderPath|folder_path|directory|rootPath)$/i.test(key) &&
        !value.startsWith('/api/v1/')
    )
        return '[path]';
    if (/email|ipAddress|remoteAddress|clientIp|serverIp|ipv6/i.test(key))
        return /email/i.test(key) ? '[email]' : '[ip]';
    if (/token|secret|password|api.?key/i.test(key)) return '[credential]';
    if (
        /user_?name|created_?by|updated_?by|owner_?name|host_?name|display_?name/i.test(key) &&
        !['sweepuser', 'safetynet-admin'].includes(value)
    )
        return '[user]';
    if (
        !value.startsWith('/api/v1/') &&
        (/^(?:file:|\/(?:mnt|media|home|Users|var|tmp|srv|data|opt|volume|storage)\/)|^[A-Za-z]:\\/.test(
            value,
        ) ||
            /(?:file|folder|directory|root)_?path|^path$/i.test(key))
    )
        return '[path]';
    return value
        .replace(/(?:pat_|svc_|stream_)[A-Za-z0-9._~-]+/g, '[credential]')
        .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[credential]')
        .replace(/([?&](?:api_key|stream_token|token|sig)=)[^&#\s"']*/gi, '$1[credential]')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
        .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
        .replace(
            /(^|[\s("'=])(?:file:\/\/)?\/(?:mnt|media|home|Users|var|tmp|srv|data|opt|volume|storage)\/[^\s"'<>]+/g,
            '$1[path]',
        )
        .replace(/\[?[a-f0-9:]*:[a-f0-9:]+\]?/gi, (candidate) =>
            isIP(candidate.replace(/^\[|\]$/g, '')) ? '[ip]' : candidate,
        )
        .replace(/denis/gi, '[user]');
}
export function excerpt(value: unknown): string {
    return (JSON.stringify(redact(value)) ?? String(value)).slice(0, 800);
}
export async function request(
    path: string,
    token: string | null,
    init: RequestInit = {},
): Promise<Response> {
    const url = safeTarget(path);
    if (url.origin !== safeTarget().origin) throw new Error('Refusing cross-origin bearer request');
    return fetch(url, {
        ...init,
        redirect: 'manual',
        signal: init.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(20000)])
            : AbortSignal.timeout(20000),
        // null = no account credential (the URL carries a playback grant).
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
    });
}
export async function login(
    user: string,
    groups: string,
    admin = false,
): Promise<{ token: string; close: () => Promise<void> }> {
    if (!['sweepuser', 'safetynet-admin'].includes(user))
        throw new Error('Only safety-net test users may mint PATs');
    const headers = {
        'x-authentik-username': user,
        'X-authentik-groups': groups,
        Origin: 'https://preprod.warp10.cc',
        'content-type': 'application/json',
    };
    const response = await fetch(new URL('/api/me/pats', safeTarget()), {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
            name: 'api-safety-net',
            scopes: admin ? ['admin'] : ['read', 'write'],
            expiresInDays: 1,
        }),
    });
    if (!response.ok) throw new Error(`Test-harness login failed: ${response.status}`);
    const result = (await response.json()) as { id: number; token: string };
    if (!result.id || !result.token) throw new Error('Test-harness login returned no PAT');
    return {
        token: result.token,
        close: async () => {
            const revoked = await fetch(new URL(`/api/me/pats/${result.id}`, safeTarget()), {
                method: 'DELETE',
                headers,
                signal: AbortSignal.timeout(20000),
            });
            if (!revoked.ok) throw new Error(`PAT revocation failed: ${revoked.status}`);
            console.log(`Revoked safety-net PAT for ${user}`);
        },
    };
}
