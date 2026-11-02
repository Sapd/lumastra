// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
export interface Shape {
    keys: Set<string>;
    nonempty: Set<string>;
}
/**
 * Free-form payloads whose inner keys depend on data (a run's result, a task's input, a task's
 * settings), not on the contract. The node must still be present and keep its JSON type, but its
 * keys are not diffed; otherwise every package learns to ignore BROKEN. Add a path ONLY for a
 * genuinely free-form payload, never to silence a real contract change.
 */
export const OPAQUE_PATHS: ReadonlySet<string> = new Set([
    '$.items[].result', // run result envelope: the spec says {} (any shape); optional keys such as
    // `message` appear only for some tasks, so a 50-run sample cannot pin them
    '$.items[].input', // run / task input payload
    '$.items[].settings', // per-task settings (differ per task)
]);
function jsonType(value: unknown): string {
    return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}
// Arrays use a wildcard and union of member shapes: ordering and length are not contracts.
export function shape(
    value: unknown,
    path = '$',
    result: Shape = { keys: new Set(), nonempty: new Set() },
): Shape {
    result.keys.add(path);
    if (OPAQUE_PATHS.has(path)) {
        // Type-check only: a change of JSON type is reported as a removed `path#type` key.
        result.keys.add(`${path}#${jsonType(value)}`);
        return result;
    }
    if (Array.isArray(value)) {
        if (value.length) result.nonempty.add(path);
        for (const item of value) shape(item, `${path}[]`, result);
    } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) shape(child, `${path}.${key}`, result);
    }
    return result;
}
export function differences(
    before: unknown,
    after: unknown,
): { broken: string[]; added: string[] } {
    const old = shape(before);
    const next = shape(after);
    return {
        broken: [
            ...[...old.keys].filter((k) => !next.keys.has(k)).map((k) => `Removed key ${k}`),
            ...[...old.nonempty]
                .filter((k) => !next.nonempty.has(k))
                .map((k) => `Non-empty array became empty: ${k}`),
        ],
        added: [...next.keys].filter((k) => !old.keys.has(k)),
    };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function mediaReferences(body: unknown): string[] {
    const found = new Set<string>();
    function walk(value: unknown, parent = ''): void {
        if (Array.isArray(value)) {
            value.forEach((v) => walk(v, parent));
            return;
        }
        if (!value || typeof value !== 'object') return;
        // A library row has the same {id, mediaType} shape as a media item; it is not one.
        if (/librar|^paths$/i.test(parent)) return;
        const row = value as Record<string, unknown>;
        for (const [key, child] of Object.entries(row)) {
            const mediaKey = /^(?:media|item|series|season|episode|movie)Id$/.test(key);
            const mediaNode =
                key === 'id' &&
                ['movie', 'series', 'season', 'episode', 'audiobook'].includes(
                    String(row.type ?? row.mediaType),
                );
            if ((mediaKey || mediaNode) && typeof child === 'string' && uuid.test(child))
                found.add(child);
            walk(child, key);
        }
    }
    walk(body);
    return [...found];
}
export function mediaUrls(body: unknown, base: string): string[] {
    const urls = new Set<string>();
    function walk(value: unknown, key = ''): void {
        if (Array.isArray(value)) {
            value.forEach((v) => walk(v, key));
            return;
        }
        if (value && typeof value === 'object') {
            Object.entries(value).forEach(([k, v]) => walk(v, k));
            return;
        }
        if (typeof value !== 'string' || !/^(?:https?:\/\/|\/)/i.test(value)) return;
        if (!/url|href|image|poster|thumb|backdrop|logo|still|card|wide|full/i.test(key)) return;
        const url = new URL(value, base);
        if (url.origin !== new URL(base).origin) return;
        // No playback-producing GETs: inspect only artwork and m3u8 explicitly advertised in a response.
        if (
            !/\.m3u8(?:$|\?)|\.(?:png|jpe?g|webp|avif)(?:$|\?)|\/images?(?:\/|\?)/i.test(
                url.pathname + url.search,
            )
        )
            return;
        if (/\/livetv\/|\/audiobook\//.test(url.pathname)) return;
        urls.add(url.href);
    }
    walk(body);
    return [...urls].slice(0, 5);
}
