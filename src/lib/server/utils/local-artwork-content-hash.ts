// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { readContainedFile } from './contained-fs.js';

/** Binary fingerprint with containment and the reader's default 32 MiB cap.
 * Read errors propagate so callers can retain their unmeasured-file fallback.
 */
export async function hashLocalArtworkFile(
    filePath: string,
    extraRoots: readonly string[] = [],
): Promise<string> {
    const bytes = await readContainedFile(filePath, { extraRoots });
    return createHash('sha256').update(bytes).digest('hex');
}
