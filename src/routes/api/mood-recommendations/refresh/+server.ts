// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { mount } from '$lib/server/api/mount.js';
import { refreshDef as def } from '../handlers.js';
export const { POST } = mount(def, { surface: 'internal' });
