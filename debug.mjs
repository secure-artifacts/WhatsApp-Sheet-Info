/** Shared console logger. Filter DevTools by: [WA-Sheet] */

const PREFIX = "[WA-Sheet]";

let enabled = true;
let verbose = true;

export function setDebugLogging({ on = true, detail = true } = {}) {
  enabled = Boolean(on);
  verbose = Boolean(detail);
}

export function isDebugEnabled() {
  return enabled;
}

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

export function logInfo(scope, message, data) {
  if (!enabled || !verbose) return;
  if (data !== undefined) console.log(PREFIX, stamp(), scope, message, data);
  else console.log(PREFIX, stamp(), scope, message);
}

export function logWarn(scope, message, data) {
  if (!enabled) return;
  if (data !== undefined) console.warn(PREFIX, stamp(), scope, message, data);
  else console.warn(PREFIX, stamp(), scope, message);
}

export function logError(scope, error, extra = {}) {
  if (!enabled) return;
  const payload = {
    message: error?.message || String(error),
    name: error?.name || "Error",
    stack: error?.stack,
    ...extra
  };
  console.error(PREFIX, stamp(), scope, payload);
}

export function summarizeError(error) {
  if (!error) return { message: "unknown" };
  return {
    message: error.message || String(error),
    name: error.name || "Error",
    aborted: error.name === "AbortError"
  };
}

/** Safe URL for logs (strip long tokens if any). */
export function safeUrl(url) {
  try {
    const u = new URL(String(url), "https://example.invalid");
    if (u.searchParams.has("access_token")) u.searchParams.set("access_token", "***");
    return u.toString();
  } catch {
    return String(url || "").slice(0, 200);
  }
}
