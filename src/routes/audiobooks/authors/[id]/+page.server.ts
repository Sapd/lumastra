// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';
import { loadAudiobookResource } from '../../resource-load';

export const load: PageServerLoad = (event) => loadAudiobookResource(event, 'authors');
