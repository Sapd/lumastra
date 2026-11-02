// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One GET of the public GitHub releases list for Sapd/lumastra.
 *
 * Fixed host, fixed URL, no token: the request carries nothing about the
 * install beyond the source IP and a plain `Lumastra-update-check` User-Agent
 * (GitHub rejects requests without one). No version in it on purpose: a list
 * of IPs with their exact build is a list of who is still unpatched. It goes through the same DNS-pinned transport
 * as every other outbound fetch (`ssrf-guard.ts`), with a timeout and a size
 * cap, and only ever follows a redirect that stays on api.github.com (GitHub
 * answers a renamed repository with a 301 to `/repositories/<id>/…`).
 *
 * The LIST is read rather than `/releases/latest` because the security flag
 * has to see every release between the running version and the newest one: an
 * install on 0.1.0 must still turn red when 0.1.1 was the security release and
 * 0.1.2 is merely the latest. One request in the normal case, and the list also carries
 * the pre-releases an install running a pre-release wants.
 *
 * Conditional: the stored ETag goes out as If-None-Match, and a 304 — which
 * GitHub does not count against the 60/h unauthenticated limit — reuses the
 * stored result.
 */

import {
    assertNotPrivateUrl,
    pinnedFetch,
    resolveSafePublicUrl,
} from '$lib/server/utils/ssrf-guard.js';
import { isSecurityRelease, parseSemver, type ReleaseInfo } from './version.js';

export const RELEASES_HOST = 'api.github.com';
export const RELEASES_URL = `https://${RELEASES_HOST}/repos/Sapd/lumastra/releases?per_page=100`;
/** Where the admin notice sends people when a release has no usable html_url. */
export const RELEASES_PAGE_URL = 'https://github.com/Sapd/lumastra/releases';
/** Release links rendered on the admin page must stay inside the repository. */
export const RELEASE_URL_PREFIX = 'https://github.com/Sapd/lumastra/releases/';
export const UPDATE_CHECK_USER_AGENT = 'Lumastra-update-check';

/** For the whole check, all pages together. */
const TIMEOUT_MS = 20_000;
/** Per page. 100 releases with long notes stay well under this. */
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
/** Up to 300 releases: years of history at any plausible release rate. */
export const MAX_PAGES = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MIN_BACKOFF_MS = 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

export type ReleasesFetchResult =
    | {
          kind: 'ok';
          etag: string | null;
          releases: ReleaseInfo[];
          /**
           * False when a later page could not be read: the list is only the
           * newest part, and must not be stored as if it were all of it.
           */
          complete: boolean;
      }
    | { kind: 'not-modified' }
    /** No such repository or no access — the public repo before its first push. */
    | { kind: 'not-found' }
    | { kind: 'rate-limited'; retryAt: string };

export type ReleasesFetcher = (opts: {
    etag: string | null;
    signal?: AbortSignal;
}) => Promise<ReleasesFetchResult>;

async function readCapped(res: Response): Promise<string> {
    const len = res.headers.get('content-length');
    if (len && Number(len) > MAX_BYTES) throw new Error('response exceeds size cap');
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
            await reader.cancel();
            throw new Error('response exceeds size cap');
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * Retry time from Retry-After or X-RateLimit-Reset; one hour when neither is
 * usable. Clamped to [1 min, 24 h]: a bogus header must not park the check
 * for months and hide a security release.
 */
export function rateLimitRetryAt(headers: Headers, now: number = Date.now()): string {
    let delay = 60 * 60 * 1000;
    const retryAfter = Number(headers.get('retry-after'));
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) delay = retryAfter * 1000;
    else if (Number.isFinite(reset) && reset * 1000 > now) delay = reset * 1000 - now;
    delay = Math.min(Math.max(delay, MIN_BACKOFF_MS), MAX_BACKOFF_MS);
    return new Date(now + delay).toISOString();
}

interface GitHubRelease {
    tag_name?: unknown;
    html_url?: unknown;
    published_at?: unknown;
    body?: unknown;
    draft?: unknown;
    prerelease?: unknown;
}

export function isRepositoryReleaseUrl(url: string): boolean {
    return (
        url === RELEASES_PAGE_URL ||
        /^https:\/\/github\.com\/Sapd\/lumastra\/releases\/tag\/[A-Za-z0-9._+-]+$/.test(url)
    );
}

/** Keep only what the check needs; drafts and non-semver tags never count. */
export function toReleaseInfos(payload: unknown): ReleaseInfo[] {
    if (!Array.isArray(payload)) throw new Error('unexpected releases payload');
    const out: ReleaseInfo[] = [];
    for (const r of payload as GitHubRelease[]) {
        if (!r || typeof r !== 'object' || r.draft === true) continue;
        if (typeof r.tag_name !== 'string' || r.tag_name.length > 100) continue;
        const version = r.tag_name.replace(/^v/, '');
        if (!parseSemver(version)) continue;
        const url =
            typeof r.html_url === 'string' && isRepositoryReleaseUrl(r.html_url)
                ? r.html_url
                : RELEASES_PAGE_URL;
        out.push({
            version,
            url,
            publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
            security: isSecurityRelease(typeof r.body === 'string' ? r.body : null),
            prerelease: r.prerelease === true,
        });
    }
    return out;
}

type PageResult =
    | { kind: 'page'; etag: string | null; payload: unknown; next: string | null }
    | { kind: 'not-modified' }
    | { kind: 'not-found' }
    | { kind: 'rate-limited'; retryAt: string };

/**
 * `<https://…?page=2>; rel="next", <…>; rel="last"` → the next URL, if any.
 * Only a releases listing of this repository counts (by name, or by the
 * numeric id GitHub uses in its own pagination links).
 */
export function nextPageUrl(link: string | null): string | null {
    if (!link) return null;
    for (const m of link.matchAll(/<([^>]+)>\s*;\s*rel="?next"?/g)) {
        try {
            const u = new URL(m[1]);
            const path = /^\/(?:repos\/Sapd\/lumastra|repositories\/\d+)\/releases$/i;
            if (u.protocol === 'https:' && u.hostname === RELEASES_HOST && path.test(u.pathname)) {
                return u.href;
            }
        } catch {
            // not a URL; ignore
        }
        return null;
    }
    return null;
}

/** One page, following redirects that stay on api.github.com. */
async function fetchPage(
    url: string,
    etag: string | null,
    signal: AbortSignal,
): Promise<PageResult> {
    let current = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (current.protocol !== 'https:' || current.hostname !== RELEASES_HOST) {
            throw new Error(`refusing to leave ${RELEASES_HOST}: ${current.host}`);
        }
        await assertNotPrivateUrl(current);
        const safe = await resolveSafePublicUrl(current);
        const headers: Record<string, string> = {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': UPDATE_CHECK_USER_AGENT,
        };
        if (etag) headers['If-None-Match'] = etag;
        const res = await pinnedFetch(safe, { headers, redirect: 'manual', signal });

        if (REDIRECT_STATUSES.has(res.status)) {
            const location = res.headers.get('location');
            await res.body?.cancel();
            if (!location) throw new Error('redirect without Location');
            current = new URL(location, current);
            continue;
        }
        if (res.status === 304) {
            await res.body?.cancel();
            return { kind: 'not-modified' };
        }
        if (res.status === 404) {
            await res.body?.cancel();
            return { kind: 'not-found' };
        }
        if (
            res.status === 429 ||
            (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')
        ) {
            await res.body?.cancel();
            return { kind: 'rate-limited', retryAt: rateLimitRetryAt(res.headers) };
        }
        if (!res.ok) {
            await res.body?.cancel();
            throw new Error(`GitHub answered HTTP ${res.status}`);
        }
        const text = await readCapped(res);
        return {
            kind: 'page',
            etag: res.headers.get('etag'),
            payload: JSON.parse(text),
            next: nextPageUrl(res.headers.get('link')),
        };
    }
    throw new Error('too many redirects');
}

/**
 * The newest MAX_PAGES × 100 releases. Only the first page is conditional: a
 * new or edited release changes page 1 (newest first), so a 304 there means
 * nothing changed. Later pages exist so an install far behind still sees an
 * old security release; a typical repository never has a second page.
 */
export const fetchLumastraReleases: ReleasesFetcher = async ({ etag, signal }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const first = await fetchPage(RELEASES_URL, etag, controller.signal);
        if (first.kind !== 'page') return first;
        const releases = toReleaseInfos(first.payload);
        let next = first.next;
        let complete = true;
        for (let page = 2; page <= MAX_PAGES && next; page++) {
            // A later page failing must not throw away page 1: the newest
            // releases are the ones that matter most. Only a cancel or the
            // overall timeout ends the whole check.
            let more: PageResult;
            try {
                more = await fetchPage(next, null, controller.signal);
            } catch (err) {
                if (controller.signal.aborted) throw err;
                complete = false;
                break;
            }
            if (more.kind !== 'page') {
                complete = false;
                break;
            }
            try {
                releases.push(...toReleaseInfos(more.payload));
            } catch {
                complete = false;
                break;
            }
            next = more.next;
        }
        // More than MAX_PAGES pages is "complete enough": 300 releases back.
        return { kind: 'ok', etag: first.etag, releases, complete };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
};
