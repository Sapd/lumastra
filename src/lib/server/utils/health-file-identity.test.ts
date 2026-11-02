// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
const readStat = vi.hoisted(() => vi.fn());
vi.mock('./safe-fs.js', () => ({ safeStatBigInt: readStat }));
import { healthPhysicalIdentity } from './health-file-identity.js';
it('keeps a shared file stable across host device IDs while detecting replacements', async () => {
    const source = { dev: 1n, ino: 22n, size: 100n, mtimeNs: 123n, ctimeNs: 456n };
    readStat
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce({ ...source, dev: 999n })
        .mockResolvedValueOnce({ ...source, ino: 23n });
    const first = await healthPhysicalIdentity('/file');
    expect(await healthPhysicalIdentity('/file')).toBe(first);
    expect(await healthPhysicalIdentity('/file')).not.toBe(first);
});
