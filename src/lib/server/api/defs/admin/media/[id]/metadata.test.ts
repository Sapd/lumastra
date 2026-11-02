// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The admin custom-metadata PATCH merges operator keys into a JSONB column that
 * the scanner and matchers also use for their own state. It must refuse those
 * server-managed keys and bound what it accepts, while operator keys
 * (chapters, lyrics, library template fields) keep working.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateItemCustomMetadata = vi.fn();
vi.mock('$lib/server/database/queries/non-entertainment-browse.queries.js', () => ({
    updateItemCustomMetadata: (...a: unknown[]) => updateItemCustomMetadata(...a),
    bulkUpdateCustomMetadata: vi.fn(),
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => ({}) },
}));
const afterMetadataChanged = vi.fn(async (..._args: unknown[]) => {});
vi.mock('$lib/server/services/media-lifecycle.service.js', () => ({
    MediaLifecycleService: {
        afterMetadataChanged: (...a: unknown[]) => afterMetadataChanged(...a),
    },
}));

import { def, MetadataPatchRequestSchema } from './metadata.js';

const ITEM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const event = { params: { id: ITEM }, locals: {} } as unknown as RequestEvent;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (metadata: Record<string, unknown>): any => ({
    surface: 'internal',
    input: { body: { metadata }, query: {} },
});

beforeEach(() => {
    vi.clearAllMocks();
    updateItemCustomMetadata.mockResolvedValue(true);
});

describe('admin custom-metadata PATCH', () => {
    it('merges operator keys and reports a custom_metadata change', async () => {
        const res = await def.handlers.PATCH!(event, ctx({ chapters: [], lyrics: { plain: 'x' } }));

        expect(res.status).toBe(200);
        expect(updateItemCustomMetadata).toHaveBeenCalledWith({}, ITEM, {
            chapters: [],
            lyrics: { plain: 'x' },
        });
        expect(afterMetadataChanged).toHaveBeenCalledWith(ITEM, ['custom_metadata']);
    });

    it('refuses a server-managed key without writing anything', async () => {
        const res = await def.handlers.PATCH!(event, ctx({ genre: 'Jazz', no_split: true }));

        expect(res.status).toBe(422);
        expect(updateItemCustomMetadata).not.toHaveBeenCalled();
    });

    it('bounds the key count and key length', () => {
        const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, i]));
        expect(MetadataPatchRequestSchema.safeParse({ metadata: many }).success).toBe(false);
        expect(
            MetadataPatchRequestSchema.safeParse({ metadata: { ['x'.repeat(129)]: 1 } }).success,
        ).toBe(false);
        expect(MetadataPatchRequestSchema.safeParse({ metadata: { genre: 'Jazz' } }).success).toBe(
            true,
        );
    });
});
