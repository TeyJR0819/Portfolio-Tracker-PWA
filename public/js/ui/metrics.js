// Updates a metric card: animates the number and colours it by sign.

import { formatMoney, getTone } from '../logic/format.js';
import { animateNumber } from './animations.js';
import { byId, setTone } from './dom.js';

export function setMetric(valueId, amount, { format = formatMoney, toned = false } = {}) {
  const element = byId(valueId);
  animateNumber(element, amount, format);
  if (toned) setTone(element, getTone(amount));
}
