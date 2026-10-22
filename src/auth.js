import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_ACCESS_LENGTH = 32 * 1024;
const MAX_ACCOUNT_ID_LENGTH = 256;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeHeaderValue(value, maxLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u0020\u007f-\u009f]/u.test(value);
}

export function getOpenCodeDataDirectory(env = process.env, home = homedir()) {
  const configuredDataHome = env.XDG_DATA_HOME;

  if (typeof configuredDataHome === "string" && configuredDataHome.length > 0) {
    return configuredDataHome;
  }

  return path.join(home, ".local", "share");
}

export function getOpenCodeAuthPath(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  return path.join(getOpenCodeDataDirectory(env, home), "opencode", "auth.json");
}

export function classifyOpenAICredential(data, now = Date.now()) {
  if (!isRecord(data) || !isRecord(data.openai)) {
    return { kind: "not-connected" };
  }

  const credential = data.openai;

  if (credential.type === "api") {
    return { kind: "api-key" };
  }

  if (credential.type !== "oauth") {
    return { kind: "not-connected" };
  }

  const accessToken = credential.access;
  const expiresAt = credential.expires;

  if (
    !isSafeHeaderValue(accessToken, MAX_ACCESS_LENGTH)
    || typeof expiresAt !== "number"
    || !Number.isFinite(expiresAt)
    || expiresAt <= now
  ) {
    return { kind: "expired" };
  }

  const accountId = credential.accountId;
  const safeAccountId = isSafeHeaderValue(accountId, MAX_ACCOUNT_ID_LENGTH)
    ? accountId
    : undefined;

  return {
    kind: "oauth",
    accessToken,
    accountId: safeAccountId,
    expiresAt,
  };
}

export async function readOpenAICredential({
  authPath,
  readFileImpl = readFile,
  signal,
  now = Date.now(),
  env = process.env,
} = {}) {
  if (signal?.aborted) {
    return { kind: "aborted" };
  }

  const authContent = env.OPENCODE_AUTH_CONTENT;

  if (authContent) {
    try {
      return classifyOpenAICredential(JSON.parse(authContent), now);
    } catch {
      // OpenCode ignores malformed snapshots and falls back to the auth file.
    }
  }

  const selectedAuthPath = authPath ?? getOpenCodeAuthPath({ env });
  let contents;

  try {
    contents = await readFileImpl(selectedAuthPath, { encoding: "utf8", signal });
  } catch (error) {
    if (signal?.aborted) {
      return { kind: "aborted" };
    }

    if (isRecord(error) && error.code === "ENOENT") {
      return { kind: "not-connected" };
    }

    return { kind: "unavailable" };
  }

  let data;

  try {
    data = JSON.parse(contents);
  } catch {
    return { kind: "unavailable" };
  }

  return classifyOpenAICredential(data, now);
}

export class QuotaRequestError extends Error {
  constructor(kind) {
    super("Quota request failed");
    this.name = "QuotaRequestError";
    this.kind = kind;
  }
}

async function readLimitedJson(response, maxBytes, signal) {
  const contentLength = response.headers?.get?.("content-length");

  if (contentLength !== null && contentLength !== undefined) {
    const declaredLength = Number(contentLength);

    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new QuotaRequestError("payload-too-large");
    }
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    throw new QuotaRequestError("invalid-response");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  const cancelOnAbort = () => {
    void reader.cancel().catch(() => {});
  };

  signal.addEventListener("abort", cancelOnAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new QuotaRequestError("payload-too-large");
      }

      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof QuotaRequestError) {
      throw error;
    }

    if (signal.aborted) {
      throw new QuotaRequestError("aborted");
    }

    throw new QuotaRequestError("invalid-response");
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);

    try {
      reader.releaseLock();
    } catch {
      // A cancelled stream may already have released its reader.
    }
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return JSON.parse(text);
  } catch {
    throw new QuotaRequestError("invalid-response");
  }
}

export async function requestOpenAIUsage(credentials, {
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  if (
    !credentials
    || !isSafeHeaderValue(credentials.accessToken, MAX_ACCESS_LENGTH)
    || typeof fetchImpl !== "function"
  ) {
    throw new QuotaRequestError("unavailable");
  }

  if (signal?.aborted) {
    throw new QuotaRequestError("aborted");
  }

  const requestController = new AbortController();
  const responseLimit = Number.isFinite(maxResponseBytes) && maxResponseBytes > 0
    ? Math.min(maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES)
    : DEFAULT_MAX_RESPONSE_BYTES;
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${credentials.accessToken}`,
  };

  if (isSafeHeaderValue(credentials.accountId, MAX_ACCOUNT_ID_LENGTH)) {
    headers["ChatGPT-Account-Id"] = credentials.accountId;
  }

  let timeoutHandle;
  let timedOut = false;
  let rejectAbort;
  const callerAborted = new Promise((resolve, reject) => {
    rejectAbort = reject;
  });
  const onCallerAbort = () => {
    requestController.abort();
    rejectAbort(new QuotaRequestError("aborted"));
  };

  if (signal) {
    signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const timeout = new Promise((resolve, reject) => {
    const duration = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, 30_000)
      : DEFAULT_TIMEOUT_MS;

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      requestController.abort();
      reject(new QuotaRequestError("timeout"));
    }, duration);
  });

  const operation = (async () => {
    try {
      const response = await fetchImpl(USAGE_ENDPOINT, {
        method: "GET",
        headers,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: requestController.signal,
      });

      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new QuotaRequestError("redirect");
      }

      if (response.status === 401) {
        throw new QuotaRequestError("expired");
      }

      if (!response.ok) {
        throw new QuotaRequestError("unavailable");
      }

      return await readLimitedJson(response, responseLimit, requestController.signal);
    } catch (error) {
      if (error instanceof QuotaRequestError) {
        throw error;
      }

      if (signal?.aborted) {
        throw new QuotaRequestError("aborted");
      }

      if (timedOut) {
        throw new QuotaRequestError("timeout");
      }

      throw new QuotaRequestError("network");
    }
  })();

  try {
    const pending = signal
      ? Promise.race([operation, timeout, callerAborted])
      : Promise.race([operation, timeout]);

    return await pending;
  } catch (error) {
    if (error instanceof QuotaRequestError) {
      throw error;
    }

    throw new QuotaRequestError(signal?.aborted ? "aborted" : "network");
  } finally {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}
