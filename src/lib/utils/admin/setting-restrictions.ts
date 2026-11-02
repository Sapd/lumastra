// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { configSchema, configSections, type SettingDefinition } from '$lib/config/schema';
import { getPageForSection } from '$lib/config/admin-settings-pages';
import { buildSettingDeepLink } from './settings-search';
import * as m from '$lib/paraglide/messages.js';

export interface SettingRestriction {
    key: string;
    label: string;
    reason: string;
    href?: string;
}

/** Resolve the actual blocker through the complete schema, including cross-section ancestors. */
export function getSettingRestriction(
    setting: SettingDefinition,
    values: Record<string, unknown>,
    sectionFeature?: string,
    schema: readonly SettingDefinition[] = configSchema,
    devFeaturesEnabled = false,
): SettingRestriction | undefined {
    const visited = new Set<string>();
    function restriction(key: string, reason: (label: string) => string): SettingRestriction {
        const controller = schema.find((candidate) => candidate.key === key);
        const label = controller?.label ?? key;
        const section = configSections.find(
            (candidate) =>
                candidate.id === controller?.section ||
                (!controller && candidate.featureFlag === key),
        );
        const page = section && getPageForSection(section.id);
        const href =
            controller &&
            !controller.uiHints?.hidden &&
            (!controller.uiHints?.devOnly || devFeaturesEnabled) &&
            section &&
            page
                ? buildSettingDeepLink({
                      setting: controller,
                      section,
                      pageHref: page.href,
                      pageLabel: page.label,
                      tab: page.tab,
                  })
                : undefined;
        const headerHref =
            !controller && section && page
                ? `${page.href}?${page.tab ? `tab=${encodeURIComponent(page.tab)}&` : ''}section=${encodeURIComponent(section.id)}`
                : undefined;
        return { key, label, reason: reason(label), href: href ?? headerHref };
    }
    function conditionValue(key: string, value: unknown): string {
        const controller = schema.find((candidate) => candidate.key === key);
        const options = controller?.options ?? controller?.validation?.options;
        const option = options?.find((candidate) => candidate.value === value);
        if (option) return option.label;
        if (typeof value === 'boolean')
            return value ? m.admin_settings_value_enabled() : m.admin_settings_value_disabled();
        return String(value);
    }
    function walk(current: SettingDefinition): SettingRestriction | undefined {
        if (visited.has(current.key)) return undefined;
        visited.add(current.key);
        const parents = [current.dependsOn, current.showWhen?.key].filter(
            (key): key is string => !!key,
        );
        for (const key of parents) {
            const parent = schema.find((candidate) => candidate.key === key);
            if (parent) {
                const ancestor = walk(parent);
                if (ancestor) return ancestor;
            }
        }
        if (current.dependsOn && !values[current.dependsOn]) {
            return restriction(current.dependsOn, (label) =>
                m.admin_settings_requires_enabled({ label }),
            );
        }
        const condition = current.showWhen;
        if (condition?.equals !== undefined && values[condition.key] !== condition.equals) {
            return restriction(condition.key, (label) =>
                m.admin_settings_requires_value({
                    label,
                    value: conditionValue(condition.key, condition.equals),
                }),
            );
        }
        if (condition?.notEquals !== undefined && values[condition.key] === condition.notEquals) {
            return restriction(condition.key, (label) =>
                m.admin_settings_requires_other_value({
                    label,
                    value: conditionValue(condition.key, condition.notEquals),
                }),
            );
        }
        return undefined;
    }
    if (sectionFeature && sectionFeature !== setting.key && !values[sectionFeature]) {
        return restriction(sectionFeature, (label) => m.admin_settings_requires_enabled({ label }));
    }
    return walk(setting);
}
