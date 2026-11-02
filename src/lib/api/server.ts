// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { apiGet } from './client.js';
import { ServerInfoSchema } from '$lib/schemas/server-info.js';

/** Read discovery before sign-in and capabilities for the authenticated caller. */
export function getServerInfo() {
    return apiGet('/api/server', ServerInfoSchema);
}
