// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { AUDIO_FILTER_LANGUAGES, SUBTITLE_FILTER_LANGUAGES } from '$lib/shared/track-language';
import { RESOLUTION_TIERS, HDR_TIERS, CODEC_TIERS } from '$lib/shared/quality-filter';

const DEFAULTS = {
    mode: 'discover',
    type: 'all',
    libraryGroupId: '',
    letter: '',
    q: '',
    genre: '',
    tag: '',
    layout: 'grid',
    audio: '',
    subs: '',
    includeUnknown: 'false',
    sort: 'title_asc',
    res: '',
    hdr: '',
    codec: '',
    qUnknown: 'false',
} as const;

type SelectionKey = keyof typeof DEFAULTS;

const CHOICES: Partial<Record<SelectionKey, readonly string[]>> = {
    mode: ['discover', 'az'],
    type: ['all', 'movies', 'series'],
    layout: ['grid', 'list'],
    sort: ['title_asc', 'title_desc', 'added_desc', 'year_desc', 'year_asc', 'rating_desc'],
    includeUnknown: ['true', 'false'],
    qUnknown: ['true', 'false'],
};
const CSV_CHOICES: Partial<Record<SelectionKey, readonly string[]>> = {
    audio: AUDIO_FILTER_LANGUAGES,
    subs: SUBTITLE_FILTER_LANGUAGES,
    res: RESOLUTION_TIERS,
    hdr: HDR_TIERS,
    codec: CODEC_TIERS,
};

/** Only selection dimensions survive; pagination, results and arbitrary URL params never do. */
function normalize(params: URLSearchParams): Record<SelectionKey, string> | null {
    const selection = {} as Record<SelectionKey, string>;
    for (const key of Object.keys(DEFAULTS) as SelectionKey[]) {
        let value = params.get(key) ?? DEFAULTS[key];
        const choices = CHOICES[key];
        if (choices && !choices.includes(value)) return null;
        const csvChoices = CSV_CHOICES[key];
        if (csvChoices) {
            const tokens = value.split(',').filter(Boolean);
            if (tokens.some((token) => !csvChoices.includes(token))) return null;
            value = [...new Set(tokens)].join(',');
        } else if (key === 'letter') {
            value = value.toUpperCase();
            if (value && !/^[A-Z#]$/.test(value)) return null;
        } else if (!choices) {
            value = value.trim();
            if (key === 'q') value = value.slice(0, 100);
            if ((key === 'genre' || key === 'tag') && value.length > 100) return null;
            // azQuerySchema accepts GUIDs (including legacy non-RFC versions).
            if (
                key === 'libraryGroupId' &&
                value &&
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
            )
                return null;
        }
        selection[key] = value;
    }
    // The jump rail is only meaningful for title sorts.
    if (selection.sort !== 'title_asc' && selection.sort !== 'title_desc') selection.letter = '';
    return selection;
}

function storageKey(userId: string | undefined): string | null {
    return userId?.trim() ? `browse-selection:v1:${encodeURIComponent(userId)}` : null;
}

/** Storage is optional (private browsing, quota limits, or no authenticated identity). */
export function saveBrowseSelection(userId: string | undefined, params: URLSearchParams): void {
    const key = storageKey(userId);
    if (!key) return;
    const selection = normalize(params);
    if (!selection) return;
    try {
        localStorage.setItem(key, JSON.stringify({ version: 1, selection }));
    } catch {
        // Browse controls and their URL must remain usable when storage is unavailable.
    }
}

/** A complete selection includes explicit defaults so old per-axis preferences cannot leak in. */
export function loadBrowseSelection(userId: string | undefined): URLSearchParams | null {
    const key = storageKey(userId);
    if (!key) return null;
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const saved: unknown = JSON.parse(raw);
        if (
            typeof saved !== 'object' ||
            saved === null ||
            !('version' in saved) ||
            saved.version !== 1
        )
            return null;
        if (
            !('selection' in saved) ||
            typeof saved.selection !== 'object' ||
            saved.selection === null
        )
            return null;
        const params = new URLSearchParams();
        for (const key of Object.keys(DEFAULTS) as SelectionKey[]) {
            const value: unknown = Reflect.get(saved.selection, key);
            if (typeof value !== 'string') return null;
            params.set(key, value);
        }
        const selection = normalize(params);
        return selection ? new URLSearchParams(selection) : null;
    } catch {
        return null;
    }
}
