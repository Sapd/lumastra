// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { safeStatBigInt } from './safe-fs.js';
/** Shared-mount identity. st_dev is host-local and must not invalidate a cross-replica review. */
export async function healthPhysicalIdentity(path: string, signal?: AbortSignal): Promise<string> {
    const stat = await safeStatBigInt(path, 5000, signal);
    return ['stat-v2', stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
