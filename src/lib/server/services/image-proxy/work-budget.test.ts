// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageCache } from './cache';
import { requireImageProviderBudget, runImageProviderBudget } from './work-budget';

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
});

describe('image provider work budget', () => {
    it('serves disk cache hits without charging, even when the upstream budget is exhausted', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'image-budget-'));
        directories.push(directory);
        const cache = new ImageCache({ directory, ttl: 60_000 });
        await cache.write('cover', Buffer.from('cached cover'));
        const charge = vi.fn(async () => new Response(null, { status: 429 }));
        const upstream = vi.fn(async () => {
            await requireImageProviderBudget();
            return Buffer.from('upstream');
        });
        for (let i = 0; i < 301; i++) {
            const response = await runImageProviderBudget(charge, async () => {
                const result = await cache.getCachedOrFetch('cover', upstream);
                return new Response(result.buffer.toString());
            });
            expect(await response.text()).toBe('cached cover');
        }
        expect(charge).not.toHaveBeenCalled();
        expect(upstream).not.toHaveBeenCalled();
    });

    it('charges once across concurrent provider calls and blocks every fetch when exhausted', async () => {
        const charge = vi.fn(async () => new Response(null, { status: 429 }));
        const fetch = vi.fn();
        const response = await runImageProviderBudget(charge, async () => {
            await Promise.allSettled(
                [1, 2].map(async () => {
                    await requireImageProviderBudget();
                    fetch();
                }),
            );
            return new Response('placeholder');
        });
        expect(response.status).toBe(429);
        expect(charge).toHaveBeenCalledTimes(1);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('keeps concurrent request budgets independent', async () => {
        const responses = await Promise.all(
            [true, false].map((allowed) =>
                runImageProviderBudget(
                    async () => (allowed ? null : new Response(null, { status: 429 })),
                    async () => {
                        await requireImageProviderBudget();
                        return new Response('image');
                    },
                ),
            ),
        );
        expect(responses.map((response) => response.status)).toEqual([200, 429]);
    });
});
