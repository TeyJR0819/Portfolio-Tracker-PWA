// Small helpers for finding and changing elements.

export function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: #${id}`);
  return element;
}

export function setText(id, text) {
  byId(id).textContent = text;
}

export function setTone(element, tone) {
  element.classList.remove('is-positive', 'is-negative', 'is-neutral');
  element.classList.add(`is-${tone}`);
}

export function createElement(tagName, { className = '', text = '', attributes = {} } = {}) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text) element.textContent = text;
  Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
  return element;
}

export function prefersReducedMotion() {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

export function readCssVariable(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
