// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { defineExternalService } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../../registry.js';
import { getAiConfig } from '../../../../config/domains/ai.js';

export const openaiExternalService = defineExternalService({
    id: 'openai',
    name: 'OpenAI',
    version: '1.0.0',
    description: 'AI embeddings and recommendations via OpenAI',
    capabilities: { http: true },
    // No settings of its own: the key is a host setting (Settings → AI) that
    // isConfigured/isAvailable already read; a plugin copy was never read.
    isConfigured: () => getAiConfig().hasOpenai,
    isAvailable: () => getAiConfig().hasOpenai,
});

registry.registerExternalService(openaiExternalService);
