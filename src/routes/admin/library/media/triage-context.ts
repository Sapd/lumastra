// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The detail page's triage bar (triage spec §7): "← <View> · Item n of m ·
 * ‹ Previous · Next ›". The browser saves the page the operator is looking at
 * (its ordered ids and the query that produced them) to sessionStorage; the
 * detail page reads it back and walks it. At a page boundary Previous/Next go
 * through the list with `?triage=first|last`, which the browser answers by
 * opening that page's first or last item.
 *
 * Pure functions over a `Storage`, like `media-browser-storage.ts`, so the
 * rules are unit-tested without a DOM.
 */

export const TRIAGE_STORAGE_KEY = 'admin-media-triage';
const VERSION = 1;

export interface TriageContext {
    /** The list URL's search string, without `page`, `jump` or `triage`. */
    search: string;
    /** Human label of the view the list was on ("Missing artwork"). */
    viewLabel: string;
    ids: string[];
    page: number;
    pageSize: number;
    total: number;
}

export type TriageEdge = 'first' | 'last';

export function listSearchWithout(search: string): string {
    const params = new URLSearchParams(search);
    for (const key of ['page', 'jump', 'triage']) params.delete(key);
    const s = params.toString();
    return s ? `?${s}` : '';
}

export function saveTriageContext(storage: Storage | null, ctx: TriageContext): void {
    if (!storage) return;
    try {
        storage.setItem(TRIAGE_STORAGE_KEY, JSON.stringify({ v: VERSION, ...ctx }));
    } catch {
        // No triage bar on the detail page; nothing else depends on it.
    }
}

export function loadTriageContext(storage: Storage | null): TriageContext | null {
    if (!storage) return null;
    try {
        const raw = storage.getItem(TRIAGE_STORAGE_KEY);
        if (!raw) return null;
        const p = JSON.parse(raw) as Partial<TriageContext> & { v?: number };
        if (p.v !== VERSION || !Array.isArray(p.ids) || typeof p.search !== 'string') return null;
        if (![p.page, p.pageSize, p.total].every((n) => typeof n === 'number')) return null;
        return {
            search: p.search,
            viewLabel: typeof p.viewLabel === 'string' ? p.viewLabel : '',
            ids: p.ids.filter((id): id is string => typeof id === 'string'),
            page: p.page!,
            pageSize: p.pageSize!,
            total: p.total!,
        };
    } catch {
        return null;
    }
}

export interface TriagePosition {
    /** 1-based position across the whole view. */
    index: number;
    total: number;
    viewLabel: string;
    listHref: string;
    prevHref: string | null;
    nextHref: string | null;
}

/**
 * Where `itemId` sits in the saved context, or null when it is not on the
 * saved page (a pasted link, or the list moved on) — then there is no bar.
 */
export function triagePosition(ctx: TriageContext | null, itemId: string): TriagePosition | null {
    if (!ctx) return null;
    const pos = ctx.ids.indexOf(itemId);
    if (pos === -1) return null;
    const base = '/admin/library/media';
    const pageUrl = (page: number, edge: TriageEdge): string => {
        const params = new URLSearchParams(ctx.search);
        if (page > 1) params.set('page', String(page));
        params.set('triage', edge);
        return `${base}?${params.toString()}`;
    };
    const totalPages = Math.max(1, Math.ceil(ctx.total / ctx.pageSize));
    const prev = ctx.ids[pos - 1];
    const next = ctx.ids[pos + 1];
    return {
        index: (ctx.page - 1) * ctx.pageSize + pos + 1,
        total: ctx.total,
        viewLabel: ctx.viewLabel,
        listHref: `${base}${ctx.search}${ctx.page > 1 ? `${ctx.search ? '&' : '?'}page=${ctx.page}` : ''}${ctx.search || ctx.page > 1 ? '&' : '?'}restore=1`,
        prevHref: prev ? `${base}/${prev}` : ctx.page > 1 ? pageUrl(ctx.page - 1, 'last') : null,
        nextHref: next
            ? `${base}/${next}`
            : ctx.page < totalPages
              ? pageUrl(ctx.page + 1, 'first')
              : null,
    };
}

export function parseTriageEdge(raw: string | null): TriageEdge | null {
    return raw === 'first' || raw === 'last' ? raw : null;
}
