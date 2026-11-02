// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Extracts a short, user-safe failure line from the tail of an FFmpeg stderr
 * buffer. The parser is intentionally conservative — the goal is not to classify
 * every error but to pick the single most informative line to surface in the
 * player's startup overlay. The full stderr tail still reaches the server log.
 */

const FILTER_PREFIX_RE = /^\[[\w. \-+]+ @ 0x[0-9a-f]+\]\s*/i;
const MAX_SUMMARY_CHARS = 200;

/**
 * Patterns that name a concrete root cause (codec missing, constant undefined,
 * initialisation failure, bad argument). When any is found we return the FIRST
 * match in the tail — cascading messages after it are usually just symptoms.
 */
const HIGH_PRIORITY_PATTERNS: readonly RegExp[] = [
    /Undefined constant/i,
    /Unknown (?:encoder|decoder|format|filter|codec|muxer|demuxer)\b/i,
    /Failed to [a-z]/i,
    /Invalid (?:data|argument|option|value|format)/i,
    /Cannot (?:open|find|allocate|load)/i,
    /No such file or directory/i,
    /Permission denied/i,
];

/**
 * Weaker signals ("Error ...", "... failed."). When no high-priority pattern
 * hits, we fall back to the LAST of these — it's usually closer to the terminal
 * failure than the noise earlier in the tail.
 */
const LOW_PRIORITY_PATTERNS: readonly RegExp[] = [/^Error /, / failed[!.]?$/i];

function stripFilterPrefix(line: string): string {
    return line.replace(FILTER_PREFIX_RE, '').trim();
}

function truncate(line: string): string {
    if (line.length <= MAX_SUMMARY_CHARS) return line;
    return `${line.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`;
}

function matchesAny(patterns: readonly RegExp[], line: string): boolean {
    return patterns.some((p) => p.test(line));
}

/**
 * Produce a one-line human summary for the player overlay.
 *
 * @param stderr - raw FFmpeg stderr tail (may be empty)
 * @param exitCode - FFmpeg process exit code, if known
 * @param fallbackMessage - override for the default "FFmpeg exited…" string
 *   (used by the spawn-error path where there's no stderr and no exit code)
 */
export function summarizeFfmpegStderr(
    stderr: string,
    exitCode: number | null,
    fallbackMessage?: string,
): string {
    const lines = stderr
        .split(/\r?\n/)
        .map(stripFilterPrefix)
        .filter((l) => l.length > 0);

    let bestHigh: { line: string; rank: number } | null = null;
    let lastLow: string | null = null;

    // Rank by pattern index (lower = more specific). Ties go to the earliest
    // matching line so that a single-match stderr behaves the same as before.
    for (const line of lines) {
        const highRank = HIGH_PRIORITY_PATTERNS.findIndex((p) => p.test(line));
        if (highRank >= 0) {
            if (bestHigh === null || highRank < bestHigh.rank) {
                bestHigh = { line, rank: highRank };
            }
        } else if (matchesAny(LOW_PRIORITY_PATTERNS, line)) {
            lastLow = line;
        }
    }

    const picked = bestHigh?.line ?? lastLow;
    if (picked) return truncate(picked);

    if (fallbackMessage && fallbackMessage.length > 0) {
        return truncate(fallbackMessage);
    }
    const code = exitCode === null ? 'unknown' : String(exitCode);
    return `FFmpeg exited with code ${code}`;
}
