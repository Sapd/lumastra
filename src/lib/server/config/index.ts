// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Configuration Module Exports
 *
 * Re-exports from schema and service for clean imports:
 *
 * ```typescript
 * import { get, getAll, saveConfig, configSchema } from '$lib/server/config';
 * ```
 */

// Schema exports (re-exported from shared location)
export {
    configSchema,
    configSections,
    getSettingsBySection,
    getSettingDefinition,
    getRootSettings,
    getChildSettings,
    groupSettingsByParent,
    isSettingVisible,
    isSettingEnabled,
    getDefaultValues,
    validateSettingValue,
    validateSchema,
    type SettingDefinition,
    type SectionDefinition,
    type SettingType,
    type ValidationRules,
    type UiHints,
} from '$lib/config/schema.js';

// Service exports
export {
    initConfigServiceSync,
    initConfigService,
    get,
    getAll,
    isEnvOverridden,
    getEnvOverriddenKeys,
    getConfigState,
    getSchema,
    saveConfig,
    reloadConfig,
    getConfigForAdmin,
    getConfigPath,
    getConfigStorageStatus,
    isSensitiveKey,
    onConfigChange,
    getPendingRestartKeys,
    valueToEnvString,
    type ConfigValues,
    type ConfigState,
    type SaveConfigOptions,
    type ConfigChangeListener,
    type ConfigStorageStatus,
} from './config.service.js';
