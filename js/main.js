// Entry point. It decides which screen to show and connects the parts of the app.
//
// Start-up flow:
//   no saved credentials  -> setup wizard -> dashboard
//   saved, session open   -> dashboard
//   saved, session closed -> lock screen  -> dashboard

import { AUTO_REFRESH_MS } from './config.js';
import { isVisibleHolding } from './logic/calculations.js';
import { downloadCsv } from './logic/export-csv.js';
import {
  endSession,
  getCredentials,
  hasCredentials,
  isSessionActive,
} from './services/auth.js';
import { cachePositions, connectDatabase, loadPositions } from './services/database.js';
import { loadMarketPrices } from './services/prices.js';
import { registerServiceWorker } from './services/service-worker-registration.js';
import { getPortfolio, getState, resetState, subscribe, updateState } from './state.js';
import { destroyAllCharts } from './ui/charts.js';
import { byId } from './ui/dom.js';
import { initLockScreen } from './ui/lock-screen.js';
import { initSetupWizard } from './ui/setup-wizard.js';
import {
  finishInitialLoad,
  hideDataError,
  renderStatus,
  setFetching,
  showDataError,
  showFatalError,
} from './ui/status.js';
import { initTabs } from './ui/tabs.js';
import { showToast } from './ui/toast.js';
import { initTransactionDrawer } from './ui/transaction-drawer.js';
import { VIEWS } from './ui/views/index.js';

let lockScreen = null;
let setupWizard = null;
let transactionDrawer = null;
let tabs = null;
let refreshTimer = null;
let isRefreshing = false;

// ---------- Drawing ----------

function render() {
  const state = getState();
  const portfolio = getPortfolio();
  VIEWS[state.activeTab](portfolio);
  renderStatus(state, portfolio.holdings);
}

// ---------- Loading data ----------

async function refreshAll({ forcePrices = false } = {}) {
  if (isRefreshing) return;
  isRefreshing = true;
  setFetching(true);
  hideDataError();

  try {
    const [dataResult, priceInfo] = await Promise.all([
      loadPositions().catch((error) => ({ failure: error })),
      loadMarketPrices({ force: forcePrices }),
    ]);
    const priceChanges = { coinPrices: priceInfo.coinPrices, priceInfo };

    if (dataResult.failure) {
      // Keep what is already on screen when a later refresh fails.
      if (getState().positions.length === 0) showDataError(dataResult.failure.message);
      updateState(priceChanges);
      return;
    }

    updateState({
      ...priceChanges,
      positions: dataResult.positions,
      dataInfo: {
        isOffline: dataResult.isOffline,
        savedAt: dataResult.savedAt,
        errorMessage: dataResult.errorMessage,
      },
    });
  } finally {
    isRefreshing = false;
    setFetching(false);
    finishInitialLoad();
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    if (!document.hidden) refreshAll();
  }, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = null;
}

// ---------- Screens ----------

function startDashboard() {
  resetState();
  document.body.classList.add('is-initial-load');
  byId('app').hidden = false;

  connectDatabase(getCredentials());
  tabs.select(getState().activeTab);
  refreshAll().then(startAutoRefresh);
}

function lockDashboard() {
  stopAutoRefresh();
  endSession();
  destroyAllCharts();
  resetState();
  byId('app').hidden = true;
  lockScreen.show();
}

// ---------- Actions ----------

function openAddTransaction() {
  if (getState().dataInfo?.isOffline) {
    showToast('You are viewing a saved copy. Reconnect before adding a transaction.', 'warning');
    return;
  }
  transactionDrawer.open();
}

function handleTransactionSaved(savedPosition) {
  const { positions } = getState();
  const exists = positions.some((position) => position.id === savedPosition.id);
  const nextPositions = exists
    ? positions.map((position) => (position.id === savedPosition.id ? savedPosition : position))
    : [...positions, savedPosition];

  cachePositions(nextPositions);
  updateState({ positions: nextPositions });
  showToast('Transaction saved', 'positive');
}

function exportCsv() {
  const holdings = getPortfolio().holdings.filter(isVisibleHolding);
  if (holdings.length === 0) {
    showToast('There is nothing to export yet.', 'warning');
    return;
  }
  downloadCsv(holdings);
  showToast('CSV file exported', 'positive');
}

const ACTIONS = {
  lock: lockDashboard,
  refresh: () => refreshAll({ forcePrices: true }),
  retry: () => refreshAll(),
  export: exportCsv,
  'add-transaction': openAddTransaction,
};

function handleActionClick(event) {
  const button = event.target.closest('[data-action]');
  if (button) ACTIONS[button.dataset.action]?.();
}

// ---------- Start-up ----------

function boot() {
  registerServiceWorker();

  if (!window.Chart || !window.supabase) {
    showFatalError(
      'A required library did not load. Check your internet connection and reload the page. If it keeps failing, see the Troubleshooting section of the README.',
    );
    return;
  }

  setupWizard = initSetupWizard({ onComplete: startDashboard });
  lockScreen = initLockScreen({ onUnlock: startDashboard });
  transactionDrawer = initTransactionDrawer({ onSaved: handleTransactionSaved });
  tabs = initTabs({
    onChange: (name) => {
      destroyAllCharts();
      updateState({ activeTab: name });
    },
  });

  subscribe(render);
  document.addEventListener('click', handleActionClick);

  if (!hasCredentials()) setupWizard.show();
  else if (isSessionActive()) startDashboard();
  else lockScreen.show();
}

boot();
