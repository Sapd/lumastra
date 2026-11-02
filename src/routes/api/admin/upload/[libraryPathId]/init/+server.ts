// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/upload/[libraryPathId]/init
 * Contract: bare object 201; errors → problem+json.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/upload/[libraryPathId]/init.js';

export const { POST } = mount(def, { surface: 'internal' });
