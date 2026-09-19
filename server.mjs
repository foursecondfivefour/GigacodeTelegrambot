#!/usr/bin/env node
/**
 * GigaCode → OpenAI-compatible proxy (single file, zero dependencies).
 *
 * Works with any editor / client that speaks the OpenAI API:
 *   VS Code (Continue, Cline, Roo), JetBrains AI/CodeGPT, Zed, Neovim
 *   (avante/codecompanion), Cursor, Open WebUI, aider, curl, ...
 *
 * Point the client at:   http://127.0.0.1:8000/v1
 * API key:               anything (not checked)
 *
 * Requires Node >= 18 (global fetch, ReadableStream, AbortSignal.timeout).
 *
 * Run:   node server.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOADED_ENV_FILES = [];

/** Minimal .env loader (no dotenv dependency). */
function loadEnvFile(file) {
  const real = path.resolve(file);
  if (LOADED_ENV_FILES.includes(real) || !fs.existsSync(real)) return false;
  LOADED_ENV_FILES.push(real);
  for (const raw of fs.readFileSync(real, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/s.test(val)) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
  return true;
}
// `env.txt` first so it stays visible in Explorer/editors (Windows hides
// dotfiles); classic `.env` still works. Both the working directory and the
// script's own folder are checked, so `npm start` works from anywhere.
// fileURLToPath is required on Windows: URL.pathname yields "/C:/...".
const CONFIG_DIRS = [...new Set([process.cwd(), SCRIPT_DIR])];
let configLoaded = false;
for (const dir of CONFIG_DIRS) {
  for (const name of ['env.txt', '.env']) {
    if (loadEnvFile(path.join(dir, name))) configLoaded = true;
  }
}

const env = (k, d) => process.env[k] ?? d;
const num = (k, d) => Number(process.env[k] ?? d);

const BASE = env('GIGACODE_BASE_URL', 'https://gigacode.ru');

export const CONFIG = {
  baseUrl: BASE,
  authUrl: env('GIGACODE_AUTH_URL', `${BASE}/api/v2/auth/plugin`),
  chatUrl: env('GIGACODE_CHAT_URL', `${BASE}/api/v2/chat/completions`),
  completionsUrl: env('GIGACODE_COMPLETIONS_URL', `${BASE}/api/v2/completions`),
  responsesUrl: env('GIGACODE_RESPONSES_URL', `${BASE}/api/v2/responses`),

  connectTimeout: num('CONNECT_TIMEOUT', 5) * 1000,
  requestTimeout: num('REQUEST_TIMEOUT', 120) * 1000,

  defaultMaxTokens: num('GIGACODE_DEFAULT_MAX_TOKENS', 32000),

  username: env('GIGACODE_USERNAME', ''),
  deviceCode: env('GIGACODE_DEVICE_CODE', ''),

  tokenFile: path.resolve(
    (env('GIGACODE_TOKEN_FILE', '') || path.join(os.homedir(), '.gigacode_proxy_tokens.json'))
      .replace(/^~(?=$|[/\\])/, os.homedir()),
  ),
  deviceCodeFile: path.join(os.homedir(), '.gigacode_device_code'),

  host: env('PROXY_HOST', '127.0.0.1'),
  port: num('PROXY_PORT', 8000),

  callbackPath: env('GIGACODE_CALLBACK_PATH', '/gigaCodeAuthCallback'),
  modelName: env('MODEL_NAME', 'CodeChat'),
  debugChunks: /^(1|true|yes)$/i.test(env('GIGACODE_DEBUG_CHUNKS', '')),

  // Role GigaCode gets instead of "system" (it rejects "system").
  systemRole: env('GIGACODE_SYSTEM_ROLE', 'user'),
  // Pure passthrough switches — turn the last safety nets off.
  keepOrphanTools: /^(1|true|yes)$/i.test(env('GIGACODE_KEEP_ORPHAN_TOOLS', '')),
  passthroughModel: /^(1|true|yes)$/i.test(env('GIGACODE_PASSTHROUGH_MODEL', '')),
  flattenMultimodal: !/^(0|false|no)$/i.test(env('GIGACODE_FLATTEN_MULTIMODAL', '1')),

  // How to surface the model's chain-of-thought:
  //   tags  - inline into content wrapped in <think>...</think> (works everywhere)
  //   field - keep the OpenAI-style `reasoning_content` delta field
  //   off   - drop it (old behaviour)
  reasoning: (env('GIGACODE_SHOW_REASONING', 'tags') || 'off').toLowerCase(),
  // Heartbeat comment interval (ms) so clients do not look frozen. 0 = off.
  keepAliveMs: num('GIGACODE_KEEPALIVE_MS', 15000),
  // Dump every raw upstream SSE line — the ground truth when a field is missing.
  debugRaw: /^(1|true|yes)$/i.test(env('GIGACODE_DEBUG_RAW', '')),
  // Serve stream=false requests by streaming upstream and assembling here.
  streamNonStream: !/^(0|false|no)$/i.test(env('GIGACODE_STREAM_NONSTREAM', '1')),
};

// Empty GIGACODE_SYSTEM_ROLE means "leave the system role alone".
const SYSTEM_ROLE = CONFIG.systemRole || null;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

// GIGACODE_TRACE=1 turns on full end-to-end tracing; GIGACODE_TRACE_FILE
// mirrors everything into a file (default: trace.log next to server.mjs when
// tracing is on). Console stays readable, the file holds the full detail.
const TRACE_ON = /^(1|true|yes)$/i.test(env('GIGACODE_TRACE', ''));
const TRACE_FILE = env('GIGACODE_TRACE_FILE', '') ||
  (TRACE_ON ? path.join(SCRIPT_DIR, 'trace.log') : '');
const TRACE_MAX = num('GIGACODE_TRACE_MAX_CHARS', 4000);

let traceStream = null;
if (TRACE_FILE) {
  try {
    traceStream = fs.createWriteStream(TRACE_FILE, { flags: 'a' });
    traceStream.write(`\n${'='.repeat(70)}\n=== session ${new Date().toISOString()}\n`);
  } catch (e) {
    console.error(`[WARN] Cannot open trace file ${TRACE_FILE}: ${e.message}`);
  }
}

const stamp = () => new Date().toISOString().slice(11, 23);

function log(...a) {
  const line = a.join(' ');
  console.error(line);
  traceStream?.write(`${stamp()} ${line}\n`);
}

/** Verbose trace: file always, console only when tracing is enabled. */
/** True when anything is actually listening; lets callers skip the work. */
function tracing() { return TRACE_ON || Boolean(traceStream); }

function trace(tag, data) {
  if (!TRACE_ON && !traceStream) return;
  let body = typeof data === 'string' ? data : JSON.stringify(data);
  if (body === undefined) body = String(data);
  if (body.length > TRACE_MAX) {
    body = `${body.slice(0, TRACE_MAX)} …(+${body.length - TRACE_MAX} chars)`;
  }
  const line = `[${tag}] ${body}`;
  if (TRACE_ON) console.error(line);
  traceStream?.write(`${stamp()} ${line}\n`);
}

/**
 * `fetch` reports every transport failure as a bare "fetch failed" and hides
 * the real reason in `error.cause`. Unwrap it, and translate the codes people
 * actually hit (VPN routing the domain abroad, no DNS, corporate TLS MITM).
 */
function describeNetworkError(err) {
  const codes = [];
  for (let c = err; c; c = c.cause) {
    // AbortSignal.timeout throws a DOMException whose `code` is the numeric
    // 23; its `name` is the useful part.
    if (c.name === 'TimeoutError' || c.name === 'AbortError') codes.push('ETIMEDOUT');
    else if (typeof c.code === 'string') codes.push(c.code);
    else if (c !== err && c.message) codes.push(c.message);
  }
  const detail = codes.length ? `${err.message} (${codes.join(' <- ')})` : err.message;

  const hint = codes.some((c) => ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(c))
    ? ' — hint: gigacode.ru is reachable from Russian networks only; turn the VPN off or add the domain to split-tunneling.'
    : codes.includes('ENOTFOUND') || codes.includes('EAI_AGAIN')
      ? ' — hint: DNS could not resolve the host; check the VPN/DNS settings.'
      : codes.some((c) => String(c).includes('CERT') || String(c).includes('SELF_SIGNED'))
        ? ' — hint: TLS interception detected; point NODE_EXTRA_CA_CERTS at your corporate CA bundle.'
        : '';

  return detail + hint;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const KNOWN_MODELS = new Set([
  'CodeChat',
  'Gigacode-Inline-13B-v4.1',
  'Gigacode-Inline-3B-v3.1',
]);

const CHAT_ALIASES = {
  gigacode: 'CodeChat',
  codechat: 'CodeChat',
  'code-chat': 'CodeChat',
  'gigacode-chat': 'CodeChat',
  'qwen3-32b': 'CodeChat',
  'qwen3-235b': 'CodeChat',
};

const COMPLETION_ALIASES = {
  gigacode: 'Gigacode-Inline-13B-v4.1',
  codechat: 'Gigacode-Inline-13B-v4.1',
  'gigacode-inline': 'Gigacode-Inline-13B-v4.1',
  'gigacode-inline-13b': 'Gigacode-Inline-13B-v4.1',
  'gigacode-inline-3b': 'Gigacode-Inline-3B-v3.1',
  'gigacode-3b': 'Gigacode-Inline-3B-v3.1',
};

function resolveModel(requested, { forCompletion = false } = {}) {
  const raw = String(requested ?? '').trim();
  if (!raw) return forCompletion ? COMPLETION_ALIASES.gigacode : CONFIG.modelName;
  if (KNOWN_MODELS.has(raw)) return raw;

  const table = forCompletion ? COMPLETION_ALIASES : CHAT_ALIASES;
  const hit = table[raw.toLowerCase()];
  if (hit) return hit;

  // Unknown name: forward it as-is when passthrough is on, otherwise fall
  // back so an editor preset like "gpt-4o" does not 4xx upstream.
  if (CONFIG.passthroughModel) return raw;
  log(`[WARN] Unknown model "${raw}", falling back to default (set GIGACODE_PASSTHROUGH_MODEL=1 to send as-is)`);
  return forCompletion ? COMPLETION_ALIASES.gigacode : CONFIG.modelName;
}

// ---------------------------------------------------------------------------
// Auth (OAuth via browser callback, token cached on disk)
// ---------------------------------------------------------------------------

const PLUGIN_META = {
  env_name: 'gigacode-proxy',
  env_version: '1.0.0',
  plugin_name: 'gigacode-proxy',
  plugin_version: '1.0.0',
  locale: 'eng',
};

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    log(`[WARN] Could not open browser: ${e.message}`);
  }
}

class AuthManager {
  #lastAuthError = null;
  #token = null;
  #expiresAt = 0;
  #deviceCode = '';
  #pending = null;

  get isAuthorized() {
    if (!this.#token) this.#loadCache();
    return Boolean(this.#token) && Date.now() < this.#expiresAt - 60_000;
  }

  headers() {
    return this.#token ? { Authorization: `Bearer ${this.#token}` } : {};
  }

  /** Concurrent callers share one authentication attempt. */
  authenticate() {
    if (!this.#pending) {
      this.#pending = this.#authenticate().finally(() => { this.#pending = null; });
    }
    return this.#pending;
  }

  async refreshIfNeeded() {
    if (this.isAuthorized) return true;
    try {
      await this.authenticate();
      return true;
    } catch (e) {
      log(`[AUTH] Refresh failed: ${e.message}`);
      return false;
    }
  }

  async #authenticate() {
    this.#deviceCode = CONFIG.deviceCode || this.#loadOrCreateDeviceCode();

    if (this.isAuthorized) {
      log('[AUTH] Using cached access token');
      return this.#token;
    }

    const signInUrl = await this.#getSignInUrl();
    if (signInUrl === '__TOKEN__') return this.#token;
    if (!signInUrl) {
      throw new Error(`Could not get sign-in URL from GigaCode: ${this.#lastAuthError ?? 'unknown reason'}`);
    }

    const { port, waitForCode, close } = await startCallbackServer();
    const redirect = `http://localhost:${port}${CONFIG.callbackPath}`;
    const full = `${signInUrl}&redirect_url=${encodeURIComponent(redirect)}`;

    log('[AUTH] Opening browser for SberID login...');
    log(`[AUTH] If it does not open, visit:\n${full}`);
    openBrowser(full);

    let code;
    try {
      code = await waitForCode(300_000);
    } catch (e) {
      log(`[AUTH] ${e.message}; trying direct token exchange...`);
      return this.#exchange(null);
    } finally {
      close();
    }

    log('[AUTH] Got auth code, exchanging for token...');
    return this.#exchange(code);
  }

  #body() {
    return { device_code: this.#deviceCode, login: CONFIG.username || 'proxy', ...PLUGIN_META };
  }

  async #getSignInUrl() {
    try {
      const res = await fetch(CONFIG.authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.#body()),
        signal: AbortSignal.timeout(CONFIG.requestTimeout),
      });

      if (res.status === 401) {
        const url = res.headers.get('x-signin-gitverse');
        if (!url) this.#lastAuthError = '401 without X-Signin-Gitverse header';
        return url || null;
      }
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.access_token) {
          this.#store(data);
          log('[AUTH] Token already issued by server');
          return '__TOKEN__';
        }
      }
      this.#lastAuthError = `unexpected status ${res.status}`;
      log(`[WARN] Unexpected auth status ${res.status}`);
      return null;
    } catch (e) {
      this.#lastAuthError = describeNetworkError(e);
      log(`[WARN] Could not get sign-in URL: ${this.#lastAuthError}`);
      return null;
    }
  }

  /** Exchange an auth code (or ask directly) for an access token. */
  async #exchange(code) {
    const attempts = code
      ? [{ 'X-Signin-Gitverse': code }, {}]   // with header, then without
      : [{}];

    let last = '';
    for (const extra of attempts) {
      try {
        const res = await fetch(CONFIG.authUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...extra },
          body: JSON.stringify(this.#body()),
          signal: AbortSignal.timeout(CONFIG.requestTimeout),
        });
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data.access_token) {
            this.#store(data);
            log(`[AUTH] Authenticated (expires in ${data.expires_in ?? 3600}s)`);
            return this.#token;
          }
        }
        last = `${res.status} ${(await res.text()).slice(0, 200)}`;
      } catch (e) {
        last = e.message;
      }
    }
    throw new Error(`Token exchange failed: ${last}`);
  }

  #store(data) {
    this.#token = data.access_token;
    this.#expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    try {
      fs.writeFileSync(CONFIG.tokenFile, JSON.stringify({
        access_token: this.#token,
        expires_at: this.#expiresAt,
        device_code: this.#deviceCode,
      }));
    } catch (e) {
      log(`[WARN] Could not save token cache: ${e.message}`);
    }
  }

  #loadCache() {
    try {
      const d = JSON.parse(fs.readFileSync(CONFIG.tokenFile, 'utf8'));
      this.#token = d.access_token ?? null;
      this.#expiresAt = d.expires_at ?? 0;
      this.#deviceCode ||= d.device_code ?? '';
      return true;
    } catch {
      return false;
    }
  }

  #loadOrCreateDeviceCode() {
    try {
      const code = fs.readFileSync(CONFIG.deviceCodeFile, 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(code)) return code;
    } catch { /* regenerate below */ }

    const code = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(CONFIG.deviceCodeFile, code);
    } catch (e) {
      log(`[WARN] Could not save device_code: ${e.message}`);
    }
    return code;
  }
}

/** Ephemeral localhost server that catches the OAuth redirect. */
function startCallbackServer() {
  return new Promise((resolve) => {
    let settle;
    const got = new Promise((res, rej) => { settle = { res, rej }; });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(code
        ? '<h1>Authentication successful</h1><p>You can close this window.</p><script>window.close()</script>'
        : '<h1>Authentication failed</h1><p>Check the proxy logs.</p>');

      if (code) settle.res(code);
      else settle.rej(new Error(error || 'No code in callback'));
    });

    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        waitForCode: (ms) => Promise.race([
          got,
          new Promise((_, rej) => setTimeout(() => rej(new Error('Callback timed out')), ms)),
        ]),
        close: () => server.close(),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Upstream HTTP client (auth injection + retries)
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message, type) {
    super(message);
    this.status = status;
    this.type = type || 'server_error';
  }
}

const STATUS_TYPES = {
  400: 'invalid_request_error', 401: 'authentication_error',
  403: 'permission_error', 404: 'not_found_error',
  413: 'invalid_request_error', 422: 'validation_error',
  429: 'rate_limit_error',
};

// Internal GigaCode error codes (recovered from the official JetBrains
// plugin). The API returns these instead of a readable message, so translate
// them — otherwise the editor just shows a bare status number.
const GIGACODE_ERRORS = {
  IAM_401: 'Not authenticated — the access token is missing or expired.',
  IAM_4031: 'Access denied — no permission for this operation.',
  IAM_4032: 'Access denied — the licence or subscription is inactive.',
  IAM_429: 'Too many requests to the auth service — slow down.',
  IAM_500: 'Auth service internal error.',
  IAM_504: 'Auth service timed out.',
  INF_400: 'Bad inference request — usually the token limit was exceeded.',
  INF_404: 'Model not found — check MODEL_NAME.',
  INF_413: 'Payload too large — the prompt exceeds the server limit. '
    + 'Shorten the history or split the task.',
  INF_422: 'Inference rejected the request shape — often an orphan tool '
    + 'result or a malformed message sequence.',
  AG_400: 'Agent service: bad request.',
  AG_404: 'Agent service: not found.',
  AG_500: 'Agent service: internal error.',
  AG_504: 'Agent service: timed out.',
  TOKEN_LIMIT_EXHAUSTED: 'Token limit exhausted — the prompt plus the '
    + 'requested output exceed the model budget.',
};

/** Pull a known GigaCode code out of an error body and explain it. */
function explainGigacodeError(text) {
  if (!text) return null;
  for (const [code, meaning] of Object.entries(GIGACODE_ERRORS)) {
    if (text.includes(code)) return `${code}: ${meaning}`;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * An abort timer that measures SILENCE, not elapsed time.
 *
 * A streaming answer can legitimately run for minutes: a long report is still
 * being produced token by token. A wall-clock budget kills it mid-sentence,
 * which is exactly what a user sees as "the proxy truncated my answer". What
 * actually signals a dead connection is the absence of data, so the timer is
 * re-armed on every chunk.
 */
class IdleAbort {
  #timer = null;
  #ctl = new AbortController();

  constructor(ms) {
    this.ms = ms;
    this.arm();
  }

  get signal() { return this.#ctl.signal; }

  arm() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#ctl.abort(new Error(
        `GigaCode sent no data for ${Math.round(this.ms / 1000)}s`,
      ));
    }, this.ms);
  }

  clear() {
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Wrap a stream so each chunk re-arms the timer; stop it when done. */
  wrap(stream) {
    if (!stream) return stream;
    const self = this;
    return stream.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        self.arm();
        controller.enqueue(chunk);
      },
      flush() { self.clear(); },
      cancel() { self.clear(); },
    }));
  }
}

class GigaCodeClient {
  constructor(auth) { this.auth = auth; }

  /**
   * POST JSON upstream. Retries 401 once (after refresh) and 429/500/503
   * with exponential backoff. Returns the raw Response.
   */
  async post(url, body, { stream = false } = {}) {
    let refreshed = false;
    trace('UP-REQ', { url, stream, body });

    for (let attempt = 0; ; attempt++) {
      let res;
      const idle = stream ? new IdleAbort(CONFIG.requestTimeout) : null;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'GigaCode-Proxy/2.0',
            Accept: stream ? 'text/event-stream' : 'application/json',
            ...this.auth.headers(),
          },
          body: JSON.stringify(body),
          signal: idle
            ? idle.signal
            : AbortSignal.timeout(CONFIG.requestTimeout),
        });
      } catch (e) {
        idle?.clear();
        if (attempt < 2) { await sleep(2 ** attempt * 1000); continue; }
        throw new HttpError(502, `Network error: ${describeNetworkError(e)}`);
      }

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        idle?.clear();
        if (await this.auth.refreshIfNeeded()) continue;
        throw new HttpError(401, 'Token refresh failed', 'authentication_error');
      }

      // 504/524 come from the gateway in front of GigaCode when the model
      // takes too long on a big prompt. They are transient, so retry them.
      if ([429, 500, 502, 503, 504, 408, 522, 524].includes(res.status) && attempt < 3) {
        log(`[UPSTREAM] HTTP ${res.status} from gateway, retry ${attempt + 1}/3`);
        idle?.clear();
        await sleep(2 ** attempt * 1000);
        continue;
      }

      trace('UP-RES', `${res.status} ${res.headers.get('content-type') ?? ''}`);

      if (!res.ok) {
        idle?.clear();
        const text = await res.text().catch(() => '');
        trace('UP-ERR', text.slice(0, 2000));
        let message = text.slice(0, 500) || 'Upstream error';
        try { message = JSON.parse(text).error ?? JSON.parse(text).message ?? message; } catch { /* plain text */ }

        // Gateways answer with a full HTML error page. Reduce it to one line
        // instead of spilling markup across the console.
        if (/^\s*<(!doctype|html)/i.test(text)) {
          const title = text.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
          message = title || `HTTP ${res.status} from the GigaCode gateway`;
          if (res.status === 504) {
            message += ' — the request took too long upstream. '
              + 'Usually the prompt is too big; start a new chat or shorten the context.';
          }
        }

        const explained = explainGigacodeError(text);
        if (explained) {
          log(`[UPSTREAM] ${explained}`);
          message = `${explained} (raw: ${String(message).slice(0, 200)})`;
        }

        throw new HttpError(res.status >= 500 ? 502 : res.status, message, STATUS_TYPES[res.status]);
      }

      // Hand back a stream that keeps the idle timer alive as long as data
      // flows, so a long generation is never cut off by the clock.
      if (idle) {
        return new Response(idle.wrap(res.body), {
          status: res.status,
          headers: res.headers,
        });
      }
      return res;
    }
  }

  /** Async iterator over non-empty upstream SSE lines. */
  async *streamLines(url, body) {
    const res = await this.post(url, body, { stream: true });
    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) yield line;
    }
    if (buffer.trim()) yield buffer;
  }
}

// ---------------------------------------------------------------------------
// Request transformation (OpenAI → GigaCode)
// ---------------------------------------------------------------------------

/** GigaCode is text-only: flatten multimodal content, keep intent visible. */
function flattenContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!CONFIG.flattenMultimodal) return content;
  if (!Array.isArray(content)) return String(content);

  const placeholders = {
    image_url: '[image omitted: GigaCode is text-only]',
    input_audio: '[audio omitted: GigaCode is text-only]',
    audio_url: '[audio omitted: GigaCode is text-only]',
    video_url: '[video omitted: GigaCode is text-only]',
  };

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text') return part.text ?? '';
      return placeholders[part.type] ?? `[${part.type ?? 'unknown'} part omitted]`;
    })
    .filter(Boolean)
    .join('\n');
}

// Fields the proxy itself consumes or renames; everything else the client
// sends is forwarded upstream untouched.
const HANDLED_KEYS = new Set([
  'model', 'messages', 'prompt', 'input', 'stream', 'max_tokens',
  'max_completion_tokens', 'max_output_tokens', 'top_p', 'stop', 'extra_body',
  // Client-side only: meaningless (or rejected) upstream.
  'stream_options', 'mode',
]);

/** Forward every unrecognised client field verbatim (plus extra_body). */
function copyExtras(target, req) {
  for (const [k, v] of Object.entries(req ?? {})) {
    if (!HANDLED_KEYS.has(k) && v !== undefined) target[k] = v;
  }
  for (const [k, v] of Object.entries(req?.extra_body ?? {})) {
    if (v !== undefined) target[k] = v;
  }
}

function transformChatRequest(req) {
  const messages = req.messages?.map((m) => {
    const out = { ...m, content: flattenContent(m.content) };
    // GigaCode rejects the "system" role outright — this rename is the one
    // message-level change we cannot skip.
    if (m.role === 'system' && SYSTEM_ROLE) out.role = SYSTEM_ROLE;
    return out;
  }) ?? [];

  // Orphan tool results at the head make GigaCode answer 422. Disable with
  // GIGACODE_KEEP_ORPHAN_TOOLS=1 if you want a pure passthrough.
  if (!CONFIG.keepOrphanTools) {
    while (messages.length && messages[0].role === 'tool') {
      log('[WARN] Dropping leading orphan tool message (upstream would 422)');
      messages.shift();
    }
  }

  const body = {
    model: resolveModel(req.model),
    messages,
    stream: Boolean(req.stream),
  };

  // Only send an output budget if the client asked for one (or a default is
  // configured). No silent cap.
  const maxTokens = req.max_tokens ?? req.max_completion_tokens ?? CONFIG.defaultMaxTokens;
  if (maxTokens) body.maxTokens = maxTokens;

  // Sampling is the client's business: forward only what it actually sent.
  if (req.top_p != null) body.topP = req.top_p;
  if (req.stop) body.stop = Array.isArray(req.stop) ? req.stop : [req.stop];

  copyExtras(body, req);
  return body;
}

function transformCompletionRequest(req) {
  const body = {
    model: resolveModel(req.model, { forCompletion: true }),
    prompt: Array.isArray(req.prompt) ? (req.prompt[0] ?? '') : (req.prompt ?? ''),
    stream: Boolean(req.stream),
  };

  const maxTokens = req.max_tokens ?? CONFIG.defaultMaxTokens;
  if (maxTokens) body.maxTokens = maxTokens;

  if (req.top_p != null) body.topP = req.top_p;
  if (req.stop) body.stop = Array.isArray(req.stop) ? req.stop : [req.stop];

  copyExtras(body, req);
  return body;
}

// ---------------------------------------------------------------------------
// Response transformation (GigaCode → OpenAI)
// ---------------------------------------------------------------------------

const pickNum = (...v) => v.find((x) => typeof x === 'number') ?? 0;

/** GigaCode may send arguments as an object, empty, or broken JSON. */
function normalizeToolCalls(toolCalls) {
  return (toolCalls ?? []).map((tc, i) => {
    const fn = { ...(tc.function ?? {}) };
    let args = fn.arguments;

    if (args == null || (typeof args === 'string' && !args.trim())) {
      args = '{}';
    } else if (typeof args !== 'string') {
      args = JSON.stringify(args);
    } else {
      try { JSON.parse(args); } catch { args = repairJson(args) ?? '{}'; }
    }

    fn.arguments = args;
    return { index: tc.index ?? i, id: tc.id, type: tc.type ?? 'function', function: fn };
  });
}

function transformChatResponse(data, model, id) {
  const choices = (data.choices ?? []).map((c, i) => {
    const msg = c.message ?? {};
    const tools = msg.toolCalls ?? msg.tool_calls;
    reportUnknownKeys(msg, 'message');
    const reasoning = CONFIG.reasoning === 'off' ? '' : extractReasoning(msg);
    let content = msg.content ?? null;
    const extra = {};

    if (reasoning) {
      if (CONFIG.reasoning === 'field') extra.reasoning_content = reasoning;
      else content = `<think>${reasoning}</think>\n\n${content ?? ''}`;
    }

    return {
      index: c.index ?? i,
      message: {
        role: msg.role ?? 'assistant',
        content,
        ...extra,
        ...(tools?.length ? { tool_calls: normalizeToolCalls(tools) } : {}),
      },
      finish_reason: c.finishReason ?? c.finish_reason ?? 'stop',
      logprobs: c.logprobs ?? null,
    };
  });

  const u = data.usage;
  return {
    id: data.id ?? id,
    object: 'chat.completion',
    created: data.created || Math.floor(Date.now() / 1000),
    model,
    choices,
    usage: u ? {
      prompt_tokens: pickNum(u.promptTokens, u.prompt_tokens),
      completion_tokens: pickNum(u.completionTokens, u.completion_tokens),
      total_tokens: pickNum(u.totalTokens, u.total_tokens),
    } : undefined,
  };
}

function transformCompletionResponse(data, model, id) {
  return {
    id: data.id ?? id,
    object: 'text_completion',
    created: data.created || Math.floor(Date.now() / 1000),
    model,
    choices: (data.choices ?? []).map((c, i) => ({
      index: c.index ?? i,
      text: c.text ?? c.message?.content ?? '',
      finish_reason: c.finishReason ?? c.finish_reason ?? 'stop',
      logprobs: c.logprobs ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

/** Best-effort repair of JSON truncated mid-stream. Returns null if hopeless. */
function repairJson(s) {
  if (!s) return null;

  let inString = false;
  let escape = false;
  const stack = [];

  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null;
    }
  }

  // Closing an unterminated string would INVENT content: {"new_text":"hello
  // becomes "hello" even though the model may have been writing "hello world".
  // For an editor tool that silently writes a truncated file. Only unbalanced
  // brackets are safe to close, because they add structure, not data.
  if (escape || inString) return null;

  let out = s;
  while (stack.length) out += stack.pop();

  try { JSON.parse(out); return out; } catch { return null; }
}

/**
 * GigaCode's stream mixes true deltas, cumulative snapshots and echoes.
 * Given everything seen so far and a new piece, return what is actually new.
 */
function smartDelta(known, piece) {
  if (!piece) return [known, ''];
  if (!known) return [piece, piece];
  if (known.startsWith(piece)) return [known, ''];
  if (piece.startsWith(known)) return [piece, piece.slice(known.length)];
  if (piece.length <= known.length && known.endsWith(piece)) return [known, ''];

  const max = Math.min(known.length, piece.length, 300);
  for (let k = max; k > 2; k--) {
    if (known.endsWith(piece.slice(0, k))) return [known + piece.slice(k), piece.slice(k)];
  }
  return [known + piece, piece];
}

/**
 * Scan `s` for every complete top-level JSON value.
 * Upstream concatenates whole snapshots ({...}{...}) and interleaves partial
 * ones, so a single JSON.parse is useless. Returns [] when nothing parses.
 */
function scanJsonValues(s) {
  const found = [];
  let i = 0;

  while (i < s.length) {
    // Scan in place; slicing the tail here made this quadratic on big args.
    let from = -1;
    for (let k = i; k < s.length; k++) {
      const c = s[k];
      if (c === '{' || c === '[') { from = k; break; }
    }
    if (from < 0) break;

    let depth = 0;
    let inString = false;
    let escape = false;
    let closed = -1;

    for (let j = from; j < s.length; j++) {
      const ch = s[j];
      if (escape) { escape = false; continue; }
      if (inString) {
        if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) { closed = j; break; }
      }
    }

    if (closed < 0) break;                       // truncated tail, stop here
    try { found.push(JSON.parse(s.slice(from, closed + 1))); } catch { /* skip */ }
    i = closed + 1;
  }

  return found;
}

/** Depth of useful content: how many non-empty leaf values an object holds. */
function scoreObject(o) {
  if (o === null || typeof o !== 'object') return (o === '' ? 0 : 1);
  return Object.values(o).reduce((n, v) => n + scoreObject(v), 0);
}

/**
 * Pick the richest reconstruction of a tool-call argument object.
 * Snapshots arrive in growing order but can also restart, so "first" and
 * "last" are both wrong: we merge every complete object we saw and keep the
 * variant carrying the most filled-in fields.
 */
function bestObject(candidates) {
  const objects = candidates.filter((c) => c && typeof c === 'object' && !Array.isArray(c));
  if (!objects.length) return candidates[candidates.length - 1] ?? null;

  // Later snapshots win per key, but a key is never overwritten with an
  // empty/undefined value from a truncated fragment.
  const merged = {};
  for (const o of objects) {
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined || v === null || v === '') continue;
      merged[k] = v;
    }
  }

  const best = objects.reduce((a, b) => (scoreObject(b) > scoreObject(a) ? b : a));
  return scoreObject(merged) >= scoreObject(best) ? merged : best;
}

/** Accumulates tool_call fragments across chunks until they are complete. */
class ToolCallAggregator {
  #parts = new Map();   // `${choice}:${index}` → tool call
  #required = new Map();// tool name → required parameter names
  #allowed = new Map(); // tool name → { keys: declared names, open: takes any }
  upstreamFinish = null;// what GigaCode itself said when the turn ended
  truncated = false;
  dropped = [];         // names of calls discarded for having no arguments

  /**
   * Learn required parameters from the tool schema the client sent.
   * A truncated call can repair into valid-but-incomplete JSON (e.g. Write
   * with only `file_path`). The client then rejects it and the agent retries
   * forever, inventing new write tools. Knowing what is mandatory lets us
   * reject the fragment here and ask for a clean retry instead.
   */
  learnSchema(tools) {
    if (!Array.isArray(tools)) return;
    for (const t of tools) {
      const name = t?.function?.name;
      if (!name) continue;
      const req = t?.function?.parameters?.required;
      if (Array.isArray(req) && req.length) this.#required.set(name, req);
      const params = t?.function?.parameters;
      const props = params?.properties;
      if (props && typeof props === 'object') {
        // A schema with additionalProperties:true is a deliberate "anything
        // goes" declaration (loose clients, free-form payloads). Stripping
        // against it would erase information the client asked to receive.
        this.#allowed.set(name, {
          keys: new Set(Object.keys(props)),
          open: params.additionalProperties === true,
        });
      }
    }
  }

  /** Required keys that are missing or empty in the assembled arguments. */
  #missing(name, parsed) {
    const req = this.#required.get(name);
    if (!req || !parsed || typeof parsed !== 'object') return [];
    return req.filter((k) => {
      const v = parsed[k];
      return v === undefined || v === null || v === '';
    });
  }

  add(choiceIndex, toolCalls) {
    toolCalls.forEach((tc, i) => {
      const idx = tc.index ?? i;
      const key = `${choiceIndex}:${idx}`;
      const cur = this.#parts.get(key) ?? {
        index: idx, id: tc.id, type: tc.type ?? 'function',
        function: { name: '', arguments: '' }, fragments: [],
      };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.function.name = tc.function.name;
      if (tc.function?.arguments != null) {
        const frag = String(tc.function.arguments);
        cur.fragments.push(frag);
        trace('TC-FRAG', `choice=${choiceIndex} idx=${idx} `
          + `name=${cur.function.name || '?'} #${cur.fragments.length} `
          + `len=${frag.length} ${JSON.stringify(frag)}`);
      }
      this.#parts.set(key, cur);
    });
  }

  get choiceIndexes() {
    return [...new Set([...this.#parts.keys()].map((k) => Number(k.split(':')[0])))];
  }

  /** Finalize + drain tool calls for one choice. Never drops a call silently. */
  drain(choiceIndex) {
    const out = [];
    // Clients index tool results by id; a missing one breaks the whole loop.
    const ensureId = (tc) => tc.id
      || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

    for (const [key, tc] of [...this.#parts.entries()].sort()) {
      if (Number(key.split(':')[0]) !== choiceIndex) continue;
      this.#parts.delete(key);

      const name = tc.function.name || '';
      const frags = tc.fragments ?? [];
      const candidates = [];

      // 1. Every fragment that is already a complete object on its own.
      //    GigaCode resends growing snapshots, so the same fragment often
      //    repeats verbatim; parsing it once is enough.
      const seenFrags = new Set();
      for (const f of frags) {
        if (!f || seenFrags.has(f)) continue;
        seenFrags.add(f);
        candidates.push(...scanJsonValues(f));
      }
      // 2. Plain concatenation, for true streaming deltas split mid-token.
      const joined = frags.join('');
      // Skip the rescan when a single fragment already was the whole payload.
      if (seenFrags.size !== 1 || !seenFrags.has(joined)) {
        candidates.push(...scanJsonValues(joined));
      }

      let args = null;
      let note = '';

      // Guarded: these payloads cost real time on 12k-char tool arguments,
      // and without the check they were built even with tracing off.
      if (tracing()) {
        trace('TC-DRAIN', `name=${name} fragments=${frags.length} `
          + `joinedLen=${joined.length} candidates=${candidates.length}`);
        frags.forEach((f, n) => trace('TC-IN', `#${n} ${JSON.stringify(f)}`));
        candidates.forEach((c, n) => trace('TC-CAND',
          `#${n} score=${scoreObject(c)} ${JSON.stringify(c)}`));
        if (!candidates.length) trace('TC-JOINED', JSON.stringify(joined));
      }

      if (candidates.length) {
        const picked = bestObject(candidates);
        args = JSON.stringify(picked);
        trace('TC-PICKED', `score=${scoreObject(picked)} keys=`
          + `${Object.keys(picked ?? {}).join(',')} ${args}`);
        if (candidates.length > 1) {
          note = `merged ${candidates.length} snapshot(s)`;
        }
      } else if (joined.trim()) {
        // Nothing complete: the stream was cut mid-object. Repair the tail,
        // but only when that adds structure rather than invented data.
        const fixed = repairJson(joined);
        if (fixed) {
          args = fixed;
          note = 'repaired truncated JSON';
        } else {
          // Cut mid-value. Forwarding it - or the {} it degrades to - hides a
          // broken payload and makes the editor fail on invented data.
          this.truncated = true;
          this.dropped.push(name || '(unnamed)');
          log(`[TOOL] ${name || '(unnamed)'}: arguments cut mid-value after `
            + `${joined.length} chars (upstream finish_reason=`
            + `${this.upstreamFinish ?? 'none'}) - dropping the call and `
            + 'signalling a retry');
          trace('TC-DROP', { name, joined });
          continue;
        }
      }

      if (args === null) args = '{}';

      // Final guarantee: clients crash on non-object arguments.
      try {
        const parsed = JSON.parse(args);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          args = '{}';
          note = 'non-object arguments replaced with {}';
        }
      } catch {
        args = '{}';
        this.truncated = true;
        note = 'unparseable, replaced with {}';
      }

      // Upstream sometimes emits a tool call with no arguments at all (the
      // generation was cut before any were produced). Forwarding `{}` makes
      // the client fail schema validation with "received undefined"; the
      // agent then burns a turn recovering. Flagging truncation instead makes
      // the client retry cleanly.
      // `{}` is a legitimate call for a tool that takes no parameters - MCP
      // servers declare plenty of those. It is only suspicious when the client
      // said which fields are mandatory: forwarding then makes the editor fail
      // validation with "received undefined" and the agent burns a turn
      // recovering, so flag truncation and let it retry cleanly instead.
      if (args === '{}') {
        const hadContent = frags.some((f) => f.trim() && f.trim() !== '{}');
        const req = this.#required.get(name) ?? [];
        if (!hadContent && req.length) {
          this.truncated = true;
          this.dropped.push(name || '(unnamed)');
          log(`[TOOL] ${name || '(unnamed)'}: upstream sent NO arguments but `
            + `the schema requires ${req.join(', ')} - dropping the call and `
            + 'signalling a retry');
          trace('TC-DROP', { name, fragments: frags });
          continue;
        }
        if (!hadContent) note = 'no arguments; schema requires none - forwarding';
      }

      // Merging growing snapshots can pull in keys from an unrelated call the
      // model started and abandoned (e.g. a stray file_path landing on Bash).
      // The schema says which keys this tool actually accepts.
      const allowed = this.#allowed.get(name);
      if (allowed && !allowed.open) {
        try {
          const obj = JSON.parse(args);
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            const alien = Object.keys(obj).filter((k) => !allowed.keys.has(k));
            const kept = Object.keys(obj).filter((k) => allowed.keys.has(k));

            // Stripping is only safe when something recognised survives. If
            // every key is unknown, the model used a different argument shape
            // (e.g. flat {count, filter} where the schema wants {queries:[…]})
            // rather than leaking a key from another call. Emptying that to {}
            // guarantees a dropped call; forwarding it lets the editor answer
            // with a real validation error the model can actually act on.
            if (alien.length && kept.length) {
              for (const k of alien) delete obj[k];
              args = JSON.stringify(obj);
              log(`[TOOL] ${name}: dropped keys not in its schema: ${alien.join(', ')}`);
            } else if (alien.length) {
              log(`[TOOL] ${name}: arguments match no schema key `
                + `(${alien.join(', ')}) - forwarding as-is, the client will `
                + 'reject them with a usable error');
            }
          }
        } catch { /* handled by the guards below */ }
      }

      // Schema check: valid JSON is not the same as a usable call. If the
      // upstream cut the payload before a required field, forwarding it makes
      // the client reject the call and the agent spiral into retries.
      const missing = this.#missing(name, (() => {
        try { return JSON.parse(args); } catch { return null; }
      })());
      // Only treat missing fields as truncation when the upstream actually cut
      // the turn. If it closed with "tool_calls" the arguments are complete —
      // just not the shape this schema wants. Dropping those is wrong: the
      // model never gets the validation error it needs to correct itself.
      const cutOff = this.upstreamFinish !== 'tool_calls';
      if (missing.length && !cutOff) {
        log(`[TOOL] ${name || '(unnamed)'}: missing ${missing.join(', ')} but `
          + 'upstream finished normally - forwarding so the client can reject it');
      }
      if (missing.length && cutOff) {
        this.truncated = true;
        this.dropped.push(name || '(unnamed)');
        // The upstream finish_reason distinguishes a real token-budget stop
        // ("length") from the model simply ending its turn early ("stop").
        // Without it the cause of a truncation is pure guesswork.
        log(`[TOOL] ${name || '(unnamed)'}: truncated before required `
          + `${missing.join(', ')} after ${args.length} chars `
          + `(upstream finish_reason=${this.upstreamFinish ?? 'none'}) `
          + '- dropping the call and signalling a retry');
        trace('TC-DROP', { name, missing, args });
        continue;
      }

      if (note) log(`[TOOL] ${name || '(unnamed)'}: ${note} -> ${args.slice(0, 160)}`);

      const emitted = {
        index: tc.index ?? out.length,
        id: ensureId(tc),
        type: tc.type || 'function',
        function: { name, arguments: args },
      };
      trace('TC-OUT', emitted);
      out.push(emitted);
    }
    return out;
  }
}

/**
 * Streaming parser for inline <think>…</think> blocks.
 *
 * The official JetBrains plugin ships a ThinkTagStreamParser, which proves
 * GigaCode emits reasoning inside the text rather than in `reasoning_content`
 * (that field is always null for CodeChat). Tags can be split across chunks,
 * so the tail is buffered until it is known not to be a partial tag.
 */
class ThinkTagParser {
  #inside = false;
  #pending = '';           // possible partial tag held back

  static OPEN = '<think>';
  static CLOSE = '</think>';

  /** Feed a chunk, get { text, reasoning } that are safe to emit now. */
  accept(chunk) {
    let buf = this.#pending + chunk;
    this.#pending = '';
    let text = '';
    let reasoning = '';

    for (;;) {
      const tag = this.#inside ? ThinkTagParser.CLOSE : ThinkTagParser.OPEN;
      const at = buf.indexOf(tag);

      if (at >= 0) {
        const before = buf.slice(0, at);
        if (this.#inside) reasoning += before;
        else text += before;
        this.#inside = !this.#inside;
        buf = buf.slice(at + tag.length);
        continue;
      }

      // No complete tag: hold back a tail that could still become one.
      const keep = ThinkTagParser.CLOSE.length - 1;
      const head = buf.length > keep ? buf.slice(0, -keep) : '';
      const tail = buf.length > keep ? buf.slice(-keep) : buf;

      // Only buffer the tail if it actually looks like the start of a tag.
      if (/<\/?t?h?i?n?k?>?$/.test(tail)) {
        this.#pending = tail;
        if (this.#inside) reasoning += head;
        else text += head;
      } else if (this.#inside) {
        reasoning += buf;
      } else {
        text += buf;
      }
      break;
    }

    return { text, reasoning };
  }

  /** Flush whatever is still buffered at end of stream. */
  finish() {
    const rest = this.#pending;
    this.#pending = '';
    return this.#inside ? { text: '', reasoning: rest } : { text: rest, reasoning: '' };
  }

  get inside() { return this.#inside; }
}

// GigaCode/vLLM-style backends name the thinking field differently.
const REASONING_KEYS = ['reasoning_content', 'reasoningContent', 'reasoning', 'thinking'];

function extractReasoning(src) {
  for (const k of REASONING_KEYS) {
    const v = src?.[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

// Keys we already understand; anything else upstream sends is reported once
// so an unknown reasoning field can actually be found instead of guessed.
const SEEN_UNKNOWN_KEYS = new Set();
const KNOWN_DELTA_KEYS = new Set([
  'role', 'content', 'tool_calls', 'toolCalls', 'function_call', 'refusal',
  ...REASONING_KEYS,
]);

function reportUnknownKeys(src, where) {
  for (const k of Object.keys(src ?? {})) {
    if (KNOWN_DELTA_KEYS.has(k) || SEEN_UNKNOWN_KEYS.has(k)) continue;
    SEEN_UNKNOWN_KEYS.add(k);
    const sample = JSON.stringify(src[k])?.slice(0, 120);
    log(`[FIELD] upstream ${where} carries unhandled key "${k}": ${sample}`);
  }
}

function parseSseLine(line) {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (payload === '[DONE]') return { done: true };
  try { return JSON.parse(payload); } catch { return null; }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const auth = new AuthManager();
const client = new GigaCodeClient(auth);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': '*',
  'Access-Control-Allow-Headers': '*',
};

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  trace('OUT-JSON', `${status} ${data}`);
  res.writeHead(status, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function sendError(res, err) {
  const status = err.status ?? 500;
  log(`[ERROR] ${status} ${err.message}`);
  sendJson(res, status, {
    error: { message: err.message, type: err.type ?? 'server_error', param: null, code: status },
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new HttpError(400, 'Invalid JSON body', 'invalid_request_error')); }
    });
  });
}

async function ensureAuth() {
  if (auth.isAuthorized) return;
  try {
    await auth.authenticate();
  } catch (e) {
    throw new HttpError(401, e.message, 'authentication_error');
  }
}

/** Pipe an upstream SSE stream to the client in OpenAI chunk format. */
async function streamChat(res, { url, body, model, id, object, wantsUsage = false }) {
  let usage = null;
  res.writeHead(200, {
    ...CORS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const created = Math.floor(Date.now() / 1000);
  const agg = new ToolCallAggregator();
  // The request still carries the client's tool definitions; use them to tell
  // a complete call from a truncated one.
  agg.learnSchema(body?.tools);
  const write = (payload) => {
    trace('OUT-CHUNK', payload);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const frame = (choices) => ({
    id,
    object,
    created,
    model,
    choices: choices.map((c) => ({ finish_reason: null, ...c })),
  });

  let seen = '';
  let seenReasoning = '';
  let thinkOpen = false;      // <think> emitted but not yet closed
  const inlineThink = new ThinkTagParser();
  let sentFinish = false;
  let sentRole = false;
  let lastWrite = Date.now();

  // OpenAI always opens with a role-only chunk; several clients rely on it to
  // create the assistant message before any text arrives.
  if (object === 'chat.completion.chunk') {
    write(frame([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]));
    sentRole = true;
  }

  // Some editors show nothing at all until the first token; a periodic SSE
  // comment keeps the connection visibly alive during long thinking phases.
  const heartbeat = CONFIG.keepAliveMs > 0 ? setInterval(() => {
    if (Date.now() - lastWrite >= CONFIG.keepAliveMs && !res.writableEnded) {
      res.write(': keep-alive\n\n');
      lastWrite = Date.now();
    }
  }, Math.max(1000, CONFIG.keepAliveMs)) : null;

  try {
    for await (const line of client.streamLines(url, body)) {
      if (CONFIG.debugRaw) log(`[RAW] ${line.slice(0, 600)}`);
      else trace('RAW', line);
      const parsed = parseSseLine(line);
      if (!parsed) continue;
      if (parsed.done) break;
      if (parsed.usage) usage = parsed.usage;

      for (const [i, c] of (parsed.choices ?? []).entries()) {
        const index = c.index ?? i;
        const src = c.delta ?? {};
        let finish = c.finishReason ?? c.finish_reason ?? null;
        if (finish) agg.upstreamFinish = finish;
        const delta = {};

        if (src.role && !sentRole) { delta.role = src.role; sentRole = true; }

        reportUnknownKeys(src, 'delta');

        // --- chain-of-thought ---------------------------------------------
        if (CONFIG.reasoning !== 'off') {
          const raw = extractReasoning(src);
          if (raw) {
            // Reasoning arrives in the same cumulative/echo shapes as content.
            const [nextR, emitR] = smartDelta(seenReasoning, raw);
            seenReasoning = nextR;
            if (emitR) {
              if (CONFIG.reasoning === 'field') {
                delta.reasoning_content = emitR;
              } else {
                delta.content = (thinkOpen ? '' : '<think>') + emitR;
                thinkOpen = true;
              }
            }
          }
        }

        let piece = src.content;

        // Split inline <think> blocks out of the text before anything else.
        if (piece) {
          const split = inlineThink.accept(piece);
          piece = split.text;

          if (split.reasoning) {
            trace('THINK-INLINE', split.reasoning.slice(0, 200));
            if (CONFIG.reasoning === 'field') {
              delta.reasoning_content = (delta.reasoning_content ?? '') + split.reasoning;
            } else if (CONFIG.reasoning === 'tags') {
              delta.content = (delta.content ?? '')
                + (thinkOpen ? '' : '<think>') + split.reasoning;
              thinkOpen = true;
            }
            // reasoning === 'off': drop it entirely.
          }
        }

        if (piece) {
          if (CONFIG.debugChunks) log(`[CHUNK] ${JSON.stringify(piece.slice(0, 80))}`);
          const [next, emit] = smartDelta(seen, piece);
          seen = next;
          if (emit) {
            // First real answer token closes the thinking block.
            const prefix = thinkOpen ? '</think>\n\n' : '';
            if (thinkOpen) thinkOpen = false;
            delta.content = (delta.content ?? '') + prefix + emit;
          }
        }

        const tools = src.tool_calls ?? src.toolCalls;
        if (tools?.length) agg.add(index, tools);

        if (finish && thinkOpen) {
          delta.content = (delta.content ?? '') + '</think>\n\n';
          thinkOpen = false;
        }

        if (finish) {
          const complete = agg.drain(index);
          if (complete.length) {
            delta.tool_calls = complete;
            if (finish === 'stop') finish = 'tool_calls';
          } else if (agg.dropped.length) {
            // A tool call arrived unusable (truncated or empty). Report the
            // upstream reason as-is: claiming "length" makes editors print
            // "model reached max token limit" and chase a budget that was
            // never the problem. Raising max_tokens cannot fix a cut stream.
            log(`[TOOL] no usable tool_calls left (dropped: `
              + `${agg.dropped.join(', ')}); finish_reason=${finish} `
              + '(NOT a token limit - upstream cut the arguments)');
          }
        }

        if (Object.keys(delta).length || finish) {
          if (finish) sentFinish = true;
          lastWrite = Date.now();
          write(frame([{ index, delta, finish_reason: finish }]));
        }
      }
    }
  } catch (e) {
    // One line only: the message may be a whole HTML page.
    log(`[ERROR] Stream failed: ${String(e.message).replace(/\s+/g, ' ').slice(0, 200)}`);
    // The connection died. 'stop' would pass a half-written answer off as
    // complete, but 'length' makes editors report a token limit that does not
    // exist. 'content_filter' is the honest OpenAI value for "ended early for
    // a reason other than the budget".
    write(frame([{
      index: 0,
      delta: thinkOpen ? { content: '</think>\n\n' } : {},
      finish_reason: 'content_filter',
    }]));
    thinkOpen = false;
    sentFinish = true;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }

  // Drain tool calls the upstream never terminated.
  for (const index of agg.choiceIndexes) {
    const complete = agg.drain(index);
    if (!complete.length) {
      if (agg.dropped.length && !sentFinish) {
        // Unusable tool call, not a budget problem — see above.
        write(frame([{ index, delta: {}, finish_reason: 'content_filter' }]));
        sentFinish = true;
      }
      continue;
    }
    write(frame([{
      index,
      delta: { tool_calls: complete },
      finish_reason: agg.truncated ? 'content_filter' : 'tool_calls',
    }]));
    sentFinish = true;
  }

  if (!sentFinish) {
    write(frame([{
      index: 0,
      delta: thinkOpen ? { content: '</think>\n\n' } : {},
      finish_reason: 'stop',
    }]));
  }

  // OpenAI sends a final usage-only chunk when stream_options asks for it;
  // clients that request it may otherwise wait for one that never comes.
  if (wantsUsage) {
    write({
      id,
      object,
      created,
      model,
      choices: [],
      usage: usage ? {
        prompt_tokens: pickNum(usage.promptTokens, usage.prompt_tokens),
        completion_tokens: pickNum(usage.completionTokens, usage.completion_tokens),
        total_tokens: pickNum(usage.totalTokens, usage.total_tokens),
      } : null,
    });
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Answer a non-streaming request by streaming from GigaCode and assembling
 * the result here.
 *
 * Agent steps (ZCode tool calls) arrive with stream=false, so nothing is
 * visible for tens of seconds and the editor looks frozen. Asking upstream
 * for a stream lets us log live progress and keep the socket warm, while the
 * client still receives exactly one JSON object.
 */
async function collectFromStream(res, { url, body, model, id }) {
  const started = Date.now();
  const agg = new ToolCallAggregator();
  // The request still carries the client's tool definitions; use them to tell
  // a complete call from a truncated one.
  agg.learnSchema(body?.tools);

  let content = '';
  let reasoning = '';
  let role = 'assistant';
  let finish = null;
  let usage = null;
  let lastLog = 0;

  // Keep the TCP socket alive: some clients drop idle connections, and the
  // upstream may think for a long time before the first token.
  res.setTimeout?.(0);

  for await (const line of client.streamLines(url, body)) {
    if (CONFIG.debugRaw) log(`[RAW] ${line.slice(0, 600)}`);
    else trace('RAW', line);
    const parsed = parseSseLine(line);
    if (!parsed) continue;
    if (parsed.done) break;
    if (parsed.usage) usage = parsed.usage;

    for (const [i, c] of (parsed.choices ?? []).entries()) {
      const src = c.delta ?? c.message ?? {};
      reportUnknownKeys(src, 'delta');

      if (src.role) role = src.role;
      if (src.content) [content] = smartDelta(content, src.content);

      const think = extractReasoning(src);
      if (think) [reasoning] = smartDelta(reasoning, think);

      const tools = src.tool_calls ?? src.toolCalls;
      if (tools?.length) agg.add(c.index ?? i, tools);

      finish = c.finishReason ?? c.finish_reason ?? finish;
      if (finish) agg.upstreamFinish = finish;
    }

    // Heartbeat in the log so a long agent step is visibly alive.
    if (Date.now() - lastLog > 5000) {
      lastLog = Date.now();
      log(`[WAIT] ${((Date.now() - started) / 1000).toFixed(0)}s `
        + `chars=${content.length} tools=${agg.choiceIndexes.length}`);
    }
  }

  const toolCalls = agg.drain(0);
  if (toolCalls.length && (!finish || finish === 'stop')) finish = 'tool_calls';
  if (!toolCalls.length && agg.dropped.length) {
    // See the streaming path: do not invent a token-limit stop.
    log(`[TOOL] no usable tool_calls left (dropped: ${agg.dropped.join(', ')}) `
      + `finish_reason=${finish} (NOT a token limit)`);
  }

  if (reasoning && CONFIG.reasoning === 'tags') {
    content = `<think>${reasoning}</think>\n\n${content}`;
  }

  log(`[DONE] ${((Date.now() - started) / 1000).toFixed(1)}s `
    + `chars=${content.length} tools=${toolCalls.length} finish=${finish ?? 'stop'}`);

  return sendJson(res, 200, {
    id,
    object: 'chat.completion',
    created: Math.floor(started / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role,
        content: content || null,
        ...(reasoning && CONFIG.reasoning === 'field' ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finish ?? 'stop',
    }],
    ...(usage ? {
      usage: {
        prompt_tokens: pickNum(usage.promptTokens, usage.prompt_tokens),
        completion_tokens: pickNum(usage.completionTokens, usage.completion_tokens),
        total_tokens: pickNum(usage.totalTokens, usage.total_tokens),
      },
    } : {}),
  });
}

const MODEL_ENTRY = (id) => ({
  id,
  object: 'model',
  created: 0,
  owned_by: 'gigacode',
  permission: [],
  root: id,
  parent: null,
});

// Many editors only offer models returned by /v1/models, and some ship a
// hardcoded preset ("gpt-4o", "claude-3-5-sonnet"). Advertising the aliases
// too means the model picker is never empty, whatever the client expects.
const ADVERTISED = [
  ...KNOWN_MODELS,
  ...new Set([...Object.keys(CHAT_ALIASES), ...Object.keys(COMPLETION_ALIASES)]),
  ...String(env('GIGACODE_EXTRA_MODELS', '')).split(',').map((m) => m.trim()).filter(Boolean),
];

const MODEL_LIST = { object: 'list', data: ADVERTISED.map(MODEL_ENTRY) };

/** GET /models/{id} — some clients validate the model before every request. */
const MODEL_ITEM_ROUTE = (method, route) => {
  if (method !== 'GET') return null;
  const m = route.match(/^\/models\/(.+)$/);
  if (!m) return null;
  return (_body, res) => sendJson(res, 200, MODEL_ENTRY(decodeURIComponent(m[1])));
};

// Routes are matched with and without the /v1 prefix so every editor works.
const ROUTES = {
  'GET /models': (_body, res) => sendJson(res, 200, MODEL_LIST),

  // Echo what the client actually sent — the fastest way to debug a new editor.
  'POST /debug/echo': (body, res) => sendJson(res, 200, {
    received: body,
    upstream_would_be: transformChatRequest(body),
  }),

  'GET /health': (_body, res) => sendJson(res, 200, {
    status: auth.isAuthorized ? 'ok' : 'unauthorized',
    authenticated: auth.isAuthorized,
    model: CONFIG.modelName,
  }),

  'POST /chat/completions': async (body, res) => {
    await ensureAuth();
    const model = body.model || CONFIG.modelName;
    const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const giga = transformChatRequest(body);

    const chars = JSON.stringify(giga.messages).length;
    log(`[REQ] chat model=${giga.model} stream=${giga.stream} `
      + `msgs=${giga.messages.length}/${body.messages?.length ?? 0} sent `
      + `chars=${chars} tools=${giga.tools?.length ?? 0} maxTokens=${giga.maxTokens ?? 'client-default'}`);

    // Past roughly 150k characters GigaCode starts answering with gateway
    // timeouts and argument-less tool calls. Warn before it happens rather
    // than leaving the failure unexplained.
    if (chars > 150_000) {
      log(`[WARN] context is ${Math.round(chars / 1000)}k chars - GigaCode often `
        + `times out or returns empty tool arguments past ~150k. Start a new chat.`);

      // Show WHERE the context went. Tool results (re-reads of the same file)
      // and repeated edit snapshots dominate long sessions, which is not
      // obvious from the total alone.
      const bucket = { system: 0, user: 0, assistant: 0, tool: 0 };
      for (const m of giga.messages ?? []) {
        const size = JSON.stringify(m).length;
        const role = m.role === 'tool' || m.tool_call_id ? 'tool'
          : (bucket[m.role] !== undefined ? m.role : 'user');
        bucket[role] += size;
      }
      const schemas = JSON.stringify(giga.tools ?? []).length;
      const kb = (n) => `${Math.round(n / 1024)}k`;
      log(`[WARN] breakdown: tool-results=${kb(bucket.tool)} `
        + `assistant=${kb(bucket.assistant)} user=${kb(bucket.user)} `
        + `system=${kb(bucket.system)} tool-schemas=${kb(schemas)}`);
    }

    if (body.stream) {
      return streamChat(res, {
        url: CONFIG.chatUrl, body: giga, model, id, object: 'chat.completion.chunk',
        wantsUsage: Boolean(body.stream_options?.include_usage),
      });
    }
    // Upgrade blocking requests to an upstream stream (see collectFromStream).
    if (CONFIG.streamNonStream) {
      return collectFromStream(res, {
        url: CONFIG.chatUrl, body: { ...giga, stream: true }, model, id,
      });
    }
    const upstream = await client.post(CONFIG.chatUrl, giga);
    return sendJson(res, 200, transformChatResponse(await upstream.json(), model, id));
  },

  'POST /completions': async (body, res) => {
    await ensureAuth();
    const model = body.model || CONFIG.modelName;
    const id = `cmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const giga = transformCompletionRequest(body);

    if (body.stream) {
      return streamChat(res, {
        url: CONFIG.completionsUrl, body: giga, model, id, object: 'text_completion',
      });
    }
    const upstream = await client.post(CONFIG.completionsUrl, giga);
    return sendJson(res, 200, transformCompletionResponse(await upstream.json(), model, id));
  },

  'POST /responses': async (body, res) => {
    await ensureAuth();
    const model = body.model || CONFIG.modelName;
    const giga = {
      model: resolveModel(body.model),
      input: body.input,
      stream: Boolean(body.stream),
      ...(body.max_output_tokens ? { maxOutputTokens: body.max_output_tokens } : {}),
    };
    copyExtras(giga, body);
    const id = `resp-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

    if (body.stream) {
      return streamChat(res, {
        url: CONFIG.responsesUrl, body: giga, model, id, object: 'chat.completion.chunk',
      });
    }

    const data = await (await client.post(CONFIG.responsesUrl, giga)).json();
    const first = data.choices?.[0] ?? {};
    const text = first.message?.content ?? first.output ?? '';
    return sendJson(res, 200, {
      id: data.id ?? id,
      object: 'response',
      created: data.created || Math.floor(Date.now() / 1000),
      model,
      output: [{ type: 'message', content: [{ type: 'text', text }] }],
    });
  },
};

const server = http.createServer(async (req, res) => {
  // SSE deltas are tiny writes. Nagle's algorithm holds them back waiting for
  // more data, which shows up as visibly stuttering token output.
  req.socket.setNoDelay(true);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  const pathname = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '') || '/';

  // Editors disagree on the base path: /v1/…, /api/v1/…, /openai/v1/…,
  // LM-Studio-style /v1/v1/… . Strip every known prefix until none is left.
  let route = pathname;
  for (let prev = null; prev !== route;) {
    prev = route;
    route = route.replace(/^\/(v1|api|openai|oai)(?=\/|$)/, '');
  }
  route = route || '/';

  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const handler = ROUTES[`${method} ${route}`] ?? MODEL_ITEM_ROUTE(method, route);

  if (!handler) {
    // Log the miss: a new editor probing an unsupported path is otherwise
    // invisible and looks like "the proxy is broken".
    log(`[404] ${req.method} ${pathname}`);
    return sendError(res, new HttpError(404, `Unknown endpoint ${pathname}`, 'not_found_error'));
  }

  try {
    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    trace('IN', `${req.method} ${pathname} -> ${route}`);
    if (req.method === 'POST') trace('IN-BODY', body);
    await handler(body, res);
  } catch (e) {
    if (res.headersSent) res.end();
    else sendError(res, e instanceof HttpError ? e : new HttpError(502, e.message));
  }
});

// A leftover instance holding the port is the single most common startup
// failure; the raw EADDRINUSE stack trace tells the user nothing useful.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`[FATAL] Port ${CONFIG.port} is already in use on ${CONFIG.host}.`);
    log('[FATAL] Another copy of the proxy is probably still running.');
    log('[FATAL] Windows:  netstat -ano | findstr :' + CONFIG.port);
    log('[FATAL]           taskkill /PID <pid> /F');
    log('[FATAL] Linux/macOS:  kill $(lsof -ti tcp:' + CONFIG.port + ')');
    log(`[FATAL] Or start on another port: set PROXY_PORT=${CONFIG.port + 1} && npm start`);
  } else if (err.code === 'EACCES') {
    log(`[FATAL] Not allowed to bind ${CONFIG.host}:${CONFIG.port}. `
      + 'Pick a port above 1024.');
  } else {
    log(`[FATAL] Server error: ${err.message}`);
  }
  process.exit(1);
});

server.listen(CONFIG.port, CONFIG.host, () => {
  log(`[INFO] GigaCode proxy on http://${CONFIG.host}:${CONFIG.port}/v1`);
  log(`[INFO] config: ${LOADED_ENV_FILES.join(', ') || 'none found (using defaults)'}`);
  if (!configLoaded) {
    // The repo ships env.example, not a ready env.txt (it would carry someone
    // else's login). Without this hint a fresh clone just fails to log in.
    log('[INFO] no env.txt found - copy env.example to env.txt and set '
      + 'GIGACODE_USERNAME, or authenticate through the browser when asked');
  }
  log(`[INFO] user=${CONFIG.username || '(unset)'} model=${CONFIG.modelName} `
    + `maxTokens=${CONFIG.defaultMaxTokens || 'client-decides'}`);
  log(`[INFO] passthrough: model=${CONFIG.passthroughModel ? 'raw' : 'aliased'} `
    + `sampling=client-only extra-fields=forwarded `
    + `system->${SYSTEM_ROLE ?? 'unchanged'} `
    + `orphan-tools=${CONFIG.keepOrphanTools ? 'kept' : 'dropped'} `
    + `multimodal=${CONFIG.flattenMultimodal ? 'flattened' : 'raw'}`);
  log(`[INFO] reasoning=${CONFIG.reasoning} `
    + `keepalive=${CONFIG.keepAliveMs ? CONFIG.keepAliveMs + 'ms' : 'off'} `
    + `non-stream=${CONFIG.streamNonStream ? 'via-upstream-stream' : 'blocking'}`);
  log('[INFO] Point your editor at that URL; any API key value works.');
  if (traceStream) log(`[INFO] full trace -> ${TRACE_FILE}`);
  else log('[INFO] tracing OFF (set GIGACODE_TRACE=1 for a full trace.log)');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); process.exit(0); });
}
