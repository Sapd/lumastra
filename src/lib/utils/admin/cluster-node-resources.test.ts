// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { formatBinaryBytes, formatCores, usageRatio, memoryLevel } from './cluster-node-resources';

describe('formatBinaryBytes', () => {
    it('uses binary units matching Kubernetes Mi/Gi limits', () => {
        expect(formatBinaryBytes(512)).toBe('512 B');
        expect(formatBinaryBytes(768 * 1024 ** 2)).toBe('768 MiB');
        expect(formatBinaryBytes(4 * 1024 ** 3)).toBe('4.0 GiB');
        expect(formatBinaryBytes(1.5 * 1024 ** 3)).toBe('1.5 GiB');
    });
});

describe('formatCores', () => {
    it('keeps small values readable', () => {
        expect(formatCores(0.354)).toBe('0.35');
        expect(formatCores(0)).toBe('0');
        expect(formatCores(1.54)).toBe('1.5');
        expect(formatCores(2)).toBe('2');
        expect(formatCores(12.4)).toBe('12');
    });
});

describe('usageRatio / memoryLevel', () => {
    it('is null without a limit and levels by threshold', () => {
        expect(usageRatio(100, undefined)).toBeNull();
        expect(usageRatio(undefined, 100)).toBeNull();
        expect(memoryLevel(null)).toBe('ok');
        expect(memoryLevel(usageRatio(50, 100))).toBe('ok');
        expect(memoryLevel(usageRatio(80, 100))).toBe('warn');
        expect(memoryLevel(usageRatio(95, 100))).toBe('critical');
    });
});
