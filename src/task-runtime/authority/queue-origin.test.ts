// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuthorityError } from './store.js';
import {
    assertTaskJobOrigin,
    taskJobId,
    taskJobOrigin,
    unmanagedTaskJobId,
} from './queue-origin.js';

const token = { partition: 'tasks', generation: '1', ownerId: randomUUID() };
describe('immutable queue job provenance', () => {
    it('retains compatibility IDs and keeps the existing final run suffix', () => {
        expect(taskJobId('fixture~~global#run_123', undefined)).toBe('fixture~~global#run_123');
        const encoded = taskJobId('fixture~~global#run_123', token);
        expect(encoded.endsWith('#run_123')).toBe(true);
        expect(encoded.includes(':')).toBe(false);
        expect(taskJobOrigin(encoded)).toEqual(token);
        expect(Object.isFrozen(taskJobOrigin(encoded))).toBe(true);
        assertTaskJobOrigin(token, token, encoded);
    });
    it('round-trips unmanaged formulas containing the marker without misclassifying them', () => {
        const id = 'fixture~~path~task-owner-v1~invalid/file#run_123';
        expect(taskJobId(id, undefined)).toBe(id);
        expect(taskJobOrigin(id)).toBeUndefined();
        assertTaskJobOrigin(undefined, undefined, id);
        const stamped = taskJobId(id, token);
        expect(taskJobOrigin(stamped)).toEqual(token);
        expect(unmanagedTaskJobId(stamped)).toBe(id);
    });
    it('rejects adoption, missing stamps and conflicting data before delivery', () => {
        const encoded = taskJobId('fixture#run_123', token);
        expect(() => assertTaskJobOrigin({ ...token, generation: '2' }, token, encoded)).toThrow();
        expect(() => assertTaskJobOrigin(token, token, 'fixture#run_123')).toThrow();
        expect(() => assertTaskJobOrigin(token, undefined, encoded)).toThrow();
        expect(() => assertTaskJobOrigin(token, { generation: 'invalid' }, encoded)).toThrow(
            AuthorityError,
        );
        expect(() => assertTaskJobOrigin(undefined, token, encoded)).toThrow();
        expect(() => taskJobOrigin('fixture#~task-owner-v1~invalid#run_123')).toThrow();
    });
});
