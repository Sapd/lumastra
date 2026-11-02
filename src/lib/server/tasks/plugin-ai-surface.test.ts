// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { AiUnavailableError } from '@sapd/lumastra-plugin-sdk';
import { buildAiSurface } from './plugin-ai-surface.js';

describe('buildAiSurface', () => {
    it('returns undefined when the proprietary loader yields nothing', async () => {
        const ai = await buildAiSurface(
            {} as never,
            { userId: 'test-user-id-a', username: 'a', groups: [], isAdmin: false },
            async () => null,
        );
        expect(ai).toBeUndefined();
    });

    it('throws AiUnavailableError from ask() when entitlement check fails', async () => {
        const ai = await buildAiSurface(
            {} as never,
            { userId: 'test-user-id-a', username: 'a', groups: [], isAdmin: false },
            async () => ({
                runAssistant: async () => {
                    throw new AiUnavailableError('no entitlement');
                },
                resolveUser: async () => ({ username: 'a' }),
            }),
        );
        await expect(ai!.ask({ prompt: 'hi' })).rejects.toBeInstanceOf(AiUnavailableError);
    });

    it('binds the RAG user to the viewer username (no caller-supplied user id exists)', async () => {
        // SECURITY INVARIANT: a plugin cannot ask the assistant "as" another
        // user — the `ask()` request shape has NO user-id field; the surface
        // resolves the user from the viewer that built the context, and that
        // resolved user must reach runAssistant.
        const resolveUser = vi.fn(async (_sql: unknown, username: string) => ({
            username,
            userId: `id-for-${username}`,
        }));
        const runAssistant = vi.fn(async () => ({
            text: 'ok',
            recommendedMedia: [],
            usage: { tokens: 1, costUsd: 0 },
        }));

        const ai = await buildAiSurface(
            'the-sql' as never,
            {
                userId: 'test-user-id-viewer-bob',
                username: 'viewer-bob',
                groups: [],
                isAdmin: false,
            },
            async () => ({ runAssistant, resolveUser }),
        );

        await ai!.ask({ prompt: 'hi' });

        // resolveUser was called with the VIEWER username.
        expect(resolveUser).toHaveBeenCalledTimes(1);
        expect(resolveUser).toHaveBeenCalledWith('the-sql', 'viewer-bob');

        // The viewer-resolved user reaches runAssistant; no `asUserId` leaks
        // into the deps or the input passed to the model.
        expect(runAssistant).toHaveBeenCalledTimes(1);
        const [input, deps] = runAssistant.mock.calls[0] as unknown as [
            Record<string, unknown>,
            Record<string, unknown>,
        ];
        expect((deps.user as { username: string }).username).toBe('viewer-bob');
        expect(deps).not.toHaveProperty('asUserId');
        expect(input).not.toHaveProperty('asUserId');
    });

    it('fails closed when resolveUser returns null (deleted/unsynced user)', async () => {
        // resolveUser returns null for a username with no resolvable row; the
        // surface must throw a clean AiUnavailableError instead of passing null
        // to runAssistant (which would TypeError on user.isAgeRestricted).
        const runAssistant = vi.fn();
        const ai = await buildAiSurface(
            {} as never,
            { userId: 'test-user-id-ghost', username: 'ghost', groups: [], isAdmin: false },
            async () => ({
                runAssistant,
                resolveUser: async () => null,
            }),
        );

        await expect(ai!.ask({ prompt: 'hi' })).rejects.toBeInstanceOf(AiUnavailableError);
        expect(runAssistant).not.toHaveBeenCalled();
    });

    it('rejects an empty prompt before reaching the model', async () => {
        const runAssistant = vi.fn();
        const ai = await buildAiSurface(
            {} as never,
            { userId: 'test-user-id-a', username: 'a', groups: [], isAdmin: false },
            async () => ({
                runAssistant,
                resolveUser: async () => ({ username: 'a' }),
            }),
        );
        await expect(ai!.ask({ prompt: '' })).rejects.toBeInstanceOf(AiUnavailableError);
        expect(runAssistant).not.toHaveBeenCalled();
    });

    it('rejects an over-length prompt before reaching the model', async () => {
        const runAssistant = vi.fn();
        const ai = await buildAiSurface(
            {} as never,
            { userId: 'test-user-id-a', username: 'a', groups: [], isAdmin: false },
            async () => ({
                runAssistant,
                resolveUser: async () => ({ username: 'a' }),
            }),
        );
        await expect(ai!.ask({ prompt: 'x'.repeat(5001) })).rejects.toBeInstanceOf(
            AiUnavailableError,
        );
        expect(runAssistant).not.toHaveBeenCalled();
    });

    it('rejects too many history turns before reaching the model', async () => {
        const runAssistant = vi.fn();
        const ai = await buildAiSurface(
            {} as never,
            { userId: 'test-user-id-a', username: 'a', groups: [], isAdmin: false },
            async () => ({
                runAssistant,
                resolveUser: async () => ({ username: 'a' }),
            }),
        );
        const history = Array.from({ length: 21 }, () => ({
            role: 'user' as const,
            content: 'hi',
        }));
        await expect(ai!.ask({ prompt: 'hi', history })).rejects.toBeInstanceOf(AiUnavailableError);
        expect(runAssistant).not.toHaveBeenCalled();
    });
});

it('maps an auth dependency outage to the plugin retryable unavailable error', async () => {
    const { AuthDependencyUnavailableError } =
        await import('$lib/server/auth/dependency-unavailable.js');
    const ai = await buildAiSurface(
        {} as never,
        { userId: 'test-id', username: 'alice', groups: [], isAdmin: false },
        async () => ({
            resolveUser: async () => {
                throw new AuthDependencyUnavailableError();
            },
            runAssistant: vi.fn(),
        }),
    );
    await expect(ai!.ask({ prompt: 'hello' })).rejects.toBeInstanceOf(AiUnavailableError);
});
