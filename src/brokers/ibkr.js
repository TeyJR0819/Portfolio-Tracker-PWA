// Reads Interactive Brokers positions and cash through the Flex Web Service.
// Flex is read-only by design: the token can only run the one saved report (the Flex Query).
// The report shows the last business day, so it is read a few times a day, not every 15 minutes.
//
// Steps (Flex Web Service version 3):
//   1. SendRequest  with the token and the query ID   -> a reference code
//   2. GetStatement with the token and the reference  -> the report as XML (may need a few tries)
//
// The Flex Query must include "Open Positions" (summary level) and "Cash Report".

const SEND_REQUEST_URL = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest';
const GET_STATEMENT_URL = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement';
const USER_AGENT = 'portfolio-tracker-worker/1.0';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 6;
const WAIT_BETWEEN_ATTEMPTS_MS = 4000;

const CASH_ASSET = 'IBKR Cash';
const CASH_CURRENCY = 'USD'; // The ledger keeps IBKR cash in USD. Other currencies are listed under their own name.

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function readTag(xml, tag) {
  return xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1].trim() ?? '';
}

function readAttributes(element) {
  const attributes = {};
  for (const [, name, value] of element.matchAll(/([A-Za-z]+)="([^"]*)"/g)) attributes[name] = value;
  return attributes;
}

function readElements(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}\\s[^>]*?/?>`, 'g'))].map((match) => readAttributes(match[0]));
}

function describeFailure(xml) {
  const code = readTag(xml, 'ErrorCode');
  const message = readTag(xml, 'ErrorMessage');
  return `IBKR refused the request (${code || 'no code'}${message ? `: ${message}` : ''}).`;
}

async function getText(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`IBKR answered with status ${response.status}.`);
  return response.text();
}

// The token is only ever sent to an Interactive Brokers address.
function chooseStatementUrl(reportedUrl) {
  try {
    const url = new URL(reportedUrl);
    if (url.protocol === 'https:' && url.hostname.endsWith('.interactivebrokers.com')) return `${url.origin}${url.pathname}`;
  } catch {
    // Fall through to the documented address.
  }
  return GET_STATEMENT_URL;
}

// Turns the report XML into [{ asset, qty }]. Exported for tests.
export function parseFlexReport(xml) {
  const totals = new Map();
  const add = (asset, qty) => totals.set(asset, (totals.get(asset) ?? 0) + qty);

  const positions = readElements(xml, 'OpenPosition');
  // A query that also lists tax lots repeats each position. Count the summary lines only.
  const hasDetailLevels = positions.some((position) => position.levelOfDetail);
  for (const position of positions) {
    if (hasDetailLevels && position.levelOfDetail !== 'SUMMARY') continue;
    const qty = Number(position.position);
    if (position.symbol && Number.isFinite(qty)) add(position.symbol, qty);
  }

  for (const cash of readElements(xml, 'CashReportCurrency')) {
    if (!cash.currency || cash.currency === 'BASE_SUMMARY') continue;
    const qty = Number(cash.endingCash);
    if (!Number.isFinite(qty)) continue;
    add(cash.currency === CASH_CURRENCY ? CASH_ASSET : `${CASH_ASSET} (${cash.currency})`, qty);
  }

  return [...totals].filter(([, qty]) => qty !== 0).map(([asset, qty]) => ({ asset, qty }));
}

export async function fetchIbkrBalances({ token, queryId, fetchImpl = fetch, wait = sleep }) {
  const requestXml = await getText(fetchImpl, `${SEND_REQUEST_URL}?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`);
  if (readTag(requestXml, 'Status') !== 'Success') throw new Error(describeFailure(requestXml));

  const statementUrl = chooseStatementUrl(readTag(requestXml, 'Url'));
  const reference = encodeURIComponent(readTag(requestXml, 'ReferenceCode'));
  const address = `${statementUrl}?t=${encodeURIComponent(token)}&q=${reference}&v=3`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await wait(WAIT_BETWEEN_ATTEMPTS_MS);
    const xml = await getText(fetchImpl, address);
    if (xml.includes('<FlexQueryResponse')) return parseFlexReport(xml);

    const stillWorking = readTag(xml, 'ErrorCode') === '1019' || xml.includes('Statement generation in progress');
    if (!stillWorking) throw new Error(describeFailure(xml));
  }
  throw new Error('IBKR did not finish the report in time. It will be tried again later.');
}
