// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';
import type { ApiResult } from '$lib/api/types.js';

/** Viewer-facing text for a failed PIN check or locked save. */
export function pinErrorMessage(result: ApiResult<unknown>): string {
    if (result.status === 429) return m.livetv_simple_pin_too_many();
    if (result.details === 'pin_invalid') return m.livetv_simple_pin_wrong();
    if (result.details === 'pin_required') return m.livetv_simple_pin_title();
    return result.error ?? m.livetv_simple_setup_failed();
}
