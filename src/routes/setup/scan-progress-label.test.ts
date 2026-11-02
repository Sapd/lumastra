// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest';
import { getLocale, overwriteGetLocale } from '$lib/paraglide/runtime.js';
const originalGetLocale = getLocale;
import { scanProgressLabel } from './scan-progress-label';

afterEach(() => overwriteGetLocale(originalGetLocale));

describe('scan progress labels', () => {
    it.each(['en', 'de'] as const)(
        'labels every scanner phase and runner state in %s',
        (locale) => {
            overwriteGetLocale(() => locale);
            for (const code of [
                'main',
                'discovering',
                'scanning',
                'Scanning files',
                'ancillary',
                'idle',
                'queued',
                'waiting',
                'delayed',
                'initializing',
                'starting',
                'active',
                'running',
                'paused',
                'cancelling',
                'completed',
                'error',
                'failed',
                'cancelled',
                'aborted',
            ]) {
                expect(scanProgressLabel(code), code).toBeTruthy();
                expect(scanProgressLabel(code), code).not.toBe(code);
            }
        },
    );
    it('uses German scan phases and leaves filenames for the caller', () => {
        overwriteGetLocale(() => 'de');
        expect(scanProgressLabel('main')).toBe('Bibliothek wird gescannt');
        expect(scanProgressLabel('discovering')).toBe('Dateien werden gesucht…');
        expect(scanProgressLabel('scanning')).toBe('Dateien werden gescannt…');
        expect(scanProgressLabel('ancillary')).toBe('Begleitdateien werden importiert…');
        expect(scanProgressLabel('/media/a.mkv')).toBeNull();
        expect(scanProgressLabel('future-phase')).toBeNull();
    });
});
