// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

export * from './types.js';
export * from './errors.js';
export { defineTask, defineTaskFromSchema } from './define-task.js';
export type { TaskInputOf } from './define-task.js';
export { defineProvider } from './define-provider.js';
export { defineTrickplayProvider } from './define-trickplay-provider.js';
export { defineWatchSync } from './define-watch-sync.js';
export type { WatchSyncAutoTaskOpts, WatchSyncWithAutoTasks } from './define-watch-sync.js';
export { defineFeature } from './define-feature.js';
export { defineIntegration } from './define-integration.js';
export { defineExternalService } from './define-external-service.js';
export { defineMediaSource } from './define-media-source.js';
export { defineSubtitleProvider } from './define-subtitle-provider.js';
export { defineLyricsProvider } from './define-lyrics-provider.js';
export { defineAuthProvider } from './define-auth-provider.js';
export { definePlugin } from './define-plugin.js';
