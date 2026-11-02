// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lumastra Playback UI Tests (Standalone Mode)
 *
 * Verifies full browser playback for items discovered by the file scanner.
 *
 * TODO: Implement after Task #7 (file scanner plugin) is complete.
 *
 * Scenarios to cover:
 * - File scanner adds item → player page loads
 * - <video> element reaches readyState >= 2 (has data)
 * - Viewing session is created in DB after playback starts
 * - Playback progress is reported
 */

import { adminTest as test } from './fixtures/auth';

test.describe('Lumastra playback — standalone mode', () => {
    test.skip('TODO: implement after Task #7 (file scanner)', () => {});
});
