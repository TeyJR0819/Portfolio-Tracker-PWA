// Entry point. It decides which screen to show and connects the parts of the app.
//
// Start-up flow:
//   no saved credentials  -> setup wizard (PIN only when the Worker supplies the Supabase details) -> sign-in -> dashboard
//   saved, session open   -> dashboard
//   saved, session closed -> lock screen  -> dashboard

import { AUTO_REFRESH_MS, STORAGE_KEYS } from './config.js';
import { isVisibleHolding } from './logic/calculations.js';
import { downloadCsv } from './logic/export-csv.js';
import {
  endSession,
  getCredentials,
  hasCredentials,
  isSessionActive,
} from './services/auth.js';
import { loadSharedConfig } from './services/app-config.js';
import { cachePositions, connectDatabase, getSession, loadBrokerSync, loadPositions, loadTransactions } from './services/database.js';
import { loadMarketPrices } from './services/prices.js';
import { registerServiceWorker } from './services/service-worker-registration.js';
import { setMoneyUnit } from './logic/format.js';
import { localStore } from './services/storage.js';
import {
  getBasePortfolio,
  getDisplayCurrency,
  getPortfolio,
  getState,
  getUsdRate,
  resetState,
  subscribe,
  updateState,
} from './state.js';
import { destroyAllCharts } from './ui/charts.js';
import { byId } from './ui/dom.js';
import { initCurrencyToggle, renderCurrencyToggle } from './ui/currency-toggle.js';
import { initEntryDrawer } from './ui/entry-drawer.js';
import { initLockScreen } from './ui/lock-screen.js';
import { initSetupWizard } from './ui/setup-wizard.js';
import { initSigninScreen } from './ui/signin-screen.js';
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
import { VIEWS } from './ui/views/index.js';
import { initTransactionsView } from './ui/views/transactions-view.js';

let lockScreen = null;
let setupWizard = null;
let signinScreen = null;
let entryDrawer = null;
let tabs = null;
let refreshTimer = null;
let isRefreshing = false;

// ---------- Drawing ----------

function render() {
  const state = getState();
  const shown = getDisplayCurrency();
  const portfolio = getPortfolio();

  setMoneyUnit(shown === 'USD' ? 'USD' : 'RM');
  renderCurrencyToggle({ shown, hasRate: Boolean(getUsdRate()) });
  VIEWS[state.activeTab]({
    ...portfolio,
    transactions: state.transactions,
    transactionsError: state.transactionsError,
    positions: state.positions,
    brokerSync: state.brokerSync,
  });
  renderStatus(state, getBasePortfolio().holdings);
}

function changeDisplayCurrency(currency) {
  localStore.setText(STORAGE_KEYS.displayCurrency, currency);
  updateState({ displayCurrency: currency });
}

// ---------- Loading data ----------

async function refreshAll({ forcePrices = false } = {}) {
  if (isRefreshing) return;
  isRefreshing = true;
  setFetching(true);
  hideDataError();

  try {
    const [dataResult, priceInfo, historyResult, brokerSync] = await Promise.all([
      loadPositions().catch((error) => ({ failure: error })),
      loadMarketPrices({ force: forcePrices }),
      loadTransactions(),
      loadBrokerSync(),
    ]);
    const priceChanges = {
      marketPrices: priceInfo.marketPrices,
      priceInfo,
      transactions: historyResult.transactions,
      transactionsError: historyResult.errorMessage,
      brokerSync,
    };

    if (dataResult.failure?.isAuthError) {
      stopAutoRefresh();
      byId('app').hidden = true;
      signinScreen.show(dataResult.failure.message);
      return;
    }

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

// The dashboard opens only for a signed-in owner. Without a session, the sign-in screen comes first.
// Offline, an expired session cannot be renewed, so a device that has signed in before may still
// open the saved copy.
async function startDashboard() {
  connectDatabase(getCredentials());

  const session = await getSession().catch(() => null);
  const hasSavedSignIn = Boolean(localStore.getText(STORAGE_KEYS.authSession));
  if (!session && !(hasSavedSignIn && !navigator.onLine)) {
    byId('app').hidden = true;
    signinScreen.show();
    return;
  }

  resetState();
  document.body.classList.add('is-initial-load');
  byId('app').hidden = false;
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

// The button may name an entry type, for example the MMF tab opens the form on "MMF gain".
function openAddEntry(button) {
  if (getState().dataInfo?.isOffline) {
    showToast('You are viewing a saved copy. Reconnect before adding an entry.', 'warning');
    return;
  }
  entryDrawer.open({ kind: button?.dataset.kind });
}

// Puts the saved balances (and the new history line) into the screen without reloading everything.
function handleEntrySaved({ positions: savedPositions, transaction, logError }) {
  const byId = new Map(getState().positions.map((position) => [position.id, position]));
  savedPositions.forEach((position) => byId.set(position.id, position));
  const nextPositions = [...byId.values()];

  cachePositions(nextPositions);
  updateState({
    positions: nextPositions,
    transactions: transaction ? [transaction, ...getState().transactions] : getState().transactions,
  });

  if (logError) showToast(`Saved, but the history line was not stored. ${logError}`, 'warning');
  else showToast('Entry saved', 'positive');
}

function exportCsv() {
  const holdings = getBasePortfolio().holdings.filter(isVisibleHolding);
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
  'add-entry': openAddEntry,
};

function handleActionClick(event) {
  const button = event.target.closest('[data-action]');
  if (button) ACTIONS[button.dataset.action]?.(button);
}

// ---------- Start-up ----------

async function boot() {
  registerServiceWorker();

  if (!window.Chart || !window.supabase) {
    showFatalError(
      'A required library did not load. Check your internet connection and reload the page. If it keeps failing, see the Troubleshooting section of the README.',
    );
    return;
  }

  setupWizard = initSetupWizard({ onComplete: startDashboard });
  signinScreen = initSigninScreen({ onSignedIn: startDashboard });
  lockScreen = initLockScreen({ onUnlock: startDashboard });
  entryDrawer = initEntryDrawer({ onSaved: handleEntrySaved });
  tabs = initTabs({
    onChange: (name) => {
      destroyAllCharts();
      updateState({ activeTab: name });
    },
  });

  initCurrencyToggle({ onChange: changeDisplayCurrency });
  initTransactionsView({ onFilter: render });
  updateState({ displayCurrency: localStore.getText(STORAGE_KEYS.displayCurrency) === 'USD' ? 'USD' : 'MYR' });

  subscribe(render);
  document.addEventListener('click', handleActionClick);

  if (!hasCredentials()) setupWizard.show(await loadSharedConfig());
  else if (isSessionActive()) startDashboard();
  else lockScreen.show();
}

boot();
