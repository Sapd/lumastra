// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/paths', () => ({ base: '' }));

import { buildImageDescriptor, buildImageSet } from './image-descriptor.js';

describe('image descriptor builders', () => {
    it('builds ready hrefs with revision and variants', () => {
        const d = buildImageDescriptor('v1', 'poster', { ownerId: 'abc', revision: 'r7', source: 'series' });
        expect(d.href).toBe('/api/v1/media/abc/images/poster?size=card&v=r7');
        expect(d.variants?.thumb).toBe('/api/v1/media/abc/images/poster?size=thumb&v=r7');
        expect(d.source).toBe('series');
        expect(d.revision).toBe('r7');
    });
    it('maps music primary onto the poster route and omits absent roles', () => {
        const s = buildImageSet('internal', { primary: { ownerId: 'x', urlRole: 'poster' }, backdrop: undefined });
        expect(s.primary?.href).toBe('/api/media/x/images/poster?size=card&v=1');
        expect(s.backdrop).toBeUndefined();
    });
});
