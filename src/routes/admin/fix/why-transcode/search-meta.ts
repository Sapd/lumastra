// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { AdminSearchMeta } from '$lib/config/admin-search-meta';
import { findSymptom } from '$lib/components/admin/fix/symptoms';

export const searchMeta: AdminSearchMeta = {
    title: () => findSymptom('why-transcode')?.title() ?? 'why-transcode',
};
