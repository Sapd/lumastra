// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Attention-item id → admin nav section mapping (admin IA redesign, spec
 * §5). Pure and dependency-free so BOTH the server (sectionStatus
 * derivation in `admin-status-payload.service.ts`) and the client (filtering
 * `AttentionList` to "items relevant to this section landing page") can
 * import the SAME mapping — a section landing page can never disagree with
 * the nav dot that sent the operator there.
 */

import type { AttentionItem } from '$lib/schemas/api-attention-responses.js';
import type { AdminSectionId } from '$lib/schemas/api-admin-status-payload.js';

/**
 * Map an attention-item id (namespace prefix) to the admin nav section whose
 * dot it should light. Unknown prefixes land on `system` — the Health page is
 * the catch-all diagnosis surface.
 */
export function sectionForItem(item: Pick<AttentionItem, 'id'>): AdminSectionId {
    const id = item.id;
    if (
        id.startsWith('circuit:') ||
        id.startsWith('overdue-schedule:') ||
        // The invariant bridge (adapters.ts `domainForLivenessSubsystem`, design
        // "Problems as Architecture" §9 Slice 3 step 4) namespaces by real
        // domain instead of a blanket `task-liveness:` prefix — heartbeats,
        // resource-class leaders and 11 of 15 health invariants land in `tasks`.
        id.startsWith('tasks:') ||
        id.startsWith('dead-letter:') ||
        id.startsWith('outbox-dead-letter:') ||
        id.startsWith('stuck-items:') ||
        id.startsWith('decline-loop:') ||
        id.startsWith('failed-run-spike:') ||
        id.startsWith('repeated-recovery:') ||
        // `adaptPluginFailures` declares `domain: 'tasks'` (adapters.ts) — these
        // are items a task could not process, grouped by the plugin that failed
        // them, so they belong beside the other task-health producers rather
        // than under a plugins-of-their-own section.
        id.startsWith('plugin-failures:')
    ) {
        return 'tasks';
    }
    if (
        id.startsWith('unmatched:') ||
        id.startsWith('gave-up:') ||
        id.startsWith('file-health:') ||
        id.startsWith('integrity:') ||
        // The remaining 2 of 15 invariants the bridge does NOT classify as
        // `tasks` — duplicate-artist-groups / duplicate-external-ids are data
        // quality problems, not pipeline ones.
        id.startsWith('library:') ||
        // "What did that scan actually do" (design task 2) — carries
        // `domain: 'library'` on the item itself, but THIS map keys on id
        // prefix, not domain (see the file header), so it needs its own
        // branch or it falls through to `system` below despite the domain.
        id.startsWith('scan-run:') ||
        // Music tagging hygiene (adapters.ts `adaptMusicHygiene`) — same trap
        // the `scan-run:` comment above describes, and it caught this producer
        // too: the items carry `domain: 'library'` AND link into
        // `/admin/library/media`, yet without this branch they rendered on
        // System/Health and counted into the System nav tooltip. Both
        // producers shipped the bug in the same plan, which is why
        // `admin-status-payload.service.test.ts` now pins every id prefix that
        // has a branch here rather than a sample of them.
        id.startsWith('music-hygiene:')
    ) {
        return 'library';
    }
    if (id.startsWith('setup-incomplete') || id.startsWith('onboarding')) {
        return 'home';
    }
    if (
        id.startsWith('livetv-import:') ||
        id.startsWith('optional-integration:') ||
        id.startsWith('settings:') ||
        // `adaptPluginUpdates` declares `domain: 'plugins'`, but there is no
        // `plugins` AdminSectionId — the plugin admin surface lives at
        // /admin/settings/plugins, which is where the item's own sourceRef and
        // action href point, so `settings` is the section it belongs to.
        id.startsWith('plugin-update:')
    ) {
        return 'settings';
    }
    // degraded-component: / optional-dependency: / lumastra-playback: / unknown /
    // storage: / transcoding: — `storage` and `transcoding` are real domains
    // (shared/attention-domain.ts) with no dedicated nav section. Deliberately
    // NOT forced onto Library or Tasks here — that is the exact "wrong dot"
    // bug the invariant-bridge rename fixes. The Health page is the catch-all
    // diagnosis surface for a domain that has none of its own.
    return 'system';
}
