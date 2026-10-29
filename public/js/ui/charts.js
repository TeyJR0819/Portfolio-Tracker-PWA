// Donut charts built with Chart.js.
// A chart is created once per canvas. Later calls update it in place, which animates the change.

import { MONEY_DECIMALS } from '../config.js';
import { percentage, roundTo } from '../logic/calculations.js';
import { formatMoney, formatNumber } from '../logic/format.js';
import { byId, prefersReducedMotion, readCssVariable } from './dom.js';

const charts = new Map();

// Draws the title and value in the hole of the donut.
const centerTextPlugin = {
  id: 'centerText',
  afterDraw(chart, _arguments, options) {
    const arc = chart.getDatasetMeta(0).data[0];
    if (!options?.value || !arc || arc.innerRadius < 36) return;

    const { ctx } = chart;
    const maxWidth = arc.innerRadius * 1.6;
    let size = Math.min(22, arc.innerRadius * 0.34);

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${size}px ${options.fontFamily}`;
    while (size > 10 && ctx.measureText(options.value).width > maxWidth) {
      size -= 1;
      ctx.font = `600 ${size}px ${options.fontFamily}`;
    }
    ctx.fillStyle = options.valueColor;
    ctx.fillText(options.value, arc.x, arc.y + size * 0.55);
    ctx.font = `400 ${Math.max(10, size * 0.62)}px ${options.fontFamily}`;
    ctx.fillStyle = options.titleColor;
    ctx.fillText(options.title, arc.x, arc.y - size * 0.55);
    ctx.restore();
  },
};

function buildCenterOptions(title, total) {
  return {
    title,
    value: total > 0 ? formatMoney(total) : '',
    fontFamily: readCssVariable('--font-sans'),
    valueColor: readCssVariable('--color-text'),
    titleColor: readCssVariable('--color-text-muted'),
  };
}

function describeSlices(slices, total) {
  return slices.map((slice) => `${slice.label} ${formatNumber(percentage(slice.value, total), 1)}%`).join(', ');
}

function createDonut(canvas, data, centerOptions, total) {
  const ChartLibrary = window.Chart;
  ChartLibrary.defaults.color = readCssVariable('--color-text-muted');
  ChartLibrary.defaults.font.family = readCssVariable('--font-sans');

  return new ChartLibrary(canvas, {
    type: 'doughnut',
    data,
    plugins: [centerTextPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      animation: prefersReducedMotion() ? false : { duration: 900, easing: 'easeOutQuart' },
      plugins: {
        centerText: centerOptions,
        legend: {
          position: 'bottom',
          labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 14 },
        },
        tooltip: {
          padding: 10,
          callbacks: {
            label: (item) => {
              const share = percentage(item.parsed, total());
              return ` ${item.label}: ${formatMoney(item.parsed)} (${formatNumber(share, 1)}%)`;
            },
          },
        },
      },
    },
  });
}

// slices: [{ label, value, color }]
export function upsertDonut(canvasId, slices, { centerTitle = 'Total' } = {}) {
  const canvas = byId(canvasId);
  const emptyNote = canvas.closest('.chart-box')?.querySelector('.chart-empty');
  const visible = slices.filter((slice) => slice.value > 0);

  canvas.hidden = visible.length === 0;
  if (emptyNote) emptyNote.hidden = visible.length > 0;

  if (visible.length === 0) {
    destroyChart(canvasId);
    return;
  }

  const total = visible.reduce((sum, slice) => sum + slice.value, 0);
  const centerOptions = buildCenterOptions(centerTitle, total);
  const surface = readCssVariable('--color-surface');
  const values = visible.map((slice) => roundTo(slice.value, MONEY_DECIMALS));
  const colors = visible.map((slice) => slice.color);
  const labels = visible.map((slice) => slice.label);

  canvas.setAttribute('aria-label', `${centerTitle}: ${describeSlices(visible, total)}`);

  const existing = charts.get(canvasId);
  if (existing) {
    existing.data.labels = labels;
    existing.data.datasets[0].data = values;
    existing.data.datasets[0].backgroundColor = colors;
    existing.options.plugins.centerText = centerOptions;
    existing.update();
    return;
  }

  const data = {
    labels,
    datasets: [{ data: values, backgroundColor: colors, borderColor: surface, borderWidth: 3, hoverOffset: 8 }],
  };
  const getTotal = () => charts.get(canvasId)?.data.datasets[0].data.reduce((sum, value) => sum + value, 0) ?? total;
  charts.set(canvasId, createDonut(canvas, data, centerOptions, getTotal));
}

export function destroyChart(canvasId) {
  charts.get(canvasId)?.destroy();
  charts.delete(canvasId);
}

export function destroyAllCharts() {
  [...charts.keys()].forEach(destroyChart);
}
