// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SetupSummary } from '$lib/schemas/livetv';

vi.mock('$lib/api/livetv', () => ({
    getSetupSummary: vi.fn(),
    applySetupPreferences: vi.fn(),
}));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { error: vi.fn(), success: vi.fn() } }));

const { getSetupSummary, applySetupPreferences } = await import('$lib/api/livetv');
const ImportGuidedSetup = (await import('./ImportGuidedSetup.svelte')).default;

function summary(over: Partial<SetupSummary> = {}): SetupSummary {
    return {
        totalChannels: 100,
        visibleChannels: 100,
        categories: [
            { name: 'Sports', channelCount: 60 },
            { name: 'Adult', channelCount: 40 },
        ],
        qualityDistribution: { uhd: 0, fhd: 10, hd: 90, sd: 0, unknown: 0 },
        detectedRegions: ['adult', 'de', 'religious', 'ro', 'uk'],
        regionalVariantCount: 0,
        regions: [
            { code: 'de', channelCount: 40 },
            { code: 'adult', channelCount: 20 },
            { code: 'ro', channelCount: 20 },
            { code: 'religious', channelCount: 10 },
            { code: 'uk', channelCount: 10 },
        ],
        untaggedChannelCount: 0,
        loopChannelCount: 0,
        ...over,
    };
}

function setLanguages(languages: string[]): void {
    Object.defineProperty(navigator, 'languages', { value: languages, configurable: true });
}

function pressed(name: RegExp): boolean {
    return screen.getByRole('button', { name }).getAttribute('aria-pressed') === 'true';
}

afterEach(cleanup);
beforeEach(() => {
    vi.mocked(getSetupSummary).mockReset();
    vi.mocked(applySetupPreferences)
        .mockReset()
        .mockResolvedValue({
            status: 200,
            data: {
                success: true,
                visibleChannels: 1,
                hiddenChannels: 0,
                categories: 1,
                message: '',
            },
            error: null,
        } as never);
});

describe('ImportGuidedSetup country pre-selection', () => {
    it('pre-selects the browser languages’ countries, never adult or religious', async () => {
        setLanguages(['de-DE', 'en']);
        vi.mocked(getSetupSummary).mockResolvedValue({
            status: 200,
            data: summary(),
            error: null,
        } as never);
        render(ImportGuidedSetup, { props: { sourceId: 's', onComplete: vi.fn() } });

        await waitFor(() =>
            expect(screen.getByRole('button', { name: /Germany|Deutschland/ })).toBeTruthy(),
        );
        expect(pressed(/Germany|Deutschland/)).toBe(true);
        expect(pressed(/United Kingdom|Vereinigtes Königreich/)).toBe(true);
        expect(pressed(/Romania|Rumänien/)).toBe(false);
        expect(pressed(/^Adult|^Erwachsene/)).toBe(false);
        expect(pressed(/^Religious|^Religiös/)).toBe(false);
    });

    it('with no matching language keeps everything except adult and religious', async () => {
        setLanguages(['ja-JP']);
        vi.mocked(getSetupSummary).mockResolvedValue({
            status: 200,
            data: summary(),
            error: null,
        } as never);
        render(ImportGuidedSetup, { props: { sourceId: 's', onComplete: vi.fn() } });

        await waitFor(() =>
            expect(screen.getByRole('button', { name: /Romania|Rumänien/ })).toBeTruthy(),
        );
        expect(pressed(/Romania|Rumänien/)).toBe(true);
        expect(pressed(/^Adult|^Erwachsene/)).toBe(false);
        expect(pressed(/^Religious|^Religiös/)).toBe(false);
    });

    it('prefers the saved setup and drops codes the provider no longer has', async () => {
        setLanguages(['de-DE']);
        vi.mocked(getSetupSummary).mockResolvedValue({
            status: 200,
            data: summary({
                savedSetup: {
                    countries: ['ro', 'gone'],
                    includeUntagged: false,
                    hideLoopChannels: false,
                    hiddenCategories: ['Adult'],
                },
            }),
            error: null,
        } as never);
        render(ImportGuidedSetup, { props: { sourceId: 's', onComplete: vi.fn() } });

        await waitFor(() =>
            expect(screen.getByRole('button', { name: /Romania|Rumänien/ })).toBeTruthy(),
        );
        expect(pressed(/Romania|Rumänien/)).toBe(true);
        expect(pressed(/Germany|Deutschland/)).toBe(false);

        await userEvent.click(screen.getAllByRole('button').at(-1)!);
        await waitFor(() => expect(applySetupPreferences).toHaveBeenCalled());
        expect(vi.mocked(applySetupPreferences).mock.calls[0][1]).toMatchObject({
            countries: ['ro'],
            includeUntagged: false,
            hiddenCategories: ['Adult'],
            // No 24/7 channels in the summary: the hidden switch is not sent as on.
            hideLoopChannels: false,
        });
    });
});

describe('ImportGuidedSetup country chips', () => {
    it('shows a selected country even when it is beyond the preview', async () => {
        setLanguages(['de-DE']);
        const many = Array.from({ length: 30 }, (_, i) => ({
            code: `x${i}`,
            channelCount: 100 - i,
        }));
        vi.mocked(getSetupSummary).mockResolvedValue({
            status: 200,
            data: summary({ regions: [...many, { code: 'ch', channelCount: 3 }] }),
            error: null,
        } as never);
        render(ImportGuidedSetup, { props: { sourceId: 's', onComplete: vi.fn() } });

        await waitFor(() =>
            expect(screen.getByRole('button', { name: /Switzerland|Schweiz/ })).toBeTruthy(),
        );
        expect(pressed(/Switzerland|Schweiz/)).toBe(true);
    });
});

describe('ImportGuidedSetup noise switches', () => {
    const counts = {
        loopChannelCount: 90,
        infoChannelCount: 10,
        eventSlotCount: 800,
        localStationCount: 1100,
        radioChannelCount: 97,
    };

    async function applyWith(over: Partial<SetupSummary>): Promise<Record<string, unknown>> {
        setLanguages(['de-DE']);
        vi.mocked(getSetupSummary).mockResolvedValue({
            status: 200,
            data: summary({ ...counts, ...over }),
            error: null,
        } as never);
        render(ImportGuidedSetup, { props: { sourceId: 's', onComplete: vi.fn() } });
        await waitFor(() => expect(screen.getByText(/1100/)).toBeTruthy());
        await userEvent.click(screen.getAllByRole('button').at(-1)!);
        await waitFor(() => expect(applySetupPreferences).toHaveBeenCalled());
        return vi.mocked(applySetupPreferences).mock.calls[0][1] as Record<string, unknown>;
    }

    it('first run: hides info screens, radio and local stations, keeps event slots', async () => {
        expect(await applyWith({})).toMatchObject({
            hideLoopChannels: true,
            hideInfoChannels: true,
            hideRadio: true,
            hideLocalStations: true,
            hideEventSlots: false,
        });
    });

    it('never sends a switch on whose kind the provider does not have', async () => {
        const prefs = await applyWith({
            infoChannelCount: 0,
            radioChannelCount: 0,
            localStationCount: 1100,
            eventSlotCount: 0,
        });
        expect(prefs).toMatchObject({
            hideInfoChannels: false,
            hideRadio: false,
            hideEventSlots: false,
            hideLocalStations: true,
        });
        expect(screen.queryByText(/Hide radio stations/)).toBeNull();
    });

    it('a setup saved before the switches existed gets their defaults', async () => {
        expect(
            await applyWith({
                savedSetup: {
                    countries: ['de'],
                    includeUntagged: true,
                    hideLoopChannels: false,
                    hiddenCategories: [],
                },
            }),
        ).toMatchObject({
            hideLoopChannels: false,
            hideInfoChannels: true,
            hideRadio: true,
            hideLocalStations: true,
            hideEventSlots: false,
        });
    });

    it('keeps the saved choices of the switches', async () => {
        expect(
            await applyWith({
                savedSetup: {
                    countries: ['de'],
                    includeUntagged: true,
                    hideLoopChannels: true,
                    hideInfoChannels: false,
                    hideEventSlots: true,
                    hideLocalStations: false,
                    hideRadio: false,
                    hiddenCategories: [],
                },
            }),
        ).toMatchObject({
            hideInfoChannels: false,
            hideRadio: false,
            hideLocalStations: false,
            hideEventSlots: true,
        });
    });
});
