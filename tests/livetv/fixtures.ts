// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { test as base, expect } from '@playwright/test';
import { createActor, waitForSlots } from './harness';
import type { Actor } from './harness';
import { haveLiveTvFfmpeg } from './env';
import type { Identity } from './env';

export const test = base.extend<{ actors: Record<Identity, Actor> }>({
    actors: async ({ baseURL }, use): Promise<void> => {
        if (!baseURL) throw new Error('Live TV config must provide a baseURL');
        // The suite-level skip runs before fixture setup on machines lacking binaries.
        await waitForSlots(0);
        const actors: Partial<Record<Identity, Actor>> = {};
        try {
            actors.alice = await createActor('alice');
            actors.bob = await createActor('bob');
            actors.admin = await createActor('admin');
            await use(actors as Record<Identity, Actor>);
        } finally {
            const activeActors = Object.values(actors).filter(
                (actor): actor is Actor => actor !== undefined,
            );
            const results = await Promise.allSettled(activeActors.map((actor) => actor.close()));
            expect(
                results.filter((result) => result.status === 'rejected'),
                'every actor closes cleanly',
            ).toEqual([]);
            await waitForSlots(0);
        }
    },
});
export { expect };
export const missingFfmpeg = !haveLiveTvFfmpeg();
export const ffmpegSkipReason =
    'Live TV E2E requires ffmpeg and ffprobe (FFMPEG_PATH / FFPROBE_PATH or PATH); no media or app is mocked';
