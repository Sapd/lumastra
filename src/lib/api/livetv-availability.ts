// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { apiGet } from './client.js';
import {
    LiveTvAvailabilitySchema,
    type LiveTvAvailability,
} from '$lib/schemas/livetv-availability.js';
import type { ApiResult } from './types.js';
export function getLiveTvAvailability(): Promise<ApiResult<LiveTvAvailability>> {
    return apiGet('/api/livetv/availability', LiveTvAvailabilitySchema);
}
