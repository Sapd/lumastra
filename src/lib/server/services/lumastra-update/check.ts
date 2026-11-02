// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Lumastra update check: ask GitHub once a day which releases exist,
 * remember the answer, and let the attention adapter and the Instance page
 * compare it against the running build.
 *
 * State lives in `plugin_settings` (plugin_id `lumastra-update-check`, key
 * `state`) — the key/value table tasks already use for their own state, so
 * this needs no migration. What is stored is the release list, not a verdict:
 * the verdict depends on the RUNNING version, and computing it at read time is
 * what makes the notice disappear the moment an upgraded build starts, rather
 * than a day later when the next check runs.
 *
 * Failure handling is deliberately quiet. GitHub being unreachable, the repo
 * not existing yet (it 404s until the public bootstrap) or the rate limit
 * being hit are all "no new information": the previous answer stays, nothing
 * throws, and a repeated failure is logged at warn level once rather than every
 * day.
 */

import type postgres from 'postgres';
import {
    addToTaskSettingList,
    getTaskSettings,
    removeFromTaskSettingList,
    upsertTaskSettings,
} from '$lib/server/database/queries/task-settings.queries.js';
import { isRepositoryReleaseUrl, type ReleasesFetcher } from './github-releases.js';
import {
    evaluateUpdate,
    parseRunningVersion,
    type ReleaseInfo,
    type UpdateEvaluation,
} from './version.js';

export const UPDATE_CHECK_STATE_ID = 'lumastra-update-check';
const STATE_KEY = 'state';
/**
 * Security releases an admin marked as reviewed. A key of its own, NOT a field
 * of `state`: the task rewrites `state` wholesale after each check, and an
 * admin's decision taken while a check was in flight must not be lost to it.
 */
const REVIEWED_KEY = 'reviewed-security';

const DAY_MS = 24 * 60 * 60 * 1000;
/** ±2h around the daily check, so installs drift apart instead of lining up. */
const JITTER_MS = 2 * 60 * 60 * 1000;
/** Retry an unexpected failure sooner than a day, but not hourly. */
const ERROR_RETRY_MS = 6 * 60 * 60 * 1000;
const MAX_STORED_RELEASES = 300;
/**
 * The ETag only covers page 1. Once a week the list is read without it, so an
 * edit to an older release (a security flag added later) is still picked up.
 */
const FULL_REFRESH_MS = 7 * DAY_MS;

export interface LumastraUpdateState {
    /** Last time GitHub answered (200, 304 or 404). */
    checkedAt: string | null;
    /** The check does nothing before this, unless run by hand. */
    nextCheckAt: string | null;
    etag: string | null;
    /** False while the repository 404s; the release list is then empty. */
    repoFound: boolean;
    releases: ReleaseInfo[];
    lastError: string | null;
    lastErrorAt: string | null;
    /**
     * Start of the current streak without a usable answer (network error,
     * rate limit, or a 404 after the repository had been found); null once
     * GitHub answers again.
     */
    failingSince: string | null;
    /** Last time the check actually tried to reach GitHub. */
    lastAttemptAt: string | null;
    /** Last time the whole list was read without If-None-Match. */
    fullFetchAt: string | null;
    /** Read from its own key (see REVIEWED_KEY); never written with `state`. */
    reviewedSecurity: string[];
}

export const EMPTY_UPDATE_STATE: LumastraUpdateState = {
    checkedAt: null,
    nextCheckAt: null,
    etag: null,
    repoFound: false,
    releases: [],
    lastError: null,
    lastErrorAt: null,
    failingSince: null,
    lastAttemptAt: null,
    fullFetchAt: null,
    reviewedSecurity: [],
};

function isReleaseInfo(v: unknown): v is ReleaseInfo {
    if (!v || typeof v !== 'object') return false;
    const r = v as Record<string, unknown>;
    return (
        typeof r.version === 'string' &&
        typeof r.url === 'string' &&
        // Re-checked on read: this URL becomes an href on an admin page.
        isRepositoryReleaseUrl(r.url) &&
        (r.publishedAt === null || typeof r.publishedAt === 'string') &&
        typeof r.security === 'boolean' &&
        typeof r.prerelease === 'boolean'
    );
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** A stored timestamp, or null when it is not one (it feeds date arithmetic). */
const isoDate = (v: unknown): string | null =>
    typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;

/** Read the stored state; anything malformed reads as "never checked". */
export async function readUpdateState(sql: postgres.Sql): Promise<LumastraUpdateState> {
    const settings = await getTaskSettings(sql, UPDATE_CHECK_STATE_ID);
    const reviewedRaw = settings[REVIEWED_KEY];
    const reviewedSecurity = Array.isArray(reviewedRaw)
        ? reviewedRaw.filter((v): v is string => typeof v === 'string')
        : [];
    const raw = settings[STATE_KEY];
    if (!raw || typeof raw !== 'object') return { ...EMPTY_UPDATE_STATE, reviewedSecurity };
    const r = raw as Record<string, unknown>;
    return {
        failingSince: isoDate(r.failingSince),
        lastAttemptAt: isoDate(r.lastAttemptAt),
        fullFetchAt: isoDate(r.fullFetchAt),
        reviewedSecurity,
        checkedAt: isoDate(r.checkedAt),
        nextCheckAt: isoDate(r.nextCheckAt),
        etag: str(r.etag),
        repoFound: r.repoFound === true,
        releases: Array.isArray(r.releases) ? r.releases.filter(isReleaseInfo) : [],
        lastError: str(r.lastError),
        lastErrorAt: isoDate(r.lastErrorAt),
    };
}

async function writeUpdateState(sql: postgres.Sql, state: LumastraUpdateState): Promise<void> {
    const { reviewedSecurity: _owned, ...persisted } = state;
    await upsertTaskSettings(sql, UPDATE_CHECK_STATE_ID, { [STATE_KEY]: persisted });
}

/**
 * An admin's "this security fix does not apply to us / we mitigated it" for
 * one security release. The red notice for that release — and for any OLDER
 * security release still pending (see `evaluateUpdate`) — becomes the normal,
 * dismissable one; a LATER security release is red again. Only versions the
 * stored list actually flags as security releases are accepted. The append is
 * one SQL statement, so two admins reviewing at once cannot lose each other's
 * decision.
 */
export async function markSecurityReviewed(sql: postgres.Sql, version: string): Promise<boolean> {
    const state = await readUpdateState(sql);
    if (!state.releases.some((r) => r.security && r.version === version)) return false;
    await addToTaskSettingList(sql, UPDATE_CHECK_STATE_ID, REVIEWED_KEY, version);
    return true;
}

/** Undo `markSecurityReviewed` for one version. */
export async function unmarkSecurityReviewed(sql: postgres.Sql, version: string): Promise<void> {
    await removeFromTaskSettingList(sql, UPDATE_CHECK_STATE_ID, REVIEWED_KEY, version);
}

/** Keep the newest list first; add older entries it no longer reaches. */
function mergeReleases(fresh: ReleaseInfo[], previous: ReleaseInfo[]): ReleaseInfo[] {
    const seen = new Set(fresh.map((r) => r.version));
    return [...fresh, ...previous.filter((r) => !seen.has(r.version))];
}

export interface RunningBuild {
    version: string;
    buildTime?: string | null;
}

/** What to announce for this build, from the stored state. */
export function evaluateStoredUpdate(
    state: LumastraUpdateState,
    build: RunningBuild,
): UpdateEvaluation {
    return evaluateUpdate(
        state.releases,
        parseRunningVersion(build.version),
        build.buildTime,
        new Set(state.reviewedSecurity),
    );
}

export type UpdateCheckStatus =
    | 'disabled'
    | 'not-due'
    | 'checked'
    | 'not-modified'
    | 'no-releases'
    | 'rate-limited'
    | 'aborted'
    | 'failed';

export interface UpdateCheckOutcome {
    status: UpdateCheckStatus;
    evaluation: UpdateEvaluation | null;
    error?: string;
}

export interface UpdateCheckLogger {
    info(msg: string, meta?: object): void;
    warn(msg: string, meta?: object): void;
    debug(msg: string, meta?: object): void;
}

export interface UpdateCheckDeps {
    sql: postgres.Sql;
    enabled: boolean;
    build: RunningBuild;
    fetchReleases: ReleasesFetcher;
    logger: UpdateCheckLogger;
    /** A manual run checks now, whatever `nextCheckAt` says. */
    force?: boolean;
    signal?: AbortSignal;
    now?: () => number;
    random?: () => number;
}

export async function runUpdateCheck(deps: UpdateCheckDeps): Promise<UpdateCheckOutcome> {
    // Opted out: no request, and nothing read or written either.
    if (!deps.enabled) return { status: 'disabled', evaluation: null };

    const now = (deps.now ?? Date.now)();
    const random = deps.random ?? Math.random;
    const state = await readUpdateState(deps.sql);

    if (!deps.force && state.nextCheckAt && Date.parse(state.nextCheckAt) > now) {
        return { status: 'not-due', evaluation: evaluateStoredUpdate(state, deps.build) };
    }

    const nextDaily = new Date(now + DAY_MS + (random() * 2 - 1) * JITTER_MS).toISOString();
    const nowIso = new Date(now).toISOString();
    let status: UpdateCheckStatus;
    let error: string | undefined;
    const next: LumastraUpdateState = { ...state, lastAttemptAt: nowIso };
    // A 304 only helps when there is a stored list to reuse. Without one
    // (first run, or entries dropped as malformed on read) ask unconditionally,
    // or an empty list could be confirmed forever; and once a week anyway.
    const fullFetchAge = state.fullFetchAt ? now - Date.parse(state.fullFetchAt) : Infinity;
    const etag = state.releases.length > 0 && fullFetchAge < FULL_REFRESH_MS ? state.etag : null;

    try {
        const result = await deps.fetchReleases({ etag, signal: deps.signal });
        switch (result.kind) {
            case 'ok':
                if (result.complete) {
                    next.releases = result.releases.slice(0, MAX_STORED_RELEASES);
                    next.etag = result.etag;
                    next.fullFetchAt = nowIso;
                } else {
                    // Only the newest page(s) arrived. Keep what older pages
                    // said last time, and no ETag, so the next check reads it
                    // all again instead of confirming a truncated list.
                    deps.logger.debug('Lumastra release list read only partly');
                    next.releases = mergeReleases(result.releases, state.releases).slice(
                        0,
                        MAX_STORED_RELEASES,
                    );
                    next.etag = null;
                }
                next.repoFound = true;
                next.checkedAt = nowIso;
                next.nextCheckAt = nextDaily;
                next.lastError = null;
                next.lastErrorAt = null;
                next.failingSince = null;
                status = next.releases.length > 0 ? 'checked' : 'no-releases';
                break;
            case 'not-modified':
                next.checkedAt = nowIso;
                next.nextCheckAt = nextDaily;
                next.lastError = null;
                next.lastErrorAt = null;
                next.failingSince = null;
                status = next.releases.length > 0 ? 'not-modified' : 'no-releases';
                break;
            case 'not-found':
                if (state.repoFound) {
                    // The repository WAS there. Its going away is not "no
                    // releases yet": keep the last list and count it as a
                    // failure, so a lasting 404 reaches the failing notice.
                    deps.logger.info('Lumastra releases are not reachable any more (HTTP 404)');
                    next.lastError = 'GitHub answered HTTP 404 for the release list';
                    next.lastErrorAt = nowIso;
                    next.failingSince = state.failingSince ?? nowIso;
                    next.nextCheckAt = nextDaily;
                    status = 'failed';
                    error = next.lastError;
                    break;
                }
                // Expected until the public repository's first release. Quiet.
                next.releases = [];
                next.etag = null;
                next.checkedAt = nowIso;
                next.nextCheckAt = nextDaily;
                next.lastError = null;
                next.lastErrorAt = null;
                next.failingSince = null;
                status = 'no-releases';
                break;
            case 'rate-limited':
                deps.logger.info('GitHub rate limit reached; update check postponed', {
                    retryAt: result.retryAt,
                });
                next.nextCheckAt =
                    Date.parse(result.retryAt) > now
                        ? result.retryAt
                        : new Date(now + 60 * 60 * 1000).toISOString();
                // Not an error, but no answer either: a shared egress IP that
                // is always over the limit must still reach the failing notice.
                next.failingSince = state.failingSince ?? nowIso;
                status = 'rate-limited';
                break;
        }
    } catch (err) {
        if (deps.signal?.aborted) {
            // Shutdown or cancel, not a GitHub problem: leave the state alone
            // so the next run checks as if this one never started.
            return { status: 'aborted', evaluation: evaluateStoredUpdate(state, deps.build) };
        }
        error = err instanceof Error ? err.message : String(err);
        // Logged once per distinct failure: a box without internet access
        // must not write the same warning every day.
        if (error !== state.lastError) {
            deps.logger.warn('Lumastra update check failed; will retry later', { error });
        } else {
            deps.logger.debug('Lumastra update check failed again', { error });
        }
        next.lastError = error;
        next.lastErrorAt = nowIso;
        next.failingSince = state.failingSince ?? nowIso;
        next.nextCheckAt = new Date(now + ERROR_RETRY_MS).toISOString();
        status = 'failed';
    }

    await writeUpdateState(deps.sql, next);
    return { status, evaluation: evaluateStoredUpdate(next, deps.build), error };
}
