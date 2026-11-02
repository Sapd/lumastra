// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One representative attention-item id per prefix `sectionForItem` branches on,
 * grouped by the section that prefix must land in — shared by the map's own
 * guard and by the guards over its two CONSUMERS.
 *
 * Shared rather than duplicated because the map's suite
 * (`admin-status-payload.service.test.ts`) already checks this table back
 * against the `startsWith(...)` literals in `attention-section-map.ts`: a
 * producer that adds a branch without adding an id here fails THAT test. Making
 * the consumer suites read the same table means the completeness guarantee
 * reaches them too — otherwise a third producer gets a branch, gets an id here,
 * and still has nothing proving the strip renders it or the nav dot counts it.
 *
 * That distinction is not theoretical. The map keys on id PREFIX while adapters
 * state a `domain`, so an item can carry `domain: 'library'`, link into
 * `/admin/library/media`, and still light the System dot with nothing failing —
 * and the operator-visible symptom both times (`scan-run:`, then
 * `music-hygiene:`) appeared in the consumers, not in the map.
 */

import type { AttentionItem } from '$lib/schemas/api-attention-responses.js';
import type { AdminSectionId } from '$lib/schemas/api-admin-status-payload.js';

export const IDS_BY_SECTION = {
    tasks: [
        'circuit:tmdb-sync',
        'overdue-schedule:calendar-sync',
        'tasks:reconciler',
        'dead-letter:media-probe',
        'outbox-dead-letter:all',
        'stuck-items:media-probe',
        'decline-loop:media-probe',
        'failed-run-spike:tmdb-sync',
        'repeated-recovery:reconciler:orphans-reclaimed',
        'plugin-failures:com.example.scanner',
    ],
    library: [
        'unmatched:all',
        'gave-up:all',
        'file-health:all',
        'integrity:all',
        'library:duplicate-artist-groups',
        'scan-run:00000000-0000-0000-0000-000000000001',
        'music-hygiene:music-title-from-filename',
    ],
    home: ['setup-incomplete', 'onboarding:library-paths'],
    settings: [
        'livetv-import:src-1',
        'optional-integration:lastfm',
        'plugin-update:all',
        'settings:jellyfin-unpaired-watch-records',
        'settings:jellyfin-unlinked-users',
        'settings:master-key:undecryptable',
        'settings:master-key:generated',
        'settings:audiobookshelf-unlinked-users',
    ],
} as const satisfies Partial<Record<AdminSectionId, readonly string[]>>;

/** The sections the table covers, as a plain array for `it.each` / loops. */
export const SECTIONS_WITH_IDS = Object.keys(IDS_BY_SECTION) as (keyof typeof IDS_BY_SECTION)[];

/** Every id in the table, flattened, in table order. */
export const ALL_SECTION_IDS: readonly string[] = SECTIONS_WITH_IDS.flatMap(
    (section) => IDS_BY_SECTION[section] as readonly string[],
);

/** A minimal well-formed `AttentionItem`; override whatever the test is about. */
export function attentionItem(over: Partial<AttentionItem> & { id: string }): AttentionItem {
    return {
        fingerprint: `fp-${over.id}`,
        type: 'degraded-component',
        severity: 'warning',
        title: `title for ${over.id}`,
        actions: [],
        firstSeen: '2026-01-01T00:00:00Z',
        lastSeen: '2026-01-01T00:00:00Z',
        acked: false,
        ...over,
    };
}
