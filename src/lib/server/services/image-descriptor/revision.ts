// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';

/** Bump whenever resize/encode rules change. */
export const IMAGE_ALGO_VERSION = '1';
export interface ImageRevisionInput {
    ownerId: string;
    role: string;
    localPath?: string | null;
    localUpdatedAt?: string | null;
    providerPath?: string | null;
    customUrl?: string | null;
    preferredProvider?: string | null;
}

export function imageRevision(input: ImageRevisionInput, algoVersion = IMAGE_ALGO_VERSION): string {
    return createHash('sha256').update(JSON.stringify([
        algoVersion, input.ownerId, input.role, input.localPath ?? null,
        input.localUpdatedAt ?? null, input.providerPath ?? null,
        input.customUrl ?? null, input.preferredProvider ?? null,
    ])).digest('hex').slice(0, 12);
}
