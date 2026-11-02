// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { liveTvLogoUrl } from './livetv-logo-url';

describe('liveTvLogoUrl', () => {
    it('uses the entity image route the channel bar uses, not the catalog route', () => {
        const url = liveTvLogoUrl('f767cbee-18cf-4dc0-a6ad-7a1d599f36e8');
        expect(url).toMatch(
            /\/api\/media\/f767cbee-18cf-4dc0-a6ad-7a1d599f36e8\/images\/poster\?size=thumb$/,
        );
        expect(url).not.toContain('/image/catalog/');
    });
});
