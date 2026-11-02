// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Component Registry for Admin Settings Inputs
 *
 * Maps setting types to their corresponding Svelte components.
 * This pattern eliminates type-based branching and enables:
 * - Open-Closed Principle compliance (add types without modifying code)
 * - Type safety via TypeScript `satisfies`
 * - Plugin extensibility (runtime registry modification)
 * - Testability (each component isolated)
 *
 * Usage:
 * ```typescript
 * import { inputRegistry } from './registry';
 * const InputComponent = inputRegistry.boolean; // BooleanInput.svelte
 * ```
 *
 * @module components/admin/inputs/registry
 */

import type { Component } from 'svelte';
import type { SettingDefinition } from '$lib/config/schema';
import BooleanInput from './BooleanInput.svelte';
import SelectInput from './SelectInput.svelte';
import NumberInput from './NumberInput.svelte';
import ArrayInput from './ArrayInput.svelte';
import GroupArrayInput from './GroupArrayInput.svelte';
import MultilineInput from './MultilineInput.svelte';
import KeyValueInput from './KeyValueInput.svelte';
import TextInput from './TextInput.svelte';
import ColorInput from './ColorInput.svelte';

// Svelte 5 component type
type InputComponent = Component<BaseInputProps>;

/**
 * Setting option type for select inputs.
 */
export interface SettingOption {
    value: string | number | boolean;
    label: string;
}

/**
 * Common props interface that all input components must implement.
 * Ensures consistency across all input types.
 */
export interface BaseInputProps {
    /** Setting definition with type, validation, UI hints */
    setting: SettingDefinition;
    /** Current value */
    value: unknown;
    /** Disabled state */
    disabled?: boolean;
    /** ENV-locked state */
    envLocked?: boolean;
    /** Reason why setting is disabled */
    disabledReason?: string;
    /** All setting values (for option dependency filtering) */
    allValues?: Record<string, unknown>;
    /** Change callback */
    onchange?: (value: unknown) => void;
    /** Save ENV to config callback */
    onsaveEnvToConfig?: (value: unknown) => void;
}

/**
 * Registry mapping setting types to their input components.
 * TypeScript `satisfies` ensures completeness and type safety.
 */
export const inputRegistry = {
    boolean: BooleanInput,
    select: SelectInput,
    number: NumberInput,
    array: ArrayInput,
    /**
     * Not a setting `type` — a hint-derived variant selected by
     * {@link getInputComponent} for `uiHints.groups`. Registered here rather than
     * branched inside ArrayInput so the registry stays the one place that answers
     * "which component renders this setting".
     */
    'array-groups': GroupArrayInput,
    multiline: MultilineInput,
    keyvalue: KeyValueInput,
    text: TextInput,
    color: ColorInput,
    // Aliases for common types
    url: TextInput,
    path: TextInput,
    string: TextInput,
} satisfies Record<string, InputComponent>;

/**
 * Type guard to check if a setting type has a registered component.
 */
export function hasInputComponent(type: string): type is keyof typeof inputRegistry {
    return type in inputRegistry;
}

/**
 * Get input component for a setting type.
 * Falls back to TextInput for unknown types.
 */
export function getInputComponent(type: string): InputComponent {
    return inputRegistry[type as keyof typeof inputRegistry] ?? inputRegistry.text;
}

/**
 * Resolve the component for a full setting definition, applying the `uiHints` that
 * select a variant rather than a type.
 *
 * Both hint rules live here together. `multiline` used to be resolved inline at the
 * single call site, which was fine while it was the only one; adding `groups` there
 * too would have put half the routing logic in a component and half in this module.
 *
 * Plugin panels keep calling {@link getInputComponent} with a bare type string —
 * plugin fields have no `uiHints`, so there is no variant to resolve.
 */
export function getInputComponentForSetting(setting: SettingDefinition): InputComponent {
    if (setting.uiHints?.multiline) return inputRegistry.multiline;
    // Group-valued arrays get the picker; a group-tagged NON-array (there is one:
    // AGE_RATING_GROUP_PREFIX, a plain string) must not, or a prefix would render
    // as a chip list.
    if (setting.type === 'array' && setting.uiHints?.groups) return inputRegistry['array-groups'];
    return getInputComponent(setting.type);
}

/**
 * Runtime registry extension API for plugins.
 * Allows plugins to register custom input components.
 *
 * Example:
 * ```typescript
 * import { registerInputComponent } from '$lib/components/admin/inputs/registry';
 * import CustomInput from './CustomInput.svelte';
 *
 * registerInputComponent('custom', CustomInput);
 * ```
 */
export function registerInputComponent(type: string, component: InputComponent): void {
    (inputRegistry as Record<string, InputComponent>)[type] = component;
}
