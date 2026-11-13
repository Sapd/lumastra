// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Search index over the admin routes: one entry per page and one per tab, plus
 * the matcher the command palette ranks them with.
 *
 * The entries come from the `search-meta.ts` files that sit next to each admin
 * `+page.svelte` (collected with `import.meta.glob`; the URL is the file's
 * directory). The nav manifest only contributes section, icon, order and
 * visibility: a page is hidden when the nav hides it (or its nearest nav
 * ancestor), or when its own `permission` fails for the admin's gate context.
 */

import type { IconSource } from 'svelte-hero-icons';
import {
    ADMIN_NAV,
    isGateOpen,
    type AdminNavSection,
    type NavGateContext,
} from '$lib/config/admin-nav';
import type { AdminSearchMeta } from '$lib/config/admin-search-meta';
import * as m from '$lib/paraglide/messages.js';
import { getLocale } from '$lib/paraglide/runtime.js';

// Protected-tier route groups are excluded: core code may not import them in any
// form (including this glob). Their nav pages are indexed from ADMIN_NAV below.
// The parentheses are escaped: unescaped they are a glob group, not literal.

const metaModules = import.meta.glob<{ searchMeta: AdminSearchMeta }>(
    ['/src/routes/admin/**/search-meta.ts', '!/src/routes/admin/\\(private\\)/**'],
    { eager: true },
);

/** Throws when a protected-tier file was collected: that breaks the license boundary. */
export function assertNoProtectedTierMetas(files: string[]): void {
    const offending = files.filter((file) => file.includes('(private)'));
    if (offending.length > 0) {
        throw new Error(
            `License boundary: core search index collected protected-tier files (${offending.join(', ')}). ` +
                'Core code may not import the (private) tier, not even via import.meta.glob.',
        );
    }
}
assertNoProtectedTierMetas(Object.keys(metaModules));

/** `/src/routes/admin/(private)/reporting/search-meta.ts` to `/admin/reporting`. */
export function routeOfMetaFile(file: string): string {
    const segments = file
        .replace(/^\/src\/routes/, '')
        .replace(/\/search-meta\.ts$/, '')
        .split('/')
        .filter((segment) => segment && !/^\(.*\)$/.test(segment));
    return '/' + segments.join('/');
}

export interface AdminRouteMeta {
    path: string;
    meta: AdminSearchMeta;
}

/** Every route's meta, nav pages first in nav order, then the rest by path. */
export const ADMIN_ROUTE_METAS: AdminRouteMeta[] = (() => {
    const navOrder = new Map(
        ADMIN_NAV.flatMap((section) => section.pages).map((page, i) => [page.path, i] as const),
    );
    return Object.entries(metaModules)
        .map(([file, mod]) => ({ path: routeOfMetaFile(file), meta: mod.searchMeta }))
        .sort((a, b) => {
            const ao = navOrder.get(a.path) ?? Infinity;
            const bo = navOrder.get(b.path) ?? Infinity;
            return ao === bo ? a.path.localeCompare(b.path) : ao - bo;
        });
})();

export interface AdminPageIndexEntry {
    kind: 'page' | 'tab';
    /** The page's route (without query). */
    path: string;
    /** Where activating the entry goes: `path`, or `path?<param>=<tab id>` for a tab. */
    href: string;
    title: string;
    description?: string;
    sectionId: string;
    sectionTitle: string;
    /** Title of the page a tab lives on. */
    parentTitle?: string;
    keywords: string[];
    icon?: IconSource;
    /** Pre-normalised search fields; use `searchAdminPages` rather than reading these. */
    norm: NormalizedFields;
}

export interface AdminPageMatch {
    entry: AdminPageIndexEntry;
    score: number;
}

interface NormalizedFields {
    title: string;
    titleWords: string[];
    parentWords: string[];
    sectionWords: string[];
    description: string;
    descriptionWords: string[];
    keywords: string[];
    keywordWords: string[];
    path: string;
}

/** Lowercase, strip diacritics (ä to a) and fold ß to ss. */
export function normalizeSearchText(text: string): string {
    return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss');
}

function wordsOf(normalized: string): string[] {
    return normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Edits a typo may cost: none below 4 characters, one up to 7, two from 8. */
function fuzzyLimit(length: number): number {
    if (length >= 8) return 2;
    if (length >= 4) return 1;
    return 0;
}

/**
 * Damerau-Levenshtein distance (optimal string alignment), abandoned early:
 * returns `max + 1` as soon as the distance is certain to exceed `max`.
 */
export function boundedEditDistance(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prevPrev: number[] = [];
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                value = Math.min(value, prevPrev[j - 2] + 1);
            }
            row.push(value);
            if (value < rowMin) rowMin = value;
        }
        if (rowMin > max) return max + 1;
        prevPrev = prev;
        prev = row;
    }
    return Math.min(prev[b.length], max + 1);
}

function normalizeEntryFields(input: {
    title: string;
    parentTitle?: string;
    sectionTitle: string;
    description?: string;
    keywords: string[];
    path: string;
}): NormalizedFields {
    const keywords = input.keywords.map(normalizeSearchText);
    const description = normalizeSearchText(input.description ?? '');
    return {
        title: normalizeSearchText(input.title),
        titleWords: wordsOf(normalizeSearchText(input.title)),
        parentWords: wordsOf(normalizeSearchText(input.parentTitle ?? '')),
        sectionWords: wordsOf(normalizeSearchText(input.sectionTitle)),
        description,
        descriptionWords: wordsOf(description),
        keywords,
        keywordWords: keywords.flatMap(wordsOf),
        path: input.path.toLowerCase().replace(/^\/admin\/?/, ''),
    };
}

/** Build an index entry, normalising its search fields. */
export function makeIndexEntry(input: Omit<AdminPageIndexEntry, 'norm'>): AdminPageIndexEntry {
    return {
        ...input,
        norm: normalizeEntryFields({
            title: input.title,
            parentTitle: input.parentTitle,
            sectionTitle: input.sectionTitle,
            description: input.description,
            keywords: input.keywords,
            path: input.path,
        }),
    };
}

/**
 * Section label for a route with no nav ancestor: the section of the visible
 * nav page that shares the longest directory prefix below `/admin`, else "More".
 */
function fallbackSection(
    path: string,
    navSections: AdminNavSection[],
): { id: string; title: string; icon?: IconSource } {
    const segments = path.split('/').filter(Boolean);
    let best: { depth: number; id: string; title: string; icon?: IconSource } | undefined;
    for (const section of navSections) {
        for (const page of section.pages) {
            const pageSegments = page.path.split('/').filter(Boolean);
            let depth = 0;
            while (
                depth < segments.length - 1 &&
                depth < pageSegments.length &&
                segments[depth] === pageSegments[depth]
            ) {
                depth++;
            }
            if (depth >= 2 && (!best || depth > best.depth)) {
                best = { depth, id: section.id, title: section.title(), icon: page.icon };
            }
        }
    }
    return best ?? { id: 'more', title: m.admin_search_section_more() };
}

/** The nav page a route belongs to: itself, or the closest nav page above it. */
function navAncestor(path: string): string | undefined {
    let best: string | undefined;
    for (const section of ADMIN_NAV) {
        for (const page of section.pages) {
            const matches =
                page.path === '/admin'
                    ? path === '/admin'
                    : path === page.path || path.startsWith(page.path + '/');
            if (matches && (!best || page.path.length > best.length)) best = page.path;
        }
    }
    return best;
}

/**
 * One entry per visible page and tab, pages followed by their tabs.
 * `navSections` must already be gate-filtered (`visibleNav`); `gate` is the
 * same context, used for the meta's own `permission` fields.
 */
export function buildAdminPageIndex(input: {
    navSections: AdminNavSection[];
    gate: NavGateContext;
}): AdminPageIndexEntry[] {
    const visibleNavPages = new Map(
        input.navSections.flatMap((section) =>
            section.pages.map((page) => [page.path, { section, page }] as const),
        ),
    );
    const entries: AdminPageIndexEntry[] = [];
    for (const { path, meta } of ADMIN_ROUTE_METAS) {
        if (!isGateOpen(meta.permission, input.gate)) continue;
        const ancestor = navAncestor(path);
        const located = ancestor ? visibleNavPages.get(ancestor) : undefined;
        if (ancestor && !located) continue;
        // No nav page above this route gates it, so it must declare its own
        // `permission` (`{}` = open to every admin); otherwise leave it out.
        if (!ancestor && !meta.permission) continue;
        const fallback = located ? undefined : fallbackSection(path, input.navSections);
        const sectionTitle = located?.section.title() ?? fallback?.title ?? '';
        const sectionId = located?.section.id ?? fallback?.id ?? '';
        const icon = located?.page.icon ?? fallback?.icon;
        const title = meta.title();
        const description = meta.description?.();
        const keywords = meta.keywords?.() ?? [];
        entries.push(
            makeIndexEntry({
                kind: 'page',
                path,
                href: path,
                title,
                description,
                sectionId,
                sectionTitle,
                keywords,
                icon,
            }),
        );
        for (const tab of [...(meta.tabs ?? []), ...(meta.destinations ?? [])]) {
            if (!isGateOpen(tab.permission, input.gate)) continue;
            const tabTitle = tab.title();
            const tabDescription = tab.description?.();
            const tabKeywords = tab.keywords?.() ?? [];
            entries.push(
                makeIndexEntry({
                    kind: 'tab',
                    path,
                    href: `${path}?${tab.param ?? 'tab'}=${encodeURIComponent(tab.id)}${tab.hash ? `#${encodeURIComponent(tab.hash)}` : ''}`,
                    title: tabTitle,
                    description: tabDescription,
                    sectionId,
                    sectionTitle,
                    parentTitle: title,
                    keywords: tabKeywords,
                    icon,
                }),
            );
        }
    }
    // Pages without a route meta (the protected-tier ones) come from the nav itself.
    const withMeta = new Set(ADMIN_ROUTE_METAS.map((r) => r.path));
    for (const [path, { section, page }] of visibleNavPages) {
        if (withMeta.has(path)) continue;
        entries.push(
            makeIndexEntry({
                kind: 'page',
                path,
                href: path,
                title: page.title(),
                description: page.description?.(),
                sectionId: section.id,
                sectionTitle: section.title(),
                keywords: [],
                icon: page.icon,
            }),
        );
    }
    return entries;
}

let memo:
    | {
          sections: AdminNavSection[];
          gate: NavGateContext;
          locale: string;
          index: AdminPageIndexEntry[];
      }
    | undefined;

/**
 * `buildAdminPageIndex`, remembered for the last (navSections, gate, locale):
 * the palette searches on every keystroke and the inputs rarely change.
 */
export function getAdminPageIndex(
    navSections: AdminNavSection[],
    gate: NavGateContext,
): AdminPageIndexEntry[] {
    const locale = getLocale();
    if (memo && memo.sections === navSections && memo.gate === gate && memo.locale === locale) {
        return memo.index;
    }
    const index = buildAdminPageIndex({ navSections, gate });
    memo = { sections: navSections, gate, locale, index };
    return index;
}

const MAX_QUERY_CHARS = 100;
const MAX_QUERY_TOKENS = 8;

/** Best score of one query token against an entry; 0 = no match. */
function scoreToken(n: NormalizedFields, token: string): number {
    let best = 0;
    const bump = (value: number): void => {
        if (value > best) best = value;
    };

    if (n.title.startsWith(token)) bump(85);
    if (n.titleWords.includes(token)) bump(80);
    if (n.titleWords.some((word) => word.startsWith(token))) bump(75);
    if (n.keywords.includes(token) || n.keywordWords.includes(token)) bump(70);
    if (n.keywords.some((k) => k.startsWith(token))) bump(60);
    if (n.keywordWords.some((word) => word.startsWith(token))) bump(55);
    if (n.title.includes(token)) bump(50);
    if (token.length >= 3 && n.keywords.some((k) => k.includes(token))) bump(45);
    if (n.descriptionWords.some((word) => word.startsWith(token))) bump(40);
    if (n.description.includes(token)) bump(35);
    if (n.parentWords.some((word) => word.startsWith(token))) bump(32);
    if (n.sectionWords.some((word) => word.startsWith(token))) bump(28);
    if (token.length >= 3 && n.path.includes(token)) bump(20);
    if (best > 0) return best;

    const limit = fuzzyLimit(token.length);
    if (limit === 0) return 0;
    const near = (words: string[]): boolean =>
        words.some((word) => boundedEditDistance(token, word, limit) <= limit);
    if (near(n.titleWords)) return 18;
    if (near(n.keywords) || near(n.keywordWords)) return 15;
    if (near(n.parentWords)) return 12;
    return 0;
}

function scoreEntry(entry: AdminPageIndexEntry, query: string, tokens: string[]): number {
    const n = entry.norm;
    if (wordsOf(n.title).join(' ') === tokens.join(' ')) return 1000;
    // A pasted route ("system/cost") matches by path even though its tokens may not.
    const pathQuery = query.replace(/^\/?admin\/?/, '');
    if (query.includes('/') && pathQuery.length >= 3 && n.path.includes(pathQuery)) return 25;
    let total = 0;
    for (const token of tokens) {
        const score = scoreToken(n, token);
        if (score === 0) return 0;
        total += score;
    }
    return total;
}

/**
 * Entries matching every query token, best first (ties keep manifest order).
 * Exact title beats title prefix, then title word, keyword, substring and
 * description matches, then typo-tolerant matches.
 */
export function searchAdminPages(index: AdminPageIndexEntry[], query: string): AdminPageMatch[] {
    const normalized = normalizeSearchText(query.slice(0, MAX_QUERY_CHARS)).trim();
    const tokens = wordsOf(normalized).slice(0, MAX_QUERY_TOKENS);
    if (tokens.length === 0) return [];
    return index
        .map((entry) => ({ entry, score: scoreEntry(entry, normalized, tokens) }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score);
}
