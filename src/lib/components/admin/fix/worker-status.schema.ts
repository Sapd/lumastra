// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Client-side shape for `GET /api/admin/worker-status`.
 *
 * That endpoint declares its response schema privately inside its own def, so
 * there is nothing importable to share. This is a deliberate re-declaration of
 * three stable fields rather than a widening of someone else's contract —
 * `apiGet` applies `.strict()` at the top level, so a server-side addition
 * would surface as a reported mismatch rather than a silent strip.
 */

import { z } from 'zod';

export const WorkerStatusSchema = z.object({
    /** Whether ANY background worker can pick up jobs — in-process or clustered. */
    available: z.boolean(),
    source: z.string(),
    detail: z.string().optional(),
    /** Present when workers heartbeat but none can take work (upgrade, consumers stopped, lease). */
    reasons: z.array(z.string()).optional(),
});

export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;
