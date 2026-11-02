// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Presentation for `media_files.health_issues` entries.
 *
 * Every surface that shows these (the media browser's per-row warning, the
 * media detail Overview and Files tabs) was mapping type → label with its own
 * if/else chain. Those chains ended in an `else` that named a SPECIFIC issue,
 * so the first new type added in 2026-08 rendered as "Duration Mismatch" on
 * the Files tab — confidently wrong, which is worse than an unknown label.
 *
 * One lookup, one severity rule, one fallback that admits it doesn't know.
 */

import * as m from '$lib/paraglide/messages.js';
import type { FileHealthRecheckResult } from '$lib/schemas/file-health-recheck.js';
import type { FileHealthIssueType } from '$lib/types/pipeline';

/** Shape shared by every consumer; extra fields on the row are ignored. */
export interface DisplayableHealthIssue {
    type: string;
    basis?: string;
    reviewed?: boolean;
    detected_at?: string;
    detail?: string;
    expected_duration?: number;
    actual_duration?: number;
}

const LABELS: Partial<Record<FileHealthIssueType, () => string>> = {
    truncated_video: m.admin_media_issue_duration_review,
    no_keyframes: m.admin_media_issue_no_keyframes,
    duration_mismatch: m.admin_media_issue_duration_review,
    tag_parse_timeout: m.admin_media_issue_tag_parse_timeout,
    tag_parse_corrupt: m.admin_media_issue_tag_parse_corrupt,
    filename_not_utf8: m.admin_media_issue_filename_not_utf8,
    container_unreadable: m.admin_media_issue_container_unreadable,
    video_ends_early: m.admin_media_issue_duration_review,
    video_decode_gaps: m.admin_media_issue_video_decode_gaps,
    unsafe_filename: m.admin_media_issue_unsafe_filename,
    playlist_container_rejected: m.admin_media_issue_playlist_container_rejected,
    episode_number_unparsed: m.admin_media_issue_episode_number_unparsed,
    series_identity_conflict: m.admin_media_issue_series_identity_conflict,
    series_folder_contention: m.admin_media_issue_series_folder_contention,
    movie_identity_conflict: m.admin_media_issue_movie_identity_conflict,
    range_superseded: m.admin_media_issue_range_superseded,
};

/**
 * Playback-breaking issues. Everything else is a soft/metadata problem the
 * viewer will never notice, so it must not be dressed up in red.
 */
const SEVERE = new Set<string>(['no_keyframes', 'container_unreadable']);

/** Human label, falling back to an unknown finding rather than to a wrong guess. */
export function fileHealthIssueLabel(type: string, basis?: string): string {
    if (basis === 'premature_eof') return m.admin_media_issue_truncated();
    if (type === 'unknown_recorded_evidence') return m.admin_health_file_unknown_evidence();
    if (type === 'additional_recorded_evidence') return m.admin_health_file_additional_evidence();
    return LABELS[type as FileHealthIssueType]?.() ?? m.media_plain_unknown_finding();
}

export function isSevereHealthIssue(type: string, basis?: string): boolean {
    return basis === 'premature_eof' || SEVERE.has(type);
}

/** Tailwind classes for a badge, matching the severity split above. */
export function fileHealthIssueBadgeClass(type: string, basis?: string): string {
    return isSevereHealthIssue(type, basis)
        ? 'bg-red-500/20 text-red-400'
        : 'bg-yellow-500/20 text-yellow-400';
}

export function fileHealthIssueTextClass(type: string, basis?: string): string {
    return isSevereHealthIssue(type, basis) ? 'text-red-400' : 'text-amber-400';
}

/**
 * The best available explanation of what is actually wrong.
 *
 * Prefers the recorded `detail` — for decode-time issues that is the verbatim
 * ffmpeg complaint including the byte offset, which is the whole reason the
 * field exists. Falls back to composing something from the durations for the
 * older probe-written types, which never carried a detail.
 */
export function fileHealthIssueReason(issue: DisplayableHealthIssue): string | undefined {
    if (issue.reviewed) return undefined;
    if (issue.detail && issue.detail.trim() !== '') return issue.detail;
    if (issue.type === 'truncated_video' || issue.type === 'video_ends_early') {
        const actual = issue.actual_duration;
        const expected = issue.expected_duration;
        if (
            typeof actual !== 'number' ||
            !Number.isFinite(actual) ||
            actual < 0 ||
            typeof expected !== 'number' ||
            !Number.isFinite(expected) ||
            expected <= 0
        )
            return undefined;
        return (
            issue.basis === 'premature_eof'
                ? m.media_files_issue_truncated_title
                : m.admin_media_issue_duration_comparison
        )({
            actual: Math.round(actual),
            expected: Math.round(expected),
        });
    }
    if (issue.type === 'no_keyframes') return m.media_files_issue_no_keyframes_title();
    if (issue.type === 'duration_mismatch') return m.media_files_issue_duration_mismatch_title();
    return undefined;
}

/** Additional next steps for evidence whose meaning is easy to overstate. */
export function fileHealthIssueGuidance(
    issue: Pick<DisplayableHealthIssue, 'type' | 'basis' | 'reviewed'>,
): string | undefined {
    if (issue.reviewed) return m.admin_health_keep_guidance();
    if (
        ['truncated_video', 'video_ends_early', 'duration_mismatch'].includes(issue.type) &&
        issue.basis !== 'premature_eof'
    )
        return m.admin_health_keep_check_ending();
    if (issue.type === 'container_unreadable') {
        return m.admin_media_issue_container_unreadable_guidance();
    }
    return undefined;
}

/** Truthful terminal guidance shared by Health and the media-probe Failures UI. */
export function fileHealthRecheckMessage(result: FileHealthRecheckResult): string {
    if (result.reason === 'disabled') return m.admin_health_recheck_disabled();
    if (result.outcome === 'healthy') return m.admin_health_recheck_healthy();
    if (result.outcome === 'cancelled') return m.admin_health_recheck_cancelled();
    if (result.outcome === 'busy') return m.admin_health_recheck_busy();
    if (result.outcome === 'error') return m.admin_health_recheck_error();
    if (result.outcome === 'inconclusive') return m.admin_health_recheck_inconclusive();
    return m.admin_health_recheck_warning({
        issues: result.issues.map((i) => fileHealthIssueLabel(i.type)).join(', '),
    });
}
