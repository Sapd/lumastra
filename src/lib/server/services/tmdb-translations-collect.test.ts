// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { collectTmdbTranslations } from './tmdb-translations-collect.js';

describe('collectTmdbTranslations', () => {
    const details = {
        translations: {
            translations: [
                {
                    iso_639_1: 'de',
                    iso_3166_1: 'DE',
                    data: {
                        title: 'Die Verschollenen',
                        overview: 'Zwei Männer…',
                        tagline: 'Slogan',
                    },
                },
                {
                    iso_639_1: 'pt',
                    iso_3166_1: 'BR',
                    data: { name: 'Um Sonho de Lanternas', overview: 'pt-BR…' },
                },
                { iso_639_1: 'pt', iso_3166_1: 'PT', data: { overview: 'pt-PT…' } },
            ],
        },
    };

    it('collects only admin-enabled languages with deterministic variants', () => {
        const out = collectTmdbTranslations(details, ['de', 'pt']);
        expect(out).toEqual([
            {
                language: 'de',
                title: 'Die Verschollenen',
                overview: 'Zwei Männer…',
                tagline: 'Slogan',
            },
            { language: 'pt', title: 'Um Sonho de Lanternas', overview: 'pt-BR…', tagline: null },
        ]);
        expect(collectTmdbTranslations(details, [])).toEqual([]);
        expect(collectTmdbTranslations({}, ['de'])).toEqual([]);
    });
});
