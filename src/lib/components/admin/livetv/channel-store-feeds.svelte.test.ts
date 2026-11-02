// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AdminChannel, AdminChannelCategory } from '$lib/schemas/livetv.js';

const apiPut = vi.fn();
vi.mock('$lib/api/client.js', () => ({
    apiPut: (...args: unknown[]) => apiPut(...args),
    apiPost: vi.fn(),
    apiDelete: vi.fn(),
    apiGet: vi.fn(),
}));
const toastError = vi.fn();
vi.mock('$lib/stores/toast.store.js', () => ({
    toasts: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a), info: vi.fn() },
}));

const { ChannelStore } = await import('./channel-store.svelte.js');

const GROUP = 'g-k9';

function feed(id: string, name: string, overrides: Partial<AdminChannel> = {}): AdminChannel {
    return {
        id,
        name,
        images: {},
        isVisible: true,
        sortOrder: 0,
        backupGroupId: GROUP,
        groupPrimaryChannelId: 'fhd',
        ...overrides,
    } as AdminChannel;
}

function seeded(): InstanceType<typeof ChannelStore> {
    const store = new ChannelStore();
    const cats: AdminChannelCategory[] = [
        {
            id: 'de',
            name: 'DE',
            sortOrder: 0,
            isVisible: true,
            channels: [
                feed('mobil', 'Kanal9 (Mobil)', { qualityTier: 'sd', sortOrder: 0 }),
                feed('fhd', 'Kanal9 FHD', { qualityTier: 'fhd', sortOrder: 1 }),
                feed('hd', 'Kanal9 HD', { qualityTier: 'hd', sortOrder: 2, isVisible: false }),
                {
                    id: 'other',
                    name: 'Other',
                    isVisible: true,
                    sortOrder: 3,
                    images: {},
                } as AdminChannel,
            ],
        },
    ];
    store.seed(cats);
    return store;
}

const primaries = (store: InstanceType<typeof ChannelStore>): (string | undefined)[] =>
    store.categories[0].channels.map((ch) => ch.groupPrimaryChannelId);

describe('ChannelStore station feeds', () => {
    beforeEach(() => {
        apiPut.mockReset();
        toastError.mockReset();
    });

    test('groupFeeds lists the group in viewer rank, primary first, degraded last', () => {
        const store = seeded();
        expect(store.groupFeeds('hd').map((f) => f.id)).toEqual(['fhd', 'hd', 'mobil']);
        expect(store.groupFeeds('other')).toEqual([]);
    });

    test('setGroupPrimary updates every member and calls the primary endpoint', async () => {
        apiPut.mockResolvedValue({ data: { ok: true }, error: null });
        const store = seeded();
        await store.setGroupPrimary('hd');
        expect(apiPut).toHaveBeenCalledWith(
            `/api/admin/livetv/backup-groups/${GROUP}/primary`,
            expect.anything(),
            { channelId: 'hd' },
        );
        expect(primaries(store)).toEqual(['hd', 'hd', 'hd', undefined]);
        expect(store.groupFeeds('fhd')[0].id).toBe('hd');
    });

    test('setGroupPrimary rolls back and reports a refusal', async () => {
        apiPut.mockResolvedValue({ data: null, error: 'nope' });
        const store = seeded();
        await store.setGroupPrimary('mobil');
        expect(primaries(store)).toEqual(['fhd', 'fhd', 'fhd', undefined]);
        expect(toastError).toHaveBeenCalledOnce();
    });

    test('setGroupPrimary on the current primary does nothing', async () => {
        const store = seeded();
        await store.setGroupPrimary('fhd');
        expect(apiPut).not.toHaveBeenCalled();
    });
});
