// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// Records requests that hit the /j catch-all (no implemented handler) so we learn
// which Jellyfin endpoints real apps need. Never throws, never blocks the 404.
// Only the client NAME and VERSION are read from the auth header: no token,
// DeviceId or user is parsed into anything we keep.

import { Logger } from '$lib/server/utils/logger.js';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import {
    unknownRouteDayKey,
    UNKNOWN_ROUTE_TTL_SECONDS,
} from '$lib/server/compat/jellyfin-unknown-routes.js';
import { matchRoute } from './contract/validate.js';
import { getContractDigest } from './contract/digest.js';
import { parseEmbyAuthHeader } from './middleware.js';

const log = Logger.for('JellyfinCompat:UnknownRoute');

const DEDUPE_WINDOW_MS = 60 * 60 * 1000;
const DEDUPE_MAX = 2000;
const HASH_MAX_FIELDS = 5000;
const MAX_KEY_LEN = 120;
const MAX_CLIENT_LEN = 48;

const WARN_BUDGET_PER_MIN = 30;
const WARN_BUDGET_WINDOW_MS = 60_000;

const seen = new Map<string, number>();
let warnWindowStart = 0;
let warnsInWindow = 0;

export function __resetUnknownRouteLogForTests(): void {
    seen.clear();
    warnWindowStart = 0;
    warnsInWindow = 0;
}

/** Process-wide cap on warn lines: the dedupe key holds an attacker-chosen client name. */
export function takeWarnBudget(now = Date.now()): boolean {
    if (now - warnWindowStart >= WARN_BUDGET_WINDOW_MS) {
        warnWindowStart = now;
        warnsInWindow = 0;
    }
    if (warnsInWindow >= WARN_BUDGET_PER_MIN) return false;
    warnsInWindow++;
    return true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32_RE = /^[0-9a-f]{32}$/i;
const DIGITS_RE = /^\d+$/;

function isIdSegment(seg: string): boolean {
    return UUID_RE.test(seg) || HEX32_RE.test(seg) || DIGITS_RE.test(seg) || seg.length > 24;
}

export interface NormalisedRoute {
    key: string;
    known: boolean;
}

export function normaliseUnknownRoute(method: string, pathname: string): NormalisedRoute {
    const m = method.toUpperCase();
    const path = pathname.split('?')[0]!;
    try {
        const hit = matchRoute(getContractDigest(), m, path);
        if (hit) return { key: `${m} ${hit.path}`.slice(0, MAX_KEY_LEN), known: true };
    } catch {
        // fall through to the shape
    }
    const shape = path
        .split('/')
        .map((s) => (s && isIdSegment(s) ? '{id}' : s))
        .join('/');
    return { key: `${m} ${shape}`.slice(0, MAX_KEY_LEN), known: false };
}

function clean(value: string | undefined): string {
    let out = '';
    for (const ch of value ?? '') {
        const c = ch.charCodeAt(0);
        if (c >= 0x20 && c !== 0x7f && ch !== '|') out += ch;
    }
    return out.trim().slice(0, MAX_CLIENT_LEN);
}

export function clientFromHeaders(headers: Headers): { name: string; version: string } {
    const raw = headers.get('X-Emby-Authorization') || headers.get('Authorization') || '';
    try {
        const p = parseEmbyAuthHeader(raw);
        return { name: clean(p['Client']) || 'unknown', version: clean(p['Version']) };
    } catch {
        return { name: 'unknown', version: '' };
    }
}

/** True when this (key, client) was not logged in the last hour; records it. */
export function shouldLogOnce(key: string, client: string, now = Date.now()): boolean {
    const id = `${key}\u0000${client}`;
    const last = seen.get(id);
    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return false;
    seen.delete(id);
    seen.set(id, now);
    while (seen.size > DEDUPE_MAX) {
        const oldest = seen.keys().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
    }
    return true;
}

async function count(key: string, client: string): Promise<void> {
    const valkey = getCoordinationClient();
    if (!valkey) return;
    const hash = unknownRouteDayKey();
    const field = `${key}|${client}`;
    const len = await valkey.hlen(hash);
    // Over the cap only NEW fields are refused; existing ones keep counting so a
    // flood of distinct client names cannot freeze real clients' counts.
    if (len > HASH_MAX_FIELDS && !(await valkey.hexists(hash, field))) return;
    const n = await valkey.hincrBy(hash, field, 1);
    if (n === 1) await valkey.expire(hash, UNKNOWN_ROUTE_TTL_SECONDS);
}

export function recordUnknownRoute(request: Request, pathname: string): void {
    queueMicrotask(() => {
        try {
            const { key, known } = normaliseUnknownRoute(request.method, pathname);
            const { name, version } = clientFromHeaders(request.headers);
            const client = version ? `${name} ${version}` : name;
            if (shouldLogOnce(key, name)) {
                const fields = { route: key, client };
                if (known && takeWarnBudget()) {
                    log.warn('Unimplemented Jellyfin route requested', fields);
                } else if (known)
                    log.debug('Unimplemented Jellyfin route requested (warn budget spent)', fields);
                else log.debug('Unknown /j path requested', fields);
            }
            if (known) void count(key, client).catch(() => {});
        } catch {
            // never affect the response
        }
    });
}
