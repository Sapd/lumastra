// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'vitest';
import StageCell from './StageCell.svelte';
import type { StageStatus } from '$lib/types/pipeline.js';

describe('StageCell', () => {
    test.each<[StageStatus, string]>([
        ['completed', 'bg-emerald-500'],
        ['running', 'bg-sky-500'],
        ['pending', 'bg-zinc-400'],
        ['failed_transient', 'bg-amber-500'],
        ['failed_permanent', 'bg-red-600'],
        ['skipped_permanent', 'bg-zinc-300'],
        ['skipped_transient', 'bg-amber-300'],
        ['obsolete', 'bg-purple-500'],
    ])('renders %s status with %s color class', (status, expectedClass) => {
        const { container } = render(StageCell, { status });
        const span = container.querySelector('span');
        expect(span).not.toBeNull();
        expect(span!.className).toContain(expectedClass);
    });

    test('sets aria-label including stageId and status', () => {
        const { container } = render(StageCell, {
            status: 'completed',
            stageId: 'media-probe',
        });
        const span = container.querySelector('span');
        expect(span).not.toBeNull();
        expect(span!.getAttribute('aria-label')).toContain('media-probe');
        // aria-label uses the operator-friendly status label (taskStatusLabel),
        // so 'completed' surfaces as 'Done'.
        expect(span!.getAttribute('aria-label')).toContain('Done');
    });

    test('aria-label includes attempt and error when provided', () => {
        const { container } = render(StageCell, {
            status: 'failed_transient',
            stageId: 'music-analysis',
            attempt: 3,
            lastError: { message: 'timeout', code: 'ERR_TIMEOUT' },
        });
        const span = container.querySelector('span');
        expect(span!.getAttribute('aria-label')).toContain('attempt 3');
        expect(span!.getAttribute('aria-label')).toContain('timeout');
    });

    test('compact renders w-1 h-1 size classes', () => {
        const { container } = render(StageCell, {
            status: 'pending',
            compact: true,
        });
        const span = container.querySelector('span');
        expect(span!.className).toContain('w-1');
        expect(span!.className).toContain('h-1');
    });

    test('non-compact renders w-2 h-2 size classes', () => {
        const { container } = render(StageCell, {
            status: 'pending',
            compact: false,
        });
        const span = container.querySelector('span');
        expect(span!.className).toContain('w-2');
        expect(span!.className).toContain('h-2');
    });

    test('shows a help cursor on hover, signaling the cell has more detail via its title', () => {
        const { container } = render(StageCell, { status: 'completed' });
        const span = container.querySelector('span');
        expect(span).not.toBeNull();
        expect(span!.className).toContain('cursor-help');
    });
});
