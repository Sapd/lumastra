// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const StuckItemReasonSchema = z.enum([
    'running_stale',
    'attempt_threshold',
    'pending_dormant',
]);

export type StuckItemReason = z.infer<typeof StuckItemReasonSchema>;
