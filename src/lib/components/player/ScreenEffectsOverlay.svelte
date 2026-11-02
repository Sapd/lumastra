<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { watchTogether } from '$lib/stores/watchTogether.svelte';
    import { SCREEN_EFFECTS, type ScreenEffect } from '$lib/types/watch-together';

    const validEffectIds = SCREEN_EFFECTS.map((e) => e.id) as ScreenEffect[];

    interface Props {
        // Reference to the video container for applying effects
        playerContainer?: HTMLElement | null;
    }

    let { playerContainer = null }: Props = $props();

    // Active effects state
    interface ActiveEffect {
        id: number;
        type: ScreenEffect;
        displayName: string;
        startTime: number;
    }

    let activeEffects: ActiveEffect[] = $state([]);
    let effectCounter = 0;

    // Particle systems
    interface Particle {
        id: number;
        x: number;
        y: number;
        vx: number;
        vy: number;
        rotation: number;
        rotationSpeed: number;
        scale: number;
        opacity: number;
        color: string;
        emoji?: string;
        type: 'confetti' | 'snow' | 'heart' | 'matrix';
    }

    let particles: Particle[] = $state([]);
    let particleId = 0;
    let animationFrame: number | null = null;

    // Matrix rain characters
    const matrixChars =
        'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789';

    // Effect durations (ms)
    const EFFECT_DURATIONS: Record<ScreenEffect, number> = {
        shake: 600,
        confetti: 6000,
        snow: 5000,
        hearts: 2500,
        flash: 300,
        zoom: 800,
        spin: 1000,
        rage: 1500,
        matrix: 4000,
        vhs: 2000,
    };

    // Confetti colors
    const confettiColors = [
        '#ff0000',
        '#00ff00',
        '#0000ff',
        '#ffff00',
        '#ff00ff',
        '#00ffff',
        '#ff8800',
        '#ff0088',
    ];

    export function triggerEffect(effect: ScreenEffect, displayName: string) {
        const activeEffect: ActiveEffect = {
            id: effectCounter++,
            type: effect,
            displayName,
            startTime: Date.now(),
        };

        activeEffects = [...activeEffects, activeEffect];

        // Apply container effect classes
        applyContainerEffect(effect);

        // Spawn particles for particle-based effects
        if (effect === 'confetti') spawnConfetti();
        if (effect === 'snow') spawnSnow();
        if (effect === 'hearts') spawnHearts();
        if (effect === 'matrix') spawnMatrix();

        // Auto-remove after duration
        setTimeout(() => {
            activeEffects = activeEffects.filter((e) => e.id !== activeEffect.id);
            removeContainerEffect(effect);
        }, EFFECT_DURATIONS[effect]);
    }

    function applyContainerEffect(effect: ScreenEffect) {
        if (!playerContainer) return;

        switch (effect) {
            case 'shake':
                playerContainer.classList.add('effect-shake');
                break;
            case 'flash':
                playerContainer.classList.add('effect-flash');
                break;
            case 'zoom':
                playerContainer.classList.add('effect-zoom');
                break;
            case 'spin':
                playerContainer.classList.add('effect-spin');
                break;
            case 'rage':
                playerContainer.classList.add('effect-rage');
                break;
            case 'vhs':
                playerContainer.classList.add('effect-vhs');
                break;
        }
    }

    function removeContainerEffect(effect: ScreenEffect) {
        if (!playerContainer) return;

        switch (effect) {
            case 'shake':
                playerContainer.classList.remove('effect-shake');
                break;
            case 'flash':
                playerContainer.classList.remove('effect-flash');
                break;
            case 'zoom':
                playerContainer.classList.remove('effect-zoom');
                break;
            case 'spin':
                playerContainer.classList.remove('effect-spin');
                break;
            case 'rage':
                playerContainer.classList.remove('effect-rage');
                break;
            case 'vhs':
                playerContainer.classList.remove('effect-vhs');
                break;
        }
    }

    function spawnConfetti() {
        const count = 100;
        for (let i = 0; i < count; i++) {
            // Stagger spawn over 500ms for more natural burst
            setTimeout(() => {
                particles = [
                    ...particles,
                    {
                        id: particleId++,
                        x: Math.random() * 100,
                        y: -10 - Math.random() * 30,
                        vx: (Math.random() - 0.5) * 2,
                        vy: Math.random() * 1 + 0.8, // Slower initial fall
                        rotation: Math.random() * 360,
                        rotationSpeed: (Math.random() - 0.5) * 10,
                        scale: Math.random() * 0.5 + 0.5,
                        opacity: 1,
                        color: confettiColors[Math.floor(Math.random() * confettiColors.length)],
                        type: 'confetti',
                    },
                ];
            }, i * 5); // Stagger spawn
        }
        startParticleAnimation();
    }

    function spawnSnow() {
        const count = 60;
        for (let i = 0; i < count; i++) {
            setTimeout(() => {
                particles = [
                    ...particles,
                    {
                        id: particleId++,
                        x: Math.random() * 100,
                        y: -5,
                        vx: (Math.random() - 0.5) * 0.5,
                        vy: Math.random() * 1.5 + 0.5,
                        rotation: 0,
                        rotationSpeed: 0,
                        scale: Math.random() * 0.8 + 0.4,
                        opacity: Math.random() * 0.5 + 0.5,
                        color: '#ffffff',
                        emoji: '❄️',
                        type: 'snow',
                    },
                ];
            }, i * 50); // Stagger spawn
        }
        startParticleAnimation();
    }

    function spawnHearts() {
        const count = 25;
        const heartEmojis = ['💕', '❤️', '💖', '💗', '💓', '💝', '💘'];
        for (let i = 0; i < count; i++) {
            setTimeout(() => {
                particles = [
                    ...particles,
                    {
                        id: particleId++,
                        x: Math.random() * 100,
                        y: 110,
                        vx: (Math.random() - 0.5) * 2,
                        vy: -(Math.random() * 3 + 2),
                        rotation: (Math.random() - 0.5) * 30,
                        rotationSpeed: (Math.random() - 0.5) * 5,
                        scale: Math.random() * 0.6 + 0.6,
                        opacity: 1,
                        color: '#ff69b4',
                        emoji: heartEmojis[Math.floor(Math.random() * heartEmojis.length)],
                        type: 'heart',
                    },
                ];
            }, i * 80);
        }
        startParticleAnimation();
    }

    function spawnMatrix() {
        const columns = 30;
        for (let i = 0; i < columns; i++) {
            setTimeout(() => {
                const x = (i / columns) * 100 + Math.random() * 3;
                for (let j = 0; j < 20; j++) {
                    setTimeout(() => {
                        particles = [
                            ...particles,
                            {
                                id: particleId++,
                                x,
                                y: -5 - j * 3,
                                vx: 0,
                                vy: Math.random() * 2 + 3,
                                rotation: 0,
                                rotationSpeed: 0,
                                scale: Math.random() * 0.5 + 0.5,
                                opacity: Math.random() * 0.5 + 0.5,
                                color: `rgba(0, ${Math.floor(Math.random() * 100 + 155)}, 0, 1)`,
                                emoji: matrixChars[Math.floor(Math.random() * matrixChars.length)],
                                type: 'matrix',
                            },
                        ];
                    }, j * 30);
                }
            }, i * 20);
        }
        startParticleAnimation();
    }

    function startParticleAnimation() {
        if (animationFrame !== null) return;

        function animate() {
            particles = particles
                .map((p) => ({
                    ...p,
                    x: p.x + p.vx * 0.3,
                    y: p.y + p.vy * 0.4, // Slower overall fall
                    rotation: p.rotation + p.rotationSpeed,
                    opacity:
                        p.type === 'confetti'
                            ? Math.max(0, p.opacity - 0.002) // Slower fade for confetti
                            : p.type === 'heart'
                              ? Math.max(0, p.opacity - 0.008)
                              : p.type === 'matrix'
                                ? Math.max(0, p.opacity - 0.003)
                                : p.opacity,
                    vy: p.type === 'confetti' ? p.vy + 0.02 : p.vy, // Reduced gravity for confetti
                }))
                .filter((p) => p.y < 110 && p.y > -30 && p.opacity > 0);

            if (particles.length > 0) {
                animationFrame = requestAnimationFrame(animate);
            } else {
                animationFrame = null;
            }
        }

        animationFrame = requestAnimationFrame(animate);
    }

    onMount(() => {
        // Listen for incoming screen effects
        watchTogether.onScreenEffect((effect, userId, displayName) => {
            // Validate effect is a known type
            if (validEffectIds.includes(effect as ScreenEffect)) {
                triggerEffect(effect as ScreenEffect, displayName);
            }
        });
    });

    onDestroy(() => {
        if (animationFrame !== null) {
            cancelAnimationFrame(animationFrame);
        }
    });
</script>

<!-- Particle overlay -->
<div class="particle-overlay">
    {#each particles as particle (particle.id)}
        <div
            class="particle particle-{particle.type}"
            style="
                left: {particle.x}%;
                top: {particle.y}%;
                transform: rotate({particle.rotation}deg) scale({particle.scale});
                opacity: {particle.opacity};
                {particle.emoji ? '' : `background-color: ${particle.color};`}
                {particle.type === 'matrix' ? `color: ${particle.color};` : ''}
            ">
            {#if particle.emoji}
                {particle.emoji}
            {/if}
        </div>
    {/each}
</div>

<!-- Effect trigger attribution (shows who triggered the effect) -->
{#if activeEffects.length > 0}
    <div class="effect-attribution">
        {#each activeEffects as effect (effect.id)}
            <div class="attribution-item" style="animation-delay: {(effect.id % 3) * 0.1}s">
                <span class="effect-trigger-user">{effect.displayName}</span>
            </div>
        {/each}
    </div>
{/if}

<style>
    .particle-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        pointer-events: none;
        overflow: hidden;
        z-index: 60;
    }

    .particle {
        position: absolute;
        pointer-events: none;
    }

    .particle-confetti {
        width: 10px;
        height: 10px;
        border-radius: 2px;
    }

    .particle-snow {
        font-size: 24px;
        filter: drop-shadow(0 0 5px rgba(255, 255, 255, 0.8));
    }

    .particle-heart {
        font-size: 32px;
        filter: drop-shadow(0 2px 4px rgba(255, 105, 180, 0.5));
    }

    .particle-matrix {
        font-size: 18px;
        font-family: monospace;
        font-weight: bold;
        text-shadow:
            0 0 10px currentColor,
            0 0 20px currentColor;
    }

    .effect-attribution {
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        gap: 8px;
        z-index: 70;
        pointer-events: none;
    }

    .attribution-item {
        background: rgba(0, 0, 0, 0.7);
        padding: 6px 12px;
        border-radius: 20px;
        animation: attribution-pop 0.3s ease-out;
    }

    .effect-trigger-user {
        color: white;
        font-size: 13px;
        font-weight: 500;
    }

    @keyframes attribution-pop {
        0% {
            transform: scale(0.5);
            opacity: 0;
        }
        50% {
            transform: scale(1.1);
        }
        100% {
            transform: scale(1);
            opacity: 1;
        }
    }

    /* Global effect classes (applied to player container) */
    :global(.effect-shake) {
        animation: shake 0.6s cubic-bezier(0.36, 0.07, 0.19, 0.97) both !important;
    }

    :global(.effect-flash) {
        animation: flash 0.3s ease-out !important;
    }

    :global(.effect-zoom) {
        animation: zoom-pulse 0.8s ease-in-out !important;
    }

    :global(.effect-spin) {
        animation: spin-effect 1s ease-in-out !important;
    }

    :global(.effect-rage) {
        animation: rage-shake 0.1s ease-in-out infinite !important;
        filter: saturate(2) hue-rotate(-20deg) brightness(1.1) !important;
    }

    :global(.effect-vhs) {
        animation: vhs-glitch 0.15s ease-in-out infinite !important;
    }

    @keyframes shake {
        0%,
        100% {
            transform: translateX(0) translateY(0) rotate(0deg);
        }
        10% {
            transform: translateX(-15px) translateY(-5px) rotate(-2deg);
        }
        20% {
            transform: translateX(15px) translateY(5px) rotate(2deg);
        }
        30% {
            transform: translateX(-12px) translateY(-3px) rotate(-1.5deg);
        }
        40% {
            transform: translateX(12px) translateY(3px) rotate(1.5deg);
        }
        50% {
            transform: translateX(-8px) translateY(-2px) rotate(-1deg);
        }
        60% {
            transform: translateX(8px) translateY(2px) rotate(1deg);
        }
        70% {
            transform: translateX(-5px) translateY(-1px) rotate(-0.5deg);
        }
        80% {
            transform: translateX(5px) translateY(1px) rotate(0.5deg);
        }
        90% {
            transform: translateX(-2px) translateY(0) rotate(0deg);
        }
    }

    @keyframes flash {
        0% {
            filter: brightness(1);
        }
        15% {
            filter: brightness(5);
        }
        30% {
            filter: brightness(1);
        }
        45% {
            filter: brightness(3);
        }
        60% {
            filter: brightness(1);
        }
        75% {
            filter: brightness(2);
        }
        100% {
            filter: brightness(1);
        }
    }

    @keyframes zoom-pulse {
        0% {
            transform: scale(1);
        }
        25% {
            transform: scale(1.08);
        }
        50% {
            transform: scale(0.95);
        }
        75% {
            transform: scale(1.03);
        }
        100% {
            transform: scale(1);
        }
    }

    @keyframes spin-effect {
        0% {
            transform: perspective(1000px) rotateY(0deg);
        }
        100% {
            transform: perspective(1000px) rotateY(360deg);
        }
    }

    @keyframes rage-shake {
        0% {
            transform: translateX(-3px) translateY(-2px);
        }
        25% {
            transform: translateX(3px) translateY(2px);
        }
        50% {
            transform: translateX(-2px) translateY(1px);
        }
        75% {
            transform: translateX(2px) translateY(-1px);
        }
        100% {
            transform: translateX(-3px) translateY(-2px);
        }
    }

    @keyframes vhs-glitch {
        0% {
            transform: translateX(0);
            filter: saturate(1) hue-rotate(0deg);
        }
        20% {
            transform: translateX(-5px);
            filter: saturate(1.5) hue-rotate(10deg);
            clip-path: inset(10% 0 20% 0);
        }
        40% {
            transform: translateX(3px);
            filter: saturate(0.8) hue-rotate(-5deg);
            clip-path: inset(30% 0 10% 0);
        }
        60% {
            transform: translateX(-2px);
            filter: saturate(1.2) hue-rotate(5deg);
            clip-path: inset(5% 0 40% 0);
        }
        80% {
            transform: translateX(4px);
            filter: saturate(1) hue-rotate(-10deg);
            clip-path: inset(20% 0 15% 0);
        }
        100% {
            transform: translateX(0);
            filter: saturate(1) hue-rotate(0deg);
            clip-path: none;
        }
    }
</style>
