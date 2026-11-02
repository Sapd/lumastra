// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { apiGet } from './client.js';
import type { ApiResult } from './types.js';
import {
    ConformanceResponseSchema,
    type ConformanceResponse,
} from '$lib/schemas/api-conformance.js';

export function getApiConformance(days = 1): Promise<ApiResult<ConformanceResponse>> {
    return apiGet('/api/admin/api-conformance', ConformanceResponseSchema, {
        params: { days },
        strict: true,
    });
}
