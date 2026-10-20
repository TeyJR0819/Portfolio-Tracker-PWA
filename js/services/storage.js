// Safe wrappers around localStorage and sessionStorage.
// Some browsers block storage (for example in private mode), so every call is guarded.

function createStorage(getBackend) {
  return {
    getText(key) {
      try {
        return getBackend().getItem(key);
      } catch {
        return null;
      }
    },
    setText(key, value) {
      try {
        getBackend().setItem(key, value);
        return true;
      } catch {
        return false;
      }
    },
    getJson(key, fallback = null) {
      try {
        const raw = getBackend().getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    setJson(key, value) {
      return this.setText(key, JSON.stringify(value));
    },
    remove(key) {
      try {
        getBackend().removeItem(key);
      } catch {
        // Nothing to remove when storage is blocked.
      }
    },
  };
}

export const localStore = createStorage(() => window.localStorage);
export const sessionStore = createStorage(() => window.sessionStorage);
