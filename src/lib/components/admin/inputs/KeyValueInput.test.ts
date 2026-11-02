// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { inputRegistry } from './registry.js';

describe('input registry keyvalue', () => {
    it('registers a keyvalue input component', () => {
        expect(inputRegistry.keyvalue).toBeDefined();
    });
});
