// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';

/** File-scanner phases plus the task runner's stage/progress states. */
export function scanProgressLabel(code: string | undefined): string | null {
    switch (code) {
        case 'main':
        case 'active':
        case 'running':
            return m.setup_scan_phase_main();
        case 'discovering':
            return m.setup_scan_phase_discovering();
        case 'scanning':
        case 'Scanning files':
            return m.setup_scan_phase_scanning();
        case 'ancillary':
            return m.setup_scan_phase_ancillary();
        case 'idle':
        case 'queued':
        case 'waiting':
        case 'delayed':
            return m.setup_scan_phase_waiting();
        case 'initializing':
        case 'starting':
            return m.setup_scan_starting();
        case 'paused':
            return m.setup_scan_phase_paused();
        case 'cancelling':
            return m.setup_scan_phase_cancelling();
        case 'completed':
            return m.setup_scan_complete();
        case 'error':
        case 'failed':
        case 'cancelled':
        case 'aborted':
            return m.setup_scan_failed();
        default:
            return null;
    }
}
