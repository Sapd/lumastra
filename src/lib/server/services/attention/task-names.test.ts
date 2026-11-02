// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/server/tasks/registry.js', () => ({
    getRegistry: vi.fn(),
}));

import { getRegistry } from '$lib/server/tasks/registry.js';
import { taskName } from './task-names.js';

describe('taskName', () => {
    it('returns the curated operator name for a builtin, not its SDK name', () => {
        vi.mocked(getRegistry).mockReturnValue({
            getTask: (id: string) =>
                id === 'fribb-anime-sync' ? { name: 'Fribb Anime ID Sync' } : undefined,
        } as ReturnType<typeof getRegistry>);
        expect(taskName('fribb-anime-sync')).toBe('Map Anime IDs (MyAnimeList, AniList)');
    });

    it('returns the registry name for a task without a curated name (plugins)', () => {
        vi.mocked(getRegistry).mockReturnValue({
            getTask: (id: string) => (id === 'acme-sync' ? { name: 'Acme Sync' } : undefined),
        } as ReturnType<typeof getRegistry>);
        expect(taskName('acme-sync')).toBe('Acme Sync');
    });

    it('falls back to a prettified id when the task is absent from the registry', () => {
        // A removed task, or a plugin that failed to load — a taskId can outlive
        // its registry entry (e.g. it still appears in old DB rows).
        vi.mocked(getRegistry).mockReturnValue({
            getTask: () => undefined,
            // Cast through `unknown`: a stub whose only member returns undefined
            // has no overlap with TaskRegistry, so TS rejects the direct
            // assertion. The stub is deliberately minimal — taskName() touches
            // nothing else on the registry.
        } as unknown as ReturnType<typeof getRegistry>);
        expect(taskName('some-removed-task')).toBe('Some removed task');
    });

    it('never returns a blank string for an unknown id', () => {
        vi.mocked(getRegistry).mockReturnValue({
            getTask: () => undefined,
            // Cast through `unknown`: a stub whose only member returns undefined
            // has no overlap with TaskRegistry, so TS rejects the direct
            // assertion. The stub is deliberately minimal — taskName() touches
            // nothing else on the registry.
        } as unknown as ReturnType<typeof getRegistry>);
        expect(taskName('')).not.toBe('');
    });
});
