// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The signpost pages: the four symptoms this surface explains rather than
 * diagnoses.
 *
 * A signpost has ONE job — say where the thing lives and get the operator there
 * in one click — and one prohibition: it must never imply it checked anything.
 * `SignpostPage.svelte` renders the same disclaimer above every one of these,
 * and the index labels them, so the promise a `diagnostic` entry makes stays
 * worth something.
 *
 * Copy is deliberately structured as "which of these two situations are you
 * in?" rather than as a checklist. A checklist is what the operator already
 * failed to complete; naming the two branches is what actually moves them.
 *
 * `path` and `query` are stored SEPARATELY because `resolve()` (the base-path
 * aware router helper this project mandates) takes a bare route path — the
 * query string has to be concatenated outside the call.
 */

import * as m from '$lib/paraglide/messages.js';
import { ADMIN_MEDIA_FILE_ISSUES_PATH } from '$lib/shared/admin-media-links.js';

export interface SignpostLink {
    label: () => string;
    /** Route path only — no query string. */
    path: string;
    /** Appended verbatim after `resolve(path)`, including the leading `?`. */
    query?: string;
}

export interface Signpost {
    id: string;
    lede: () => string;
    body: () => string;
    links: readonly SignpostLink[];
}

/**
 * `ADMIN_MEDIA_FILE_ISSUES_PATH` carries its own query string and the module it
 * comes from documents a production bug caused by hand-spelling it. Split it
 * once, here, so `resolve()` still gets a bare path and the constant stays the
 * single source of that URL.
 */
const FILE_ISSUES_SPLIT = ADMIN_MEDIA_FILE_ISSUES_PATH.indexOf('?');
const FILE_ISSUES_LINK: SignpostLink = {
    label: m.admin_fix_link_file_issues,
    path: ADMIN_MEDIA_FILE_ISSUES_PATH.slice(0, FILE_ISSUES_SPLIT),
    query: ADMIN_MEDIA_FILE_ISSUES_PATH.slice(FILE_ISSUES_SPLIT),
};

export const SIGNPOSTS: readonly Signpost[] = [
    {
        id: 'poster',
        lede: m.admin_fix_sp_poster_lede,
        body: m.admin_fix_sp_poster_body,
        links: [
            { label: m.admin_fix_link_fix_matches, path: '/admin/library/fix-matches' },
            { label: m.admin_fix_link_task_artwork, path: '/admin/tasks/provider-artwork-poster' },
            { label: m.admin_fix_link_media_browser, path: '/admin/library/media' },
        ],
    },
    {
        id: 'subtitles',
        lede: m.admin_fix_sp_subtitles_lede,
        body: m.admin_fix_sp_subtitles_body,
        links: [
            { label: m.admin_fix_link_new_files_diag, path: '/admin/fix/new-files' },
            { label: m.admin_fix_link_media_settings, path: '/admin/settings/media' },
            FILE_ISSUES_LINK,
        ],
    },
    {
        id: 'music-art',
        lede: m.admin_fix_sp_music_art_lede,
        body: m.admin_fix_sp_music_art_body,
        links: [
            { label: m.admin_fix_link_task_artist, path: '/admin/tasks/artist-enrichment' },
            { label: m.admin_fix_link_music_settings, path: '/admin/settings/music' },
            { label: m.admin_fix_link_new_files_diag, path: '/admin/fix/new-files' },
        ],
    },
    {
        id: 'stale-clients',
        lede: m.admin_fix_sp_stale_clients_lede,
        body: m.admin_fix_sp_stale_clients_body,
        links: [
            { label: m.admin_fix_link_media_browser, path: '/admin/library/media' },
            { label: m.admin_fix_link_sessions, path: '/admin/users/sessions' },
        ],
    },
];

export function findSignpost(id: string): Signpost | undefined {
    return SIGNPOSTS.find((s) => s.id === id);
}
