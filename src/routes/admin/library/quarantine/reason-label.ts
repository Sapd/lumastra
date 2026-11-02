// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import * as m from '$lib/paraglide/messages.js';

export function quarantineReason(reason: string): string {
    switch (reason.replace('reconcile-backfill:', '')) {
        case 'matched':
            return m.admin_quarantine_reason_matched();
        case 'below-threshold':
            return m.admin_quarantine_reason_below();
        case 'duplicate-match':
            return m.admin_quarantine_reason_duplicate();
        case 'no-usable-chapters':
            return m.admin_quarantine_reason_no_chapters();
        case 'chapter-count-mismatch':
            return m.admin_quarantine_reason_chapters();
        case 'contradictory-file-window':
            return m.admin_quarantine_reason_window();
        case 'identity-bound':
            return m.admin_quarantine_block_identity_bound();
        case 'manually-locked':
            return m.admin_quarantine_block_manually_locked();
        default:
            return m.admin_quarantine_reason_unknown();
    }
}
