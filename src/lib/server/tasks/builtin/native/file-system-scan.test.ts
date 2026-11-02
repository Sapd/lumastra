// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { runTask } from '@sapd/lumastra-plugin-sdk-testing';
import {
    fileSystemScanDiscoverTask,
    fileSystemScanProbeTask,
    fileSystemScanIngestTask,
    fileSystemScanTask,
} from './file-system-scan.js';

describe('native file-system-scan pipeline', () => {
    it('discover stage runs first (no `after`)', () => {
        expect(fileSystemScanDiscoverTask.pipeline?.of).toBe('file-system-scan');
        expect(fileSystemScanDiscoverTask.pipeline?.after).toBeUndefined();
    });

    it('probe stage waits for discover', () => {
        expect(fileSystemScanProbeTask.pipeline?.of).toBe('file-system-scan');
        expect(fileSystemScanProbeTask.pipeline?.after).toEqual(['file-system-scan-discover']);
    });

    it('ingest stage waits for probe', () => {
        expect(fileSystemScanIngestTask.pipeline?.after).toEqual(['file-system-scan-probe']);
    });

    it('probe `when` predicate skips empty discover results', () => {
        const when = fileSystemScanProbeTask.pipeline?.when;
        expect(when?.({ paths: [] })).toBe(false);
        expect(when?.({ paths: ['/a'] })).toBe(true);
        expect(when?.(undefined)).toBe(false);
    });

    it('discover stage produces a path list', async () => {
        const result = await runTask(fileSystemScanDiscoverTask, {
            libraryGroupId: 'lg-test',
            force: false,
        });
        expect(result.success).toBe(true);
        expect(Array.isArray((result.result as { paths?: unknown })?.paths)).toBe(true);
    });

    it('all stages are scoped to libraryGroup', () => {
        for (const t of [
            fileSystemScanDiscoverTask,
            fileSystemScanProbeTask,
            fileSystemScanIngestTask,
            fileSystemScanTask,
        ]) {
            expect(t.scope).toBe('libraryGroup');
            // Colons banned in identity formulas — BullMQ 5.71 rejects them
            // in jobIds (see commit 46e931899). Native task uses `-` instead.
            expect(t.identityFor({ libraryGroupId: 'lg-test', force: false })).toBe('lg-lg-test');
        }
    });
});
