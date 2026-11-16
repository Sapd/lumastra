// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { currentJellyfinRequestContext, runWithJellyfinRequestContext } from './request-context';

describe('jellyfin request context (AsyncLocalStorage)', () => {
    it('is undefined outside any context', () => {
        expect(currentJellyfinRequestContext()).toBeUndefined();
    });

    it('is visible inside the run callback', () => {
        const seen = runWithJellyfinRequestContext({ canDownload: true }, () =>
            currentJellyfinRequestContext(),
        );
        expect(seen).toEqual({ canDownload: true });
    });

    it('survives awaits inside the run callback', async () => {
        const seen = await runWithJellyfinRequestContext({ canDownload: true }, async () => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            return currentJellyfinRequestContext();
        });
        expect(seen).toEqual({ canDownload: true });
    });

    it('keeps concurrent requests isolated', async () => {
        const run = (canDownload: boolean) =>
            runWithJellyfinRequestContext({ canDownload }, async () => {
                await new Promise((resolve) => setTimeout(resolve, canDownload ? 5 : 1));
                return currentJellyfinRequestContext()?.canDownload;
            });
        const [allowed, denied] = await Promise.all([run(true), run(false)]);
        expect(allowed).toBe(true);
        expect(denied).toBe(false);
    });

    it('is cleared again after the run callback returns', () => {
        runWithJellyfinRequestContext({ canDownload: true }, () => undefined);
        expect(currentJellyfinRequestContext()).toBeUndefined();
    });
});
