// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The daily update check against lumastra.org, with GitHub as the fallback.
 *
 *   GET https://lumastra.org/api/update-check?v=<version>
 *
 * The request is the same for every install running the same version: no
 * install ID, no hash, no token, no cookie, no body. Only Accept and the plain
 * `Lumastra-update-check` User-Agent go with it, and the source IP is what any
 * web request reveals. The worker (lumastra-web, `update-check-endpoint.ts`)
 * answers with the release list and counts the request by version and country,
 * storing no IP, so nothing links two requests.
 *
 * Answer: `{ releases: [{ version, url, publishedAt, security, prerelease }],
 * complete }`, the same fields the GitHub path reduces its list to, so the
 * stored state, the security flag and the red notice work unchanged.
 *
 * Anything but a well-formed 200 (outage, 429, redirect, garbage) is an error
 * here; `fetchReleasesPreferringLumastraOrg` then reads GitHub in the same
 * run. The caller decides whether lumastra.org may be asked at all: the switch
 * `LICENSE_SERVER_CONTACT_ENABLED` on and the setup answer (see
 * `services/lumastra-org-consent.ts`). Otherwise GitHub only, and lumastra.org
 * is not contacted.
 */

import {
    assertNotPrivateUrl,
    pinnedFetch,
    resolveSafePublicUrl,
} from '$lib/server/utils/ssrf-guard.js';
import {
    fetchLumastraReleases,
    isRepositoryReleaseUrl,
    RELEASES_PAGE_URL,
    UPDATE_CHECK_USER_AGENT,
    type ReleasesFetcher,
    type ReleasesFetchResult,
} from './github-releases.js';
import { parseSemver, type ReleaseInfo } from './version.js';

export const UPDATE_CHECK_ENDPOINT = 'https://lumastra.org/api/update-check';
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;
/** What the worker accepts for `v` (`[A-Za-z0-9._+-]{1,64}`). */
const VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/;

/** The request URL. A version the worker would reject goes out as a placeholder. */
export function updateCheckUrl(version: string): URL {
    const url = new URL(UPDATE_CHECK_ENDPOINT);
    url.searchParams.set(
        'v',
        version === '' ? 'unknown' : VERSION_RE.test(version) ? version : 'other',
    );
    return url;
}

function parseAnswer(payload: unknown): { releases: ReleaseInfo[]; complete: boolean } {
    if (!payload || typeof payload !== 'object') throw new Error('unexpected update-check answer');
    const { releases, complete } = payload as { releases?: unknown; complete?: unknown };
    if (!Array.isArray(releases) || typeof complete !== 'boolean') {
        throw new Error('unexpected update-check answer');
    }
    const out: ReleaseInfo[] = [];
    for (const r of releases as Record<string, unknown>[]) {
        if (!r || typeof r !== 'object') throw new Error('unexpected update-check answer');
        if (typeof r.security !== 'boolean' || typeof r.prerelease !== 'boolean') {
            throw new Error('unexpected update-check answer');
        }
        if (typeof r.version !== 'string' || !parseSemver(r.version)) continue;
        out.push({
            version: r.version,
            // This URL becomes an href on an admin page: only the repository's own.
            url:
                typeof r.url === 'string' && isRepositoryReleaseUrl(r.url)
                    ? r.url
                    : RELEASES_PAGE_URL,
            publishedAt: typeof r.publishedAt === 'string' ? r.publishedAt : null,
            security: r.security,
            prerelease: r.prerelease,
        });
    }
    return { releases: out, complete };
}

async function readCapped(res: Response): Promise<string> {
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

/** One GET to lumastra.org. Throws on anything but a well-formed answer. */
export async function fetchLumastraOrgReleases(opts: {
    version: string;
    signal?: AbortSignal;
}): Promise<ReleasesFetchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const onAbort = (): void => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const url = updateCheckUrl(opts.version);
        await assertNotPrivateUrl(url);
        const safe = await resolveSafePublicUrl(url);
        const res = await pinnedFetch(safe, {
            headers: { Accept: 'application/json', 'User-Agent': UPDATE_CHECK_USER_AGENT },
            redirect: 'manual',
            signal: controller.signal,
        });
        if (res.status !== 200) {
            await res.body?.cancel();
            throw new Error(`lumastra.org answered HTTP ${res.status}`);
        }
        const { releases, complete } = parseAnswer(JSON.parse(await readCapped(res)));
        // No ETag: the request carries nothing from an earlier answer.
        return { kind: 'ok', etag: null, releases, complete };
    } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
    }
}

export interface PreferringLumastraOrgOpts {
    version: string;
    /** GitHub's ETag from the stored state; never sent to lumastra.org. */
    etag: string | null;
    signal?: AbortSignal;
    /** Switch on and the setup answer given, read when the request is made. */
    contact: boolean | (() => boolean);
    /** False once lumastra.org was already asked today: go straight to GitHub. */
    contactAllowed: boolean;
    /** Called right before lumastra.org is contacted (so the caller can remember it). */
    onContact?: () => void;
    fetchGithub?: ReleasesFetcher;
    fetchOrg?: typeof fetchLumastraOrgReleases;
}

/**
 * lumastra.org first when the install may contact it, GitHub otherwise or when
 * lumastra.org fails. At most one request to each, no retries.
 */
export async function fetchReleasesPreferringLumastraOrg(
    opts: PreferringLumastraOrgOpts,
): Promise<ReleasesFetchResult> {
    const fetchGithub = opts.fetchGithub ?? fetchLumastraReleases;
    const fetchOrg = opts.fetchOrg ?? fetchLumastraOrgReleases;
    const contact = typeof opts.contact === 'function' ? opts.contact() : opts.contact;
    if (contact && opts.contactAllowed) {
        opts.onContact?.();
        try {
            return await fetchOrg({ version: opts.version, signal: opts.signal });
        } catch {
            if (opts.signal?.aborted) throw new Error('aborted');
            // Fall through to GitHub: the update notice must keep working.
        }
    }
    return fetchGithub({ etag: opts.etag, signal: opts.signal });
}
