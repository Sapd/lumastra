// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CollaborationPreviewResult } from '$lib/schemas/collaboration-review.js';
import * as m from '$lib/paraglide/messages.js';

const mocks = vi.hoisted(() => ({ review: vi.fn(), search: vi.fn() }));
vi.mock('$lib/api/admin.js', () => ({
    reviewArtistCollaboration: mocks.review,
    searchArtists: mocks.search,
}));
vi.mock('$lib/api/music-credits.js', () => ({
    readMusicEdits: async () => ({ data: { edits: [] } }),
    restoreMusicEdit: vi.fn(),
}));
import CollaborationReviewModal from './CollaborationReviewModal.svelte';

const artistId = '11111111-1111-4111-8111-111111111111';
const trackId = '22222222-2222-4222-8222-222222222222';
const albumId = '33333333-3333-4333-8333-333333333333';
const ids = [
    '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555',
    '66666666-6666-4666-8666-666666666666',
];
function preview(members: CollaborationPreviewResult['members']): CollaborationPreviewResult {
    return {
        artist: { id: artistId, title: 'Aria feat. Nora feat. Vale' },
        members,
        suggestedNames: ['Aria', 'Nora', 'Vale'],
        witnesses: members.map((member) => ({
            member: 'id' in member ? member.name : member.newName,
            tags: ['solo source'],
        })),
        tracks:
            members.length < 2
                ? []
                : [
                      {
                          id: trackId,
                          title: 'Duet',
                          albumId,
                          albumTitle: 'Shared',
                          albumArtistId: artistId,
                          albumArtistTitle: 'Aria feat. Nora feat. Vale',
                          sourceTag: 'Aria feat. Nora feat. Vale',
                          fileCount: 1,
                          status: 'eligible',
                          reason: null,
                          before: [
                              {
                                  id: artistId,
                                  name: 'Aria feat. Nora feat. Vale',
                                  creditedAs: 'Aria feat. Nora feat. Vale',
                                  role: 'performer',
                                  active: true,
                              },
                          ],
                          after: members.map((member) => ({
                              artist: member,
                              creditedAs: 'id' in member ? member.name : member.newName,
                              role: 'performer',
                          })),
                          reviewSnapshot: 'b'.repeat(64),
                      },
                  ],
        overflow: false,
        albums:
            members.length < 2
                ? []
                : [
                      {
                          id: albumId,
                          title: 'Shared',
                          ownerId: artistId,
                          ownerTitle: 'Aria feat. Nora feat. Vale',
                      },
                  ],
        snapshot: 'a'.repeat(64),
        reviewed: false,
    };
}
beforeEach(() => {
    mocks.search.mockImplementation(async (_id: string, query: string) => ({
        data: {
            artists: ['Aria', 'Nora', 'Vale']
                .map((name, index) => ({ id: ids[index], title: name }))
                .filter((artist) => artist.title.toLowerCase().includes(query.toLowerCase())),
        },
    }));
    mocks.review.mockImplementation(
        async (
            _id: string,
            request: { action: string; members?: CollaborationPreviewResult['members'] },
        ) =>
            request.action === 'preview'
                ? { data: { action: 'preview', preview: preview(request.members ?? []) } }
                : {
                      data: {
                          action: 'apply',
                          result: { changedTracks: 1, unchangedAlbums: 1, reviewed: true },
                      },
                  },
    );
});
afterEach(() => {
    cleanup();
    vi.resetAllMocks();
});

it('saves the chosen members once with no acknowledgment and preselects eligible tracks', async () => {
    const changed = vi.fn();
    render(CollaborationReviewModal, { artistId, onclose: vi.fn(), onchanged: changed });
    await screen.findByText(m.collaboration_suggestions());
    for (const name of ['Aria', 'Nora', 'Vale']) {
        await fireEvent.input(
            screen.getByRole('textbox', { name: m.collaboration_search_artist() }),
            { target: { value: name } },
        );
        await fireEvent.click(screen.getByRole('button', { name: m.collaboration_search() }));
        await screen.findByRole('button', { name });
        await fireEvent.click(screen.getByRole('button', { name }));
    }
    await fireEvent.click(screen.getByRole('button', { name: m.collaboration_preview() }));
    const trackCheck = await screen.findByRole('checkbox', {
        name: m.collaboration_select_track({ title: 'Duet' }),
    });
    expect((trackCheck as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('checkbox', { name: m.collaboration_album_ack() })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: m.collaboration_confirm() }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    const apply = mocks.review.mock.calls.find((call) => call[1].action === 'apply')?.[1];
    expect(apply).toMatchObject({
        trackIds: [trackId],
        members: [
            { id: ids[0], name: 'Aria' },
            { id: ids[1], name: 'Nora' },
            { id: ids[2], name: 'Vale' },
        ],
    });
});

it('explains a dismissed track and prevents selecting it or closing the collaboration review', async () => {
    mocks.review.mockImplementation(
        async (_id: string, request: { members?: CollaborationPreviewResult['members'] }) => {
            const result = preview(request.members ?? []);
            if (result.tracks.length) {
                result.tracks.push({
                    ...result.tracks[0],
                    id: '77777777-7777-4777-8777-777777777777',
                    title: 'Hidden take',
                    status: 'abstain',
                    reason: 'dismissed',
                    before: [],
                    after: [],
                    reviewSnapshot: null,
                });
            }
            return { data: { action: 'preview', preview: result } };
        },
    );
    render(CollaborationReviewModal, { artistId, onclose: vi.fn(), onchanged: vi.fn() });
    await screen.findByText(m.collaboration_suggestions());
    for (const name of ['Aria', 'Nora']) {
        await fireEvent.input(
            screen.getByRole('textbox', { name: m.collaboration_search_artist() }),
            {
                target: { value: name },
            },
        );
        await fireEvent.click(screen.getByRole('button', { name: m.collaboration_search() }));
        await fireEvent.click(await screen.findByRole('button', { name }));
    }
    await fireEvent.click(screen.getByRole('button', { name: m.collaboration_preview() }));
    expect(await screen.findByText(m.collaboration_reason_dismissed())).toBeTruthy();
    const hidden = screen.getByRole('checkbox', {
        name: m.collaboration_select_track({ title: 'Hidden take' }),
    }) as HTMLInputElement;
    expect(hidden.disabled).toBe(true);
    expect(screen.queryByRole('checkbox', { name: m.collaboration_mark_reviewed() })).toBeNull();
    const current = screen.getByRole('checkbox', {
        name: m.collaboration_select_track({ title: 'Duet' }),
    }) as HTMLInputElement;
    expect(current.disabled).toBe(false);
});

it('does not offer zero-edit completion for a still-joined locked track', async () => {
    mocks.review.mockImplementation(
        async (
            _id: string,
            request: { action: string; members?: CollaborationPreviewResult['members'] },
        ) => {
            const result = preview(request.members ?? []);
            if (result.tracks.length) {
                result.tracks[0].status = 'abstain';
                result.tracks[0].reason = 'locked';
                result.tracks[0].after = [];
            }
            return { data: { action: 'preview', preview: result } };
        },
    );
    render(CollaborationReviewModal, { artistId, onclose: vi.fn(), onchanged: vi.fn() });
    await screen.findByText(m.collaboration_suggestions());
    for (const name of ['Aria', 'Nora']) {
        await fireEvent.input(
            screen.getByRole('textbox', { name: m.collaboration_search_artist() }),
            { target: { value: name } },
        );
        await fireEvent.click(screen.getByRole('button', { name: m.collaboration_search() }));
        await fireEvent.click(await screen.findByRole('button', { name }));
    }
    await fireEvent.click(screen.getByRole('button', { name: m.collaboration_preview() }));
    await screen.findByText(m.collaboration_reason_locked());
    expect(
        (screen.getByRole('button', { name: m.collaboration_confirm() }) as HTMLButtonElement)
            .disabled,
    ).toBe(true);
    expect(mocks.review.mock.calls.some((call) => call[1].action === 'apply')).toBe(false);
});

it('keeps dismissed tracks automatically when finishing a resolved cleanup', async () => {
    mocks.review.mockImplementation(
        async (
            _id: string,
            request: { action: string; members?: CollaborationPreviewResult['members'] },
        ) => {
            if (request.action === 'apply')
                return {
                    data: {
                        action: 'apply',
                        result: { changedTracks: 0, unchangedAlbums: 1, reviewed: true },
                    },
                };
            const result = preview(request.members ?? []);
            if (result.tracks.length) {
                result.tracks[0].status = 'already-resolved';
                result.tracks.push({
                    ...result.tracks[0],
                    id: '77777777-7777-4777-8777-777777777777',
                    title: 'Hidden take',
                    status: 'abstain',
                    reason: 'dismissed',
                    before: [],
                    after: [],
                    reviewSnapshot: null,
                });
            }
            return { data: { action: 'preview', preview: result } };
        },
    );
    const changed = vi.fn();
    render(CollaborationReviewModal, { artistId, onclose: vi.fn(), onchanged: changed });
    await screen.findByText(m.collaboration_suggestions());
    for (const name of ['Aria', 'Nora']) {
        await fireEvent.input(
            screen.getByRole('textbox', { name: m.collaboration_search_artist() }),
            { target: { value: name } },
        );
        await fireEvent.click(screen.getByRole('button', { name: m.collaboration_search() }));
        await fireEvent.click(await screen.findByRole('button', { name }));
    }
    await fireEvent.click(screen.getByRole('button', { name: m.collaboration_preview() }));
    await fireEvent.click(screen.getByRole('button', { name: m.collaboration_confirm() }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(mocks.review.mock.calls.find((call) => call[1].action === 'apply')?.[1]).toMatchObject({
        trackIds: [],
    });
});

it('ignores a late preview after the selected members change', async () => {
    render(CollaborationReviewModal, { artistId, onclose: vi.fn(), onchanged: vi.fn() });
    await screen.findByText(m.collaboration_suggestions());
    for (const name of ['Aria', 'Nora']) {
        await fireEvent.input(
            screen.getByRole('textbox', { name: m.collaboration_search_artist() }),
            { target: { value: name } },
        );
        await fireEvent.click(screen.getByRole('button', { name: m.collaboration_search() }));
        await fireEvent.click(await screen.findByRole('button', { name }));
    }
    let finish: (value: unknown) => void = () => {
        throw new Error('No pending preview');
    };
    const pending = new Promise((resolve) => {
        finish = resolve;
    });
    mocks.review.mockReturnValueOnce(pending);
    await fireEvent.click(screen.getByRole('button', { name: m.collaboration_preview() }));
    await fireEvent.click(screen.getAllByRole('button', { name: m.collaboration_move_down() })[0]);
    finish({
        data: {
            action: 'preview',
            preview: preview([
                { id: ids[0], name: 'Aria' },
                { id: ids[1], name: 'Nora' },
            ]),
        },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('heading', { name: m.collaboration_impact() })).toBeNull();
});

it('preserves actionable server conflict details instead of replacing them with a generic error', async () => {
    const changed = vi.fn();
    render(CollaborationReviewModal, { artistId, onclose: vi.fn(), onchanged: changed });
    await screen.findByText(m.collaboration_suggestions());
    for (const name of ['Aria', 'Nora']) {
        await fireEvent.input(
            screen.getByRole('textbox', { name: m.collaboration_search_artist() }),
            { target: { value: name } },
        );
        await fireEvent.click(screen.getByRole('button', { name: m.collaboration_search() }));
        await fireEvent.click(await screen.findByRole('button', { name }));
    }
    await fireEvent.click(screen.getByRole('button', { name: m.collaboration_preview() }));
    await screen.findByRole('checkbox', { name: m.collaboration_select_track({ title: 'Duet' }) });
    const detail = 'Scanner is reviewing collaborations. Retry with a fresh preview.';
    mocks.review.mockResolvedValueOnce({ data: null, error: detail, status: 409 });
    await fireEvent.click(screen.getByRole('button', { name: m.collaboration_confirm() }));
    expect(await screen.findByText(detail)).toBeTruthy();
    expect(changed).not.toHaveBeenCalled();
});

it('refreshes the parent queue immediately after a save before loading the next preview', async () => {
    const changed = vi.fn();
    render(CollaborationReviewModal, { artistId, onclose: vi.fn(), onchanged: changed });
    await screen.findByText(m.collaboration_suggestions());
    for (const name of ['Aria', 'Nora']) {
        await fireEvent.input(
            screen.getByRole('textbox', { name: m.collaboration_search_artist() }),
            { target: { value: name } },
        );
        await fireEvent.click(screen.getByRole('button', { name: m.collaboration_search() }));
        await fireEvent.click(await screen.findByRole('button', { name }));
    }
    await fireEvent.click(screen.getByRole('button', { name: m.collaboration_preview() }));
    await screen.findByRole('checkbox', { name: m.collaboration_select_track({ title: 'Duet' }) });
    let finish: (value: unknown) => void = () => {
        throw new Error('No pending refresh');
    };
    const pending = new Promise((resolve) => {
        finish = resolve;
    });
    mocks.review
        .mockResolvedValueOnce({
            data: {
                action: 'apply',
                result: { changedTracks: 1, unchangedAlbums: 1, reviewed: false },
            },
        })
        .mockReturnValueOnce(pending);
    await fireEvent.click(screen.getByRole('button', { name: m.collaboration_confirm() }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getAllByRole('button', { name: m.collaboration_move_down() })[0]);
    finish({
        data: {
            action: 'preview',
            preview: preview([
                { id: ids[0], name: 'Aria' },
                { id: ids[1], name: 'Nora' },
            ]),
        },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changed).toHaveBeenCalledOnce();
});

it('shows a confirmed zero-track save immediately while the parent refresh is pending', async () => {
    let applied = false;
    mocks.review.mockImplementation(
        async (
            _id: string,
            request: { action: string; members?: CollaborationPreviewResult['members'] },
        ) => {
            if (request.action === 'apply') {
                applied = true;
                return {
                    data: {
                        action: 'apply',
                        result: { changedTracks: 0, unchangedAlbums: 1, reviewed: true },
                    },
                };
            }
            const result = preview(request.members ?? []);
            result.reviewed = applied;
            for (const row of result.tracks) row.status = 'already-resolved';
            return { data: { action: 'preview', preview: result } };
        },
    );
    let finish: () => void = () => {
        throw new Error('No pending refresh');
    };
    const pending = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const changed = vi.fn(() => pending);
    render(CollaborationReviewModal, { artistId, onclose: vi.fn(), onchanged: changed });
    await screen.findByText(m.collaboration_suggestions());
    for (const name of ['Aria', 'Nora']) {
        await fireEvent.input(
            screen.getByRole('textbox', { name: m.collaboration_search_artist() }),
            { target: { value: name } },
        );
        await fireEvent.click(screen.getByRole('button', { name: m.collaboration_search() }));
        await fireEvent.click(await screen.findByRole('button', { name }));
    }
    await fireEvent.click(screen.getByRole('button', { name: m.collaboration_preview() }));
    await fireEvent.click(screen.getByRole('button', { name: m.collaboration_confirm() }));
    try {
        await waitFor(() => expect(changed).toHaveBeenCalledOnce());
        expect(await screen.findByText(m.collaboration_review_saved())).toBeTruthy();
        expect(screen.queryByRole('button', { name: m.collaboration_review_changes() })).toBeNull();
    } finally {
        finish();
    }
    await screen.findByRole('button', { name: m.collaboration_return_queue() });
});
