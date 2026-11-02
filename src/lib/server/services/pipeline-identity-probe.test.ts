// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for buildIdentityProbeKey (Slice 2).
 *
 * Regression guard: the identity-lock probe must build the SAME key the
 * orchestrator writes — `identityKey(taskId, computeIdentity(task, input))` —
 * not `identityKey(taskId, mediaItemId)`. The latter never matched a real key,
 * so the `identity-locked` diagnosis silently never fired.
 */

import { describe, it, expect } from 'vitest';
import type { TaskDefinition } from '@sapd/lumastra-plugin-sdk';
import { buildIdentityProbeKey } from './pipeline-identity-probe.js';

const ITEM = '11111111-1111-1111-1111-111111111111';

const idOf = (i: unknown): string => (i as { mediaItemId?: string }).mediaItemId ?? '';

function task(over: Partial<TaskDefinition>): TaskDefinition {
    return {
        id: 'demo',
        identityFor: idOf,
        ...over,
    } as unknown as TaskDefinition;
}

describe('buildIdentityProbeKey', () => {
    it('undefined task → null', () => {
        expect(buildIdentityProbeKey(undefined, ITEM)).toBeNull();
    });

    it('non-exclusive task → null (no cross-time identity lock exists to probe)', () => {
        expect(buildIdentityProbeKey(task({}), ITEM)).toBeNull();
    });

    it('exclusive per-item task whose identityFor TRANSFORMS the id resolves the real key (the regression)', () => {
        const t = task({
            exclusiveWith: {
                ttl: '24h',
            } as unknown as TaskDefinition['exclusiveWith'],
            identityFor: (i: unknown) => `item-${(i as { mediaItemId: string }).mediaItemId}`,
        });
        // orchestrator writes identityKey(taskId, computeIdentity(task, input))
        //   = task:identity:<taskId>:<taskId>~~<formula>
        expect(buildIdentityProbeKey(t, ITEM)).toBe(`task:identity:demo:demo~~item-${ITEM}`);
    });

    it('exclusive per-item task whose identityFor returns the bare id', () => {
        const t = task({
            exclusiveWith: {
                ttl: '24h',
            } as unknown as TaskDefinition['exclusiveWith'],
            identityFor: idOf,
        });
        expect(buildIdentityProbeKey(t, ITEM)).toBe(`task:identity:demo:demo~~${ITEM}`);
    });

    it('exclusive shared/global identity does not establish a per-item lock probe', () => {
        const t = task({
            exclusiveWith: {
                ttl: '24h',
            } as unknown as TaskDefinition['exclusiveWith'],
            identityFor: () => 'global',
        });
        expect(buildIdentityProbeKey(t, ITEM)).toBeNull();
    });

    it('identityFor returning a reserved-char formula → null (sanitize throws, never guess)', () => {
        const t = task({
            exclusiveWith: {
                ttl: '24h',
            } as unknown as TaskDefinition['exclusiveWith'],
            identityFor: () => 'a:b',
        });
        expect(buildIdentityProbeKey(t, ITEM)).toBeNull();
    });
});

it('does not mistake an analyzer-style input contract for a verified item-specific identity', () => {
    const t = task({
        exclusiveWith: { scope: 'global', ttl: '8h' },
        identityFor: (input) => {
            const value = input as { mediaId?: string; seasonId?: string };
            return value.mediaId
                ? `media-${value.mediaId}`
                : value.seasonId
                  ? `season-${value.seasonId}`
                  : 'global';
        },
    });
    expect(buildIdentityProbeKey(t, ITEM)).toBeNull();
});
