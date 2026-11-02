// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The scope this modal returns decides what a library-wide run is allowed to
 * RETRACT. Picking the wrong one removes markers the operator asked to keep, so
 * the mapping from radio to returned scope is worth pinning down.
 */

import { render, screen } from '@testing-library/svelte';
import { describe, expect, test, vi } from 'vitest';
import SegmentRefreshModal from './SegmentRefreshModal.svelte';

vi.mock('$lib/stores/modal.store', () => ({
    modals: { close: vi.fn().mockResolvedValue(undefined) },
}));

describe('SegmentRefreshModal', () => {
    test('offers all three scopes and defaults to both', () => {
        render(SegmentRefreshModal, { onConfirm: vi.fn() });

        const radios = screen.getAllByRole('radio') as HTMLInputElement[];
        expect(radios).toHaveLength(3);
        expect(radios.map((r) => r.value)).toEqual(['both', 'intro', 'outro']);
        // "Both" is the safe default: it is what an operator means by
        // "re-detect segments" unless they say otherwise.
        expect(radios[0].checked).toBe(true);
    });

    test('confirming without touching the radios asks for both', async () => {
        const onConfirm = vi.fn();
        render(SegmentRefreshModal, { onConfirm });

        const confirm = screen.getByRole('button', { name: /start/i });
        confirm.click();
        await new Promise((r) => setTimeout(r, 0));

        expect(onConfirm).toHaveBeenCalledWith('both');
    });

    test('confirming after picking a narrower scope passes that scope through', async () => {
        const onConfirm = vi.fn();
        render(SegmentRefreshModal, { onConfirm });

        const outro = screen
            .getAllByRole('radio')
            .find((r) => (r as HTMLInputElement).value === 'outro')!;
        outro.click();
        await new Promise((r) => setTimeout(r, 0));

        screen.getByRole('button', { name: /start/i }).click();
        await new Promise((r) => setTimeout(r, 0));

        // Not 'both' — a silently widened scope would retract the intros the
        // operator explicitly chose to leave alone.
        expect(onConfirm).toHaveBeenCalledWith('outro');
    });

    test('cancelling never starts a run', async () => {
        const onConfirm = vi.fn();
        const onCancel = vi.fn();
        render(SegmentRefreshModal, { onConfirm, onCancel });

        screen.getByRole('button', { name: /cancel|abbrechen/i }).click();
        await new Promise((r) => setTimeout(r, 0));

        expect(onCancel).toHaveBeenCalled();
        expect(onConfirm).not.toHaveBeenCalled();
    });
});
