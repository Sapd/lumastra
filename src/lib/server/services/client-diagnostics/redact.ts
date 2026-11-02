// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Write-time redaction for client diagnostics. `deepStripSecrets` moved here from
 * playback-incident.service.ts unchanged so both paths share one implementation.
 */

import { redactSecretKeys, stripSecrets } from '$lib/shared/transcode-failure-report.js';

// Bounded quantifiers (RFC 5321 limits): the unbounded form rescanned every long
// alnum/dash run from each start position (quadratic; 200k chars ~ 20 s).
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g;
const AUTH_HEADER = /(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;"']+/gi;

/** Home directories name the person (macOS/Linux/Windows user name) or pin one app
 *  install (iOS app-container uuid). A name runs up to the next separator, whitespace,
 *  quote or bracket. The `[user]` placeholder re-matches and maps to itself and `[app]`
 *  does not match the uuid class, so scrubText stays idempotent. */
const HOME_NAME = `[^/\\\\\\s"'(),;]+`;
const HOME_PATHS: [RegExp, string][] = [
    [
        /\/var\/mobile\/Containers\/Data\/Application\/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g,
        '/var/mobile/Containers/Data/Application/[app]',
    ],
    [new RegExp(`/(Users|home)/${HOME_NAME}`, 'g'), '/$1/[user]'],
    [new RegExp(`\\b([A-Za-z]):\\\\Users\\\\${HOME_NAME}`, 'g'), '$1:\\Users\\[user]'],
];

function scrubHomePaths(text: string): string {
    let out = text;
    for (const [re, replacement] of HOME_PATHS) out = out.replace(re, replacement);
    return out;
}

export function scrubText(text: string): string {
    return scrubHomePaths(
        stripSecrets(text).replace(AUTH_HEADER, '$1[redacted]').replace(EMAIL, '[email]'),
    );
}

/**
 * Deep-walks `value`, running `stripSecrets`' free-text credential regex over
 * every string leaf — including values nested inside objects/arrays at any
 * depth, not just a shallow top-level pass. Non-plain objects (Date, class
 * instances) and cycles are returned as-is, mirroring `redactSecretKeys`' own
 * guards. Moved verbatim from `playback-incident.service.ts` so both paths
 * share one implementation.
 */
export function deepStripSecrets(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
    if (typeof value === 'string') return stripSecrets(value);
    if (Array.isArray(value)) {
        if (seen.has(value)) return value;
        seen.add(value);
        return value.map((entry) => deepStripSecrets(entry, seen));
    }
    if (typeof value !== 'object' || value === null) return value;
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    if (seen.has(value)) return value;
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = deepStripSecrets(entry, seen);
    }
    return out;
}

function deepScrubText(value: unknown): unknown {
    if (typeof value === 'string') return scrubText(value);
    if (Array.isArray(value)) return value.map(deepScrubText);
    if (typeof value === 'object' && value !== null) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>))
            out[k] = deepScrubText(v);
        return out;
    }
    return value;
}

/** Key-name redaction, then value-pattern redaction on every string leaf, then email/auth scrub. */
export function deepRedact<T>(value: T): T {
    return deepScrubText(deepStripSecrets(redactSecretKeys(value))) as T;
}
