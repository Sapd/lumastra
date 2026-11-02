// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import BackupGroupEditor from './BackupGroupEditor.svelte';
import type * as SvelteModule from 'svelte';

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

// SvelteSet is not available in happy-dom; provide a Set-based polyfill
vi.mock('svelte', async (importOriginal) => {
    const mod = await importOriginal<typeof SvelteModule>();
    return {
        ...mod,
        SvelteSet: class SvelteSet<T> extends Set<T> {
            constructor(iterable?: Iterable<T>) {
                super(iterable);
            }
        },
    };
});

const mockToastError = vi.fn();

vi.mock('$lib/stores/toast.store.js', () => ({
    toasts: {
        error: (...args: unknown[]) => mockToastError(...args),
        success: vi.fn(),
    },
}));

vi.mock('$lib/paraglide/messages.js', async (importOriginal) => ({
    // Real messages for everything the filters added; fixed texts the tests below match.
    ...(await importOriginal<Record<string, unknown>>()),
    admin_livetv_backup_groups: () => 'Backup Groups',
    admin_livetv_backup_groups_description: () =>
        'Review and adjust auto-detected channel groupings',
    admin_livetv_backup_group_primary: () => 'Primary',
    admin_livetv_backup_group_remove: () => 'Remove from group',
    admin_livetv_backup_group_split: () => 'Split selected into new group',
    admin_livetv_backup_group_split_short: () => 'Split',
    admin_livetv_backup_group_create: () => 'Group selected channels',
    admin_livetv_backup_group_add_to: () => 'Add to group',
    admin_livetv_backup_group_ungrouped: () => 'Ungrouped Channels',
    admin_livetv_backup_group_empty: () => 'No backup groups detected',
    admin_livetv_backup_group_save_error: () => 'Failed to update backup group',
    admin_livetv_backup_group_min_channels: () => 'Select at least 2 channels',
    admin_livetv_backup_group_cancel: () => 'Cancel',
    admin_livetv_backup_group_hidden: () => 'Hidden',
    admin_livetv_backup_group_select_to_split: ({ count }: { count: string }) =>
        `Select channels to split (${count} selected)`,
    admin_livetv_backup_group_new_group: () => 'New Group',
}));

// apiGet, apiPost, apiDelete mocks
const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
const mockApiDelete = vi.fn();
const mockApiPut = vi.fn();

vi.mock('$lib/api/client.js', () => ({
    apiGet: (...args: unknown[]) => mockApiGet(...args),
    apiPost: (...args: unknown[]) => mockApiPost(...args),
    apiDelete: (...args: unknown[]) => mockApiDelete(...args),
    apiPut: (...args: unknown[]) => mockApiPut(...args),
}));

// Schema mocks — pass through real schemas
vi.mock('$lib/schemas/livetv.js', () => ({
    BackupGroupsAdminResponseSchema: {},
    BackupGroupMemberSchema: {},
    BackupGroupSchema: {},
    ChannelUpdatedResponseSchema: {},
    SetGroupsOnAirResponseSchema: {},
    LiveTvAckResponseSchema: {},
}));

// --- Test data ---

const makeGroup = (
    overrides: Partial<{
        id: string;
        name: string;
        primaryChannelId: string;
        channels: Array<{
            id: string;
            name: string;
            qualityTier?: string;
            isVisible: boolean;
            adminDisplayName?: string;
            health?: Record<string, unknown>;
        }>;
    }> = {},
) => ({
    id: 'group-1',
    name: 'WBN',
    primaryChannelId: 'ch-1',
    channels: [
        { id: 'ch-1', name: 'WBN One HD', qualityTier: 'hd', isVisible: true },
        { id: 'ch-2', name: 'WBN One SD', qualityTier: 'sd', isVisible: true },
    ],
    ...overrides,
});

const defaultApiResponse = {
    data: {
        groups: [makeGroup()],
        ungroupedChannels: [
            {
                id: 'ch-3',
                name: 'Standalone Channel',
                qualityTier: 'fhd',
                isVisible: true,
            },
        ],
    },
    error: null,
};

// --- Tests ---

describe('BackupGroupEditor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockApiGet.mockResolvedValue(defaultApiResponse);
    });

    test('renders groups with member channels after loading', async () => {
        render(BackupGroupEditor);

        // Wait for data to load
        expect(await screen.findByText('WBN')).toBeTruthy();
        expect(screen.getByText('WBN One HD')).toBeTruthy();
        expect(screen.getByText('WBN One SD')).toBeTruthy();
        expect(screen.getByText('2 feeds')).toBeTruthy();
    });

    test('renders ungrouped channels section', async () => {
        render(BackupGroupEditor);

        expect(await screen.findByText('Ungrouped Channels')).toBeTruthy();
        expect(screen.getByText('Standalone Channel')).toBeTruthy();
    });

    test('renders quality badges for channels', async () => {
        render(BackupGroupEditor);

        await screen.findByText('WBN');
        expect(screen.getByText('HD')).toBeTruthy();
        expect(screen.getByText('SD')).toBeTruthy();
        expect(screen.getByText('FHD')).toBeTruthy();
    });

    test('shows empty state when no groups or channels', async () => {
        mockApiGet.mockResolvedValue({
            data: { groups: [], ungroupedChannels: [] },
            error: null,
        });

        render(BackupGroupEditor);

        expect(await screen.findByText('No backup groups detected')).toBeTruthy();
    });

    test('shows error toast when API fails to load', async () => {
        mockApiGet.mockResolvedValue({
            data: null,
            error: { message: 'Network error' },
        });

        render(BackupGroupEditor);

        // Wait for effect to run
        await vi.waitFor(() => {
            expect(mockToastError).toHaveBeenCalledWith({
                message: 'Network error',
            });
        });
    });

    test('remove button calls API and removes channel from list', async () => {
        const user = userEvent.setup();
        mockApiDelete.mockResolvedValue({ error: null });

        render(BackupGroupEditor);

        await screen.findByText('WBN');

        // Find remove buttons (X icons)
        const removeButtons = screen.getAllByTitle('Remove from group');
        expect(removeButtons).toHaveLength(2);

        await user.click(removeButtons[0]);

        expect(mockApiDelete).toHaveBeenCalledWith(
            '/api/admin/livetv/backup-groups/group-1/channels',
            expect.anything(),
            { channelId: 'ch-1' },
        );
    });

    test('remove error rolls back and shows toast', async () => {
        const user = userEvent.setup();
        mockApiDelete.mockResolvedValue({
            error: { message: 'Server error' },
        });

        render(BackupGroupEditor);

        await screen.findByText('WBN');

        const removeButtons = screen.getAllByTitle('Remove from group');
        await user.click(removeButtons[1]);

        await vi.waitFor(() => {
            expect(mockToastError).toHaveBeenCalledWith('Failed to update backup group');
        });

        // Channel should still be in the group after rollback
        expect(screen.getByText('WBN One SD')).toBeTruthy();
    });

    test('split mode shows checkboxes and split button', async () => {
        const user = userEvent.setup();

        render(BackupGroupEditor);

        await screen.findByText('WBN');

        // Click the split button on the group header
        const splitButton = screen.getByText('Split');
        await user.click(splitButton);

        // Should show selection UI
        expect(screen.getByText('Select channels to split (0 selected)')).toBeTruthy();
        expect(screen.getByText('Split selected into new group')).toBeTruthy();
        expect(screen.getByText('Cancel')).toBeTruthy();

        // Should show checkboxes
        const checkboxes = screen.getAllByRole('checkbox');
        expect(checkboxes.length).toBeGreaterThanOrEqual(2);
    });

    test('split calls API with selected channel IDs', async () => {
        const user = userEvent.setup();
        mockApiPost.mockResolvedValue({ error: null });
        // After split, reload returns updated data
        mockApiGet
            .mockResolvedValueOnce(defaultApiResponse) // initial load
            .mockResolvedValueOnce({
                // reload after split
                data: {
                    groups: [
                        makeGroup({
                            channels: [
                                {
                                    id: 'ch-1',
                                    name: 'WBN One HD',
                                    qualityTier: 'hd',
                                    isVisible: true,
                                },
                            ],
                        }),
                        makeGroup({
                            id: 'group-2',
                            name: 'WBN One SD',
                            primaryChannelId: 'ch-2',
                            channels: [
                                {
                                    id: 'ch-2',
                                    name: 'WBN One SD',
                                    qualityTier: 'sd',
                                    isVisible: true,
                                },
                            ],
                        }),
                    ],
                    ungroupedChannels: [],
                },
                error: null,
            });

        render(BackupGroupEditor);

        await screen.findByText('WBN');

        // Enter split mode
        const splitButton = screen.getByText('Split');
        await user.click(splitButton);

        // Select second channel
        const checkboxes = screen.getAllByRole('checkbox');
        await user.click(checkboxes[1]); // select WBN One SD

        // Click "Split selected into new group"
        const confirmSplit = screen.getByText('Split selected into new group');
        await user.click(confirmSplit);

        expect(mockApiPost).toHaveBeenCalledWith(
            '/api/admin/livetv/backup-groups/group-1/split',
            expect.anything(),
            { channelIds: ['ch-2'] },
        );
    });

    test('create group from ungrouped channels requires min 2', async () => {
        render(BackupGroupEditor);

        await screen.findByText('Ungrouped Channels');

        // The "Group selected channels" button should exist
        const createBtn = screen.getByText('Group selected channels');
        expect(createBtn).toBeTruthy();
    });

    test('create group calls API with selected channel IDs', async () => {
        const user = userEvent.setup();
        mockApiPost.mockResolvedValue({ error: null });
        mockApiGet
            .mockResolvedValueOnce({
                data: {
                    groups: [],
                    ungroupedChannels: [
                        {
                            id: 'ch-a',
                            name: 'Channel A',
                            qualityTier: 'hd',
                            isVisible: true,
                        },
                        {
                            id: 'ch-b',
                            name: 'Channel B',
                            qualityTier: 'sd',
                            isVisible: true,
                        },
                    ],
                },
                error: null,
            })
            .mockResolvedValueOnce({
                data: {
                    groups: [
                        makeGroup({
                            id: 'new-group',
                            name: 'Channel A',
                            primaryChannelId: 'ch-a',
                            channels: [
                                {
                                    id: 'ch-a',
                                    name: 'Channel A',
                                    qualityTier: 'hd',
                                    isVisible: true,
                                },
                                {
                                    id: 'ch-b',
                                    name: 'Channel B',
                                    qualityTier: 'sd',
                                    isVisible: true,
                                },
                            ],
                        }),
                    ],
                    ungroupedChannels: [],
                },
                error: null,
            });

        render(BackupGroupEditor);

        await screen.findByText('Channel A');

        // Enter create mode
        const createButton = screen.getByText('Group selected channels');
        await user.click(createButton);

        // Select both channels
        const checkboxes = screen.getAllByRole('checkbox');
        await user.click(checkboxes[0]);
        await user.click(checkboxes[1]);

        // Find the create confirmation button (second "Group selected channels")
        const confirmButtons = screen.getAllByText('Group selected channels');
        const confirmBtn = confirmButtons[confirmButtons.length - 1];
        await user.click(confirmBtn);

        expect(mockApiPost).toHaveBeenCalledWith(
            '/api/admin/livetv/backup-groups',
            expect.anything(),
            { channelIds: expect.arrayContaining(['ch-a', 'ch-b']) },
        );
    });

    test('add-to-group dropdown shows existing groups', async () => {
        const user = userEvent.setup();

        render(BackupGroupEditor);

        await screen.findByText('Ungrouped Channels');

        // Find the add button for the ungrouped channel
        const addButtons = screen.getAllByTitle('Add to group');
        expect(addButtons).toHaveLength(1);

        await user.click(addButtons[0]);

        // Dropdown should show the existing group name
        // The dropdown contains group buttons
        const dropdown = screen.getByRole('dialog', { name: 'Add to group' });
        expect(within(dropdown).getByRole('option', { name: /WBN/ })).toBeTruthy();
    });

    test('add-to-group calls API and moves channel', async () => {
        const user = userEvent.setup();
        mockApiPost.mockResolvedValue({ error: null });

        render(BackupGroupEditor);

        await screen.findByText('Ungrouped Channels');

        // Open dropdown
        const addButtons = screen.getAllByTitle('Add to group');
        await user.click(addButtons[0]);

        // Click group name in dropdown
        const dropdown = screen.getByRole('dialog', { name: 'Add to group' });
        await user.click(within(dropdown).getByRole('option', { name: /WBN/ }));

        expect(mockApiPost).toHaveBeenCalledWith(
            '/api/admin/livetv/backup-groups/group-1/channels',
            expect.anything(),
            { channelId: 'ch-3' },
        );
    });

    test('"Make primary" moves the star and saves', async () => {
        const user = userEvent.setup();
        mockApiPut.mockResolvedValue({ data: { ok: true }, error: null });
        render(BackupGroupEditor);
        // One group: shown expanded.
        await screen.findByText('WBN One SD');

        await user.click(screen.getByRole('button', { name: 'Make WBN One SD the primary' }));
        expect(mockApiPut).toHaveBeenCalledWith(
            '/api/admin/livetv/backup-groups/group-1/primary',
            expect.anything(),
            { channelId: 'ch-2' },
        );
        // The former primary now offers the button instead.
        expect(screen.getByRole('button', { name: 'Make WBN One HD the primary' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Make WBN One SD the primary' })).toBeNull();
    });

    test('marks the feed viewers get and hides a feed with its eye', async () => {
        const user = userEvent.setup();
        mockApiPut.mockResolvedValue({ data: { success: true }, error: null });
        render(BackupGroupEditor);
        await screen.findByText('WBN One SD');

        const primaryRow = document.querySelector('[data-channel-id="ch-1"]') as HTMLElement;
        expect(within(primaryRow).getByText('On air')).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Hide WBN One HD' }));
        expect(mockApiPut).toHaveBeenCalledWith(
            '/api/admin/livetv/channels/ch-1',
            expect.anything(),
            { isVisible: false },
        );
        // The primary is hidden now: viewers get the SD feed, and the group says so.
        const sdRow = document.querySelector('[data-channel-id="ch-2"]') as HTMLElement;
        expect(within(sdRow).getByText('On air')).toBeTruthy();
        expect(screen.getByText('Primary hidden')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Show WBN One HD' })).toBeTruthy();
    });

    test('a hidden primary is fixed in one click: the on-air feed becomes primary', async () => {
        const user = userEvent.setup();
        mockApiGet.mockResolvedValue({
            data: {
                groups: [
                    makeGroup({
                        channels: [
                            { id: 'ch-1', name: 'WBN One HD', qualityTier: 'hd', isVisible: false },
                            { id: 'ch-2', name: 'WBN One SD', qualityTier: 'sd', isVisible: true },
                        ],
                    }),
                ],
                ungroupedChannels: [],
            },
            error: null,
        });
        mockApiPut.mockResolvedValue({ data: { ok: true }, error: null });
        render(BackupGroupEditor);
        await screen.findByText('Primary hidden');

        await user.click(screen.getByRole('button', { name: 'Make the on-air feed primary' }));
        expect(mockApiPut).toHaveBeenCalledWith(
            '/api/admin/livetv/backup-groups/group-1/primary',
            expect.anything(),
            { channelId: 'ch-2' },
        );
        expect(screen.queryByText('Primary hidden')).toBeNull();
    });

    test('"Make on-air feeds primary" fixes every group with a hidden primary', async () => {
        const user = userEvent.setup();
        const hiddenPrimary = (id: string) =>
            makeGroup({
                id,
                name: id,
                primaryChannelId: `${id}-a`,
                channels: [
                    { id: `${id}-a`, name: `${id} A`, isVisible: false },
                    { id: `${id}-b`, name: `${id} B`, isVisible: true },
                ],
            });
        mockApiGet.mockResolvedValue({
            data: { groups: [hiddenPrimary('g1'), hiddenPrimary('g2')], ungroupedChannels: [] },
            error: null,
        });
        mockApiPut.mockResolvedValue({ data: { ok: true }, error: null });
        render(BackupGroupEditor);

        await user.click(
            await screen.findByRole('button', { name: 'Make on-air feeds primary (2)' }),
        );
        expect(mockApiPut).toHaveBeenCalledTimes(2);
        expect(mockApiPut).toHaveBeenCalledWith(
            '/api/admin/livetv/backup-groups/g2/primary',
            expect.anything(),
            { channelId: 'g2-b' },
        );
        expect(screen.queryByText('Primary hidden')).toBeNull();
    });

    test('a station goes off air and back on in one request each', async () => {
        const user = userEvent.setup();
        mockApiPut.mockResolvedValue({ data: { ok: true, groups: 1 }, error: null });
        render(BackupGroupEditor);
        await screen.findByText('WBN One SD');

        await user.click(screen.getByRole('button', { name: 'Take WBN off air' }));
        expect(mockApiPut).toHaveBeenLastCalledWith(
            '/api/admin/livetv/backup-groups/visibility',
            expect.anything(),
            { groupIds: ['group-1'], onAir: false },
        );
        expect(screen.getByRole('button', { name: 'Show WBN One HD' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Show WBN One SD' })).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Put WBN on air' }));
        expect(mockApiPut).toHaveBeenLastCalledWith(
            '/api/admin/livetv/backup-groups/visibility',
            expect.anything(),
            { groupIds: ['group-1'], onAir: true },
        );
        // Only the primary comes back on air, the other feed stays hidden.
        expect(screen.getByRole('button', { name: 'Hide WBN One HD' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Show WBN One SD' })).toBeTruthy();
    });

    test('taking a station off air rolls back when the save fails', async () => {
        const user = userEvent.setup();
        mockApiPut.mockResolvedValue({ data: null, error: 'boom' });
        render(BackupGroupEditor);
        await screen.findByText('WBN One SD');

        await user.click(screen.getByRole('button', { name: 'Take WBN off air' }));
        expect(mockToastError).toHaveBeenCalledWith('Failed to update backup group');
        expect(screen.getByRole('button', { name: 'Hide WBN One HD' })).toBeTruthy();
    });

    test('"Make primary" rolls back when the save fails', async () => {
        const user = userEvent.setup();
        mockApiPut.mockResolvedValue({ data: null, error: 'boom' });
        render(BackupGroupEditor);
        // One group: shown expanded.
        await screen.findByText('WBN One SD');

        await user.click(screen.getByRole('button', { name: 'Make WBN One SD the primary' }));
        expect(mockToastError).toHaveBeenCalledWith('Failed to update backup group');
        expect(screen.getByRole('button', { name: 'Make WBN One SD the primary' })).toBeTruthy();
    });

    // =====================================================================
    // A large lineup: ~1,200 groups, ~9,000 ungrouped channels on prod
    // =====================================================================

    type Member = {
        id: string;
        name: string;
        isVisible: boolean;
        qualityTier?: string;
        categoryId?: string;
        categoryName?: string;
        countryCode?: string;
    };
    const feed = (id: string, extra: Partial<Member> = {}): Member => ({
        id,
        name: id,
        isVisible: true,
        categoryId: 'news',
        categoryName: 'News',
        countryCode: 'DE',
        ...extra,
    });

    function largeLineup(): typeof defaultApiResponse {
        const groups = Array.from({ length: 120 }, (_, i) => {
            const n = String(i).padStart(3, '0');
            return {
                id: `g-${n}`,
                name: `Station ${n}`,
                primaryChannelId: `g-${n}-a`,
                channels: [feed(`g-${n}-a`), feed(`g-${n}-b`)],
            };
        });
        // Primary hidden, another feed visible; feeds of two countries.
        groups.push({
            id: 'g-pro',
            name: 'Siebenstern',
            primaryChannelId: 'pro-fhd',
            channels: [
                feed('pro-fhd', { isVisible: false, categoryId: 'movies', categoryName: 'Movies' }),
                feed('pro-plus', {
                    categoryId: 'movies',
                    categoryName: 'Movies',
                    countryCode: 'AT',
                }),
            ],
        });
        const ungrouped = Array.from({ length: 250 }, (_, i) => feed(`u-${i}`));
        return { data: { groups, ungroupedChannels: ungrouped }, error: null } as never;
    }

    const groupNames = (): string[] =>
        [...document.querySelectorAll('span.font-medium')].map((el) => el.textContent ?? '');
    const ungroupedRows = (): number => document.querySelectorAll('[data-channel-id^="u-"]').length;

    test('renders groups and ungrouped channels a page at a time', async () => {
        const user = userEvent.setup();
        mockApiGet.mockResolvedValue(largeLineup());
        render(BackupGroupEditor);
        await screen.findByText('Station 000');

        expect(groupNames()).toHaveLength(50);
        expect(ungroupedRows()).toBe(100);
        expect(screen.getByText('121 of 121 groups')).toBeTruthy();

        await user.click(screen.getByRole('button', { name: /71 remaining/ }));
        expect(groupNames()).toHaveLength(100);
        await user.click(screen.getByRole('button', { name: /150 remaining/ }));
        expect(ungroupedRows()).toBe(200);
    });

    test('search finds a group by the name of one of its feeds', async () => {
        const user = userEvent.setup();
        mockApiGet.mockResolvedValue(largeLineup());
        render(BackupGroupEditor);
        await screen.findByText('Station 000');

        await user.type(screen.getByRole('searchbox'), 'pro-plus');
        expect(groupNames()).toEqual(['Siebenstern']);
        expect(screen.getByText('1 of 121 groups')).toBeTruthy();
        // The ungrouped list is searched too.
        expect(ungroupedRows()).toBe(0);
    });

    test('"Problems only" lists the group whose primary is hidden and that mixes countries', async () => {
        const user = userEvent.setup();
        mockApiGet.mockResolvedValue(largeLineup());
        render(BackupGroupEditor);
        await screen.findByText('Station 000');

        await user.click(screen.getByRole('checkbox', { name: /Problems only \(1\)/ }));
        expect(groupNames()).toEqual(['Siebenstern']);
        const problems = [...document.querySelectorAll('[data-problem]')].map((el) =>
            el.getAttribute('data-problem'),
        );
        expect(problems).toEqual(['primary-hidden', 'mixed-countries']);
    });

    test('category and country filters narrow the groups', async () => {
        const user = userEvent.setup();
        mockApiGet.mockResolvedValue(largeLineup());
        render(BackupGroupEditor);
        await screen.findByText('Station 000');

        await user.selectOptions(
            screen.getByRole('combobox', { name: 'All categories' }),
            'movies',
        );
        expect(groupNames()).toEqual(['Siebenstern']);
        await user.click(screen.getByRole('button', { name: 'Reset filters' }));
        await user.selectOptions(screen.getByRole('combobox', { name: 'All countries' }), 'AT');
        expect(groupNames()).toEqual(['Siebenstern']);
    });

    test('bulk off air applies to the filtered groups after a confirm', async () => {
        const user = userEvent.setup();
        mockApiGet.mockResolvedValue(largeLineup());
        mockApiPut.mockResolvedValue({ data: { ok: true, groups: 1 }, error: null });
        render(BackupGroupEditor);
        await screen.findByText('Station 000');

        await user.selectOptions(
            screen.getByRole('combobox', { name: 'All categories' }),
            'movies',
        );
        await user.click(screen.getByRole('button', { name: 'Take 1 groups off air' }));
        expect(mockApiPut).not.toHaveBeenCalled();
        expect(screen.getByRole('alertdialog').textContent).toContain('Take 1 groups off air?');

        await user.click(screen.getByRole('button', { name: 'Confirm' }));
        expect(mockApiPut).toHaveBeenCalledWith(
            '/api/admin/livetv/backup-groups/visibility',
            expect.anything(),
            { groupIds: ['g-pro'], onAir: false },
        );
        expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    test('sorting by most feeds puts the largest group first', async () => {
        const user = userEvent.setup();
        const lineup = largeLineup() as unknown as {
            data: { groups: Array<{ name: string; channels: Member[] }> };
        };
        lineup.data.groups[5].channels.push(feed('extra-1'), feed('extra-2'));
        mockApiGet.mockResolvedValue(lineup);
        render(BackupGroupEditor);
        await screen.findByText('Station 000');

        await user.selectOptions(screen.getByRole('combobox', { name: 'Sort groups' }), 'size');
        expect(groupNames()[0]).toBe('Station 005');
    });
});

describe('BackupGroupEditor feed health', () => {
    const offline = {
        state: 'offline',
        consecutiveFailures: 4,
        lastReason: 'provider_unreachable',
        lastFailureAt: new Date().toISOString(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('shows a badge per unhealthy member and no group summary while one feed is ok', async () => {
        const group = makeGroup({
            channels: [
                { id: 'ch-1', name: 'WBN One HD', isVisible: true, health: offline },
                { id: 'ch-2', name: 'WBN One SD', isVisible: true },
            ],
        });
        mockApiGet.mockResolvedValue({
            data: { groups: [group], ungroupedChannels: [] },
            error: null,
        });
        render(BackupGroupEditor);
        await screen.findByText('WBN');

        expect(screen.getAllByTestId('feed-health-badge')).toHaveLength(1);
        expect(screen.queryByTestId('group-all-offline')).toBeNull();
    });

    test('summarises a group whose members are all offline', async () => {
        const group = makeGroup({
            channels: [
                { id: 'ch-1', name: 'WBN One HD', isVisible: true, health: offline },
                { id: 'ch-2', name: 'WBN One SD', isVisible: true, health: offline },
            ],
        });
        mockApiGet.mockResolvedValue({
            data: { groups: [group], ungroupedChannels: [] },
            error: null,
        });
        render(BackupGroupEditor);
        await screen.findByText('WBN');

        expect(screen.getByTestId('group-all-offline')).toBeTruthy();
    });

    test('Reset posts to the health endpoint and clears the badge', async () => {
        const user = userEvent.setup();
        const group = makeGroup({
            channels: [
                { id: 'ch-1', name: 'WBN One HD', isVisible: true, health: offline },
                { id: 'ch-2', name: 'WBN One SD', isVisible: true },
            ],
        });
        mockApiGet.mockResolvedValue({
            data: { groups: [group], ungroupedChannels: [] },
            error: null,
        });
        mockApiPost.mockResolvedValue({
            data: { state: 'ok', consecutiveFailures: 0 },
            error: null,
        });
        render(BackupGroupEditor);
        await screen.findByText('WBN');

        await user.click(screen.getByRole('button', { name: 'Reset' }));

        expect(mockApiPost).toHaveBeenCalledWith(
            '/api/admin/livetv/channels/ch-1/health/reset',
            expect.anything(),
        );
        expect(screen.queryByTestId('feed-health-badge')).toBeNull();
    });
});
