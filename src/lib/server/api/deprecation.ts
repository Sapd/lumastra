// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runtime side of the deprecation policy (docs/api/API.md, "Stability and
 * deprecation"): an operation whose docs say `stability: 'deprecated'` answers
 * with `Deprecation` (RFC 9745), `Sunset` (RFC 8594) and a `Link` to its
 * replacement, so a client notices without reading the spec. The spec side
 * (`deprecated: true`, `x-deprecation`) is emitted by the OpenAPI generator
 * from the same `deprecation` block.
 */

import type { DeprecationInfo } from '../openapi.js';

/** `2026-11-01` → `@1793491200` (RFC 9745 structured-field date). */
function structuredDate(isoDate: string): string {
    return `@${Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 1000)}`;
}

/** `2027-02-01` → `Mon, 01 Feb 2027 00:00:00 GMT` (RFC 8594 HTTP-date). */
function httpDate(isoDate: string): string {
    return new Date(`${isoDate}T00:00:00Z`).toUTCString();
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** RFC 9745 `rel="deprecation"` target: the policy every deprecation follows. */
export const DEPRECATION_POLICY_URL = 'https://lumastra.org/developers/api/#stability-labels-and-deprecation';

/** Policy minimum between announcing a deprecation and removing the operation. */
const MIN_NOTICE_DAYS = 90;

/** Why a deprecation block is unusable, or null. Checked by the OpenAPI generator. */
export function deprecationProblem(info: DeprecationInfo): string | null {
    const valid = (d: string): boolean => ISO_DATE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
    if (!valid(info.since)) return `since "${info.since}" is not a YYYY-MM-DD date`;
    if (info.sunset !== undefined && !valid(info.sunset)) return `sunset "${info.sunset}" is not a YYYY-MM-DD date`;
    if (info.sunset !== undefined) {
        const days = (Date.parse(info.sunset) - Date.parse(info.since)) / 86_400_000;
        if (days < MIN_NOTICE_DAYS) return `sunset is ${days} days after since; the policy needs at least ${MIN_NOTICE_DAYS}`;
    }
    if (!info.replacement.startsWith('/')) return 'replacement must be a path starting with /';
    return null;
}

/**
 * Fill `{param}` segments of the replacement path from the request's route
 * params (`/media/{id}/rating` on a request for media X → `/media/X/rating`).
 * Returns null when a segment has no matching param, so no `{id}` URL is sent.
 */
export function fillPathParams(path: string, params: Partial<Record<string, string>>): string | null {
    let unresolved = false;
    const filled = path.replace(/\{([^}]+)\}/g, (_, name: string) => {
        const value = params[name];
        if (value === undefined) {
            unresolved = true;
            return '';
        }
        return encodeURIComponent(value);
    });
    return unresolved ? null : filled;
}

/**
 * @param replacementUrl Absolute-path URL of the replacement, or null when it
 *   cannot be built for this request (then no Link is sent).
 */
export function deprecationHeaders(
    info: DeprecationInfo,
    replacementUrl: string | null,
): Record<string, string> {
    const headers: Record<string, string> = { Deprecation: structuredDate(info.since) };
    const links = [`<${DEPRECATION_POLICY_URL}>; rel="deprecation"`];
    if (replacementUrl) links.unshift(`<${replacementUrl}>; rel="successor-version"`);
    headers.Link = links.join(', ');
    if (info.sunset) headers.Sunset = httpDate(info.sunset);
    return headers;
}

/** Statuses whose responses must not carry a body (Response throws otherwise). */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Add the deprecation headers to a response. `Link` is appended, never
 * replacing a handler's own Link (pagination). Responses with immutable
 * headers (a proxied `fetch` result) are re-wrapped around the same body.
 */
export function withDeprecationHeaders(response: Response, headers: Record<string, string>): Response {
    const apply = (target: Headers): void => {
        for (const [name, value] of Object.entries(headers)) {
            if (name === 'Link') target.append(name, value);
            else target.set(name, value);
        }
    };
    try {
        apply(response.headers);
        return response;
    } catch {
        const merged = new Headers(response.headers);
        apply(merged);
        return new Response(NULL_BODY_STATUSES.has(response.status) ? null : response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: merged,
        });
    }
}
