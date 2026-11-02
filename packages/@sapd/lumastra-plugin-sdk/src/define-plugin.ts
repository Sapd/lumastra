// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

import { defineTask } from './define-task.js';
import { defineProvider } from './define-provider.js';
import { defineTrickplayProvider } from './define-trickplay-provider.js';
import { defineWatchSync } from './define-watch-sync.js';
import { defineFeature } from './define-feature.js';
import { defineIntegration } from './define-integration.js';
import { defineMediaSource } from './define-media-source.js';
import { defineExternalService } from './define-external-service.js';
import { defineSubtitleProvider } from './define-subtitle-provider.js';
import { defineLyricsProvider } from './define-lyrics-provider.js';
import { defineAuthProvider } from './define-auth-provider.js';
import type { PluginDefinition } from './types.js';

export function definePlugin(def: PluginDefinition): PluginDefinition {
    if (
        !def.tasks?.length &&
        !def.providers?.length &&
        !def.trickplayProviders?.length &&
        !def.watchSyncs?.length &&
        !def.features?.length &&
        !def.integrations?.length &&
        !def.mediaSources?.length &&
        !def.externalServices?.length &&
        !def.subtitleProviders?.length &&
        !def.lyricsProviders?.length &&
        !def.authProviders?.length
    ) {
        throw new Error('definePlugin: at least one contract array must be non-empty');
    }

    if (def.tasks) {
        def.tasks.forEach((t) => defineTask(t));
    }
    if (def.providers) {
        def.providers.forEach((p) => defineProvider(p));
    }
    if (def.trickplayProviders) {
        def.trickplayProviders.forEach((tp) => defineTrickplayProvider(tp));
    }
    if (def.watchSyncs) {
        def.watchSyncs.forEach((ws) => defineWatchSync(ws));
    }
    if (def.features) {
        def.features.forEach((f) => defineFeature(f));
    }
    if (def.integrations) {
        def.integrations.forEach((i) => defineIntegration(i));
    }
    if (def.mediaSources) {
        def.mediaSources.forEach((ms) => defineMediaSource(ms));
    }
    if (def.externalServices) {
        def.externalServices.forEach((svc) => defineExternalService(svc));
    }
    if (def.subtitleProviders) {
        def.subtitleProviders.forEach((sp) => defineSubtitleProvider(sp));
    }
    if (def.lyricsProviders) {
        def.lyricsProviders.forEach((lp) => defineLyricsProvider(lp));
    }
    if (def.authProviders) {
        def.authProviders.forEach((ap) => defineAuthProvider(ap));
    }

    return def;
}
