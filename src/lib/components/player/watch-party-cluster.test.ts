// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    computeClusterDisplay,
    getAvatarSizeForIndex,
    CLUSTER_MAX_VISIBLE,
} from './watch-party-cluster';
import type { WatchTogetherParticipant } from '$lib/schemas/watch-together-core-types';

function p(userId: string): WatchTogetherParticipant {
    return {
        userId,
        displayName: userId,
        images: { primary: { href: `/avatar/${userId}`, revision: '0', source: 'self' as const } },
        joinedAt: 0,
        clientId: userId,
    };
}

describe('computeClusterDisplay', () => {
    it('solo party: just the current user', () => {
        const result = computeClusterDisplay([p('you')], 'you');
        expect(result.visible).toHaveLength(1);
        expect(result.visible[0].userId).toBe('you');
        expect(result.overflowCount).toBe(0);
    });

    it('two participants: other left, you right', () => {
        const result = computeClusterDisplay([p('you'), p('alice')], 'you');
        expect(result.visible).toHaveLength(2);
        expect(result.visible[0].userId).toBe('alice');
        expect(result.visible[1].userId).toBe('you');
        expect(result.overflowCount).toBe(0);
    });

    it('exactly MAX_VISIBLE participants: no overflow', () => {
        const result = computeClusterDisplay([p('you'), p('a'), p('b')], 'you');
        expect(result.visible).toHaveLength(3);
        expect(result.visible[2].userId).toBe('you');
        expect(result.overflowCount).toBe(0);
    });

    it('more than MAX_VISIBLE: overflow count, you always visible', () => {
        const result = computeClusterDisplay([p('you'), p('a'), p('b'), p('c')], 'you');
        expect(result.visible).toHaveLength(3);
        expect(result.visible[2].userId).toBe('you');
        expect(result.overflowCount).toBe(1);
    });

    it('current user not in list: shows others only', () => {
        const result = computeClusterDisplay([p('a'), p('b')], 'you');
        expect(result.visible).toHaveLength(2);
        expect(result.overflowCount).toBe(0);
    });

    it('same user on multiple devices (multi-clientId): shows only one self avatar', () => {
        const self1 = {
            userId: 'you',
            displayName: 'you',
            images: { primary: { href: '/avatar/you', revision: '0', source: 'self' as const } },
            joinedAt: 0,
            clientId: 'device-1',
        };
        const self2 = {
            userId: 'you',
            displayName: 'you',
            images: { primary: { href: '/avatar/you', revision: '0', source: 'self' as const } },
            joinedAt: 1,
            clientId: 'device-2',
        };
        const result = computeClusterDisplay([self1, self2, p('alice')], 'you');
        const selfAvatars = result.visible.filter((v) => v.userId === 'you');
        expect(selfAvatars).toHaveLength(1);
        expect(result.visible.length).toBeLessThanOrEqual(CLUSTER_MAX_VISIBLE);
        expect(result.visible[result.visible.length - 1].userId).toBe('you');
    });
});

describe('getAvatarSizeForIndex', () => {
    it('single visible avatar is always 44px', () => {
        expect(getAvatarSizeForIndex(0, 1)).toBe(44);
    });

    it('two avatars: 36px then 44px', () => {
        expect(getAvatarSizeForIndex(0, 2)).toBe(36);
        expect(getAvatarSizeForIndex(1, 2)).toBe(44);
    });

    it('three avatars: 30px, 36px, 44px', () => {
        expect(getAvatarSizeForIndex(0, 3)).toBe(30);
        expect(getAvatarSizeForIndex(1, 3)).toBe(36);
        expect(getAvatarSizeForIndex(2, 3)).toBe(44);
    });

    it('out-of-range index falls back to largest size', () => {
        expect(getAvatarSizeForIndex(5, 3)).toBe(44);
    });

    it('maxVisible=0 produces empty visible list with no overflow', () => {
        const result = computeClusterDisplay([p('you'), p('alice')], 'you', 0);
        expect(result.visible).toHaveLength(0);
        expect(result.overflowCount).toBe(1); // alice overflows
    });
});
