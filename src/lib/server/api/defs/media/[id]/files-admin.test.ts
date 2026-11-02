// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const mocks = vi.hoisted(() => ({ delegate: vi.fn() }));
vi.mock('$lib/server/api/delegate.js', () => ({ delegateToAdmin: mocks.delegate }));
vi.mock('../../../../../../routes/api/admin/media/[id]/files/+server.js', () => ({ GET: vi.fn() }));
import { def } from './files-admin.js';
it('projects delegated internal file details through the public schema', async () => {
    mocks.delegate.mockResolvedValue(
        new Response(
            JSON.stringify({
                files: [
                    {
                        id: 'test-file',
                        file_path: '/fixture/test.mkv',
                        edition: null,
                        part_number: null,
                        library_group_id: null,
                        created_at: '2026-10-01',
                        media_item_id: 'test-media',
                        file_size_bytes: '1',
                        duration_seconds: 2,
                        container_format: 'mkv',
                        file_mtime: null,
                        file_hash_head: null,
                        probed_at: null,
                        health_issues: null,
                        is_default: true,
                        file_sort_order: 0,
                        file_label: null,
                        tailAssessment: { private: 'inventory/source/measurements' },
                    },
                ],
            }),
            { status: 200 },
        ),
    );
    const response = await def.handlers.GET!({} as RequestEvent, {} as never);
    const body: unknown = await response.json();
    expect(body).not.toHaveProperty('files.0.tailAssessment');
    expect(body).toHaveProperty('files.0.file_size_bytes', '1');
});
