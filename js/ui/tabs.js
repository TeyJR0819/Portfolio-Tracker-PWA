// Tab switching. The fade and slide effect is done by CSS when a panel becomes visible.

import { byId } from './dom.js';

export function initTabs({ onChange }) {
  const tabList = byId('tab-list');
  const buttons = [...tabList.querySelectorAll('[data-tab]')];

  function select(name, { focus = false } = {}) {
    buttons.forEach((button) => {
      const isActive = button.dataset.tab === name;
      button.setAttribute('aria-selected', String(isActive));
      button.tabIndex = isActive ? 0 : -1;
      if (isActive && focus) button.focus();
    });

    document.querySelectorAll('[data-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== name;
    });

    onChange(name);
  }

  tabList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (button) select(button.dataset.tab);
  });

  tabList.addEventListener('keydown', (event) => {
    const currentIndex = buttons.findIndex((button) => button.getAttribute('aria-selected') === 'true');
    const lastIndex = buttons.length - 1;
    const nextIndex = {
      ArrowRight: currentIndex === lastIndex ? 0 : currentIndex + 1,
      ArrowLeft: currentIndex === 0 ? lastIndex : currentIndex - 1,
      Home: 0,
      End: lastIndex,
    }[event.key];

    if (nextIndex === undefined) return;
    event.preventDefault();
    select(buttons[nextIndex].dataset.tab, { focus: true });
  });

  return { select };
}
