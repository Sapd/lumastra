// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    LiveTvProgramSchema,
    LiveTvAiringSchema,
    LiveTvNowNextSchema,
    LiveTvStationSchema,
    LiveTvChannelSchema,
    LiveTvCategorySchema,
    LiveTvStreamInfoSchema,
    LiveTvSourceSchema,
    LiveTvSourceConfigSchema,
    ReorderChannelsRequestSchema,
    UpdateChannelRequestSchema,
    BulkUpdateChannelsRequestSchema,
    BackupGroupMemberSchema,
    BackupGroupSchema,
    BackupGroupsAdminResponseSchema,
    RemoveFromGroupRequestSchema,
    SplitGroupRequestSchema,
    CreateBackupGroupRequestSchema,
    AddToGroupRequestSchema,
    EpgMatchConfidenceLevelSchema,
    CurrentProgramPreviewSchema,
    EpgMatchReviewItemSchema,
    EpgMatchReviewResponseSchema,
    EpgChannelSearchResultSchema,
    EpgChannelSearchResponseSchema,
    UpdateEpgMatchRequestSchema,
    EpgMatchReviewFilterSchema,
    RenameCategoryRequestSchema,
    CreateCategoryRequestSchema,
    CreateCategoryResponseSchema,
    MergeCategoryRequestSchema,
    MergeCategoryResponseSchema,
    CategoryChannelCountResponseSchema,
    StreamLimitActiveChannelSchema,
    StreamLimitErrorResponseSchema,
    StreamFailureErrorSchema,
} from './livetv.js';

describe('LiveTvProgramSchema', () => {
    it('validates a complete program', () => {
        const program = {
            id: '123e4567-e89b-12d3-a456-426614174000',
            stationId: '223e4567-e89b-12d3-a456-426614174000',
            title: 'Evening News',
            description: 'Daily news broadcast',
            startTime: '2026-03-09T18:00:00Z',
            endTime: '2026-03-09T19:00:00Z',
            epgId: 'news-001',
        };
        const result = LiveTvProgramSchema.safeParse(program);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.title).toBe('Evening News');
        }
    });

    it('validates a minimal program (optional fields omitted)', () => {
        const program = {
            id: '123e4567-e89b-12d3-a456-426614174000',
            stationId: '223e4567-e89b-12d3-a456-426614174000',
            title: 'Evening News',
            startTime: '2026-03-09T18:00:00Z',
            endTime: '2026-03-09T19:00:00Z',
        };
        const result = LiveTvProgramSchema.safeParse(program);
        expect(result.success).toBe(true);
    });

    it('rejects program missing required fields', () => {
        const program = {
            id: '123e4567-e89b-12d3-a456-426614174000',
            stationId: '223e4567-e89b-12d3-a456-426614174000',
            // missing title, startTime, endTime
        };
        const result = LiveTvProgramSchema.safeParse(program);
        expect(result.success).toBe(false);
    });
});

describe('LiveTvChannelSchema', () => {
    it('validates a complete channel with current program', () => {
        const channel = {
            id: '323e4567-e89b-12d3-a456-426614174000',
            name: 'WBN One',
            images: {
                primary: { href: 'https://example.com/wbn-one.png', revision: '0', source: 'self' },
            },
            category: 'News',
            categoryId: '423e4567-e89b-12d3-a456-426614174000',
            sortOrder: 1,
            isVisible: true,
            qualityTier: 'hd' as const,
            currentProgram: {
                id: '123e4567-e89b-12d3-a456-426614174000',
                channelId: '323e4567-e89b-12d3-a456-426614174000',
                title: 'Evening News',
                startTime: '2026-03-09T18:00:00Z',
                endTime: '2026-03-09T19:00:00Z',
            },
            backupGroupId: '523e4567-e89b-12d3-a456-426614174000',
            sourceId: '623e4567-e89b-12d3-a456-426614174000',
        };
        const result = LiveTvChannelSchema.safeParse(channel);
        expect(result.success).toBe(true);
    });

    it('validates a minimal channel', () => {
        const channel = {
            id: '323e4567-e89b-12d3-a456-426614174000',
            name: 'WBN One',
            images: {},
            sortOrder: 1,
            isVisible: true,
        };
        const result = LiveTvChannelSchema.safeParse(channel);
        expect(result.success).toBe(true);
    });

    it('rejects invalid quality tier', () => {
        const channel = {
            id: '323e4567-e89b-12d3-a456-426614174000',
            name: 'WBN One',
            images: {},
            sortOrder: 1,
            isVisible: true,
            qualityTier: '4k', // invalid
        };
        const result = LiveTvChannelSchema.safeParse(channel);
        expect(result.success).toBe(false);
    });

    it('rejects channel missing required fields', () => {
        const channel = {
            id: '323e4567-e89b-12d3-a456-426614174000',
            name: 'WBN One',
            // missing sortOrder, isVisible
        };
        const result = LiveTvChannelSchema.safeParse(channel);
        expect(result.success).toBe(false);
    });
});

describe('LiveTvCategorySchema', () => {
    it('validates a complete category', () => {
        const category = {
            id: '423e4567-e89b-12d3-a456-426614174000',
            name: 'Sports',
            sortOrder: 2,
            isVisible: true,
            channelCount: 15,
        };
        const result = LiveTvCategorySchema.safeParse(category);
        expect(result.success).toBe(true);
    });

    it('validates a minimal category', () => {
        const category = {
            id: '423e4567-e89b-12d3-a456-426614174000',
            name: 'Sports',
            sortOrder: 2,
            isVisible: true,
        };
        const result = LiveTvCategorySchema.safeParse(category);
        expect(result.success).toBe(true);
    });

    it('rejects category missing required fields', () => {
        const result = LiveTvCategorySchema.safeParse({
            id: '123',
            name: 'Test',
        });
        expect(result.success).toBe(false);
    });
});

describe('LiveTvStreamInfoSchema', () => {
    it('validates complete stream info', () => {
        const streamInfo = {
            streamUrl: 'http://proxy.local/live/channel1.m3u8',
            streamUrls: [
                'http://backup1.local/live/channel1.m3u8',
                'http://backup2.local/live/channel1.m3u8',
            ],
            requiresProxy: true,
            sourceId: '623e4567-e89b-12d3-a456-426614174000',
            maxStreams: 2,
            rungId: null,
            requestedMaxBitrateBps: null,
            appliedMaxBitrateBps: null,
            appliedMaxHeight: null,
            reason: null,
        };
        const result = LiveTvStreamInfoSchema.safeParse(streamInfo);
        expect(result.success).toBe(true);
    });

    it('validates minimal stream info', () => {
        const streamInfo = {
            streamUrl: 'http://direct.local/live/channel1.m3u8',
            requiresProxy: false,
            rungId: null,
            requestedMaxBitrateBps: null,
            appliedMaxBitrateBps: null,
            appliedMaxHeight: null,
            reason: null,
        };
        const result = LiveTvStreamInfoSchema.safeParse(streamInfo);
        expect(result.success).toBe(true);
    });

    it('rejects stream info missing streamUrl', () => {
        const streamInfo = {
            requiresProxy: false,
        };
        const result = LiveTvStreamInfoSchema.safeParse(streamInfo);
        expect(result.success).toBe(false);
    });
});

describe('LiveTvSourceSchema', () => {
    it('validates an m3u source', () => {
        const source = {
            id: '723e4567-e89b-12d3-a456-426614174000',
            name: 'My IPTV',
            sourceType: 'm3u' as const,
            maxStreams: 2,
            lastRefreshAt: '2026-03-09T10:00:00Z',
            lastRefreshStatus: 'success',
        };
        const result = LiveTvSourceSchema.safeParse(source);
        expect(result.success).toBe(true);
    });

    it('validates an xtream source', () => {
        const source = {
            id: '823e4567-e89b-12d3-a456-426614174000',
            name: 'Xtream Provider',
            sourceType: 'xtream' as const,
            maxStreams: 1,
        };
        const result = LiveTvSourceSchema.safeParse(source);
        expect(result.success).toBe(true);
    });

    it('rejects invalid source type', () => {
        const source = {
            id: '923e4567-e89b-12d3-a456-426614174000',
            name: 'Invalid',
            sourceType: 'hls', // invalid
            maxStreams: 1,
        };
        const result = LiveTvSourceSchema.safeParse(source);
        expect(result.success).toBe(false);
    });
});

describe('LiveTvSourceConfigSchema', () => {
    it('validates standalone source', () => {
        expect(LiveTvSourceConfigSchema.safeParse('standalone').success).toBe(true);
    });

    it('validates disabled source', () => {
        expect(LiveTvSourceConfigSchema.safeParse('disabled').success).toBe(true);
    });

    it('rejects jellyfin (removed)', () => {
        expect(LiveTvSourceConfigSchema.safeParse('jellyfin').success).toBe(false);
    });

    it('rejects invalid source config', () => {
        expect(LiveTvSourceConfigSchema.safeParse('custom').success).toBe(false);
    });

    it('rejects empty string', () => {
        expect(LiveTvSourceConfigSchema.safeParse('').success).toBe(false);
    });
});

// =============================================================================
// ReorderChannelsRequestSchema (Story 4.2)
// =============================================================================

describe('ReorderChannelsRequestSchema', () => {
    it('accepts valid channel reorder payload', () => {
        const payload = {
            channels: [
                { id: '00000000-0000-4000-8000-000000000001', sortOrder: 0 },
                { id: '00000000-0000-4000-8000-000000000002', sortOrder: 1 },
            ],
        };
        const result = ReorderChannelsRequestSchema.safeParse(payload);
        expect(result.success).toBe(true);
    });

    it('accepts valid category reorder payload', () => {
        const payload = {
            categories: [
                { id: '00000000-0000-4000-8000-000000000101', sortOrder: 0 },
                { id: '00000000-0000-4000-8000-000000000102', sortOrder: 1 },
            ],
        };
        const result = ReorderChannelsRequestSchema.safeParse(payload);
        expect(result.success).toBe(true);
    });

    it('accepts combined channel + category reorder', () => {
        const payload = {
            channels: [{ id: '00000000-0000-4000-8000-000000000001', sortOrder: 0 }],
            categories: [{ id: '00000000-0000-4000-8000-000000000101', sortOrder: 0 }],
        };
        const result = ReorderChannelsRequestSchema.safeParse(payload);
        expect(result.success).toBe(true);
    });

    it('rejects empty payload (neither channels nor categories)', () => {
        const result = ReorderChannelsRequestSchema.safeParse({});
        expect(result.success).toBe(false);
    });

    it('rejects payload with empty arrays', () => {
        const result = ReorderChannelsRequestSchema.safeParse({
            channels: [],
            categories: [],
        });
        expect(result.success).toBe(false);
    });

    it('rejects negative sort order', () => {
        const payload = {
            channels: [{ id: '00000000-0000-4000-8000-000000000001', sortOrder: -1 }],
        };
        const result = ReorderChannelsRequestSchema.safeParse(payload);
        expect(result.success).toBe(false);
    });

    it('accepts duplicate sort order values', () => {
        const payload = {
            channels: [
                { id: '00000000-0000-4000-8000-000000000001', sortOrder: 0 },
                { id: '00000000-0000-4000-8000-000000000002', sortOrder: 0 },
            ],
        };
        const result = ReorderChannelsRequestSchema.safeParse(payload);
        expect(result.success).toBe(true);
    });

    it('rejects non-integer sort order', () => {
        const payload = {
            channels: [{ id: '00000000-0000-4000-8000-000000000001', sortOrder: 1.5 }],
        };
        const result = ReorderChannelsRequestSchema.safeParse(payload);
        expect(result.success).toBe(false);
    });

    it('rejects missing id in channel update', () => {
        const payload = {
            channels: [{ sortOrder: 0 }],
        };
        const result = ReorderChannelsRequestSchema.safeParse(payload);
        expect(result.success).toBe(false);
    });

    it('rejects missing sortOrder in channel update', () => {
        const payload = {
            channels: [{ id: '00000000-0000-4000-8000-000000000001' }],
        };
        const result = ReorderChannelsRequestSchema.safeParse(payload);
        expect(result.success).toBe(false);
    });
});

// =============================================================================
// UpdateChannelRequestSchema (Story 4.3)
// =============================================================================

describe('UpdateChannelRequestSchema', () => {
    it('accepts visibility update', () => {
        const result = UpdateChannelRequestSchema.safeParse({
            isVisible: false,
        });
        expect(result.success).toBe(true);
    });

    it('accepts quality tier update', () => {
        const result = UpdateChannelRequestSchema.safeParse({
            qualityTier: 'fhd',
        });
        expect(result.success).toBe(true);
    });

    it('accepts admin display name update', () => {
        const result = UpdateChannelRequestSchema.safeParse({
            adminDisplayName: 'My Channel',
        });
        expect(result.success).toBe(true);
    });

    it('accepts category id update', () => {
        const result = UpdateChannelRequestSchema.safeParse({
            categoryId: 'uuid-cat-1',
        });
        expect(result.success).toBe(true);
    });

    it('accepts multiple fields', () => {
        const result = UpdateChannelRequestSchema.safeParse({
            isVisible: true,
            qualityTier: 'hd',
            adminDisplayName: 'Test',
        });
        expect(result.success).toBe(true);
    });

    it('rejects empty body (no fields)', () => {
        const result = UpdateChannelRequestSchema.safeParse({});
        expect(result.success).toBe(false);
    });

    it('rejects invalid quality tier', () => {
        const result = UpdateChannelRequestSchema.safeParse({
            qualityTier: '4k',
        });
        expect(result.success).toBe(false);
    });

    it('accepts empty string adminDisplayName (schema level — frontend prevents empty saves)', () => {
        const result = UpdateChannelRequestSchema.safeParse({
            adminDisplayName: '',
        });
        expect(result.success).toBe(true);
    });
});

// =============================================================================
// BulkUpdateChannelsRequestSchema (Story 4.3)
// =============================================================================

describe('BulkUpdateChannelsRequestSchema', () => {
    it('accepts hide action', () => {
        const result = BulkUpdateChannelsRequestSchema.safeParse({
            channelIds: [
                '123e4567-e89b-12d3-a456-426614174001',
                '123e4567-e89b-12d3-a456-426614174002',
            ],
            action: 'hide',
        });
        expect(result.success).toBe(true);
    });

    it('accepts show action', () => {
        const result = BulkUpdateChannelsRequestSchema.safeParse({
            channelIds: ['123e4567-e89b-12d3-a456-426614174001'],
            action: 'show',
        });
        expect(result.success).toBe(true);
    });

    it('accepts setQuality with qualityTier', () => {
        const result = BulkUpdateChannelsRequestSchema.safeParse({
            channelIds: ['123e4567-e89b-12d3-a456-426614174001'],
            action: 'setQuality',
            qualityTier: 'fhd',
        });
        expect(result.success).toBe(true);
    });

    it('rejects setQuality without qualityTier', () => {
        const result = BulkUpdateChannelsRequestSchema.safeParse({
            channelIds: ['uuid-1'],
            action: 'setQuality',
        });
        expect(result.success).toBe(false);
    });

    it('accepts moveToCategory with categoryId', () => {
        const result = BulkUpdateChannelsRequestSchema.safeParse({
            channelIds: ['123e4567-e89b-12d3-a456-426614174001'],
            action: 'moveToCategory',
            categoryId: '423e4567-e89b-12d3-a456-426614174001',
        });
        expect(result.success).toBe(true);
    });

    it('rejects moveToCategory without categoryId', () => {
        const result = BulkUpdateChannelsRequestSchema.safeParse({
            channelIds: ['uuid-1'],
            action: 'moveToCategory',
        });
        expect(result.success).toBe(false);
    });

    it('rejects empty channelIds array', () => {
        const result = BulkUpdateChannelsRequestSchema.safeParse({
            channelIds: [],
            action: 'hide',
        });
        expect(result.success).toBe(false);
    });

    it('rejects invalid action', () => {
        const result = BulkUpdateChannelsRequestSchema.safeParse({
            channelIds: ['uuid-1'],
            action: 'delete',
        });
        expect(result.success).toBe(false);
    });

    it('rejects invalid quality tier for setQuality', () => {
        const result = BulkUpdateChannelsRequestSchema.safeParse({
            channelIds: ['uuid-1'],
            action: 'setQuality',
            qualityTier: '4k',
        });
        expect(result.success).toBe(false);
    });
});

// =============================================================================
// Backup Group Schemas (Story 4.5)
// =============================================================================

describe('BackupGroupMemberSchema', () => {
    it('validates a complete member', () => {
        const result = BackupGroupMemberSchema.safeParse({
            id: '123e4567-e89b-12d3-a456-426614174000',
            name: 'WBN One HD',
            adminDisplayName: 'WBN 1',
            qualityTier: 'hd',
            isVisible: true,
        });
        expect(result.success).toBe(true);
    });

    it('validates a minimal member (optional fields omitted)', () => {
        const result = BackupGroupMemberSchema.safeParse({
            id: '123e4567-e89b-12d3-a456-426614174000',
            name: 'WBN One',
            isVisible: false,
        });
        expect(result.success).toBe(true);
    });

    it('rejects invalid quality tier', () => {
        const result = BackupGroupMemberSchema.safeParse({
            id: '123e4567-e89b-12d3-a456-426614174000',
            name: 'WBN One',
            isVisible: true,
            qualityTier: '4k',
        });
        expect(result.success).toBe(false);
    });
});

describe('BackupGroupSchema', () => {
    it('validates a group with channels', () => {
        const result = BackupGroupSchema.safeParse({
            id: '223e4567-e89b-12d3-a456-426614174000',
            name: 'WBN One',
            primaryChannelId: '123e4567-e89b-12d3-a456-426614174000',
            channels: [
                {
                    id: '123e4567-e89b-12d3-a456-426614174000',
                    name: 'WBN One HD',
                    qualityTier: 'hd',
                    isVisible: true,
                },
                {
                    id: '323e4567-e89b-12d3-a456-426614174000',
                    name: 'WBN One SD',
                    qualityTier: 'sd',
                    isVisible: true,
                },
            ],
        });
        expect(result.success).toBe(true);
    });

    it('validates a group with empty channels', () => {
        const result = BackupGroupSchema.safeParse({
            id: '223e4567-e89b-12d3-a456-426614174000',
            name: 'Empty Group',
            channels: [],
        });
        expect(result.success).toBe(true);
    });
});

describe('BackupGroupsAdminResponseSchema', () => {
    it('validates full response', () => {
        const result = BackupGroupsAdminResponseSchema.safeParse({
            groups: [
                {
                    id: '223e4567-e89b-12d3-a456-426614174000',
                    name: 'WBN',
                    primaryChannelId: '123e4567-e89b-12d3-a456-426614174000',
                    channels: [
                        {
                            id: '123e4567-e89b-12d3-a456-426614174000',
                            name: 'WBN HD',
                            qualityTier: 'hd',
                            isVisible: true,
                        },
                    ],
                },
            ],
            ungroupedChannels: [
                {
                    id: '423e4567-e89b-12d3-a456-426614174000',
                    name: 'Standalone',
                    isVisible: true,
                },
            ],
        });
        expect(result.success).toBe(true);
    });

    it('validates empty response', () => {
        const result = BackupGroupsAdminResponseSchema.safeParse({
            groups: [],
            ungroupedChannels: [],
        });
        expect(result.success).toBe(true);
    });
});

describe('RemoveFromGroupRequestSchema', () => {
    it('validates a valid UUID', () => {
        const result = RemoveFromGroupRequestSchema.safeParse({
            channelId: '123e4567-e89b-12d3-a456-426614174000',
        });
        expect(result.success).toBe(true);
    });

    it('rejects non-UUID string', () => {
        const result = RemoveFromGroupRequestSchema.safeParse({
            channelId: 'not-a-uuid',
        });
        expect(result.success).toBe(false);
    });

    it('rejects empty body', () => {
        const result = RemoveFromGroupRequestSchema.safeParse({});
        expect(result.success).toBe(false);
    });
});

describe('SplitGroupRequestSchema', () => {
    it('validates array of UUIDs', () => {
        const result = SplitGroupRequestSchema.safeParse({
            channelIds: ['123e4567-e89b-12d3-a456-426614174000'],
        });
        expect(result.success).toBe(true);
    });

    it('rejects empty array', () => {
        const result = SplitGroupRequestSchema.safeParse({
            channelIds: [],
        });
        expect(result.success).toBe(false);
    });

    it('rejects non-UUID strings', () => {
        const result = SplitGroupRequestSchema.safeParse({
            channelIds: ['not-a-uuid'],
        });
        expect(result.success).toBe(false);
    });
});

describe('CreateBackupGroupRequestSchema', () => {
    it('validates array of 2+ UUIDs', () => {
        const result = CreateBackupGroupRequestSchema.safeParse({
            channelIds: [
                '123e4567-e89b-12d3-a456-426614174000',
                '223e4567-e89b-12d3-a456-426614174000',
            ],
        });
        expect(result.success).toBe(true);
    });

    it('rejects single UUID (min 2)', () => {
        const result = CreateBackupGroupRequestSchema.safeParse({
            channelIds: ['123e4567-e89b-12d3-a456-426614174000'],
        });
        expect(result.success).toBe(false);
    });

    it('rejects empty array', () => {
        const result = CreateBackupGroupRequestSchema.safeParse({
            channelIds: [],
        });
        expect(result.success).toBe(false);
    });
});

describe('AddToGroupRequestSchema', () => {
    it('validates a valid UUID', () => {
        const result = AddToGroupRequestSchema.safeParse({
            channelId: '123e4567-e89b-12d3-a456-426614174000',
        });
        expect(result.success).toBe(true);
    });

    it('rejects non-UUID string', () => {
        const result = AddToGroupRequestSchema.safeParse({
            channelId: 'not-a-uuid',
        });
        expect(result.success).toBe(false);
    });
});

// =============================================================================
// EPG Match Review Schemas (Story 4.6)
// =============================================================================

describe('EpgMatchConfidenceLevelSchema', () => {
    it('validates high', () => {
        expect(EpgMatchConfidenceLevelSchema.safeParse('high').success).toBe(true);
    });

    it('validates medium', () => {
        expect(EpgMatchConfidenceLevelSchema.safeParse('medium').success).toBe(true);
    });

    it('validates low', () => {
        expect(EpgMatchConfidenceLevelSchema.safeParse('low').success).toBe(true);
    });

    it('validates unmatched', () => {
        expect(EpgMatchConfidenceLevelSchema.safeParse('unmatched').success).toBe(true);
    });

    it('validates manual', () => {
        expect(EpgMatchConfidenceLevelSchema.safeParse('manual').success).toBe(true);
    });

    it('validates stale', () => {
        expect(EpgMatchConfidenceLevelSchema.safeParse('stale').success).toBe(true);
    });

    it('rejects invalid level', () => {
        expect(EpgMatchConfidenceLevelSchema.safeParse('unknown').success).toBe(false);
    });
});

describe('CurrentProgramPreviewSchema', () => {
    it('validates complete program preview', () => {
        const result = CurrentProgramPreviewSchema.safeParse({
            title: 'Evening News',
            startTime: '2026-03-10T18:00:00Z',
            endTime: '2026-03-10T19:00:00Z',
        });
        expect(result.success).toBe(true);
    });

    it('rejects missing title', () => {
        const result = CurrentProgramPreviewSchema.safeParse({
            startTime: '2026-03-10T18:00:00Z',
            endTime: '2026-03-10T19:00:00Z',
        });
        expect(result.success).toBe(false);
    });
});

describe('EpgMatchReviewItemSchema', () => {
    it('validates a complete review item with all fields', () => {
        const result = EpgMatchReviewItemSchema.safeParse({
            id: '123e4567-e89b-12d3-a456-426614174000',
            name: 'WBN One',
            adminDisplayName: 'WBN 1',
            images: {
                primary: { href: 'https://example.com/wbn-one.png', revision: '0', source: 'self' },
            },
            epgChannelId: 'wbn-one.uk',
            epgDisplayName: 'WBN One',
            confidenceLevel: 'high',
            confidenceScore: 0.95,
            matchSignals: ['name_exact', 'logo_match'],
            isManualOverride: false,
            categoryName: 'News',
            currentProgram: {
                title: 'Evening News',
                startTime: '2026-03-10T18:00:00Z',
                endTime: '2026-03-10T19:00:00Z',
            },
        });
        expect(result.success).toBe(true);
    });

    it('validates a minimal review item (required fields only)', () => {
        const result = EpgMatchReviewItemSchema.safeParse({
            id: '123e4567-e89b-12d3-a456-426614174000',
            name: 'WBN One',
            images: {},
            confidenceLevel: 'unmatched',
            isManualOverride: false,
        });
        expect(result.success).toBe(true);
    });

    it('rejects missing required fields (id missing)', () => {
        const result = EpgMatchReviewItemSchema.safeParse({
            name: 'WBN One',
            images: {},
            confidenceLevel: 'high',
            isManualOverride: false,
        });
        expect(result.success).toBe(false);
    });
});

describe('EpgMatchReviewResponseSchema', () => {
    it('validates complete response with channels and stats', () => {
        const result = EpgMatchReviewResponseSchema.safeParse({
            channels: [
                {
                    id: '123e4567-e89b-12d3-a456-426614174000',
                    name: 'WBN One',
                    images: {},
                    confidenceLevel: 'high',
                    isManualOverride: false,
                },
            ],
            stats: {
                total: 100,
                matched: 85,
                unmatched: 10,
                lowConfidence: 5,
                manualOverrides: 3,
            },
        });
        expect(result.success).toBe(true);
    });

    it('validates empty response (empty channels array)', () => {
        const result = EpgMatchReviewResponseSchema.safeParse({
            channels: [],
            stats: {
                total: 0,
                matched: 0,
                unmatched: 0,
                lowConfidence: 0,
                manualOverrides: 0,
            },
        });
        expect(result.success).toBe(true);
    });
});

describe('EpgChannelSearchResultSchema', () => {
    it('validates complete result', () => {
        const result = EpgChannelSearchResultSchema.safeParse({
            id: 'wbn-one.uk',
            displayName: 'WBN One',
            iconUrl: 'https://example.com/wbn-one.png',
        });
        expect(result.success).toBe(true);
    });

    it('validates minimal result (no iconUrl)', () => {
        const result = EpgChannelSearchResultSchema.safeParse({
            id: 'wbn-one.uk',
            displayName: 'WBN One',
        });
        expect(result.success).toBe(true);
    });
});

describe('EpgChannelSearchResponseSchema', () => {
    it('validates response with results', () => {
        const result = EpgChannelSearchResponseSchema.safeParse({
            results: [
                { id: 'wbn-one.uk', displayName: 'WBN One' },
                {
                    id: 'wbn-two.uk',
                    displayName: 'WBN Two',
                    iconUrl: 'https://example.com/wbn-two.png',
                },
            ],
        });
        expect(result.success).toBe(true);
    });

    it('validates empty results', () => {
        const result = EpgChannelSearchResponseSchema.safeParse({
            results: [],
        });
        expect(result.success).toBe(true);
    });
});

describe('UpdateEpgMatchRequestSchema', () => {
    it('accepts string epgChannelId (match)', () => {
        const result = UpdateEpgMatchRequestSchema.safeParse({
            epgChannelId: 'wbn-one.uk',
        });
        expect(result.success).toBe(true);
    });

    it('accepts null epgChannelId (unmatch)', () => {
        const result = UpdateEpgMatchRequestSchema.safeParse({
            epgChannelId: null,
        });
        expect(result.success).toBe(true);
    });

    it('rejects missing epgChannelId', () => {
        const result = UpdateEpgMatchRequestSchema.safeParse({});
        expect(result.success).toBe(false);
    });

    it('rejects undefined epgChannelId (must be null or string)', () => {
        const result = UpdateEpgMatchRequestSchema.safeParse({
            epgChannelId: undefined,
        });
        expect(result.success).toBe(false);
    });
});

describe('EpgMatchReviewFilterSchema', () => {
    it('validates all', () => {
        expect(EpgMatchReviewFilterSchema.safeParse('all').success).toBe(true);
    });

    it('validates mismatches', () => {
        expect(EpgMatchReviewFilterSchema.safeParse('mismatches').success).toBe(true);
    });

    it('validates unmatched', () => {
        expect(EpgMatchReviewFilterSchema.safeParse('unmatched').success).toBe(true);
    });

    it('rejects invalid filter', () => {
        expect(EpgMatchReviewFilterSchema.safeParse('low-confidence').success).toBe(false);
    });
});

// =============================================================================
// Category Management Schemas (Story 4.7)
// =============================================================================

describe('RenameCategoryRequestSchema', () => {
    it('accepts valid name', () => {
        const result = RenameCategoryRequestSchema.safeParse({
            name: 'Sports',
        });
        expect(result.success).toBe(true);
    });

    it('rejects empty name', () => {
        const result = RenameCategoryRequestSchema.safeParse({ name: '' });
        expect(result.success).toBe(false);
    });

    it('rejects name over 200 chars', () => {
        const result = RenameCategoryRequestSchema.safeParse({
            name: 'A'.repeat(201),
        });
        expect(result.success).toBe(false);
    });

    it('accepts name at 200 chars', () => {
        const result = RenameCategoryRequestSchema.safeParse({
            name: 'A'.repeat(200),
        });
        expect(result.success).toBe(true);
    });

    it('rejects missing name', () => {
        const result = RenameCategoryRequestSchema.safeParse({});
        expect(result.success).toBe(false);
    });
});

describe('CreateCategoryRequestSchema', () => {
    it('accepts valid name', () => {
        const result = CreateCategoryRequestSchema.safeParse({ name: 'News' });
        expect(result.success).toBe(true);
    });

    it('rejects empty name', () => {
        const result = CreateCategoryRequestSchema.safeParse({ name: '' });
        expect(result.success).toBe(false);
    });

    it('rejects name over 200 chars', () => {
        const result = CreateCategoryRequestSchema.safeParse({
            name: 'A'.repeat(201),
        });
        expect(result.success).toBe(false);
    });
});

describe('CreateCategoryResponseSchema', () => {
    it('validates complete response', () => {
        const result = CreateCategoryResponseSchema.safeParse({
            id: '123e4567-e89b-12d3-a456-426614174000',
            name: 'Sports',
            sortOrder: 5,
        });
        expect(result.success).toBe(true);
    });

    it('rejects missing fields', () => {
        const result = CreateCategoryResponseSchema.safeParse({ id: 'abc' });
        expect(result.success).toBe(false);
    });
});

describe('MergeCategoryRequestSchema', () => {
    it('accepts valid targetCategoryId', () => {
        const result = MergeCategoryRequestSchema.safeParse({
            targetCategoryId: '123e4567-e89b-12d3-a456-426614174000',
        });
        expect(result.success).toBe(true);
    });

    it('rejects missing targetCategoryId', () => {
        const result = MergeCategoryRequestSchema.safeParse({});
        expect(result.success).toBe(false);
    });

    it('rejects non-UUID targetCategoryId', () => {
        const result = MergeCategoryRequestSchema.safeParse({
            targetCategoryId: 'not-a-uuid',
        });
        expect(result.success).toBe(false);
    });
});

describe('MergeCategoryResponseSchema', () => {
    it('validates complete response', () => {
        const result = MergeCategoryResponseSchema.safeParse({
            success: true,
            movedChannelCount: 12,
        });
        expect(result.success).toBe(true);
    });

    it('rejects success: false', () => {
        const result = MergeCategoryResponseSchema.safeParse({
            success: false,
            movedChannelCount: 0,
        });
        expect(result.success).toBe(false);
    });
});

describe('CategoryChannelCountResponseSchema', () => {
    it('validates count response', () => {
        const result = CategoryChannelCountResponseSchema.safeParse({
            count: 42,
        });
        expect(result.success).toBe(true);
    });

    it('rejects missing count', () => {
        const result = CategoryChannelCountResponseSchema.safeParse({});
        expect(result.success).toBe(false);
    });

    it('rejects non-number count', () => {
        const result = CategoryChannelCountResponseSchema.safeParse({
            count: 'many',
        });
        expect(result.success).toBe(false);
    });
});

// =============================================================================
// Stream Limit Error Response Schemas (Story 5.1)
// =============================================================================

describe('StreamLimitActiveChannelSchema', () => {
    it('validates a complete active channel', () => {
        const result = StreamLimitActiveChannelSchema.safeParse({
            channelId: 'abc-123',
            channelName: 'LRV',
            viewers: 2,
        });
        expect(result.success).toBe(true);
    });

    it('rejects missing channelId', () => {
        const result = StreamLimitActiveChannelSchema.safeParse({
            channelName: 'LRV',
            viewers: 2,
        });
        expect(result.success).toBe(false);
    });

    it('rejects missing viewers', () => {
        const result = StreamLimitActiveChannelSchema.safeParse({
            channelId: 'abc-123',
            channelName: 'LRV',
        });
        expect(result.success).toBe(false);
    });
});

describe('StreamLimitErrorResponseSchema', () => {
    it('accepts valid stream limit response with active channels', () => {
        const result = StreamLimitErrorResponseSchema.safeParse({
            error: 'stream_limit_reached',
            limit: 2,
            active: [
                { channelId: 'abc-123', channelName: 'LRV', viewers: 2 },
                { channelId: 'def-456', channelName: 'ZAVO', viewers: 1 },
            ],
            showActiveStreams: true,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.limit).toBe(2);
            expect(result.data.active).toHaveLength(2);
            expect(result.data.showActiveStreams).toBe(true);
        }
    });

    it('rejects response missing error discriminant', () => {
        const result = StreamLimitErrorResponseSchema.safeParse({
            limit: 2,
            active: [],
            showActiveStreams: true,
        });
        expect(result.success).toBe(false);
    });

    it('rejects response with wrong error value', () => {
        const result = StreamLimitErrorResponseSchema.safeParse({
            error: 'some_other_error',
            limit: 2,
            active: [],
            showActiveStreams: true,
        });
        expect(result.success).toBe(false);
    });

    it('accepts response with empty active array', () => {
        const result = StreamLimitErrorResponseSchema.safeParse({
            error: 'stream_limit_reached',
            limit: 2,
            active: [],
            showActiveStreams: false,
        });
        expect(result.success).toBe(true);
    });

    it('accepts response with showActiveStreams false', () => {
        const result = StreamLimitErrorResponseSchema.safeParse({
            error: 'stream_limit_reached',
            limit: 1,
            active: [{ channelId: 'ch-1', channelName: 'Test', viewers: 1 }],
            showActiveStreams: false,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.showActiveStreams).toBe(false);
        }
    });

    it('rejects response missing showActiveStreams', () => {
        const result = StreamLimitErrorResponseSchema.safeParse({
            error: 'stream_limit_reached',
            limit: 2,
            active: [],
        });
        expect(result.success).toBe(false);
    });

    it('rejects response missing limit', () => {
        const result = StreamLimitErrorResponseSchema.safeParse({
            error: 'stream_limit_reached',
            active: [],
            showActiveStreams: true,
        });
        expect(result.success).toBe(false);
    });
});

// =============================================================================
// Stream Failure Error Response Schemas (Story 5.2)
// =============================================================================

describe('StreamFailureErrorSchema', () => {
    it('accepts spawn_failed with message', () => {
        const result = StreamFailureErrorSchema.safeParse({
            error: 'spawn_failed',
            message: 'FFmpeg failed to start',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.error).toBe('spawn_failed');
            expect(result.data.message).toBe('FFmpeg failed to start');
        }
    });

    it('accepts source_unreachable with message', () => {
        const result = StreamFailureErrorSchema.safeParse({
            error: 'source_unreachable',
            message: 'Connection refused',
        });
        expect(result.success).toBe(true);
    });

    it('accepts channel_not_found without message', () => {
        const result = StreamFailureErrorSchema.safeParse({
            error: 'channel_not_found',
        });
        expect(result.success).toBe(true);
    });

    it('accepts no_segments without message', () => {
        const result = StreamFailureErrorSchema.safeParse({
            error: 'no_segments',
        });
        expect(result.success).toBe(true);
    });

    it('accepts proxy_unreachable without message', () => {
        const result = StreamFailureErrorSchema.safeParse({
            error: 'proxy_unreachable',
        });
        expect(result.success).toBe(true);
    });

    it('accepts internal_error with message', () => {
        const result = StreamFailureErrorSchema.safeParse({
            error: 'internal_error',
            message: 'Stream unavailable',
        });
        expect(result.success).toBe(true);
    });

    it('rejects unknown error code', () => {
        const result = StreamFailureErrorSchema.safeParse({
            error: 'unknown_error',
            message: 'Something',
        });
        expect(result.success).toBe(false);
    });

    it('rejects missing error field', () => {
        const result = StreamFailureErrorSchema.safeParse({
            message: 'No error code',
        });
        expect(result.success).toBe(false);
    });

    it('accepts response with optional message omitted', () => {
        const result = StreamFailureErrorSchema.safeParse({
            error: 'spawn_failed',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.message).toBeUndefined();
        }
    });
});

describe('station airing read schemas', () => {
    const airing = {
        id: 'airing',
        stationId: 'station',
        title: 'News',
        startTime: '2026-10-17T10:00:00Z',
        endTime: '2026-10-17T11:00:00Z',
    };
    it('strips feed identifiers and provenance from the airing shape', () => {
        expect(
            LiveTvAiringSchema.parse({
                ...airing,
                channelId: 'feed',
                epgId: 'xmltv',
                sourceId: 'source',
            }),
        ).toEqual(airing);
        expect(
            LiveTvAiringSchema.safeParse({ ...airing, startTime: '2026-10-17T10:00:00' }).success,
        ).toBe(false);
    });
    it('requires explicit nullable current and next members', () => {
        expect(LiveTvNowNextSchema.parse({ current: airing, next: null })).toEqual({
            current: airing,
            next: null,
        });
        expect(LiveTvNowNextSchema.safeParse({}).success).toBe(false);
    });
    it('requires nowNext and strips old station programme fields', () => {
        const station = {
            id: 'station',
            feedId: 'feed',
            name: 'News',
            images: {},
            sortOrder: 0,
            isVisible: true,
        };
        expect(LiveTvStationSchema.safeParse(station).success).toBe(false);
        const parsed = LiveTvStationSchema.parse({
            ...station,
            nowNext: { current: null, next: null },
            currentProgram: airing,
            nextProgram: airing,
        });
        expect(parsed).not.toHaveProperty('currentProgram');
        expect(parsed).not.toHaveProperty('nextProgram');
    });
});

it('preserves explicit Bps names on live stream info and the start fixture', async () => {
    const { liveStartFixture } = await import('$lib/utils/livetv-start.fixture.js');
    const fixture = liveStartFixture();
    expect(fixture.delivery).toHaveProperty('requestedMaxBitrateBps', null);
    expect(fixture.delivery).toHaveProperty('appliedMaxBitrateBps', null);
    const wire = {
        streamUrl: '/live',
        ...fixture.delivery,
        requestedMaxBitrateBps: 4000000,
        appliedMaxBitrateBps: 2000000,
        adaptive: {
            rungs: [{ id: '720p', height: 720, maxBitrateBps: 2000000, codec: 'h264' }],
            includesOriginal: false,
        },
    };
    const parsed = LiveTvStreamInfoSchema.parse(wire);
    expect(parsed).toMatchObject({
        requestedMaxBitrateBps: 4000000,
        appliedMaxBitrateBps: 2000000,
        adaptive: wire.adaptive,
    });
    expect(parsed).not.toHaveProperty('requestedMaxBitrate');
});
