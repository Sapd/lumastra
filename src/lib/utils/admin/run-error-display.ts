// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Operator-facing display helpers for task-run failure messages.
 *
 * Raw run errors are written by the runner/tasks for engineers
 * ("orphaned_at_recovery", "Handler runtime 300s exceeded hard timeout", raw
 * JS TypeErrors, `ENOSPC: no space left on device`). Operator surfaces render
 * the plain-language explanation from `explainRunError` as the primary line
 * and keep the raw message behind a details affordance — same philosophy as
 * `error-contract.ts`, but for run *outcomes* rather than fetch failures.
 *
 * Copy for the curated entries follows the error-message design rules: name
 * the thing in the operator's vocabulary, one sentence of cause, **say
 * whether it fixes itself**, say what still works, and end on exactly one
 * action. Never "check the logs" — the raw text is already one click away at
 * every render site.
 */

import * as m from '$lib/paraglide/messages.js';
import { EXPECTED_RUN_ERROR_PATTERN } from '$lib/shared/run-error-severity.js';

/**
 * Native tasks historically bake their own id into the error message
 * ("mal-anime-id-enrichment: upstream outage — …"). On a surface already
 * scoped to that task (its card, its detail drawer, a run row grouped under
 * its name) the prefix is pure noise — strip it for display only.
 */
export function stripTaskIdPrefix(message: string, taskId?: string | null): string {
    if (!taskId) return message;
    const trimmed = message.trimStart();
    if (!trimmed.toLowerCase().startsWith(taskId.toLowerCase())) return message;
    const rest = trimmed.slice(taskId.length);
    const separator = /^\s*[:—–-]\s*/.exec(rest);
    if (!separator) return message;
    const stripped = rest.slice(separator[0].length).trim();
    // Never strip down to nothing — a bare task id is still better than "".
    return stripped.length > 0 ? stripped : message;
}

/**
 * Rewrites raw millisecond counts inside an error message for reading:
 * "FFmpeg operation timed out after 300000ms" → "… after 5 min". Only counts
 * of a second or more are touched ("250ms" is already readable), and the units
 * (s / min / h) read the same in English and German. Display only — never
 * feed the result back into anything that parses errors.
 */
export function humanizeErrorDurations(message: string): string {
    return message.replace(/\b(\d{4,})\s?ms\b/g, (whole, digits: string) => {
        const ms = Number(digits);
        if (!Number.isFinite(ms)) return whole;
        const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));
        const seconds = ms / 1000;
        if (seconds < 60) return `${fmt(seconds)} s`;
        const minutes = seconds / 60;
        if (minutes < 60) return `${fmt(minutes)} min`;
        return `${fmt(minutes / 60)} h`;
    });
}

/**
 * How urgently an operator should treat a run failure. Severity is *earned*:
 * amber is reserved for conditions that genuinely clear on their own, because
 * a red badge that resolves itself while the admin does nothing trains them to
 * ignore red forever.
 *
 *  - `expected`: self-healing — a known, temporary condition (rate limit,
 *    quota, name-lookup failure, a task pausing itself after repeated
 *    failures) that resolves without operator action. Not an outage. This is
 *    the only value the render sites paint amber.
 *  - `transient`: a runner-internal blip (timeout, stall, orphan, transition
 *    conflict) — usually resolves on the next scheduled attempt.
 *  - `operator`: a real problem in the operator's own environment (full disk,
 *    unreadable path, missing ffmpeg, a title that needs matching by hand).
 *    Nobody's bug — but nothing improves until a human acts.
 *  - `internal`: our bug (an uncaught JS error, a database constraint
 *    violation, a crashed plugin). Attribute it honestly and out loud.
 *
 * Render sites treat every non-`expected` value as red today; the distinction
 * between `transient`/`operator`/`internal` exists so the *attribution* in the
 * copy and any future triage can stay honest.
 */
export type RunErrorSeverity = 'expected' | 'transient' | 'operator' | 'internal';

export interface RunErrorExplanation {
    /** One plain sentence: what happened. */
    summary: string;
    /**
     * Second sentence: whether it fixes itself, what still works, and the one
     * thing the operator should do. Rendered where the surface has room for it
     * (the diagnostics panel); the summary alone carries the single-line rows.
     */
    hint: string;
    severity: RunErrorSeverity;
}

interface ErrorPattern {
    pattern: RegExp;
    explain: (match: RegExpExecArray) => RunErrorExplanation;
}

/**
 * Messages the task itself already wrote for a human ("… — resumes
 * automatically once the quota window resets") are never rewritten: the task
 * knows which provider and which window, and this module does not. The guard
 * is deliberately a single, distinctive phrase rather than a general
 * heuristic — it exists so a later pattern addition cannot silently swallow
 * hand-authored operator copy.
 */
const HUMAN_AUTHORED_SELF_HEALING = /resumes automatically/i;

/** Messages the resume-after-restart reclaim writes (they embed raw reasons). */
const RESUME_MESSAGE = /^(?:Not resumed:|Stopped after \d+ restarts:)/;

// Ordered: first match wins. Two ordering constraints are load-bearing and
// covered by tests:
//   - the subtitle-specific timeout must precede the generic hard timeout,
//   - `spawn ffmpeg ENOENT` must be read as "ffmpeg is missing", never as
//     "your media folder disappeared", so ffmpeg-missing precedes path-missing,
//   - a worker killed with `code 137` / SIGKILL is an out-of-memory kill, not
//     a generic plugin crash, so worker-oom precedes plugin-crash.
const PATTERNS: ErrorPattern[] = [
    {
        pattern:
            /Video packet timestamps do not advance despite sustained positive packet durations/i,
        explain: () => ({
            summary: m.admin_run_error_source_timing(),
            hint: m.admin_run_error_source_timing_hint(),
            severity: 'operator',
        }),
    },
    // Resume after restart (server `tasks/run-resume.ts` writes these
    // messages — keep the wording in sync). FIRST, and anchored: a resumed
    // run's message keeps the `orphaned_at_recovery` prefix (failure counts
    // treat it as churn), and a "could not be started (<reason>)" message
    // embeds a raw reason that a later rule (hard timeout, stall …) would
    // otherwise claim.
    {
        pattern:
            /^orphaned_at_recovery: interrupted by a restart, resumed as \S+ \((\d+)\/(\d+)\)$/i,
        explain: (match) => ({
            summary: m.admin_run_error_resumed({ count: match[1], max: match[2] }),
            hint: m.admin_run_error_resumed_hint(),
            severity: 'expected',
        }),
    },
    {
        pattern: /^Stopped after (\d+) restarts: resume limit reached$/i,
        explain: (match) => ({
            summary: m.admin_run_error_resume_exhausted({ max: match[1] }),
            hint: m.admin_run_error_resume_exhausted_hint(),
            severity: 'operator',
        }),
    },
    {
        pattern: /^Not resumed: interrupted again within/i,
        explain: () => ({
            summary: m.admin_run_error_resume_crash_loop(),
            hint: m.admin_run_error_resume_crash_loop_hint(),
            severity: 'operator',
        }),
    },
    {
        pattern: /^Not resumed: the worker stopped unexpectedly/i,
        explain: () => ({
            summary: m.admin_run_error_resume_crashed(),
            hint: m.admin_run_error_resume_crashed_hint(),
            severity: 'operator',
        }),
    },
    {
        pattern: /^Not resumed: the resumed run could not be started/i,
        explain: () => ({
            summary: m.admin_run_error_resume_failed(),
            hint: m.admin_run_error_resume_failed_hint(),
            severity: 'operator',
        }),
    },
    {
        // Before the generic hard timeout below. Only fires when the message
        // actually names subtitles — the extractor's own current wording
        // ("FFmpeg operation timed out after 120000ms") does not, and claiming
        // "playback still works, subtitles render live" for a trickplay
        // timeout would be a lie.
        pattern:
            /subtitle[^\n]{0,60}(?:timed out|timeout)|(?:timed out|timeout)[^\n]{0,60}subtitle/i,
        explain: () => ({
            summary: m.admin_run_error_subtitle_timeout(),
            hint: m.admin_run_error_subtitle_timeout_hint(),
            severity: 'operator',
        }),
    },
    {
        pattern: /exceeded hard timeout|handler runtime .*exceeded/i,
        explain: () => ({
            summary: m.admin_run_error_hard_timeout(),
            hint: m.admin_run_error_hard_timeout_hint(),
            severity: 'transient',
        }),
    },
    {
        pattern: /stalled more than allowable limit|job stalled/i,
        explain: () => ({
            summary: m.admin_run_error_stalled(),
            hint: m.admin_run_error_stalled_hint(),
            severity: 'transient',
        }),
    },
    {
        pattern: /orphaned[_ ]at[_ ]recovery|orphaned at startup/i,
        explain: () => ({
            summary: m.admin_run_error_orphaned(),
            hint: m.admin_run_error_orphaned_hint(),
            severity: 'transient',
        }),
    },
    {
        pattern: /transition conflict/i,
        explain: () => ({
            summary: m.admin_run_error_transition_conflict(),
            hint: m.admin_run_error_transition_conflict_hint(),
            severity: 'transient',
        }),
    },
    {
        // orchestrator.ts: `Circuit breaker is <state> for task <id>: <reason>`.
        // Operator copy never says "circuit breaker" or "half-open" — the task
        // paused itself, and it un-pauses itself, so this is amber.
        pattern:
            /circuit breaker is (?:open|half[_-]?open)|\bcircuit_open\b|\bopen_with_cooldown\b|\bhalf_open_probe_taken\b/i,
        explain: () => ({
            summary: m.admin_run_error_task_paused(),
            hint: m.admin_run_error_task_paused_hint(),
            severity: 'expected',
        }),
    },
    {
        // `Error: spawn ffmpeg ENOENT` — must beat the ENOENT path rule below.
        pattern:
            /spawn (?:ffmpeg|ffprobe)[^\n]{0,20}ENOENT|\b(?:ffmpeg|ffprobe)\b[^\n]{0,20}(?:not found|is not installed|no such file)/i,
        explain: () => ({
            summary: m.admin_run_error_ffmpeg_missing(),
            hint: m.admin_run_error_ffmpeg_missing_hint(),
            severity: 'operator',
        }),
    },
    {
        // `EDQUOT` / "disk quota exceeded" belong here, NOT with the rate
        // limits: a full volume is the operator's problem and never clears on
        // its own. Anything vaguer than these four spellings stays out — a
        // bare "quota" is a provider word far more often than a disk word.
        pattern: /\bENOSPC\b|no space left on device|\bEDQUOT\b|disk quota exceeded/i,
        explain: () => ({
            summary: m.admin_run_error_disk_full(),
            hint: m.admin_run_error_disk_full_hint(),
            severity: 'operator',
        }),
    },
    {
        pattern: /\bEACCES\b|\bEPERM\b|permission denied|operation not permitted/i,
        explain: () => ({
            summary: m.admin_run_error_permission_denied(),
            hint: m.admin_run_error_permission_denied_hint(),
            severity: 'operator',
        }),
    },
    {
        pattern: /\bENOENT\b|no such file or directory/i,
        explain: () => ({
            summary: m.admin_run_error_path_missing(),
            hint: m.admin_run_error_path_missing_hint(),
            severity: 'operator',
        }),
    },
    {
        // DNS only — the copy says "a name lookup failed", so ECONNREFUSED and
        // friends deliberately stay out rather than making the sentence wrong.
        pattern: /\bEAI_AGAIN\b|\bENOTFOUND\b|\bgetaddrinfo\b/i,
        explain: () => ({
            summary: m.admin_run_error_no_network(),
            hint: m.admin_run_error_no_network_hint(),
            severity: 'expected',
        }),
    },
    {
        // A bare `429` never matches: `/anime/429` is a real MyAnimeList id,
        // and "processed 429 items" is a count. It must be an HTTP status or
        // carry its reason phrase — the same anchoring `RATE_LIMIT_ERROR_PATTERN`
        // documents.
        pattern:
            /too many requests|(?:\bhttps?\b|\bstatus(?:\s+code)?\b|\bcode\b)\s*[:=]?\s*\b429\b|retry[\s-]?after/i,
        explain: () => ({
            summary: m.admin_run_error_rate_limited(),
            hint: m.admin_run_error_rate_limited_hint(),
            severity: 'expected',
        }),
    },
    {
        // Same anchoring rule as 429, for the same reason. The tasks' own
        // "TMDB API key missing or invalid — check the key in settings"
        // deliberately does NOT match: it is already operator copy.
        pattern:
            /\b401\s+unauthorized\b|unauthorized\s*\(\s*401\s*\)|(?:\bhttps?\b|\bstatus(?:\s+code)?\b|\bcode\b)\s*[:=]?\s*\b401\b|"status_code"\s*:\s*7\b|\binvalid[_ ]api[_ ]key\b/i,
        explain: () => ({
            summary: m.admin_run_error_provider_auth(),
            hint: m.admin_run_error_provider_auth_hint(),
            severity: 'operator',
        }),
    },
    {
        // ffmpeg/ffprobe stderr and non-zero exits. The exit-code arm is
        // anchored on the tool name so an unrelated "exited with code 1" from
        // some other subprocess is not blamed on a damaged media file.
        pattern:
            /invalid nal unit|invalid data found when processing input|moov atom not found|error while decoding|could not find codec parameters|\b(?:ffmpeg|ffprobe)\b[^\n]{0,60}exited(?: with code)? [1-9]/i,
        explain: () => ({
            summary: m.admin_run_error_media_decode(),
            hint: m.admin_run_error_media_decode_hint(),
            severity: 'operator',
        }),
    },
    {
        // "The job worked; this item couldn't be matched" is not "the job
        // failed" — but that distinction is an aggregation decision upstream
        // (a "Needs identifying" list), not one this module can make: if the
        // text reached a run error, the run did fail. All this can do is stop
        // the operator reading it as a fault.
        pattern:
            /no results for\b|no match(?:es)? found\b|could(?:n't|not| not) identify\b|no matching (?:title|release|candidate)\b/i,
        explain: () => ({
            summary: m.admin_run_error_no_match(),
            hint: m.admin_run_error_no_match_hint(),
            severity: 'operator',
        }),
    },
    {
        // `isolation worker exited (code 137) before completing` — 137 is
        // 128+SIGKILL, i.e. the kernel OOM killer. Must precede the generic
        // plugin-crash rule below, which matches the same sentence.
        pattern:
            /\bout of memory\b|\boom[- ]kill(?:ed|er)?\b|ERR_WORKER_OUT_OF_MEMORY|(?:exited|killed|terminated)[^\n]{0,40}\bSIGKILL\b|(?:code|status|signal)\s*[:=]?\s*\(?\s*137\b/i,
        explain: () => ({
            summary: m.admin_run_error_worker_oom(),
            hint: m.admin_run_error_worker_oom_hint(),
            severity: 'operator',
        }),
    },
    {
        pattern:
            /isolation worker exited|plugin[^\n]{0,40}crashed|plugin worker (?:exited|terminated|died)|\bPluginError\b/i,
        explain: () => ({
            summary: m.admin_run_error_plugin_crash(),
            hint: m.admin_run_error_plugin_crash_hint(),
            severity: 'internal',
        }),
    },
    {
        // Postgres SQLSTATE class 23 (integrity constraint violation). The
        // numeric arm needs a code-shaped context so "processed 23503 rows"
        // is not read as a constraint violation.
        pattern:
            /violates (?:foreign key|unique|not-null|check|exclusion) constraint|duplicate key value violates|(?:sqlstate|errcode|error code|code)\s*[:=]?\s*'?\b23\d{3}\b/i,
        explain: () => ({
            summary: m.admin_run_error_db_constraint(),
            hint: m.admin_run_error_db_constraint_hint(),
            severity: 'internal',
        }),
    },
    {
        // Uncaught JS errors leaking straight into the outcome message.
        pattern:
            /cannot read propert|is not a function|is not defined|undefined is not an object|^TypeError:|^ReferenceError:/i,
        explain: () => ({
            summary: m.admin_run_error_internal(),
            hint: m.admin_run_error_internal_hint(),
            severity: 'internal',
        }),
    },
];

/**
 * Self-healing failures — a known, temporary upstream condition (rate limit,
 * quota) that resolves on its own without operator action. These messages
 * are already human-authored by the task (e.g. "rate limit reached
 * (mdblist.com free-tier quota) — resumes automatically once the quota
 * window resets"), so they must NOT be routed through `explainRunError`'s
 * summary rewrite — only classified, via `classifyRunErrorSeverity`. The
 * pattern itself lives in `$lib/shared/run-error-severity.ts` so the
 * server-side attention adapters can classify the same messages without
 * importing this client-scoped module.
 */

/**
 * Returns a plain-language explanation for a known failure message, or null
 * when the message is already human-authored (task-written messages like
 * "upstream outage — 0 enriched with 3 error(s)", or any message carrying the
 * tasks' own "resumes automatically" self-healing prose, pass through).
 */
export function explainRunError(message: string | null | undefined): RunErrorExplanation | null {
    if (!message) return null;
    if (HUMAN_AUTHORED_SELF_HEALING.test(message) && !RESUME_MESSAGE.test(message)) return null;
    for (const { pattern, explain } of PATTERNS) {
        const match = pattern.exec(message);
        if (match) return explain(match);
    }
    return null;
}

/**
 * Classifies a run error message's severity, independent of whether the
 * message gets a plain-language rewrite from `explainRunError` — the two are
 * separate concerns so a human-authored self-healing message (already fine
 * to display verbatim) can still be recognized as `expected` without having
 * its text replaced. Returns `null` when nothing is recognized (the message
 * is an ordinary, unclassified failure — render it as a real failure).
 *
 * A curated pattern wins over {@link EXPECTED_RUN_ERROR_PATTERN}, which is
 * broad by design: that pattern treats any "quota" as self-healing, which is
 * right for a provider quota and badly wrong for `EDQUOT`. A full disk must
 * not wear the amber "self-healing" badge — severity has to be earned.
 */
export function classifyRunErrorSeverity(
    message: string | null | undefined,
): RunErrorSeverity | null {
    if (!message) return null;
    const explained = explainRunError(message);
    if (explained) return explained.severity;
    return EXPECTED_RUN_ERROR_PATTERN.test(message) ? 'expected' : null;
}
