// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom
import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import EPGMatchReview from './EPGMatchReview.svelte';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';

// structuredClone in happy-dom can't handle Svelte 5 reactive proxies
const originalStructuredClone = globalThis.structuredClone;
globalThis.structuredClone = <T>(obj: T): T => {
    try {
        return originalStructuredClone(obj);
    } catch {
        return JSON.parse(JSON.stringify(obj)) as T;
    }
};

// --- Mocks ---

const mockToastError = vi.fn();

vi.mock('$lib/stores/toast.store.js', () => ({
    toasts: { error: (...args: unknown[]) => mockToastError(...args) },
}));

vi.mock('$lib/paraglide/messages.js', () => ({
    admin_livetv_epg_stats: ({
        matched,
        lowConfidence,
        unmatched,
    }: {
        matched: string;
        lowConfidence: string;
        unmatched: string;
    }) => `${matched} matched · ${lowConfidence} low confidence · ${unmatched} unmatched`,
    admin_livetv_epg_filter_all: () => 'All',
    admin_livetv_epg_filter_low_confidence: () => 'Low Confidence',
    admin_livetv_epg_filter_unmatched: () => 'Unmatched',
    admin_livetv_epg_confidence_high: () => 'High confidence',
    admin_livetv_epg_confidence_medium: () => 'Low confidence',
    admin_livetv_epg_unmatched: () => 'Unmatched',
    admin_livetv_epg_confidence_manual: () => 'Manual',
    admin_livetv_epg_confidence_stale: () => 'EPG source removed',
    admin_livetv_epg_current_program: () => 'Now',
    admin_livetv_epg_unmatch: () => 'Remove match',
    admin_livetv_epg_search_placeholder: () => 'Search EPG channels...',
    admin_livetv_epg_no_results: () => 'No EPG channels found',
    admin_livetv_epg_save_error: () => 'Failed to update EPG match',
}));

const mockApiGet = vi.fn();
const mockApiPut = vi.fn();

vi.mock('$lib/api/client.js', () => ({
    apiGet: (...args: unknown[]) => mockApiGet(...args),
    apiPut: (...args: unknown[]) => mockApiPut(...args),
}));

vi.mock('$lib/schemas/livetv.js', () => ({
    EpgMatchReviewResponseSchema: {},
    EpgChannelSearchResponseSchema: {},
    ChannelUpdatedResponseSchema: {},
}));

// --- Test data ---

function makeChannel(
    overrides: Partial<{
        id: string;
        name: string;
        adminDisplayName: string;
        images: ImageSet;
        epgChannelId: string;
        epgDisplayName: string;
        confidenceLevel: string;
        confidenceScore: number;
        matchSignals: string[];
        isManualOverride: boolean;
        categoryName: string;
        currentProgram: { title: string; startTime: string; endTime: string };
    }> = {},
) {
    return {
        id: 'ch-1',
        name: 'WBN One',
        images: {},
        confidenceLevel: 'high' as const,
        isManualOverride: false,
        ...overrides,
    };
}

const defaultApiResponse = {
    data: {
        channels: [
            makeChannel({
                id: 'ch-1',
                name: 'WBN One',
                epgChannelId: 'wbn1',
                epgDisplayName: 'WBN One HD',
                confidenceLevel: 'high',
                confidenceScore: 0.95,
                isManualOverride: false,
            }),
            makeChannel({
                id: 'ch-2',
                name: 'Siebenstern',
                epgChannelId: 'stern7',
                epgDisplayName: 'Siebenstern',
                confidenceLevel: 'medium',
                confidenceScore: 0.65,
                isManualOverride: false,
            }),
            makeChannel({
                id: 'ch-3',
                name: 'Unknown Channel',
                confidenceLevel: 'unmatched',
                isManualOverride: false,
            }),
        ],
        stats: {
            total: 3,
            matched: 2,
            unmatched: 1,
            lowConfidence: 1,
            manualOverrides: 0,
        },
    },
    error: null,
};

// --- Tests ---

describe('EPGMatchReview', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockApiGet.mockResolvedValue(defaultApiResponse);
    });

    test('renders channels with names after loading', async () => {
        render(EPGMatchReview);

        expect(await screen.findByText('WBN One')).toBeTruthy();
        expect(screen.getByText('Siebenstern')).toBeTruthy();
        expect(screen.getByText('Unknown Channel')).toBeTruthy();
    });

    test('renders confidence badges with correct labels', async () => {
        render(EPGMatchReview);

        await screen.findByText('WBN One');
        expect(screen.getByText('High confidence')).toBeTruthy();
        expect(screen.getByText('Low confidence')).toBeTruthy();
        // "Unmatched" appears in both filter tab and confidence badge
        const unmatchedElements = screen.getAllByText('Unmatched');
        expect(unmatchedElements.length).toBeGreaterThanOrEqual(2);
    });

    test('renders stats bar', async () => {
        render(EPGMatchReview);

        expect(await screen.findByText('2 matched · 1 low confidence · 1 unmatched')).toBeTruthy();
    });

    test('renders filter tabs', async () => {
        render(EPGMatchReview);

        await screen.findByText('WBN One');
        expect(screen.getByText('All')).toBeTruthy();
        expect(screen.getByText('Low Confidence')).toBeTruthy();
        // "Unmatched" appears both as filter tab and confidence badge
        const unmatchedElements = screen.getAllByText('Unmatched');
        expect(unmatchedElements.length).toBeGreaterThanOrEqual(2);
    });

    test('renders EPG display name for matched channels', async () => {
        render(EPGMatchReview);

        await screen.findByText('WBN One');
        expect(screen.getByText('EPG: WBN One HD')).toBeTruthy();
        expect(screen.getByText('EPG: Siebenstern')).toBeTruthy();
    });

    test('renders unmatch button for matched channels', async () => {
        render(EPGMatchReview);

        await screen.findByText('WBN One');
        const removeButtons = screen.getAllByTitle('Remove match');
        // 2 matched channels should have unmatch buttons
        expect(removeButtons).toHaveLength(2);
    });

    test('shows error toast when API fails to load', async () => {
        mockApiGet.mockResolvedValue({
            data: null,
            error: { message: 'Network error' },
        });

        render(EPGMatchReview);

        await vi.waitFor(() => {
            expect(mockToastError).toHaveBeenCalledWith({
                message: 'Network error',
            });
        });
    });

    test('shows empty state when no channels', async () => {
        mockApiGet.mockResolvedValue({
            data: {
                channels: [],
                stats: {
                    total: 0,
                    matched: 0,
                    unmatched: 0,
                    lowConfidence: 0,
                    manualOverrides: 0,
                },
            },
            error: null,
        });

        render(EPGMatchReview);

        expect(await screen.findByText('No EPG channels found')).toBeTruthy();
    });

    test('clicking channel row opens search input', async () => {
        const user = userEvent.setup();
        render(EPGMatchReview);

        await screen.findByText('WBN One');

        // Click the first channel row button
        const channelButtons = screen.getAllByRole('button');
        const wbnButton = channelButtons.find((btn) => btn.textContent?.includes('WBN One'));
        expect(wbnButton).toBeTruthy();

        await user.click(wbnButton!);

        expect(screen.getByPlaceholderText('Search EPG channels...')).toBeTruthy();
    });

    test('clicking unmatch button calls API with null', async () => {
        const user = userEvent.setup();
        mockApiPut.mockResolvedValue({ error: null });

        render(EPGMatchReview);

        await screen.findByText('WBN One');

        const removeButtons = screen.getAllByTitle('Remove match');
        await user.click(removeButtons[0]);

        expect(mockApiPut).toHaveBeenCalledWith(
            '/api/admin/livetv/channels/ch-1/epg',
            expect.anything(),
            { epgChannelId: null },
        );
    });

    test('unmatch error shows toast and rolls back', async () => {
        const user = userEvent.setup();
        mockApiPut.mockResolvedValue({
            error: { message: 'Server error' },
        });

        render(EPGMatchReview);

        await screen.findByText('WBN One');

        const removeButtons = screen.getAllByTitle('Remove match');
        await user.click(removeButtons[0]);

        await vi.waitFor(() => {
            expect(mockToastError).toHaveBeenCalledWith('Failed to update EPG match');
        });

        // Channel should still show as matched after rollback
        expect(screen.getByText('EPG: WBN One HD')).toBeTruthy();
    });

    test('filter tab click re-fetches data with filter param', async () => {
        const user = userEvent.setup();
        render(EPGMatchReview);

        await screen.findByText('WBN One');

        // Initial load called with 'all' filter
        expect(mockApiGet).toHaveBeenCalledWith(
            expect.stringContaining('filter=all'),
            expect.anything(),
        );

        // Click "Low Confidence" filter
        const unmatchedTab = screen.getAllByText('Unmatched').find((el) => el.tagName === 'BUTTON');
        if (unmatchedTab) {
            await user.click(unmatchedTab);

            await vi.waitFor(() => {
                expect(mockApiGet).toHaveBeenCalledWith(
                    expect.stringContaining('filter=unmatched'),
                    expect.anything(),
                );
            });
        }
    });

    test('search input does not fire API for queries shorter than 2 chars', async () => {
        const user = userEvent.setup();

        // Return search results for search API
        mockApiGet.mockImplementation((url: string) => {
            if (url.includes('/epg/search')) {
                return Promise.resolve({
                    data: { results: [] },
                    error: null,
                });
            }
            return Promise.resolve(defaultApiResponse);
        });

        render(EPGMatchReview);

        await screen.findByText('WBN One');

        // Open search
        const channelButtons = screen.getAllByRole('button');
        const wbnButton = channelButtons.find((btn) => btn.textContent?.includes('WBN One'));
        await user.click(wbnButton!);

        const input = screen.getByPlaceholderText('Search EPG channels...');
        await user.type(input, 'a');

        // Wait a bit — should NOT have called search API
        await new Promise((r) => setTimeout(r, 400));
        const searchCalls = mockApiGet.mock.calls.filter(
            (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('/epg/search'),
        );
        expect(searchCalls).toHaveLength(0);
    });
});
