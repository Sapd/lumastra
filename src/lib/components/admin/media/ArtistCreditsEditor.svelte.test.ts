// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ArtistCreditReview } from '$lib/schemas/music-credit-review.js';
const mocks = vi.hoisted(() => ({
    read: vi.fn(),
    apply: vi.fn(),
    search: vi.fn(),
    page: { url: new URL('http://localhost/') },
}));
vi.mock('$lib/api/music-credits.js', () => ({
    readArtistCredits: mocks.read,
    applyArtistCredits: mocks.apply,
    readMusicEdits: async () => ({ data: { edits: [] } }),
    restoreMusicEdit: vi.fn(),
}));
vi.mock('$lib/api/admin', () => ({ searchArtists: mocks.search }));
vi.mock('$app/state', () => ({ page: mocks.page }));
import ArtistCreditsEditor from './ArtistCreditsEditor.svelte';
const track = '11111111-1111-4111-8111-111111111111';
const album = '22222222-2222-4222-8222-222222222222';
const artist = '33333333-3333-4333-8333-333333333333';
function review(): ArtistCreditReview {
    return {
        track: { id: track, title: 'Keep title', titleSource: 'filename' },
        album: { id: album, title: 'Keep album' },
        albumArtist: { id: album, title: 'Keep owner' },
        protection: { locked: false, lockedBy: null, lockedAt: null },
        credits: [
            {
                id: artist,
                name: 'Canonical Voice',
                creditedAs: 'Raw credit',
                role: 'performer',
                active: true,
            },
        ],
        rawEvidence: { artist: 'Raw credit' },
        snapshot: 'a'.repeat(64),
    };
}
beforeEach(() => {
    mocks.page.url = new URL(
        `http://localhost/admin/library/media/${track}?tracks_q=Needle&tracks_page=2&music_from_album=${album}`,
    );
    mocks.read.mockResolvedValue({ data: { artistCreditReview: review() } });
    mocks.search.mockResolvedValue({ data: { artists: [] } });
});
afterEach(() => {
    cleanup();
    vi.resetAllMocks();
});
async function proposal() {
    await screen.findByDisplayValue('Raw credit');
    await fireEvent.input(screen.getByRole('textbox', { name: 'Credited as' }), {
        target: { value: 'Reviewed credit' },
    });
}
it('saves once without an acknowledgment and verifies the fresh canonical ordered result', async () => {
    const fresh = review();
    fresh.credits[0].creditedAs = 'Reviewed credit';
    fresh.protection = { locked: true, lockedBy: 'admin', lockedAt: '1' };
    mocks.read
        .mockResolvedValueOnce({ data: { artistCreditReview: review() } })
        .mockResolvedValueOnce({ data: { artistCreditReview: fresh } });
    mocks.apply.mockResolvedValue({ data: { locked: true }, status: 200 });
    const saved = vi.fn();
    render(ArtistCreditsEditor, { mediaId: track, refreshKey: '1', onsaved: saved });
    await proposal();
    expect(screen.queryByRole('checkbox')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Save artists and remixers' }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(mocks.apply.mock.calls[0][1].credits[0].creditedAs).toBe('Reviewed credit');
});
it('adopts the final authoritative review after the owner refresh changes refreshKey', async () => {
    const fresh = review();
    fresh.credits[0].creditedAs = 'Reviewed credit';
    fresh.protection = { locked: true, lockedBy: 'admin', lockedAt: '1' };
    mocks.read
        .mockResolvedValueOnce({ data: { artistCreditReview: review() } })
        .mockResolvedValueOnce({ data: { artistCreditReview: fresh } });
    mocks.apply.mockResolvedValue({ data: { locked: true }, status: 200 });
    let mounted: ReturnType<typeof render>;
    const saved = vi.fn(async () => {
        await mounted.rerender({ mediaId: track, refreshKey: '2' });
    });
    mounted = render(ArtistCreditsEditor, {
        mediaId: track,
        refreshKey: '1',
        onsaved: saved,
    });
    await proposal();
    await fireEvent.click(screen.getByRole('button', { name: 'Save artists and remixers' }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect((await screen.findByRole('status')).textContent).toContain('Artist credits saved');
    expect(screen.queryByText(/Track or protection changed/)).toBeNull();
    expect(screen.queryByText(/differs from your proposal/)).toBeNull();
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.apply).toHaveBeenCalledOnce();
});
it('verifies and adopts saved credits when the owner refresh rejects', async () => {
    const fresh = review();
    fresh.credits[0].creditedAs = 'Reviewed credit';
    fresh.protection = { locked: true, lockedBy: 'admin', lockedAt: '1' };
    mocks.read
        .mockResolvedValueOnce({ data: { artistCreditReview: review() } })
        .mockResolvedValueOnce({ data: { artistCreditReview: fresh } });
    mocks.apply.mockResolvedValue({ data: { locked: true }, status: 200 });
    const saved = vi.fn().mockRejectedValue(new Error('owner refresh failed'));
    render(ArtistCreditsEditor, { mediaId: track, refreshKey: '1', onsaved: saved });
    await proposal();

    await fireEvent.click(screen.getByRole('button', { name: 'Save artists and remixers' }));

    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    expect(screen.getByDisplayValue('Reviewed credit')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Artist credits saved');
    expect(screen.getByRole('alert').textContent).toContain('page could not refresh');
    expect(screen.queryByText(/Track or protection changed/)).toBeNull();
    expect(mocks.apply).toHaveBeenCalledOnce();
});
it('retains the proposal and reports changed result instead of falsely claiming exact success', async () => {
    const fresh = review();
    fresh.credits[0].creditedAs = 'Another editor';
    fresh.protection = { locked: true, lockedBy: 'other', lockedAt: '2' };
    mocks.read
        .mockResolvedValueOnce({ data: { artistCreditReview: review() } })
        .mockResolvedValueOnce({ data: { artistCreditReview: fresh } });
    mocks.apply.mockResolvedValue({ data: { locked: true }, status: 200 });
    render(ArtistCreditsEditor, { mediaId: track, refreshKey: '1' });
    await proposal();
    await fireEvent.click(screen.getByRole('button', { name: 'Save artists and remixers' }));
    expect((await screen.findByRole('alert')).textContent).toContain('differs from your proposal');
    expect(screen.getByDisplayValue('Reviewed credit').closest('fieldset')?.disabled).toBe(true);
    expect(mocks.apply).toHaveBeenCalledOnce();
});
it('requires reload after an uncertain network write and preserves music context in ownership navigation', async () => {
    mocks.apply.mockRejectedValue(new Error('network'));
    render(ArtistCreditsEditor, { mediaId: track, refreshKey: '1' });
    await proposal();
    const link = screen.getByRole('link', { name: 'Review album ownership separately' });
    expect(link.getAttribute('href')).toContain('tracks_q=Needle');
    expect(link.getAttribute('href')).toContain('tracks_page=2');
    await fireEvent.click(screen.getByRole('button', { name: 'Save artists and remixers' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Reload');
    expect(screen.getByDisplayValue('Reviewed credit').closest('fieldset')?.disabled).toBe(true);
});
it('keeps a dirty draft when title/lock refresh arrives and fences a prior item load', async () => {
    let resolve!: (value: unknown) => void;
    const late = new Promise((done) => {
        resolve = done;
    });
    mocks.read
        .mockReturnValueOnce(late)
        .mockResolvedValue({ data: { artistCreditReview: review() } });
    const mounted = render(ArtistCreditsEditor, { mediaId: album, refreshKey: '1' });
    await mounted.rerender({ mediaId: track, refreshKey: '2' });
    await screen.findByDisplayValue('Raw credit');
    await fireEvent.input(screen.getByRole('textbox', { name: 'Credited as' }), {
        target: { value: 'Retain draft' },
    });
    await mounted.rerender({ mediaId: track, refreshKey: '3' });
    resolve({
        data: {
            artistCreditReview: {
                ...review(),
                track: { id: album, title: 'Old route', titleSource: null },
            },
        },
    });
    await waitFor(() => expect(screen.getByDisplayValue('Retain draft')).toBeTruthy());
    expect(screen.queryByText('Old route')).toBeNull();
    expect(
        (screen.getByRole('button', { name: 'Save artists and remixers' }) as HTMLButtonElement)
            .disabled,
    ).toBe(true);
});

it('actual ownership link snapshots direct artist page2 filters independently of album edit tab', async () => {
    mocks.page.url = new URL(
        `http://localhost/admin/library/media/${track}?music_from_artist_tracks=${artist}&tracks_q=GuestNeedle&tracks_issue=missing-file&tracks_sort=title&tracks_page=2`,
    );
    render(ArtistCreditsEditor, { mediaId: track, refreshKey: '1' });
    await screen.findByDisplayValue('Raw credit');
    const editor = screen.getByRole('region', { name: 'Artist credits' });
    expect(editor.id).toBe('artist-credits');
    expect(editor.getAttribute('tabindex')).toBe('-1');
    const link = screen.getByRole('link', { name: 'Review album ownership separately' });
    const target = new URL(link.getAttribute('href')!, 'https://example.invalid');
    expect(target.pathname).toContain(album);
    expect(target.searchParams.get('tab')).toBe('overview');
    expect(target.searchParams.get('edit')).toBe('1');
    expect(target.searchParams.get('music_from_artist_tracks')).toBe(artist);
    expect(target.searchParams.get('artist_tracks_q')).toBe('GuestNeedle');
    expect(target.searchParams.get('artist_tracks_issue')).toBe('missing-file');
    expect(target.searchParams.get('artist_tracks_sort')).toBe('title');
    expect(target.searchParams.get('artist_tracks_page')).toBe('2');
    expect(target.searchParams.has('tracks_q')).toBe(false);
});
