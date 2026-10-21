// Number counter animation. The number counts from its last shown value to the new one.

import { prefersReducedMotion } from './dom.js';

const frames = new WeakMap();

export function animateNumber(element, target, format, duration = 900) {
  const from = Number(element.dataset.value ?? 0);
  element.dataset.value = String(target);

  cancelAnimationFrame(frames.get(element));

  if (prefersReducedMotion() || from === target) {
    element.textContent = format(target);
    return;
  }

  const startTime = performance.now();

  function step(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - (1 - progress) ** 3;
    element.textContent = format(from + (target - from) * eased);
    if (progress < 1) frames.set(element, requestAnimationFrame(step));
  }

  frames.set(element, requestAnimationFrame(step));
}
