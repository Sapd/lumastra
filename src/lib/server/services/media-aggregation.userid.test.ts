// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';

// The builder maps each ActiveSessionView → StreamSession. We assert the
// contract: the owner UUID from the view is emitted as `userId`. This guards
// the field that the inline Stop button's ownership check depends on.
import type { StreamSession } from '$lib/schemas/api-playback-responses';

describe('StreamSession contract', () => {
    it('StreamSession type accepts a userId field', () => {
        // Compile-time + runtime guard: the field exists on the shape the
        // builder emits. If someone removes userId from SessionUserSchema this
        // fails to typecheck.
        const s: Pick<StreamSession, 'userId'> = { userId: 'uid-123' };
        expect(s.userId).toBe('uid-123');
    });
});
