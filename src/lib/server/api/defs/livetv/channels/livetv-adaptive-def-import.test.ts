// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';

describe('Live TV adaptive OpenAPI definition', () => {
    test('imports the adaptive master definition without dropping the route', async () => {
        const module = await import('./[id]/stream/a/master.m3u8.js');

        expect(module.def).toBeDefined();
    });
});
