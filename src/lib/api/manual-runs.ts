// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { apiGet } from './client.js';
import { ManualRunsResponseSchema } from '$lib/schemas/manual-runs.js';

/** The caller's manual runs: live ones, plus those finished after `since`. */
export function getMyManualRuns(since?: string) {
    const query = since ? `?since=${encodeURIComponent(since)}` : '';
    return apiGet(`/api/me/manual-runs${query}`, ManualRunsResponseSchema);
}
