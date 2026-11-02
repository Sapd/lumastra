// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { Sql } from 'postgres';
import type * as CollageRenderer from './cover-collage.service.js';
import type * as ImageDescriptors from '$lib/server/services/image-descriptor/index.js';
import { AsyncSemaphore } from '$lib/server/utils/async-semaphore.js';
import { Logger } from '$lib/server/utils/logger.js';
import { musicCollageImages } from './collage-images.js';

const logger = Logger.for('CollageWarmup');
// Shared across all producers, including overlapping recomputations.
const renders = new AsyncSemaphore(2);
let renderer: Promise<typeof CollageRenderer> | undefined;
let descriptors: Promise<typeof ImageDescriptors> | undefined;
const pending = new Map<string, Promise<void>>();

/** Warm exact published URLs directly through the renderer, without internal HTTP. */
export async function warmCollageUrls(urls: readonly string[]): Promise<void> {
    await Promise.all(
        urls.map(async (href) => {
            try {
                const url = new URL(href, 'http://collage.local');
                const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
                const size = url.searchParams.get('size') ?? 'card';
                if (!ids.length || (size !== 'thumb' && size !== 'card' && size !== 'full')) return;
                const revision = url.searchParams.get('v') ?? undefined;
                const key = JSON.stringify([ids, size, revision]);
                const existing = pending.get(key);
                if (existing) return await existing;
                const work = renders.withPermit(async () => {
                    const { getCoverCollage } = await (renderer ??=
                        import('./cover-collage.service.js'));
                    await getCoverCollage(ids, size, revision);
                });
                pending.set(key, work);
                try {
                    await work;
                } finally {
                    pending.delete(key);
                }
            } catch (error) {
                logger.debug('Collage warm-up failed', { error: String(error) });
            }
        }),
    );
}

/**
 * Called after a producer writes its new cover candidates. Descriptor lookup
 * and all three published presets run in the background; failures never reach
 * the producing task/service. Surface changes only the path, not the disk key.
 */
export function warmMusicCollages(
    sql: Sql,
    groups: readonly (readonly string[])[] | (() => Promise<readonly (readonly string[])[]>),
): void {
    void Promise.resolve()
        .then(async () => {
            const candidates = typeof groups === 'function' ? await groups() : groups;
            const { resolveImageSets } = await (descriptors ??=
                import('$lib/server/services/image-descriptor/index.js'));
            const members = await resolveImageSets(
                sql,
                'v1',
                [...new Set(candidates.flat())].map((id) => ({ id })),
            );
            const urls = candidates.flatMap((ids) => {
                const primary = musicCollageImages(ids, 'v1', members).primary;
                return primary ? Object.values(primary.variants ?? {}) : [];
            });
            await warmCollageUrls(urls);
        })
        .catch((error: unknown) => {
            logger.debug('Collage warm-up preparation failed', { error: String(error) });
        });
}
