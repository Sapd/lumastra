// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/upload/[libraryPathId]/ancillary/[mediaItemId]
 * Contract: bare { path, type }; errors → problem+json.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/upload/[libraryPathId]/ancillary.js';

export const { POST } = mount(def, { surface: 'internal' });
