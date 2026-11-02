// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { externalPluginsDir, lastLoadError } from './loader.js';

describe('loader extraction primitives', () => {
    it('externalPluginsDir reads process.env per call [review C7]', () => {
        const prev = process.env.PLUGINS_EXTERNAL_DIR;
        try {
            process.env.PLUGINS_EXTERNAL_DIR = '/tmp/x-one';
            expect(externalPluginsDir()).toBe('/tmp/x-one');
            process.env.PLUGINS_EXTERNAL_DIR = '/tmp/x-two';
            expect(externalPluginsDir()).toBe('/tmp/x-two');
        } finally {
            if (prev === undefined) delete process.env.PLUGINS_EXTERNAL_DIR;
            else process.env.PLUGINS_EXTERNAL_DIR = prev;
        }
    });
    it('lastLoadError is an exported, mutable Map [review C12]', () => {
        expect(lastLoadError instanceof Map).toBe(true);
        lastLoadError.set('probe', 'boom');
        expect(lastLoadError.get('probe')).toBe('boom');
        lastLoadError.delete('probe');
    });
});
