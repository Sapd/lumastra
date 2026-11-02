// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Labels, colours and fix actions for the media browser's issue badges and
 * saved views. The vocabulary itself (kinds, severities, per-type rules) lives
 * in `$lib/shared/media-issues`; this module only presents it.
 *
 * Exhaustive switches over message calls, not record literals, for the reason
 * `media-action-presentation.ts` gives: a record keyed by a union is not
 * checked in `.svelte` consumers, and a missing paraglide key is a runtime
 * crash, not a type error.
 */

import { toInternalMediaType } from '$lib/shared/media-type-domain.js';
import * as m from '$lib/paraglide/messages.js';
import { fileHealthIssueLabel } from '$lib/utils/file-health-issue';
import { mediaActionLabel } from './media-action-presentation.js';
import type { MediaBrowserView, MediaIssue, MediaIssueSeverity } from '$lib/shared/media-issues.js';

export function mediaIssueLabel(issue: MediaIssue, mediaType: string): string {
    switch (issue.kind) {
        case 'files_lost':
            return m.media_issue_files_lost();
        case 'file_problem':
            if (issue.subtype === 'episodes')
                return m.media_issue_episode_problems({ count: issue.count ?? 0 });
            return issue.subtype && issue.subtype !== 'integrity'
                ? fileHealthIssueLabel(issue.subtype)
                : m.media_issue_integrity();
        case 'no_tmdb':
            return m.media_issue_no_tmdb();
        case 'no_poster':
            if (mediaType === 'album') return m.media_issue_no_cover();
            if (mediaType === 'artist') return m.media_issue_no_image();
            return m.media_issue_no_poster();
        case 'no_overview':
            return mediaType === 'audiobook'
                ? m.media_issue_no_description()
                : m.media_issue_no_overview();
        case 'duplicate':
            return m.media_issue_duplicate();
        case 'not_in_jellyfin':
            return m.media_issue_not_in_jellyfin();
    }
}

export function mediaViewLabel(view: MediaBrowserView): string {
    switch (view) {
        case 'all':
            return m.media_view_all();
        case 'attention':
            return m.media_view_attention();
        case 'unidentified':
            return m.media_view_unidentified();
        case 'artwork':
            return m.media_view_artwork();
        case 'overview':
            return m.media_view_overview();
        case 'files':
            return m.media_view_files();
        case 'duplicates':
            return m.media_view_duplicates();
        case 'jellyfin':
            return m.media_view_jellyfin();
        case 'recent':
            return m.media_view_recent();
        case 'lost':
            return m.media_view_lost();
    }
}

export function mediaViewHint(view: MediaBrowserView): string {
    switch (view) {
        case 'all':
            return m.media_view_hint_all();
        case 'attention':
            return m.media_view_hint_attention();
        case 'unidentified':
            return m.media_view_hint_unidentified();
        case 'artwork':
            return m.media_view_hint_artwork();
        case 'overview':
            return m.media_view_hint_overview();
        case 'files':
            return m.media_view_hint_files();
        case 'duplicates':
            return m.media_view_hint_duplicates();
        case 'jellyfin':
            return m.media_view_hint_jellyfin();
        case 'recent':
            return m.media_view_hint_recent();
        case 'lost':
            return m.media_view_hint_lost();
    }
}

/**
 * Badge classes per severity. The three differ in lightness as well as hue,
 * and every badge carries a text label, so colour is never the only signal.
 */
export function severityBadgeClass(severity: MediaIssueSeverity): string {
    switch (severity) {
        case 'error':
            return 'border-red-700/70 bg-red-950/70 text-red-100';
        case 'warn':
            return 'border-amber-700/70 bg-amber-950/60 text-amber-100';
        case 'info':
            return 'border-indigo-700/60 bg-indigo-950/50 text-indigo-200';
    }
}

export function severityDotClass(severity: MediaIssueSeverity): string {
    switch (severity) {
        case 'error':
            return 'bg-red-400';
        case 'warn':
            return 'bg-amber-400';
        case 'info':
            return 'bg-indigo-400';
    }
}

/**
 * The fix an issue card offers. Every target is an existing action: the
 * browser's identify dialog, the sync endpoints, the detail page's Files tab
 * (there is no persisting re-probe endpoint — see the `reprobe` note in
 * media-actions.ts), and the duplicates panel's merge flow.
 */
export type MediaIssueFix = 'identify' | 'syncImages' | 'syncMetadata' | 'showFiles' | 'merge';

export function mediaIssueFix(issue: MediaIssue): MediaIssueFix {
    switch (issue.kind) {
        case 'no_tmdb':
            return 'identify';
        case 'no_poster':
            return 'syncImages';
        case 'no_overview':
        case 'not_in_jellyfin':
            return 'syncMetadata';
        case 'file_problem':
        case 'files_lost':
            return 'showFiles';
        case 'duplicate':
            return 'merge';
    }
}

export function mediaIssueFixLabel(fix: MediaIssueFix): string {
    switch (fix) {
        case 'identify':
        case 'syncImages':
        case 'syncMetadata':
            return mediaActionLabel(fix);
        case 'showFiles':
            return m.media_fix_show_files();
        case 'merge':
            return m.media_fix_merge();
    }
}

/** A visible media name, never an internal code. */
export function mediaTypeName(value: string): string {
    switch (toInternalMediaType(value)) {
        case 'movie':
            return m.media_plain_type_movie();
        case 'tv':
            return m.media_plain_type_tv();
        case 'episode':
            return m.media_plain_type_episode();
        case 'season':
            return m.media_plain_type_season();
        case 'artist':
            return m.media_plain_type_artist();
        case 'album':
            return m.media_plain_type_album();
        case 'track':
            return m.media_plain_type_track();
        case 'audiobook':
            return m.media_plain_type_audiobook();
        case 'audio':
            return m.media_plain_type_audio();
        case 'music':
            return m.media_plain_type_music();
        case 'home_video':
            return m.media_plain_type_home_video();
        case 'training':
            return m.media_plain_type_training();
        case 'educational':
            return m.media_plain_type_educational();
        case 'personal':
            return m.media_plain_type_personal();
        case 'extra':
            return m.media_plain_type_extra();
        case 'book':
            return m.media_plain_type_book();
        case 'manga':
            return m.media_plain_type_manga();
        case 'comic':
            return m.media_plain_type_comic();
        case 'podcast':
            return m.media_plain_type_podcast();
        case 'radio':
            return m.media_plain_type_radio();
        case 'tvchannel':
            return m.media_plain_type_tvchannel();
        default:
            return m.media_plain_media_item();
    }
}
