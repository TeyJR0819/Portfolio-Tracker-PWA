// Credentials, PIN checking and the unlocked session.
// The PIN is never stored. Only a salted SHA-256 hash is saved in the browser.

import { STORAGE_KEYS } from '../config.js';
import { localStore, sessionStore } from './storage.js';

const PIN_PATTERN = /^\d{4}$/;

export function isValidPin(pin) {
  return PIN_PATTERN.test(pin);
}

export function isValidDatabaseUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  if (!window.crypto?.subtle) {
    throw new Error('This browser cannot hash the PIN. Open the app through its https address.');
  }
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

function createSalt() {
  return toHex(window.crypto.getRandomValues(new Uint8Array(16)));
}

export function getCredentials() {
  return localStore.getJson(STORAGE_KEYS.credentials);
}

export function hasCredentials() {
  const credentials = getCredentials();
  return Boolean(credentials?.databaseUrl && credentials?.databaseKey && credentials?.pinHash);
}

export async function saveCredentials({ databaseUrl, databaseKey, pin }) {
  const pinSalt = createSalt();
  const pinHash = await sha256Hex(pinSalt + pin);
  const saved = localStore.setJson(STORAGE_KEYS.credentials, {
    databaseUrl: databaseUrl.trim().replace(/\/+$/, ''),
    databaseKey: databaseKey.trim(),
    pinSalt,
    pinHash,
  });
  if (!saved) {
    throw new Error('The browser blocked saving. Turn off private browsing and try again.');
  }
}

export async function verifyPin(pin) {
  const credentials = getCredentials();
  if (!credentials) return false;
  return (await sha256Hex(credentials.pinSalt + pin)) === credentials.pinHash;
}

export function startSession({ remember }) {
  sessionStore.setText(STORAGE_KEYS.sessionUnlocked, '1');
  if (remember) localStore.setText(STORAGE_KEYS.rememberDevice, '1');
}

export function isSessionActive() {
  return (
    sessionStore.getText(STORAGE_KEYS.sessionUnlocked) === '1' ||
    localStore.getText(STORAGE_KEYS.rememberDevice) === '1'
  );
}

export function endSession() {
  sessionStore.remove(STORAGE_KEYS.sessionUnlocked);
  localStore.remove(STORAGE_KEYS.rememberDevice);
}

export function clearAllSavedData() {
  Object.values(STORAGE_KEYS).forEach((key) => {
    localStore.remove(key);
    sessionStore.remove(key);
  });
}
