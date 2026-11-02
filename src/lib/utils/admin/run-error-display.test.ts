// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the curated run-error catalogue.
 *
 * The "must NOT match" and "ordering" blocks are the load-bearing halves. A
 * pattern that is too eager does more damage than a missing one: it replaces
 * an accurate raw message with confident, wrong prose ("your media folder
 * disappeared" for a missing ffmpeg binary), and — through
 * `classifyRunErrorSeverity` — can paint a real outage amber.
 *
 * Paraglide messages are mocked to echo their key, so an assertion names the
 * catalogue entry rather than a translatable sentence.
 *
 * Run with: npx vitest run src/lib/utils/admin/run-error-display.test.ts
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/paraglide/messages.js', () => {
    const keys = [
        'admin_run_error_hard_timeout',
        'admin_run_error_stalled',
        'admin_run_error_orphaned',
        'admin_run_error_transition_conflict',
        'admin_run_error_internal',
        'admin_run_error_provider_auth',
        'admin_run_error_rate_limited',
        'admin_run_error_media_decode',
        'admin_run_error_source_timing',
        'admin_run_error_ffmpeg_missing',
        'admin_run_error_disk_full',
        'admin_run_error_permission_denied',
        'admin_run_error_path_missing',
        'admin_run_error_no_network',
        'admin_run_error_no_match',
        'admin_run_error_db_constraint',
        'admin_run_error_task_paused',
        'admin_run_error_subtitle_timeout',
        'admin_run_error_worker_oom',
        'admin_run_error_plugin_crash',
        'admin_run_error_resumed',
        'admin_run_error_resume_exhausted',
        'admin_run_error_resume_crash_loop',
        'admin_run_error_resume_crashed',
        'admin_run_error_resume_failed',
    ];
    const mod: Record<string, () => string> = {};
    for (const key of keys) {
        mod[key] = () => key;
        mod[`${key}_hint`] = () => `${key}_hint`;
    }
    return mod;
});

const { explainRunError, classifyRunErrorSeverity, stripTaskIdPrefix, humanizeErrorDurations } =
    await import('./run-error-display.js');

/** The catalogue entry a message resolves to, or null. */
function entry(message: string): string | null {
    return explainRunError(message)?.summary ?? null;
}

describe('explainRunError — curated operator failures', () => {
    const cases: Array<[string, string, string]> = [
        // [catalogue entry, label, a message shaped like the real emitter]
        [
            'admin_run_error_provider_auth',
            'TMDB rejecting the API key',
            'TMDB API request failed: 401 Unauthorized — /movie/603',
        ],
        [
            'admin_run_error_provider_auth',
            "TMDB's own status_code 7",
            'TMDBError: {"success":false,"status_code":7,"status_message":"Invalid API key"}',
        ],
        [
            'admin_run_error_rate_limited',
            'a provider asking us to slow down',
            'TMDB API request failed: 429 Too Many Requests — /movie/603',
        ],
        [
            'admin_run_error_rate_limited',
            'an HTTP-anchored 429',
            'mdblist rate limit exceeded (HTTP 429)',
        ],
        [
            'admin_run_error_rate_limited',
            'a Retry-After header surfaced verbatim',
            'upstream asked us to back off, retry-after: 8',
        ],
        [
            'admin_run_error_media_decode',
            'a corrupt video stream',
            '[h264 @ 0x55f2] Invalid NAL unit size (-1852 > 143)',
        ],
        ['admin_run_error_media_decode', 'a non-zero ffmpeg exit', 'FFmpeg exited with code 1'],
        [
            'admin_run_error_media_decode',
            'a non-zero ffprobe exit',
            'ffprobe exited with code 1: Invalid data found when processing input',
        ],
        ['admin_run_error_ffmpeg_missing', 'ffmpeg not on PATH', 'Error: spawn ffmpeg ENOENT'],
        [
            'admin_run_error_disk_full',
            'a full volume',
            "ENOSPC: no space left on device, write '/config/cache/trickplay/8f2c.jpg'",
        ],
        [
            'admin_run_error_disk_full',
            'a disk quota, which is NOT a provider quota',
            'EDQUOT: disk quota exceeded writing trickplay tile',
        ],
        [
            'admin_run_error_permission_denied',
            'an unreadable media folder',
            "EACCES: permission denied, scandir '/media/anime'",
        ],
        [
            'admin_run_error_path_missing',
            'a library folder that vanished',
            "ENOENT: no such file or directory, scandir '/media/movies'",
        ],
        [
            'admin_run_error_no_network',
            'a failed name lookup',
            'getaddrinfo EAI_AGAIN api.themoviedb.org',
        ],
        [
            'admin_run_error_no_match',
            'an unidentifiable filename',
            'no results for query "Awakening.2016.2160p.HDR.WEB-DL"',
        ],
        [
            'admin_run_error_db_constraint',
            'a foreign key violation',
            'insert or update on table "media_items" violates foreign key constraint "fk_library" (23503)',
        ],
        [
            'admin_run_error_task_paused',
            'a task that paused itself after repeated failures',
            'Circuit breaker is open for task tmdb-metadata-sync: circuit_open',
        ],
        [
            'admin_run_error_subtitle_timeout',
            'a subtitle extraction that ran long',
            'subtitle extraction timed out after 120000ms for The Return of the King',
        ],
        [
            'admin_run_error_worker_oom',
            'a worker killed by the OOM killer',
            'isolation worker exited (code 137) before completing',
        ],
        [
            'admin_run_error_worker_oom',
            'an explicit SIGKILL',
            'Worker process exited with signal SIGKILL',
        ],
        [
            'admin_run_error_plugin_crash',
            'a plugin worker dying for any other reason',
            'isolation worker exited (code 1) before completing',
        ],
    ];

    for (const [expected, label, message] of cases) {
        it(`recognizes ${label}`, () => {
            expect(entry(message)).toBe(expected);
        });
    }

    it('still recognizes the four pre-existing runner-internal failures', () => {
        expect(entry('Handler runtime 300s exceeded hard timeout')).toBe(
            'admin_run_error_hard_timeout',
        );
        expect(entry('job stalled more than allowable limit')).toBe('admin_run_error_stalled');
        expect(entry('orphaned_at_recovery')).toBe('admin_run_error_orphaned');
        // Resume after restart: the resumed-run message keeps the orphan
        // prefix, so its rule must win over the generic orphan rule.
        expect(
            entry('orphaned_at_recovery: interrupted by a restart, resumed as run_01ABC (1/3)'),
        ).toBe('admin_run_error_resumed');
        expect(entry('Stopped after 3 restarts: resume limit reached')).toBe(
            'admin_run_error_resume_exhausted',
        );
        expect(
            entry('Not resumed: interrupted again within 15 min of its last resume (crash loop)'),
        ).toBe('admin_run_error_resume_crash_loop');
        expect(
            entry('Not resumed: the worker stopped unexpectedly while this run was active'),
        ).toBe('admin_run_error_resume_crashed');
        expect(entry('Not resumed: the resumed run could not be started (quota exceeded)')).toBe(
            'admin_run_error_resume_failed',
        );
        expect(entry('transition conflict: running→completed rejected')).toBe(
            'admin_run_error_transition_conflict',
        );
        expect(entry("TypeError: Cannot read properties of undefined (reading 'id')")).toBe(
            'admin_run_error_internal',
        );
    });
});

describe('explainRunError — must NOT match', () => {
    const cases: Array<[string, string]> = [
        // The documented `429` trap: 429 is a real, low MyAnimeList anime id.
        ['a bare 429 that is an upstream id', 'MAL lookup failed for /anime/429'],
        ['a bare 429 that is a count', 'processed 429 items before aborting'],
        // Same trap, same shape, for the auth pattern.
        ['a bare 401 that is a count', 'processed 401 items before aborting'],
        // "storage quota" is an app-level quota, not a disk — and the copy for
        // a full disk would be wrong for it.
        ['an app-level storage quota', 'storage quota exceeded for library group'],
        // An unrelated subprocess exit must not be blamed on a damaged file.
        ['a non-ffmpeg subprocess exit', 'plugin build exited with code 1'],
        ['a clean ffmpeg exit', 'FFmpeg exited with code 0'],
        // 137 must be an exit code, not any number that starts with 137.
        ['an exit code that merely starts with 137', 'aborted after 1370 items'],
        // SIGTERM is a graceful shutdown, not an out-of-memory kill.
        ['a graceful worker shutdown', 'worker exited with signal SIGTERM'],
        // The engineer-facing stage-recovery note lists SIGKILL/OOM as
        // possibilities; it is not itself an out-of-memory report.
        [
            'the stage-recovery note that merely mentions SIGKILL / OOM',
            'Stage row was running but the owning task_history run is no longer active. Most likely the worker died (SIGKILL / OOM / container restart) between markRunning and the terminal transition. Recovered to failed_transient so stage-sweep will retry on the next tick.',
        ],
        // SQLSTATE-shaped digits that are just a row count.
        ['a row count that looks like a SQLSTATE', 'processed 23503 rows before aborting'],
        // "Not Found" is not ENOTFOUND, and not a no-match.
        ['an HTTP 404', 'TMDB API request failed: 404 Not Found — /movie/603'],
        // Ordinary task-authored prose keeps its own words.
        [
            'a task-authored upstream-outage message',
            'mal-anime-id-enrichment: upstream outage — 0 enriched with 3 error(s).',
        ],
    ];

    for (const [label, message] of cases) {
        it(`leaves ${label} alone`, () => {
            expect(explainRunError(message)).toBeNull();
        });
    }
});

describe('explainRunError — human-authored messages pass through unrewritten', () => {
    const authored = [
        'mdblist-sync: rate limit reached (mdblist.com free-tier quota) — resumes automatically once the quota window resets',
        'tmdb-metadata-sync: rate limit reached (TMDB API) — resumes automatically once the quota window resets (12 item(s) deferred).',
    ];

    for (const message of authored) {
        it(`does not rewrite "${message.slice(0, 48)}…"`, () => {
            expect(explainRunError(message)).toBeNull();
        });
    }

    it('leaves the tasks\' own "API key missing or invalid" copy alone', () => {
        // Already operator copy, and it names the fix — the 401 pattern is
        // anchored on the status code precisely so it does not swallow this.
        expect(
            explainRunError(
                'tmdb-metadata-sync: TMDB API key missing or invalid — check the key in settings; no metadata synced.',
            ),
        ).toBeNull();
    });

    it('still classifies a passed-through self-healing message as expected', () => {
        expect(
            classifyRunErrorSeverity(
                'mdblist-sync: rate limit reached (mdblist.com free-tier quota) — resumes automatically once the quota window resets',
            ),
        ).toBe('expected');
    });
});

describe('explainRunError — ordering between overlapping patterns', () => {
    it('reads "spawn ffmpeg ENOENT" as a missing binary, not a vanished folder', () => {
        expect(entry('Error: spawn ffmpeg ENOENT')).toBe('admin_run_error_ffmpeg_missing');
    });

    it('reads a subtitle timeout as its own case, not the generic hard timeout', () => {
        expect(entry('Handler runtime 600s exceeded hard timeout extracting subtitles')).toBe(
            'admin_run_error_subtitle_timeout',
        );
    });

    it('reads exit code 137 as an out-of-memory kill, not a plugin crash', () => {
        expect(entry('isolation worker exited (code 137) before completing')).toBe(
            'admin_run_error_worker_oom',
        );
    });
});

describe('classifyRunErrorSeverity — severity has to be earned', () => {
    it('paints a full disk red, not amber, despite the word "quota"', () => {
        // EXPECTED_RUN_ERROR_PATTERN matches any "quota"; a curated entry wins
        // so an operator is never told a full disk is self-healing.
        expect(classifyRunErrorSeverity('EDQUOT: disk quota exceeded')).toBe('operator');
    });

    it('paints a provider rate limit amber', () => {
        expect(classifyRunErrorSeverity('TMDB API request failed: 429 Too Many Requests')).toBe(
            'expected',
        );
    });

    it('paints a name-lookup failure amber — it resumes by itself', () => {
        expect(classifyRunErrorSeverity('getaddrinfo EAI_AGAIN api.themoviedb.org')).toBe(
            'expected',
        );
    });

    it('paints a self-paused task amber — it un-pauses itself', () => {
        expect(
            classifyRunErrorSeverity(
                'Circuit breaker is open for task metadata-sync: circuit_open',
            ),
        ).toBe('expected');
    });

    it('attributes a constraint violation to us, not the operator', () => {
        expect(
            classifyRunErrorSeverity('duplicate key value violates unique constraint "media_pkey"'),
        ).toBe('internal');
    });

    it('returns null for an ordinary unclassified failure', () => {
        expect(classifyRunErrorSeverity('upstream outage — 0 created/updated')).toBeNull();
    });
});

describe('stripTaskIdPrefix', () => {
    it('strips a task id the row is already scoped to', () => {
        expect(stripTaskIdPrefix('mdblist-sync: upstream outage', 'mdblist-sync')).toBe(
            'upstream outage',
        );
    });

    it('never strips down to nothing', () => {
        expect(stripTaskIdPrefix('mdblist-sync', 'mdblist-sync')).toBe('mdblist-sync');
    });
});

describe('humanizeErrorDurations', () => {
    it('rewrites millisecond counts of a second or more', () => {
        expect(humanizeErrorDurations('FFmpeg operation timed out after 300000ms')).toBe(
            'FFmpeg operation timed out after 5 min',
        );
        expect(humanizeErrorDurations('waited 1500 ms')).toBe('waited 1.5 s');
        expect(humanizeErrorDurations('lease 7200000ms expired')).toBe('lease 2 h expired');
    });

    it('leaves short durations and other numbers alone', () => {
        expect(humanizeErrorDurations('took 250ms')).toBe('took 250ms');
        expect(humanizeErrorDurations('port 30000 refused')).toBe('port 30000 refused');
    });
});

it('provides source repair guidance only for the known nonadvancing timing evidence', () => {
    expect(
        entry(
            'Video packet timestamps do not advance despite sustained positive packet durations; repair the source file before retrying analysis',
        ),
    ).toBe('admin_run_error_source_timing');
    expect(entry('Unknown first attempt permanent failure')).toBeNull();
});
