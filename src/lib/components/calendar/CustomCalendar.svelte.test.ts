// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages';
import CustomCalendar from './CustomCalendar.svelte';

vi.mock('$app/environment', () => ({ browser: true }));

function releases(): Array<{
    start: Date;
    end: Date;
    titleHTML: string;
    imageUrl: string;
    backdropUrl: string;
    extendedProps: { title: string };
}> {
    return Array.from({ length: 9 }, (_, i) => ({
        start: new Date(new Date().setHours(12, i, 0, 0)),
        end: new Date(new Date().setHours(12, i, 0, 0)),
        titleHTML: `<div class="calendar-image"><span class="calendar-poster"></span><div class="calendar-content">Release ${i + 1}</div></div>`,
        imageUrl: `/artwork/${i}.jpg`,
        backdropUrl: `/backdrops/${i}.jpg`,
        extendedProps: { title: `Release ${i + 1}` },
    }));
}

beforeEach(() => {
    localStorage.clear();
    window.innerWidth = 1400;
});
afterEach(cleanup);

describe('calendar release density', () => {
    it('starts with poster icons, expands a day on demand, and preserves event activation', async () => {
        const onEventClick = vi.fn();
        const { container, getByRole } = render(CustomCalendar, {
            view: 'week',
            locale: 'en',
            eventSources: [{ events: async () => releases() }],
            onEventClick,
        });
        await waitFor(() =>
            expect(container.querySelectorAll('.calendar-day-thumb')).toHaveLength(9),
        );
        const first = container.querySelector('.calendar-day-thumb')!;
        await fireEvent.focus(first);
        await waitFor(() =>
            expect(first.getAttribute('aria-describedby')).toBe('calendar-week-thumb-tooltip'),
        );
        await fireEvent.keyDown(first, { key: 'Escape' });
        expect(first.getAttribute('aria-describedby')).toBeNull();
        expect(first.querySelector('.calendar-week-title')).toBeNull();
        const expand = container.querySelector('.calendar-day-count')!;
        expect(expand.getAttribute('aria-expanded')).toBe('false');
        await fireEvent.click(expand);
        expect(expand.getAttribute('aria-expanded')).toBe('true');
        expect(first.getAttribute('style')).toContain('/backdrops/0.jpg');
        expect(first.querySelector('.calendar-week-title')?.textContent).toBe('Release 1');
        expect(onEventClick).not.toHaveBeenCalled();
        await fireEvent.click(expand);
        expect(first.querySelector('.calendar-week-title')).toBeNull();
        expect(expand.getAttribute('aria-expanded')).toBe('false');
        expect(first.querySelector('.calendar-week-poster')?.getAttribute('style')).toContain(
            '/artwork/0.jpg',
        );
        // A collapsed single-release thumb opens the event directly (no expand step)
        await fireEvent.keyDown(first, { key: 'Enter' });
        expect(onEventClick).toHaveBeenCalledOnce();
        expect(first.querySelector('.calendar-week-title')).toBeNull();
        await fireEvent.click(first);
        expect(onEventClick).toHaveBeenCalledTimes(2);
        await fireEvent.focus(first);
        await waitFor(() =>
            expect(document.getElementById('calendar-week-thumb-tooltip')?.className).toContain(
                'pointer-events-none',
            ),
        );
        await fireEvent.click(getByRole('button', { name: m.calendar_week_detailed() }));
        await waitFor(() =>
            expect(container.querySelectorAll('.calendar-rail-col .calendar-event')).toHaveLength(
                9,
            ),
        );
        expect(localStorage.getItem('calendar-week-style')).toBe('detailed');
        expect(
            container.querySelector('.calendar-backdrop-event')?.getAttribute('style'),
        ).toContain('/backdrops/0.jpg');
    });

    it('a touch tap only previews a release; Details (or a second tap) opens it', async () => {
        const onEventClick = vi.fn();
        const { container, findByRole } = render(CustomCalendar, {
            view: 'week',
            locale: 'en',
            eventSources: [{ events: async () => releases() }],
            onEventClick,
        });
        await waitFor(() =>
            expect(container.querySelectorAll('.calendar-day-thumb')).toHaveLength(9),
        );
        const first = container.querySelector('.calendar-day-thumb')!;
        const tap = async (): Promise<void> => {
            await fireEvent.pointerDown(first, { pointerType: 'touch' });
            await fireEvent.focus(first);
            await fireEvent.click(first);
        };
        await tap();
        expect(onEventClick).not.toHaveBeenCalled();
        const details = await findByRole('button', { name: m.calendar_preview_details() });
        expect(document.getElementById('calendar-week-thumb-tooltip')?.className).not.toContain(
            'pointer-events-none',
        );
        // The anchor's blur (iOS never focuses the Details button) must not close it.
        await fireEvent.blur(first);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await fireEvent.click(details);
        expect(onEventClick).toHaveBeenCalledOnce();
        expect(document.getElementById('calendar-week-thumb-tooltip')).toBeNull();
        await tap();
        expect(onEventClick).toHaveBeenCalledOnce();
        await tap();
        expect(onEventClick).toHaveBeenCalledTimes(2);
        // An outside tap dismisses a pinned preview without opening anything.
        await tap();
        await fireEvent.pointerDown(document.body, { pointerType: 'touch' });
        expect(document.getElementById('calendar-week-thumb-tooltip')).toBeNull();
        // A keypress after a tap is keyboard input: Enter opens directly.
        await fireEvent.keyDown(first, { key: 'Enter' });
        expect(onEventClick).toHaveBeenCalledTimes(3);
    });

    it('a mouse click opens a release directly, even right after page load', async () => {
        const now = vi.spyOn(performance, 'now').mockReturnValue(10);
        const onEventClick = vi.fn();
        const { container } = render(CustomCalendar, {
            view: 'week',
            locale: 'en',
            eventSources: [{ events: async () => releases() }],
            onEventClick,
        });
        await waitFor(() =>
            expect(container.querySelectorAll('.calendar-day-thumb')).toHaveLength(9),
        );
        const first = container.querySelector('.calendar-day-thumb')!;
        await fireEvent.pointerDown(first, { pointerType: 'mouse' });
        await fireEvent.click(first);
        expect(onEventClick).toHaveBeenCalledOnce();
        now.mockRestore();
    });

    it('a touch preview of an entry with nothing to open has no Details and closes on a second tap', async () => {
        const onEventClick = vi.fn();
        const { container, queryByRole } = render(CustomCalendar, {
            view: 'week',
            locale: 'en',
            eventSources: [{ events: async () => releases() }],
            onEventClick,
            canOpenEvent: () => false,
        });
        await waitFor(() =>
            expect(container.querySelectorAll('.calendar-day-thumb')).toHaveLength(9),
        );
        const first = container.querySelector('.calendar-day-thumb')!;
        const tap = async (): Promise<void> => {
            await fireEvent.pointerDown(first, { pointerType: 'touch' });
            await fireEvent.focus(first);
            await fireEvent.click(first);
        };
        await tap();
        expect(document.getElementById('calendar-week-thumb-tooltip')).not.toBeNull();
        expect(queryByRole('button', { name: m.calendar_preview_details() })).toBeNull();
        await tap();
        expect(document.getElementById('calendar-week-thumb-tooltip')).toBeNull();
        expect(onEventClick).not.toHaveBeenCalled();
    });

    it('keeps series grouped when expanded and fans out episodes on focus', async () => {
        const events = releases()
            .slice(0, 3)
            .map((event, index) => ({
                ...event,
                extendedProps: {
                    title: `Episode ${index + 1}`,
                    type: 'episode',
                    context: {
                        series: {
                            id: index < 2 ? 'series-tanya' : 'series-horses',
                            catalogId: null,
                            title: index < 2 ? 'Saga of Tanya the Evil' : 'Slow Horses',
                        },
                        seasonNumber: index === 1 ? 0 : 2,
                        episodeNumber: index + 1,
                    },
                },
            }));
        const onEventClick = vi.fn();
        const { container, getByRole } = render(CustomCalendar, {
            view: 'week',
            locale: 'en',
            eventSources: [{ events: async () => events }],
            onEventClick,
        });
        await waitFor(() =>
            expect(container.querySelectorAll('.calendar-day-thumb')).toHaveLength(2),
        );
        expect(container.querySelector('.calendar-day-count')?.textContent).toContain(
            '2 series · 3 episodes',
        );
        await fireEvent.click(container.querySelector('.calendar-day-count')!);
        expect(container.querySelectorAll('.calendar-week-title')).toHaveLength(2);
        const first = container.querySelector('.calendar-day-thumb')!;
        await fireEvent.focus(first);
        const preview = await waitFor(() => getByRole('dialog'));
        expect(preview.textContent).toContain(
            `${m.calendar_special_episode({ episode: '2' })} · Episode 2`,
        );
        expect(preview.textContent).toContain('S2E1 · Episode 1');
        expect(preview.textContent).not.toContain('Episode 3');
        expect(preview.querySelectorAll('button')).toHaveLength(2);
        await fireEvent.keyDown(first, { key: 'Escape' });
        expect(onEventClick).not.toHaveBeenCalled();
        await fireEvent.click(getByRole('button', { name: /Show less/ }));
        expect(container.querySelectorAll('.calendar-day-thumb')).toHaveLength(2);
    });

    it('shows a whole season in order and activates the chosen episode', async () => {
        const episodes = Array.from({ length: 10 }, (_, i) => ({
            ...releases()[0],
            extendedProps: {
                type: 'episode',
                context: {
                    series: { id: 'shorefolk', catalogId: null, title: 'Shorefolk' },
                    seasonNumber: 2,
                    episodeNumber: 10 - i,
                },
                title: `Episode ${10 - i}`,
            },
        }));
        const onEventClick = vi.fn();
        const { container, getByRole } = render(CustomCalendar, {
            view: 'week',
            locale: 'en',
            eventSources: [{ events: async () => episodes }],
            onEventClick,
        });
        await waitFor(() =>
            expect(container.querySelectorAll('.calendar-day-thumb')).toHaveLength(1),
        );
        const entry = container.querySelector('.calendar-day-thumb')!;
        await fireEvent.click(entry);
        const preview = await waitFor(() => getByRole('dialog'));
        const choices = preview.querySelectorAll('button');
        expect(choices).toHaveLength(10);
        expect(choices[0].textContent).toContain('S2E1');
        expect(choices[9].textContent).toContain('S2E10');
        await fireEvent.click(choices[9]);
        expect(onEventClick).toHaveBeenCalledWith({
            event: { extendedProps: episodes[0].extendedProps },
        });
        expect(container.querySelectorAll('.calendar-day-thumb')).toHaveLength(1);
    });

    it.each(['dayGridMonth', 'week', 'listWeek'] as const)(
        'groups only the same series on the same date in %s',
        async (view) => {
            const base = releases()[0];
            const episode = {
                ...base,
                extendedProps: {
                    type: 'episode',
                    context: {
                        series: { id: 'original', catalogId: null, title: 'Same title' },
                        seasonNumber: 1,
                        episodeNumber: 1,
                    },
                    title: 'Pilot',
                },
            };
            const tomorrow = new Date(base.start);
            // Stay in the current week even when today is Sunday.
            tomorrow.setDate(tomorrow.getDate() + (tomorrow.getDay() === 0 ? -1 : 1));
            const events = [
                episode,
                {
                    ...episode,
                    extendedProps: {
                        ...episode.extendedProps,
                        context: { ...episode.extendedProps.context, episodeNumber: 2 },
                        title: 'Second',
                    },
                },
                {
                    ...episode,
                    extendedProps: {
                        ...episode.extendedProps,
                        context: {
                            ...episode.extendedProps.context,
                            series: { id: 'remake', catalogId: null, title: 'Same title' },
                        },
                    },
                },
                { ...episode, start: tomorrow, end: tomorrow },
                { ...base, extendedProps: { title: 'Same title', type: 'movie' } },
            ];
            const { container, getByRole } = render(CustomCalendar, {
                view,
                locale: 'en',
                eventSources: [{ events: async () => events }],
            });
            const selector = view === 'week' ? '.calendar-day-thumb' : '.calendar-event';
            await waitFor(() => expect(container.querySelectorAll(selector)).toHaveLength(4));
            if (view === 'week') {
                await fireEvent.click(getByRole('button', { name: m.calendar_week_detailed() }));
                expect(
                    container.querySelectorAll('.calendar-rail-col .calendar-event'),
                ).toHaveLength(4);
            }
        },
    );

    it('caps month days at four releases, expands and collapses without opening an event', async () => {
        const onEventClick = vi.fn();
        const { container, getByRole } = render(CustomCalendar, {
            locale: 'en',
            eventSources: [{ events: async () => releases() }],
            onEventClick,
        });
        await waitFor(() => expect(container.querySelectorAll('.calendar-event')).toHaveLength(4));
        const more = getByRole('button', { name: /Show more.*5/ });
        expect(more.getAttribute('aria-expanded')).toBe('false');
        // The gridcell must not cancel native keyboard activation of child buttons.
        expect(await fireEvent.keyDown(more, { key: 'Enter' })).toBe(true);
        await fireEvent.click(more);
        expect(container.querySelectorAll('.calendar-event')).toHaveLength(9);
        expect(more.getAttribute('aria-expanded')).toBe('true');
        expect(onEventClick).not.toHaveBeenCalled();
        await fireEvent.click(more);
        expect(container.querySelectorAll('.calendar-event')).toHaveLength(4);
        await fireEvent.click(container.querySelector('.calendar-event')!);
        expect(onEventClick).toHaveBeenCalledOnce();
    });

    it('keeps all releases and their artwork in list view', async () => {
        const { container, getByRole } = render(CustomCalendar, {
            locale: 'en',
            eventSources: [{ events: async () => releases() }],
        });
        await waitFor(() => expect(container.querySelectorAll('.calendar-event')).toHaveLength(4));
        await fireEvent.click(getByRole('button', { name: m.calendar_switch_list_view() }));
        await waitFor(() =>
            expect(container.querySelectorAll('.calendar-list-event')).toHaveLength(9),
        );
        expect(container.querySelector('.calendar-list-poster')?.getAttribute('style')).toContain(
            '/artwork/0.jpg',
        );
    });

    it('shows the full selected day on mobile', async () => {
        window.innerWidth = 390;
        const { container } = render(CustomCalendar, {
            locale: 'en',
            eventSources: [{ events: async () => releases() }],
        });
        await waitFor(() =>
            expect(container.querySelector('.calendar-event-dot')?.textContent).toBe('9'),
        );
        const today = container.querySelector('[aria-current="date"]');
        expect(today).not.toBeNull();
        await fireEvent.click(today!);
        expect(container.querySelectorAll('.calendar-mobile-events .calendar-event')).toHaveLength(
            9,
        );
    });
});
