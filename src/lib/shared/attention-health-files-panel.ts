// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which attention items the System → Health "Files" panel renders, and which of
 * them link into the media browser.
 *
 * Pure and dependency-free (types only), the same shape as
 * `attention-section-map.ts`, so the predicate is unit-testable without a
 * component harness — a `.svelte` file's inline `$derived` filter is invisible
 * to `npm run typecheck` (tsgo skips `.svelte`) and to every server test.
 *
 * ## Why this is keyed on ID PREFIX and not on `type`
 *
 * The panel used to filter `i.type === 'file-health' || i.type === 'integrity'`
 * and take its media-browser-link branch on `item.type === 'integrity'`.
 * `AttentionType` is a CLOSED 15-value enum mirrored in four artifacts (the Zod
 * schema, the generated OpenAPI client, a Postgres CHECK constraint, and the
 * adapters that write it), which is exactly why `domain` was introduced to
 * replace it — see `attention-domain.ts`. A producer that needs an item to
 * exist today therefore has to pick a NEAR-MISS enum member, and
 * `adaptMusicHygiene` picked `integrity` because it is the closest one that
 * already maps to the `library` domain.
 *
 * The consequence: every non-zero music-hygiene item — a calm `info` nudge about
 * artist names and missing title tags — rendered inside this panel next to
 * genuine file damage, on a page it has nothing to do with, and took the
 * `integrity` link branch while it was there.
 *
 * Filtering by id prefix rather than widening the enum is deliberate. Widening
 * `AttentionType` costs a migration for the CHECK constraint plus a client
 * regen, and it would grow a vocabulary the codebase is actively retiring;
 * `type` is documented as deprecated in favour of `domain`, so a NINTH member is
 * the wrong direction of travel. `domain` cannot do this job either — it is
 * `library` for integrity violations AND for music hygiene, and `storage` for
 * file health, so no domain test separates the three the way this panel needs.
 * The id namespace is what actually identifies a producer, which is the same
 * conclusion `attention-section-map.ts` reached.
 */

import type { AttentionItem } from '$lib/schemas/api-attention-responses.js';

/**
 * The id namespaces whose items this panel is ABOUT: `adaptFileHealth`
 * (`file-health:all`) and `adaptIntegrity` (`integrity:all`).
 *
 * An ALLOWLIST, not a denylist of `music-hygiene:`. A denylist puts the burden
 * on every future producer that happens to reuse one of the two enum members,
 * and the review that found this bug found it because that burden had already
 * been missed once.
 */
export const HEALTH_FILES_PANEL_PREFIXES = ['file-health:', 'integrity:'] as const;

/** The prefix whose items are scoped to a `media_items` row, so the browser can show them. */
export const HEALTH_FILES_INTEGRITY_PREFIX = 'integrity:';

/** Whether the System → Health "Files" panel should render this item. */
export function isHealthFilesPanelItem(item: Pick<AttentionItem, 'id'>): boolean {
    return HEALTH_FILES_PANEL_PREFIXES.some((prefix) => item.id.startsWith(prefix));
}

/**
 * Whether this panel item gets the "view in the media browser" link.
 *
 * Integrity violations ARE scoped to a `media_items` row, so the browser is the
 * right surface. The file-health summary gets no link: its list is the panel
 * directly below it, on the same page.
 */
export function isHealthFilesIntegrityItem(item: Pick<AttentionItem, 'id'>): boolean {
    return item.id.startsWith(HEALTH_FILES_INTEGRITY_PREFIX);
}

/** Whether the panel should fetch the file-level list below the summaries. */
export function isHealthFilesFileHealthItem(item: Pick<AttentionItem, 'id'>): boolean {
    return item.id.startsWith('file-health:');
}
