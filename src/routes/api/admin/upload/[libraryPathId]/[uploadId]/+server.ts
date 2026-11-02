// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DELETE /api/admin/upload/[libraryPathId]/[uploadId]
 * Contract: bare { deleted: true }; errors → problem+json.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/upload/[libraryPathId]/[uploadId].js';

export const { GET, DELETE } = mount(def, { surface: 'internal' });
