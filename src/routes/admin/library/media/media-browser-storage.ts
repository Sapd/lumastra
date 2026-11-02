// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin media-browser localStorage helpers.
 *
 * Lives in a sibling module rather than in `+page.svelte` for the same reason
 * `media-filters.ts` does: these are pure mappers, and inline in a component
 * they cannot be unit-tested. `Storage` is a parameter rather than a global so
 * a test can pass an in-memory stand-in and the caller can pass
 * `browser ? localStorage : null`.
 */

export const FILTERS_STORAGE_KEY = 'admin-media-filters';
export const COLUMNS_STORAGE_KEY = 'admin-media-columns';

/**
 * Storage-format version.
 *
 * A stored blob whose version does not match is DISCARDED, not migrated — it
 * holds transient view state, and a migration would have to guess intent.
 *
 * ⚠️ Bump this whenever a default changes: a new default-visible column, or a
 * changed per-domain default type/sort. Without a bump the stored preference
 * wins forever on every bare navigation and the new default is invisible to
 * every existing operator.
 *
 * v2 (2026-08-26): versioning introduced; music defaults to artists; `filter`,
 * `added_since` and `updated_since` stopped being persisted. This bump is also
 * what retires `COLUMNS_ADDED_AFTER_V1` — with every pre-v2 column blob
 * discarded, a newly default-visible column simply arrives via the defaults.
 *
 * v3 (2026-08-26): the `ancestryParent` / `ancestryRoot` columns became
 * default-visible.
 *
 * v4 (2026-08-26): the `season` view's default sort changed from `title` to
 * `hierarchy`. A stored `sort` only ever arrives from an explicit header click,
 * which is why this bump is easy to talk yourself out of — but an operator who
 * clicked the Season "Title" header while `title` was still that view's default
 * has `sort=title` persisted for `type=season`, and the restore reapplies it on
 * every bare navigation. That masks the new default permanently, for exactly
 * the operators who use the header most.
 *
 * v5 (2026-10-06): a domain tab no longer writes its default `type` into the
 * URL, so a search there can widen past it (Music searches every music type,
 * not just Artists). A stored `type=artist` from a pre-v5 tab click would keep
 * re-narrowing every search to artists.
 */
export const STORAGE_VERSION = 6;

/**
 * URL params SAVED on every URL change and restored on a bare navigation.
 *
 * Deep-link params (`filter`, `added_since`, `updated_since`) are deliberately
 * ABSENT. They arrive from an attention item's "view affected files" link or a
 * scan-run link; persisting them turns a one-off investigation into a sticky
 * preference, and a frozen `added_since` timestamp silently restores a stale
 * scan window on the operator's next bare visit to Media.
 */
export const PERSISTED_FILTER_PARAMS = [
    // The saved view (triage spec §2): the browser reopens on the view the
    // operator last worked in. No STORAGE_VERSION bump: an old blob simply
    // has no `view` and restores to All, as before.
    'view',
    'domain',
    'type',
    'library',
    'unavailable',
    'dismissed',
    'sort',
    'order',
    'missing_tmdb',
    'missing_jf',
    'missing_poster',
    'missing_overview',
    'has_embedding',
    'locked',
    'local_only',
    'custom_poster',
] as const;

/**
 * Params whose presence in the URL means "the operator asked for this view",
 * so the saved-filter restore must NOT fire.
 *
 * Deliberately a SUPERSET of `PERSISTED_FILTER_PARAMS`, not the same list.
 * Conflating the two is a real bug: a bookmarked bare `?filter=file-issues`
 * would count as "no filters present", and the restore would merge the saved
 * `domain`/`type` on top — re-narrowing the exact link that exists to show file
 * issues across every media type.
 */
export const RESTORE_SUPPRESSING_PARAMS = [
    ...PERSISTED_FILTER_PARAMS,
    // The detail page's triage hop (`?triage=first|last`): restoring over it
    // would race the redirect to that page's first/last item.
    'q',
    'scope',
    'layout',
    'restore',
    'page_size',
    'triage',
    'filter',
    'added_since',
    'updated_since',
] as const;

/**
 * Whether the one-shot saved-filter restore may fire for this URL.
 *
 * The decision itself, not a readability wrapper: `+page.svelte` computed it
 * inline, so the only thing under test was the SUPERSET PROPERTY of the two
 * constants — never the choice of which constant the effect actually reads. A
 * refactor swapping `RESTORE_SUPPRESSING_PARAMS` back to
 * `PERSISTED_FILTER_PARAMS` at the call site passed every test and regressed
 * only in production, which is how the deep-link bug below escaped once
 * already. Exported so that choice is the thing being asserted.
 *
 * False means the operator asked for THIS view, so the saved filters must not
 * be merged over it. The case that matters is a bare `?filter=file-issues`:
 * `filter` is a deep-link param and deliberately NOT persisted, so a check
 * against the persisted list alone reads that URL as "no filters present" and
 * merges a saved `domain`/`type` on top — re-narrowing the exact link that
 * exists to show file issues across every media type.
 *
 * Two further rules the raw `.some(() => !!get(key))` at the call site did not
 * carry, both of which would let a suppressing param slip through:
 *   - a param present but EMPTY (`?domain=`) selects nothing, so it must not
 *     suppress — it is noise from a cleared control, not an operator's choice;
 *   - a repeated param (`?type=&type=track`) suppresses on ANY non-empty value,
 *     where `get()` returns only the first and would have missed `track`.
 */
export function shouldRestoreSavedFilters(params: URLSearchParams): boolean {
    for (const key of RESTORE_SUPPRESSING_PARAMS) {
        if (params.getAll(key).some((value) => value.trim() !== '')) return false;
    }
    return true;
}

interface FiltersBlob {
    v: number;
    filters: Record<string, string>;
}

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export function loadSavedFilters(storage: Storage | null): Record<string, string> {
    if (!storage) return {};
    try {
        const stored = storage.getItem(FILTERS_STORAGE_KEY);
        if (!stored) return {};
        const parsed: unknown = JSON.parse(stored);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const blob = parsed as Partial<FiltersBlob>;
        if (blob.v !== STORAGE_VERSION) return {};
        const filters = blob.filters;
        if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return {};
        const result: Record<string, string> = {};
        for (const key of PERSISTED_FILTER_PARAMS) {
            const value = (filters as Record<string, unknown>)[key];
            if (typeof value !== 'string' || !value) continue;
            // A bad library id would be restored into the URL on every visit.
            if (key === 'library' && !UUID_RE.test(value)) continue;
            result[key] = value;
        }
        return result;
    } catch {
        // Storage unavailable (private browsing, disabled, partitioned iframe).
        return {};
    }
}

export function saveFilters(storage: Storage | null, params: URLSearchParams): void {
    if (!storage) return;
    const filters: Record<string, string> = {};
    for (const key of PERSISTED_FILTER_PARAMS) {
        const value = params.get(key);
        if (value) filters[key] = value;
    }
    try {
        storage.setItem(FILTERS_STORAGE_KEY, JSON.stringify({ v: STORAGE_VERSION, filters }));
    } catch {
        // Filters just won't persist for next visit.
    }
}

interface ColumnsBlob {
    v: number;
    keys: string[];
}

export function loadColumnVisibility(
    storage: Storage | null,
    defaults: string[],
    allKeys: string[],
    alwaysKeys: string[],
): string[] {
    if (!storage) return defaults;
    try {
        const stored = storage.getItem(COLUMNS_STORAGE_KEY);
        if (!stored) return defaults;
        const parsed: unknown = JSON.parse(stored);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
        const blob = parsed as Partial<ColumnsBlob>;
        if (blob.v !== STORAGE_VERSION || !Array.isArray(blob.keys)) return defaults;
        const filtered = blob.keys.filter((k) => allKeys.includes(k));
        return [...new Set([...filtered, ...alwaysKeys])];
    } catch {
        // getItem itself throws in a partitioned iframe, so it lives inside the try.
        return defaults;
    }
}

export function saveColumnVisibility(storage: Storage | null, keys: string[]): void {
    if (!storage) return;
    try {
        storage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify({ v: STORAGE_VERSION, keys }));
    } catch {
        // Column choice just won't persist.
    }
}

export interface BrowserReturnState<Row> {
    url: string;
    selected: Array<[string, Row]>;
    scroll: number;
    focusId: string | null;
    focusHref: string | null;
    layout: string;
    pageSize: number;
}
const RETURN_STORAGE_KEY = 'admin-media-return';

export function saveBrowserReturn<Row>(
    storage: Storage | null,
    state: BrowserReturnState<Row>,
): void {
    try {
        storage?.setItem(RETURN_STORAGE_KEY, JSON.stringify(state));
    } catch {
        /* storage unavailable */
    }
}
export function loadBrowserReturn<Row>(
    storage: Storage | null,
    url: string,
): BrowserReturnState<Row> | null {
    try {
        const value = storage?.getItem(RETURN_STORAGE_KEY);
        if (!value) return null;
        const parsed = JSON.parse(value) as BrowserReturnState<Row>;
        if (
            parsed.url !== url ||
            !Array.isArray(parsed.selected) ||
            typeof parsed.scroll !== 'number'
        )
            return null;
        return parsed;
    } catch {
        return null;
    }
}
