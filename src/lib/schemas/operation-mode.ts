// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Operation Mode Zod Schema
 *
 * SINGLE SOURCE OF TRUTH for the client-facing operation mode shape.
 * Defines the contract for system capability flags passed via +layout.server.ts.
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Export both schema and inferred type
 */

import { z } from 'zod';

/**
 * Client-facing operation mode — system capability flags.
 *
 * Exposed via +layout.server.ts → $page.data.operationMode
 */
export const OperationModeSchema = z.object({
    jellyfinEnabled: z.boolean().describe('Jellyfin feature is on (URL + API key set)'),
    jellyfinAvailable: z.boolean().describe('Jellyfin is reachable right now'),
    canLiveTV: z.boolean().describe('Live TV features available (Jellyfin or standalone source)'),
    isStandalone: z.boolean().describe('No media server configured — discovery-only mode'),
});

export type ClientOperationMode = z.infer<typeof OperationModeSchema>;
