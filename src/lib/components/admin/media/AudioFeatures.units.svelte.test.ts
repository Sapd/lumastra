// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('$lib/api/admin', () => ({
    updateMediaMetadata: vi.fn(),
    rescanMediaAudioFeatures: vi.fn(),
}));
vi.mock('$app/navigation', () => ({ beforeNavigate: vi.fn() }));
import OverviewTab from './OverviewTab.svelte';
import AudioFeaturesTab from './AudioFeaturesTab.svelte';
afterEach(cleanup);
describe('Essentia danceability units', () => {
    it('shows the 0–3 score and bounded meter in Overview', () => {
        render(OverviewTab, {
            mediaId: 'track',
            title: 'Fictional Dance',
            mediaType: 'track',
            locked: false,
            audioFeatures: { essentia: { danceability: 2.4 } },
        });
        expect(screen.getByText('2.4/3')).toBeTruthy();
        expect(screen.queryByText('240%')).toBeNull();
        const meter = screen.getByRole('meter') as HTMLMeterElement;
        expect(meter.getAttribute('max')).toBe('3');
        expect(meter.getAttribute('aria-valuenow')).toBe('2.4');
    });
    it('shows the same score in Audio Features', () => {
        render(AudioFeaturesTab, {
            mediaId: 'track',
            audioFeatures: { essentia: { danceability: 2.4 } },
        });
        expect(screen.getByText('2.4/3')).toBeTruthy();
        expect(screen.queryByText('240%')).toBeNull();
    });
});
