// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.
/**
 * Opt-in (JELLYFIN_CONTRACT_VALIDATE=log): validates /j JSON responses against the
 * jellyfin-sdk-kotlin contract after they are returned, and logs each distinct
 * violation once per process. On in dev and preprod, off in prod. Runs as an
 * observer registered with the AGPL core (compat/jellyfin-response-observer.ts)
 * rather than inside withJellyfinAuth because several /j routes
 * (System/Info/Public, Branding, QuickConnect, play-token streams) bypass it.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import { Logger } from '$lib/server/utils/logger';
import { validateJellyfinResponse } from './validate';

const logger = Logger.for('JellyfinCompat:Contract');
const MAX_BYTES = 2 * 1024 * 1024;
const RUNTIME_ARRAY_LIMIT = 50;
const seen = new Set<string>();

export function resetContractLogDedupe(): void {
    seen.clear();
}

/** Reads the body up to MAX_BYTES; cancels the stream and returns null when exceeded. */
async function readCapped(res: Response): Promise<string | null> {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

export function observeJellyfinResponse(event: RequestEvent, response: Response): void {
    if (config.JELLYFIN_CONTRACT_VALIDATE !== 'log') return;
    if (!(response.headers.get('content-type') ?? '').includes('application/json')) return;
    const len = Number(response.headers.get('content-length') ?? '0');
    if (len > MAX_BYTES) return;
    let copy: Response;
    try {
        copy = response.clone();
    } catch {
        // Disturbed/locked body: a debug-only validator must never fail the request.
        return;
    }
    const method = event.request.method;
    const pathname = event.url.pathname;
    const device = event.locals.jfDevice;
    setImmediate(() => {
        void (async () => {
            try {
                const text = await readCapped(copy);
                if (text === null) return;
                const r = validateJellyfinResponse(method, pathname, JSON.parse(text), {
                    clientName: device?.clientName ?? undefined,
                    arrayLimit: RUNTIME_ARRAY_LIMIT,
                });
                for (const v of r.violations) {
                    const key = `${method} ${r.route} ${v.pointer.replace(/\/\d+(?=\/|$)/g, '/*')} ${v.kind}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    logger.warn('Jellyfin contract violation', {
                        route: `${method} ${r.route}`,
                        pointer: v.pointer,
                        kind: v.kind,
                        severity: v.severity,
                        versions: v.versions,
                        detail: v.detail,
                        client: device?.clientName ?? null,
                        clientVersion: device?.clientVersion ?? null,
                    });
                }
            } catch (err) {
                const key = `error ${method} ${pathname.split('/').slice(0, 3).join('/')}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    logger.warn('Jellyfin contract validation failed', {
                        route: pathname,
                        error: String(err),
                    });
                }
            }
        })();
    });
}
