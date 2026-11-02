// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect } from '@playwright/test';
import { expectHydrated } from '../helpers/hydration';
import { webUrl } from './wt-env';
import { scenario } from './wt-harness';

declare global {
    interface Window {
        revealHomeWidget: (id: string) => void;
    }
}

scenario(
    'home widgets preserve viewport-based mounting',
    {
        directions: ['A hosts'],
        tag: ['@chromium-only', '@pr'],
    },
    async (s) => {
        await s.movie();
        const widgets = [
            ['trending', '360px'],
            ['upcoming-episodes', '700px'],
            ['calendar', '520px'],
        ];
        const participant = await s.participant(s.hostUser, 'host-home-widgets');
        const page = participant.page;
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        // Hold only LazyMount's viewport boundary. Other observers keep behaving
        // normally; each widget can then be released independently and observed.
        await page.addInitScript(() => {
            const Native = window.IntersectionObserver;
            const held = new Map<
                IntersectionObserver,
                {
                    callback: ConstructorParameters<typeof IntersectionObserver>[0];
                    targets: Set<Element>;
                }
            >();
            window.IntersectionObserver = class extends Native {
                private held: boolean;
                constructor(
                    callback: ConstructorParameters<typeof IntersectionObserver>[0],
                    options?: ConstructorParameters<typeof IntersectionObserver>[1],
                ) {
                    super(callback, options);
                    this.held = options?.rootMargin === '600px 0px';
                    if (this.held) held.set(this, { callback, targets: new Set() });
                }
                observe(target: Element): void {
                    if (this.held) held.get(this)?.targets.add(target);
                    else super.observe(target);
                }
                disconnect(): void {
                    held.delete(this);
                    super.disconnect();
                }
            };
            window.revealHomeWidget = (id) => {
                for (const [observer, entry] of [...held]) {
                    for (const target of entry.targets) {
                        if (target.closest(`#widget-${id}`)) {
                            entry.callback(
                                [{ target, isIntersecting: true } as IntersectionObserverEntry],
                                observer,
                            );
                        }
                    }
                }
            };
        });
        await page.goto(webUrl());
        await expectHydrated(page);
        const mountedWidgets: string[][] = [];
        for (const [id, height] of widgets) {
            // Calendar requires a configured integration. The other two are
            // enabled in the suite's default configuration.
            if (id !== 'calendar') await expect(page.locator(`#widget-${id}`)).toBeAttached();
            if (await page.locator(`#widget-${id}`).count()) {
                mountedWidgets.push([id, height]);
                await expect(
                    page.locator(`#widget-${id} [style*="min-height: ${height}"]`),
                ).toHaveCount(1);
            }
        }
        expect(mountedWidgets.length).toBeGreaterThanOrEqual(2);
        for (const [id, height] of mountedWidgets) {
            await page.evaluate((id) => window.revealHomeWidget(id), id);
            await expect(
                page.locator(`#widget-${id} [style*="min-height: ${height}"]`),
            ).toHaveCount(0);
        }
        expect(errors).toEqual([]);
    },
);
