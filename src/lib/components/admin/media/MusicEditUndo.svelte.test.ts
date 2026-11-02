// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
const mocks = vi.hoisted(() => ({ read: vi.fn(), undo: vi.fn() }));
vi.mock('$lib/api/music-credits.js', () => ({
    readMusicEdits: mocks.read,
    restoreMusicEdit: mocks.undo,
}));
import MusicEditUndo from './MusicEditUndo.svelte';
const target = '11111111-1111-4111-8111-111111111111';
const receipt = '22222222-2222-4222-8222-222222222222';
beforeEach(() => {
    mocks.read.mockResolvedValue({
        data: {
            edits: [
                {
                    id: receipt,
                    kind: 'credits',
                    createdAt: '2026-10-28 12:00:00+00',
                    undone: false,
                },
            ],
        },
    });
});
afterEach(() => {
    cleanup();
    vi.resetAllMocks();
});
it('discovers saved recovery after navigation and undoes it once without another confirmation', async () => {
    const changed = vi.fn();
    render(MusicEditUndo, { mediaId: target, onsaved: changed });
    await fireEvent.click(await screen.findByText(m.music_edit_history()));
    const undo = screen.getByRole('button', { name: m.music_edit_undo() });
    mocks.undo.mockResolvedValue({ data: { restored: true } });
    mocks.read.mockResolvedValue({
        data: { edits: [{ id: receipt, kind: 'credits', createdAt: '2026-10-28', undone: true }] },
    });
    await fireEvent.click(undo);
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(mocks.undo).toHaveBeenCalledExactlyOnceWith(target, receipt);
    expect(await screen.findByText(m.music_edit_restored())).toBeTruthy();
    expect(screen.queryByRole('button', { name: m.music_edit_undo() })).toBeNull();
});
it('shows a stale recovery conflict without claiming success or refreshing away the evidence', async () => {
    const changed = vi.fn();
    mocks.undo.mockResolvedValue({ error: 'stale', status: 409 });
    render(MusicEditUndo, { mediaId: target, onsaved: changed });
    await fireEvent.click(await screen.findByText(m.music_edit_history()));
    await fireEvent.click(screen.getByRole('button', { name: m.music_edit_undo() }));
    expect((await screen.findByRole('alert')).textContent).toContain(m.music_edit_conflict());
    expect(changed).not.toHaveBeenCalled();
    expect(screen.queryByText(m.music_edit_restored())).toBeNull();
});
