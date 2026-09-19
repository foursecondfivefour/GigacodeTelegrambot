#!/usr/bin/env node
/**
 * Telegram-бот поверх GigaCode → OpenAI-прокси (server.mjs).
 *
 * Никаких зависимостей: только встроенные модули Node >= 18
 * (fetch, ReadableStream, AbortSignal.timeout). npm install не нужен.
 *
 * Что умеет:
 *   • диалог с моделью GigaCode прямо из Telegram (потоковый вывод);
 *   • историю на каждый чат с обрезкой по бюджету символов;
 *   • Markdown → Telegram HTML (код, таблицы, цитаты, ссылки, списки);
 *   • команды /new, /retry, /model, /system, /stats, /cancel, /health;
 *   • кнопки «Стоп» / «Ещё раз» / «Новый диалог»;
 *   • работу с файлами кода (кидаешь .py/.js/.txt — уходит в контекст);
 *   • белый список пользователей (по умолчанию — только вы);
 *   • авто-запуск прокси, если он ещё не поднят.
 *
 * Запуск:  node bot.mjs        (токен берётся из env.txt / .env / окружения)
 *
 * Настройки — в env.example.txt, читается тот же синтаксис, что и у прокси.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { escapeHtml, renderMarkdown, splitHtml, splitThink, stripHtml } from './format.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowTime = () => new Date().toISOString().slice(11, 19);

function log(...a) {
  process.stdout.write(`[${nowTime()}] ${a.join(' ')}\n`);
}
function warn(...a) {
  process.stdout.write(`[${nowTime()}] [WARN] ${a.join(' ')}\n`);
}

// ---------------------------------------------------------------------------
// Конфиг: ./env.txt, ./.env, ./bot-env.txt, ../ — реальные переменные окружения
// имеют приоритет над файлами.
// ---------------------------------------------------------------------------

const LOADED_ENV_FILES = [];

function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
  LOADED_ENV_FILES.push(file);
  return true;
}

const CANDIDATES = [
  process.env.BOT_ENV_FILE,
  path.join(process.cwd(), 'env.txt'),
  path.join(process.cwd(), '.env'),
  path.join(process.cwd(), 'bot-env.txt'),
  path.join(SCRIPT_DIR, 'env.txt'),
  path.join(SCRIPT_DIR, '.env'),
  path.join(SCRIPT_DIR, 'bot-env.txt'),
  path.join(SCRIPT_DIR, '..', 'env.txt'),
].filter(Boolean);
for (const file of [...new Set(CANDIDATES)]) loadEnvFile(file);

const env = (k, d = '') => process.env[k] ?? d;
const num = (k, d) => (Number.isFinite(Number(process.env[k])) && String(env(k)).trim() !== '' ? Number(env(k)) : d);
const bool = (k, d = false) => {
  const v = String(env(k, d ? '1' : '0')).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};

/** 0.0.0.0 — это «слушать везде», подключаться к нему нельзя. */
const connectHost = (h) => (h === '0.0.0.0' || h === '::' || h === '' ? '127.0.0.1' : h);

const PROXY_HOST = connectHost(env('PROXY_HOST', '127.0.0.1'));
const PROXY_PORT = num('PROXY_PORT', 8000);
const PROXY_URL = (env('PROXY_URL') || `http://${PROXY_HOST}:${PROXY_PORT}/v1`).replace(/\/+$/, '');

const CONFIG = {
  token: env('TELEGRAM_BOT_TOKEN'),
  apiBase: (env('TELEGRAM_API_BASE') || 'https://api.telegram.org').replace(/\/+$/, ''),
  proxyUrl: PROXY_URL,
  proxyKey: env('PROXY_API_KEY', 'telegram-bot'),
  model: env('MODEL_NAME', 'CodeChat'),
  systemPrompt: env('BOT_SYSTEM_PROMPT',
    'Ты — полезный ассистент в Telegram. Отвечай по делу и на языке пользователя. '
    + 'Форматирование: обычный Markdown (``` для кода), без таблиц-HTML.'),
  historyMaxMessages: num('BOT_HISTORY_MAX_MESSAGES', 40),
  historyCharBudget: num('BOT_HISTORY_CHAR_BUDGET', 60000),
  maxTokens: num('BOT_MAX_TOKENS', 0),          // 0 = длину решает модель
  temperature: env('BOT_TEMPERATURE'),          // пусто = не вмешиваемся
  showReasoning: bool('BOT_SHOW_REASONING', false),
  stream: bool('BOT_STREAM', true),
  allowAll: bool('BOT_ALLOW_ALL', false),
  allowedUsers: String(env('BOT_ALLOWED_USERS')).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
  allowGroups: bool('BOT_ALLOW_GROUPS', false),
  autostartProxy: bool('BOT_AUTOSTART_PROXY', fs.existsSync(path.join(SCRIPT_DIR, 'server.mjs'))),
  proxyDir: env('BOT_PROXY_DIR', SCRIPT_DIR),
  stateFile: env('BOT_STATE_FILE', path.join(SCRIPT_DIR, 'bot-state.json')),
  logFile: env('BOT_LOG_FILE', ''),
  idleTimeoutMs: num('BOT_IDLE_TIMEOUT_MS', 180000),
  maxFileBytes: num('BOT_MAX_FILE_BYTES', 400000),
  maxFileChars: num('BOT_MAX_FILE_CHARS', 80000),
  // Модель текстовая: картинки/голос/видео не понимает — бот честно об этом говорит.
  textOnly: bool('BOT_TEXT_ONLY', true),
  // Сколько вопросов можно поставить в очередь, пока бот отвечает на предыдущий.
  queueMax: num('BOT_QUEUE_MAX', 3),
  // Лимит: запросов в минуту на пользователя (0 = без лимита).
  rateLimit: num('BOT_RATE_LIMIT', 0),
  // Реакция 👀 на принятый вопрос (наглядно, что бот увидел сообщение).
  reactions: bool('BOT_REACTIONS', true),
  // Начиная с какой длины ответ предлагать «Прислать файлом».
  fileAfterChars: num('BOT_FILE_AFTER_CHARS', 2500),
};

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'log', 'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'cs',
  'c', 'h', 'cpp', 'hpp', 'cc', 'm', 'mm', 'swift', 'php', 'pl', 'lua', 'r', 'sql', 'sh',
  'bash', 'zsh', 'ps1', 'bat', 'cmd', 'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte',
  'xml', 'csv', 'tsv', 'patch', 'diff', 'dockerfile', 'gradle', 'properties',
]);

if (!CONFIG.token) {
  warn('TELEGRAM_BOT_TOKEN не задан.');
  console.log(`
Откуда взять токен:
  1. @BotFather → /newbot → придумать имя → скопировать токен вида 123456789:AA...
  2. Положить его в env.txt рядом с этим файлом:
         TELEGRAM_BOT_TOKEN=123456789:AA...
     (или в переменную окружения, или запустить: node bot.mjs --token 123456:AA...)
  3. Запустить: node bot.mjs
`);
  const i = process.argv.indexOf('--token');
  if (i >= 0 && process.argv[i + 1]) CONFIG.token = process.argv[i + 1];
  else process.exit(1);
}

// ---------------------------------------------------------------------------
// Логирование
// ---------------------------------------------------------------------------

let logStream = null;
if (CONFIG.logFile) {
  try {
    logStream = fs.createWriteStream(CONFIG.logFile, { flags: 'a' });
  } catch (e) {
    warn(`Не удалось открыть BOT_LOG_FILE: ${e.message}`);
  }
}
for (const stream of ['stdout', 'stderr']) {
  const orig = process[stream].write.bind(process[stream]);
  process[stream].write = (chunk, ...rest) => {
    if (logStream) logStream.write(chunk);
    return orig(chunk, ...rest);
  };
}

const redact = (s) => String(s).replace(/(bot)?\d{6,}:[A-Za-z0-9_-]{30,}/g, '<TOKEN>');

// ---------------------------------------------------------------------------
// Telegram Bot API
// ---------------------------------------------------------------------------

class TelegramError extends Error {
  constructor(data, status) {
    super(data?.description || `HTTP ${status}`);
    this.status = status;
    this.data = data;
  }
}

async function tg(method, params = {}, { timeoutMs = 30000, signal } = {}) {
  const url = `${CONFIG.apiBase}/bot${CONFIG.token}/${method}`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      });
      const data = await res.json().catch(() => null);
      if (!data) throw new TelegramError(null, res.status);
      if (data.ok) return data.result;
      if (data.error_code === 429) {
        const wait = (data.parameters?.retry_after ?? 3) + 1;
        warn(`Telegram 429 на ${method}, пауза ${wait}s`);
        await sleep(wait * 1000);
        lastErr = new TelegramError(data, res.status);
        continue;
      }
      throw new TelegramError(data, res.status);
    } catch (e) {
      lastErr = e;
      if (e instanceof TelegramError && e.data) throw e;   // настоящая ошибка API, ретраить бессмысленно
      if (e.name === 'AbortError' || e.name === 'TimeoutError') throw e;
      if (attempt === 2) break;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr;
}

/** Отправка файла (multipart/form-data) — для /export, /save и кнопки «Файлом». */
async function tgUpload(method, fields, file) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) form.append(k, String(v));
  }
  form.append(file.field, new Blob([file.content], { type: file.mime }), file.name);
  const res = await fetch(`${CONFIG.apiBase}/bot${CONFIG.token}/${method}`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json().catch(() => null);
  if (!data?.ok) throw new TelegramError(data, res.status);
  return data.result;
}

const EXT_BY_LANG = {
  js: 'js', javascript: 'js', mjs: 'mjs', ts: 'ts', typescript: 'ts', jsx: 'jsx', tsx: 'tsx',
  python: 'py', py: 'py', java: 'java', kotlin: 'kt', kt: 'kt', c: 'c', cpp: 'cpp', 'c++': 'cpp',
  csharp: 'cs', 'c#': 'cs', cs: 'cs', go: 'go', golang: 'go', rust: 'rs', rs: 'rs', ruby: 'rb',
  rb: 'rb', php: 'php', swift: 'swift', sql: 'sql', sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh',
  powershell: 'ps1', ps1: 'ps1', html: 'html', css: 'css', scss: 'scss', less: 'less', json: 'json',
  yaml: 'yaml', yml: 'yaml', xml: 'xml', toml: 'toml', ini: 'ini', md: 'md', markdown: 'md',
  dockerfile: 'dockerfile', diff: 'diff', patch: 'patch', csv: 'csv', log: 'log', txt: 'txt',
};

/** Подбирает имя и расширение для файла с ответом (по языку из ```фенса). */
function fileNameFor(text, prefix = 'gigacode') {
  const lang = (String(text).match(/```([\w.+#-]*)/)?.[1] || '').toLowerCase();
  const ext = EXT_BY_LANG[lang] || 'md';
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `${prefix}-${stamp}.${ext}`;
}

/** Присылает текст файлом; если Telegram не принял — отдаёт текстом. */
async function sendFileSmart(chatId, content, { name, caption, replyTo, keyboard } = {}) {
  const fileName = name || fileNameFor(content);
  try {
    const res = await tgUpload('sendDocument', {
      chat_id: chatId,
      caption,
      parse_mode: caption ? 'HTML' : undefined,
      reply_to_message_id: replyTo,
      reply_markup: keyboard ? JSON.stringify(keyboard) : undefined,
    }, { field: 'document', content, name: fileName, mime: 'text/plain; charset=utf-8' });
    log(`[FILE] chat=${chatId} ${fileName} ${content.length} символов`);
    return res;
  } catch (e) {
    warn(`sendDocument: ${e.message}`);
    await sendMessage(chatId, `⚠️ Файл не отправился (${e.message}). Вот текстом:\n\n${escapeHtml(content.slice(0, 3000))}`,
      { replyTo, parseMode: 'HTML' });
    return null;
  }
}

/** Ошибки вида «message is not modified» — это норма при стриминге. */
const isHarmless = (e) => /message is not modified|message to edit not found|query is too old/i.test(e?.message || '');

const tgSafe = async (method, params, opts) => {
  try {
    return await tg(method, params, opts);
  } catch (e) {
    if (!isHarmless(e)) warn(`${method}: ${redact(e.message)}`);
    return null;
  }
};

/** sendMessage с фолбэком в plain text, если Telegram не переварил разметку. */
async function sendMessage(chatId, text, opts = {}) {
  const { replyTo, keyboard, parseMode = 'HTML', preview = false } = opts;
  const { split = true, limit = 3800 } = opts;
  const parts = parseMode === 'HTML' && split ? splitHtml(text, limit) : [text];
  let first = null;

  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const base = {
      chat_id: chatId,
      text: parts[i],
      reply_to_message_id: i === 0 ? replyTo : undefined,
      reply_markup: isLast ? keyboard : undefined,
      link_preview_options: { is_disabled: !preview },
    };
    let res = await tgSafe('sendMessage', parseMode ? { ...base, parse_mode: parseMode } : base);
    if (!res) {
      res = await tgSafe('sendMessage', { ...base, text: stripHtml(parts[i]) });   // без разметки
    }
    if (!res) throw new Error('Не удалось отправить сообщение в Telegram');
    first ??= res;
  }
  return first;
}

// ---------------------------------------------------------------------------
// Состояние (история, настройки чатов)
// ---------------------------------------------------------------------------

const state = { chats: {}, savedAt: 0, lastUpdateId: 0 };
const chatStateAll = () => state;

function chatState(id) {
  const key = String(id);
  state.chats[key] ??= { history: [], model: '', system: '', pendingFile: null, files: [], updatedAt: 0 };
  return state.chats[key];
}

let saveTimer = null;
function saveStateSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = `${CONFIG.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 0));
      fs.renameSync(tmp, CONFIG.stateFile);
    } catch (e) {
      warn(`Не удалось сохранить состояние: ${e.message}`);
    }
  }, 400);
}

(function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
    if (data && typeof data.chats === 'object') {
      state.chats = data.chats;
      state.lastUpdateId = Number(data.lastUpdateId) || 0;
      log(`История загружена: ${Object.keys(state.chats).length} чат(ов) из ${CONFIG.stateFile}`);
    }
  } catch { /* первый запуск */ }
})();

/** Обрезаем историю: сначала по числу сообщений, потом по символам. */
function trimHistory(session) {
  const h = session.history;
  while (h.length > CONFIG.historyMaxMessages) h.shift();
  let total = h.reduce((n, m) => n + m.content.length, 0);
  while (h.length > 2 && total > CONFIG.historyCharBudget) {
    total -= h[0].content.length;
    h.shift();
  }
  // история не должна начинаться с ответа ассистента без вопроса
  while (h.length && h[0].role === 'assistant') h.shift();
}

// ---------------------------------------------------------------------------
// Клиент прокси (OpenAI-совместимый, SSE)
// ---------------------------------------------------------------------------

class ProxyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function proxyHealth(timeoutMs = 4000) {
  try {
    const res = await fetch(`${CONFIG.proxyUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return await res.json();
  } catch (e) {
    return { status: 'unreachable', error: e.message };
  }
}

async function proxyModels() {
  try {
    const res = await fetch(`${CONFIG.proxyUrl}/models`, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    return (data?.data ?? []).map((m) => m.id).filter(Boolean);
  } catch {
    return [];
  }
}

async function* sseLines(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      yield line;
    }
  }
  if (buf.trim()) yield buf.replace(/\r$/, '');
}

/**
 * Потоковый чат с прокси. Возвращает async-итератор по дельтам:
 *   { type: 'text' | 'reasoning' | 'tool' | 'done', text? }
 */
async function* chatStream({ messages, model, signal, onActivity }) {
  const body = {
    model: model || CONFIG.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (CONFIG.maxTokens > 0) body.max_tokens = CONFIG.maxTokens;
  if (CONFIG.temperature !== '' && Number.isFinite(Number(CONFIG.temperature))) {
    body.temperature = Number(CONFIG.temperature);
  }

  let res;
  try {
    res = await fetch(`${CONFIG.proxyUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${CONFIG.proxyKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw new ProxyError(0, e.name === 'AbortError' ? 'отменено' : e.message);
  }

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      message = data?.error?.message || data?.message || message;
    } catch {
      try { message = (await res.text()).slice(0, 400) || message; } catch { /* ignore */ }
    }
    throw new ProxyError(res.status, message);
  }
  if (!res.body) throw new ProxyError(res.status, 'прокси не отдал поток');

  let usage = null;
  let finish = null;
  for await (const line of sseLines(res.body)) {
    onActivity?.();
    if (!line || line.startsWith(':')) continue;                 // keep-alive комментарий
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta ?? {};
    const reasoning = delta.reasoning_content ?? delta.reasoning ?? null;
    if (reasoning) yield { type: 'reasoning', text: String(reasoning) };
    if (delta.content) yield { type: 'text', text: String(delta.content) };
    if (delta.tool_calls) yield { type: 'tool' };
  }
  yield { type: 'done', usage, finish };
}

// ---------------------------------------------------------------------------
// Разбор содержимого сообщений
// ---------------------------------------------------------------------------

function attachmentsOf(message) {
  const list = [];
  if (message.document) list.push(message.document);
  return list;
}

async function downloadTelegramFile(fileId) {
  const file = await tg('getFile', { file_id: fileId }, { timeoutMs: 20000 });
  const url = `${CONFIG.apiBase}/file/bot${CONFIG.token}/${file.file_path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`скачивание файла: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, name: path.basename(file.file_path || 'file') };
}

async function fileToContext(message) {
  const docs = attachmentsOf(message);
  if (!docs.length) return null;
  const doc = docs[0];
  const name = doc.file_name || 'file';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (doc.file_size && doc.file_size > CONFIG.maxFileBytes) {
    return { skip: `Файл большой (${Math.round(doc.file_size / 1024)} КБ > ${Math.round(CONFIG.maxFileBytes / 1024)} КБ).` };
  }
  if (!TEXT_EXT.has(ext) && doc.mime_type && !/^text\//.test(doc.mime_type) && !/json|xml|javascript/i.test(doc.mime_type)) {
    return { skip: `Формат «${ext || doc.mime_type}» не текстовый — я умею читать только текстовые файлы.` };
  }
  const { buf } = await downloadTelegramFile(doc.file_id);
  let text = buf.toString('utf8');
  if (text.includes('\uFFFD')) {
    try {
      text = new TextDecoder('windows-1251').decode(buf);
    } catch { /* оставляем utf8 */ }
  }
  const truncated = text.length > CONFIG.maxFileChars;
  return {
    name,
    text: text.slice(0, CONFIG.maxFileChars),
    truncated,
    lines: text.split('\n').length,
    chars: text.length,
  };
}

// ---------------------------------------------------------------------------
// Диалог
// ---------------------------------------------------------------------------

const sessions = new Map();          // chatId → { busy, abort, queue, chain }

function sessionOf(chatId) {
  const key = String(chatId);
  if (!sessions.has(key)) {
    sessions.set(key, { id: chatId, busy: false, abort: null, chain: Promise.resolve(), queue: [] });
  }
  return sessions.get(key);
}

const stopKeyboard = { inline_keyboard: [[{ text: '⏹ Стоп', callback_data: 'stop' }]] };
const doneKeyboard = {
  inline_keyboard: [[
    { text: '🔁 Ещё раз', callback_data: 'retry' },
    { text: '🆕 Новый диалог', callback_data: 'new' },
  ]],
};

/** Кнопки под готовым ответом: повтор, продолжение, файл, новый диалог. */
function answerKeyboard({ truncated = false, asFile = false } = {}) {
  const row1 = [{ text: '🔁 Ещё раз', callback_data: 'retry' }];
  if (truncated) row1.push({ text: '➡️ Продолжить', callback_data: 'continue' });
  const row2 = [];
  if (asFile) row2.push({ text: '📄 Прислать файлом', callback_data: 'file' });
  row2.push({ text: '🆕 Новый диалог', callback_data: 'new' });
  return { inline_keyboard: [row1, row2] };
}

/** Настройки конкретного чата важнее глобальных (переключаются в /settings). */
const settingOf = (st, key, fallback) => (st && st[key] !== undefined && st[key] !== null ? st[key] : fallback);
const reasoningOn = (st) => Boolean(settingOf(st, 'reasoning', CONFIG.showReasoning));
const streamOn = (st) => Boolean(settingOf(st, 'stream', CONFIG.stream));

/** Модель текстовая: эти вложения она понять не может. */
function nonTextKind(message) {
  if (message.photo) return 'фото';
  if (message.voice) return 'голосовое сообщение';
  if (message.audio) return 'аудиофайл';
  if (message.video) return 'видео';
  if (message.video_note) return 'видеокружок';
  if (message.animation) return 'гифку';
  if (message.sticker) return 'стикер';
  return null;
}

/** Простейший лимит частоты: N запросов в минуту на пользователя. */
const rateLog = new Map();
function rateLimited(userId) {
  if (!CONFIG.rateLimit) return false;
  const now = Date.now();
  const hits = (rateLog.get(userId) ?? []).filter((t) => now - t < 60000);
  hits.push(now);
  rateLog.set(userId, hits);
  if (rateLog.size > 1000) rateLog.clear();
  return hits.length > CONFIG.rateLimit;
}

/** Когда чату последний раз объясняли, что работа в группах выключена. */
const groupNotice = new Map();

/** Сколько сообщений в чате бот проигнорировал, потому что к нему не обратились. */
const ignoredInGroup = new Map();

/** 👀 на принятый вопрос — видно, что бот его увидел. */
function reactSeen(chatId, messageId) {
  if (!CONFIG.reactions || !messageId) return;
  tgSafe('setMessageReaction', {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: 'emoji', emoji: '👀' }],
  }, { timeoutMs: 8000 });
}

function historyFor(chatId) {
  const st = chatState(chatId);
  const messages = [];
  const system = (st.system || CONFIG.systemPrompt || '').trim();
  if (system) messages.push({ role: 'system', content: system });
  for (const m of st.history) messages.push({ role: m.role, content: m.content });
  return messages;
}

/**
 * Стримит ответ модели в Telegram: сначала сообщение-заглушка,
 * затем точечные правки (не чаще раза в ~1.3 с), в конце — форматирование.
 */
async function streamAnswer(chatId, userMessage, { replyTo } = {}) {
  const st = chatState(chatId);
  const session = sessionOf(chatId);
  const controller = new AbortController();
  session.abort = controller;
  session.busy = true;

  const history = historyFor(chatId);
  history.push({ role: 'user', content: userMessage });

  const placeholder = await sendMessage(chatId, '⏳ Думаю…', {
    replyTo,
    keyboard: stopKeyboard,
    parseMode: null,
    limit: 3800,
  }).catch((e) => {
    warn(`sendMessage: ${e.message}`);
    return null;
  });
  if (!placeholder) {
    session.busy = false;
    session.abort = null;
    throw new Error('Telegram недоступен');
  }
  const messageId = placeholder.message_id;

  let answer = '';
  let reasoning = '';
  let toolHint = false;
  let finish = null;
  let lastEdit = 0;
  let edits = 0;
  let lastActivity = Date.now();
  let timeoutNotice = false;

  const typing = setInterval(() => {
    tgSafe('sendChatAction', { chat_id: chatId, action: 'typing' }, { timeoutMs: 10000 });
  }, 4500);
  tgSafe('sendChatAction', { chat_id: chatId, action: 'typing' }, { timeoutMs: 10000 });

  // Следим за «тишиной»: если прокси молчит дольше idleTimeoutMs — обрываем.
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > CONFIG.idleTimeoutMs) {
      timeoutNotice = true;
      controller.abort();
    }
  }, 5000);

  const paint = async (force) => {
    const t = Date.now();
    if (!force && t - lastEdit < 1300) return;
    if (!force && edits > 150) return;
    lastEdit = t;
    edits++;
    const tail = answer.slice(-3600);
    const text = tail
      ? `${escapeHtml(tail)}${controller.signal.aborted ? '' : ' ▌'}`
      : '⏳ Думаю…';
    await tgSafe('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: stopKeyboard,
    });
  };

  try {
    for await (const event of chatStream({
      messages: history,
      model: st.model,
      signal: controller.signal,
      onActivity: () => { lastActivity = Date.now(); },
    })) {
      lastActivity = Date.now();
      if (event.type === 'text') {
        answer += event.text;
        if (streamOn(st)) await paint(false);
      } else if (event.type === 'reasoning') {
        reasoning += event.text;
      } else if (event.type === 'tool') {
        toolHint = true;
      } else if (event.type === 'done') {
        finish = event.finish ?? finish;
        if (event.usage) st.lastUsage = event.usage;
      }
    }
  } catch (e) {
    clearInterval(typing);
    clearInterval(watchdog);
    session.busy = false;
    session.abort = null;

    const cancelled = controller.signal.aborted && !timeoutNotice;
    const hint = timeoutNotice
      ? `⏱ Прокси молчит больше ${Math.round(CONFIG.idleTimeoutMs / 1000)} с — запрос прерван.`
      : cancelled
        ? '⏹ Остановлено.'
        : e instanceof ProxyError && e.status === 401
          ? '🔒 Прокси не авторизован в GigaCode.\nЗапустите server.mjs на компьютере и войдите через браузер (или повторите вход), затем /health.'
          : e instanceof ProxyError && !e.status
            ? `🔌 Прокси недоступен (${CONFIG.proxyUrl}).\nЗапустите: node server.mjs`
            : `⚠️ Ошибка: ${e.message}`;

    await tgSafe('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: hint,
      parse_mode: null,
      reply_markup: doneKeyboard,
    });
    if (cancelled) throw e;
    return { cancelled: true };
  }

  clearInterval(typing);
  clearInterval(watchdog);
  const cancelled = controller.signal.aborted;
  session.busy = false;
  session.abort = null;

  const { content, reasoning: inlineReasoning } = splitThink(answer);
  const think = (reasoning + inlineReasoning).trim();
  const finalText = (content.trim() || (cancelled ? '⏹ Остановлено.' : 'Пустой ответ от модели.'));

  const truncated = finish === 'length' || finish === 'max_tokens';
  const asFile = !cancelled && (finalText.length > CONFIG.fileAfterChars || truncated);

  let html = renderMarkdown(finalText);
  if (cancelled) html += '\n\n<i>…остановлено</i>';
  if (truncated) html += '\n\n<i>…ответ упёрся в лимит длины — нажмите «Продолжить»</i>';
  if (toolHint) html += '\n\n<i>(модель пыталась вызвать инструмент — в Telegram он недоступен)</i>';
  if (think && reasoningOn(st)) {
    const trimmed = think.length > 1200 ? `${think.slice(0, 1200)}…` : think;
    html += `\n\n<blockquote expandable>🧠 <b>Размышления</b>\n${escapeHtml(trimmed)}</blockquote>`;
  }

  const parts = splitHtml(html, 3800);
  const keyboard = answerKeyboard({ truncated, asFile });
  const firstOk = await tgSafe('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: parts[0],
    parse_mode: 'HTML',
    reply_markup: parts.length === 1 ? keyboard : undefined,
    link_preview_options: { is_disabled: true },
  });
  if (!firstOk) {
    await tgSafe('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: stripHtml(parts[0]).slice(0, 4000),
      reply_markup: parts.length === 1 ? keyboard : undefined,
    });
  }
  for (let i = 1; i < parts.length; i++) {
    await sendMessage(chatId, parts[i], { parseMode: 'HTML', keyboard: i === parts.length - 1 ? keyboard : undefined });
  }

  st.lastFinish = finish;

  st.history.push({ role: 'user', content: userMessage });
  st.history.push({ role: 'assistant', content: finalText });
  st.updatedAt = Date.now();
  trimHistory(st);
  saveStateSoon();

  log(`[ANS] chat=${chatId} chars=${finalText.length} history=${st.history.length} edits=${edits}`);
  return { text: finalText, cancelled: false };
}

/** Запускает диалог в очередь чата: два вопроса подряд не перемешаются. */
function enqueue(chatId, task) {
  const session = sessionOf(chatId);
  const run = session.chain.then(task, task);
  session.chain = run.catch(() => {});
  return run;
}

/**
 * Отправляет вопрос на обработку и, когда ответ готов, берёт следующий
 * из очереди — писать боту можно не дожидаясь конца генерации.
 */
function runTurn(chatId, question, replyTo) {
  const session = sessionOf(chatId);
  return enqueue(chatId, async () => {
    try {
      await streamAnswer(chatId, question, { replyTo });
    } finally {
      const next = session.queue.shift();
      if (next) runTurn(chatId, next.question, next.replyTo);
    }
  }).catch((e) => {
    if (e?.message !== 'отменено' && e?.name !== 'AbortError') warn(`runTurn: ${e.message}`);
  });
}

// ---------------------------------------------------------------------------
// Команды
// ---------------------------------------------------------------------------

const CONTINUE_PROMPT = 'Продолжи ответ ровно с того места, где он оборвался. '
  + 'Не повторяй уже написанное и не начинай заново.';

const HELP = `🤖 <b>GigaCode в Telegram</b>
Бот работает через локальный прокси <code>server.mjs</code> и модель GigaCode.

Модель <b>текстовая</b>: понимает текст и текстовые файлы, а картинки, голосовые и видео — нет.
Пишите вопрос как обычно; ответ печатается потоком. Пока бот думает, можно отправить
ещё вопросы — они встанут в очередь и обработаются по порядку.

<b>Команды</b>
/new — начать новый диалог (очистить контекст)
/retry — повторить последний ответ
/continue — продолжить оборванный ответ
/save — прислать последний ответ файлом
/export — выгрузить всю переписку файлом (<code>/export json</code> — в JSON)
/cancel — прервать генерацию и очистить очередь
/model — текущая модель; <code>/model имя</code> — переключить
/system — показать системный промпт; <code>/system текст</code> — задать
/settings — настройки чата кнопками (модель, размышления, поток)
/stats — что в контексте, токены, состояние прокси
/health — статус прокси и авторизации в GigaCode
/id — ваш id (для белого списка)
/help — эта справка

📎 Текстовый файл (.py, .js, .md, .log, .json …) уйдёт в контекст.
↩️ Ответ на любое сообщение — его текст попадёт в вопрос цитатой.`;

/** Выгрузка переписки в Markdown или JSON. */
function exportDialog(chatId, asJson = false) {
  const st = chatState(chatId);
  const system = (st.system || CONFIG.systemPrompt || '').trim();
  if (asJson) {
    return JSON.stringify({
      model: st.model || CONFIG.model,
      system,
      messages: st.history,
      exportedAt: new Date().toISOString(),
    }, null, 2);
  }
  const lines = [
    '# Диалог с GigaCode',
    '',
    `- модель: ${st.model || CONFIG.model}`,
    `- сообщений: ${st.history.length}`,
    `- выгружено: ${new Date().toISOString()}`,
    '',
  ];
  if (system) lines.push('## Системный промпт', '', system, '');
  for (const m of st.history) {
    lines.push(m.role === 'user' ? '## 🧑 Вы' : '## 🤖 GigaCode', '', m.content, '');
  }
  return lines.join('\n');
}

async function doExport(chatId, asJson, replyTo) {
  const st = chatState(chatId);
  if (!st.history.length) {
    await sendMessage(chatId, 'Переписки пока нет — нечего выгружать.', { replyTo });
    return;
  }
  const content = exportDialog(chatId, asJson);
  await sendFileSmart(chatId, content, {
    name: `gigacode-dialog-${new Date().toISOString().slice(0, 10)}.${asJson ? 'json' : 'md'}`,
    caption: `📄 Переписка: ${st.history.length} сообщений, ${Math.round(content.length / 1000)}k символов`,
    replyTo,
  });
}

/** Настройки чата — кнопками, без правки env.txt. */
function settingsKeyboard(st) {
  const model = st.model || CONFIG.model;
  return {
    inline_keyboard: [
      [{ text: `🧠 Модель: ${model}`, callback_data: 'model:list' }],
      [
        { text: `💭 Размышления: ${reasoningOn(st) ? 'вкл' : 'выкл'}`, callback_data: 'toggle:reasoning' },
        { text: `⚡️ Поток: ${streamOn(st) ? 'вкл' : 'выкл'}`, callback_data: 'toggle:stream' },
      ],
      [
        { text: '📄 Экспорт', callback_data: 'export' },
        { text: '🧹 Новый диалог', callback_data: 'new' },
      ],
    ],
  };
}

function settingsText(st) {
  return `<b>Настройки этого чата</b>
Модель: <code>${escapeHtml(st.model || CONFIG.model)}</code>
Сообщений в контексте: ${st.history.length}
Размышления модели: ${reasoningOn(st) ? 'показываю свёрнутым блоком' : 'скрываю'}
Вывод: ${streamOn(st) ? 'печатаю по мере генерации' : 'присылаю целиком'}
Прокси: <code>${escapeHtml(CONFIG.proxyUrl)}</code>`;
}

async function sendSettings(chatId, { replyTo, messageId } = {}) {
  const st = chatState(chatId);
  const text = settingsText(st);
  const keyboard = settingsKeyboard(st);
  if (messageId) {
    const ok = await tgSafe('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup: keyboard });
    if (ok) return ok;
  }
  return sendMessage(chatId, text, { replyTo, parseMode: 'HTML', keyboard });
}

async function sendModelList(chatId, messageId, replyTo) {
  const st = chatState(chatId);
  const current = st.model || CONFIG.model;
  const models = (await proxyModels()).slice(0, 12);
  if (!models.length) {
    await sendMessage(chatId, 'Прокси недоступен — список моделей не получен.', { replyTo });
    return;
  }
  const rows = models.map((m) => [{ text: `${m === current ? '✅ ' : ''}${m}`, callback_data: `model:${m}`.slice(0, 60) }]);
  rows.push([{ text: '⬅️ Назад к настройкам', callback_data: 'settings' }]);
  const text = 'Выберите модель для этого чата:';
  const keyboard = { inline_keyboard: rows };
  if (messageId) {
    const ok = await tgSafe('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: keyboard });
    if (ok) return;
  }
  await sendMessage(chatId, text, { replyTo, keyboard });
}

/** Последний ответ ассистента — для /save и кнопки «Файлом». */
const lastAnswer = (st) => [...st.history].reverse().find((m) => m.role === 'assistant')?.content ?? null;

async function sendHelp(chatId, replyTo) {
  await sendMessage(chatId, HELP, { replyTo, parseMode: 'HTML' });
}

/** Откатывает историю до последнего вопроса и задаёт его заново. */
function retryLast(chatId, replyTo) {
  const st = chatState(chatId);
  const idx = st.history.map((m) => m.role).lastIndexOf('user');
  if (idx < 0) return false;
  const content = st.history[idx].content;
  st.history = st.history.slice(0, idx);
  saveStateSoon();
  runTurn(chatId, content, replyTo);
  return true;
}

function formatStats(chatId) {
  const st = chatState(chatId);
  const chars = st.history.reduce((n, m) => n + m.content.length, 0);
  const usage = st.lastUsage
    ? `\nПоследний ответ: prompt ${st.lastUsage.prompt_tokens ?? '?'} / completion ${st.lastUsage.completion_tokens ?? '?'} токенов`
    : '';
  const files = st.pendingFile ? `\n📎 Ждёт в контексте: <code>${escapeHtml(st.pendingFile.name)}</code> (${st.pendingFile.lines} строк)` : '';
  const queue = sessionOf(chatId).queue.length;
  const finish = st.lastFinish ? `\nПричина остановки: <code>${escapeHtml(st.lastFinish)}</code>${st.lastFinish === 'length' ? ' — ответ обрезан, есть кнопка «Продолжить»' : ''}` : '';
  return `<b>Статистика</b>
Модель: <code>${escapeHtml(st.model || CONFIG.model)}</code>
Прокси: <code>${escapeHtml(CONFIG.proxyUrl)}</code>
Сообщений в истории: ${st.history.length} (${Math.round(chars / 1000)}k символов)
Бюджет контекста: ${st.history.length}/${CONFIG.historyMaxMessages} сообщений, ${Math.round(CONFIG.historyCharBudget / 1000)}k символов${finish}${usage}${files}
В очереди: ${queue}
Режим модели: текстовый (без картинок и голоса)
Группы: ${CONFIG.allowGroups ? 'включены (ответ на упоминание, реплай или команду)' : 'выключены (BOT_ALLOW_GROUPS=0)'}`;
}

async function handleCommand(message, chatId, text) {
  const st = chatState(chatId);
  const replyTo = message.message_id;
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.replace(/@\w+$/, '').toLowerCase();
  const arg = text.slice(rawCmd.length).trim();

  switch (cmd) {
    case '/start':
      await sendMessage(chatId, `👋 Привет! Я бот поверх GigaCode-прокси.\n\nНапишите вопрос — отвечу. /help — все команды.`, { replyTo });
      return true;
    case '/help':
      await sendHelp(chatId, replyTo);
      return true;
    case '/id': {
      const type = message.chat?.type ?? 'private';
      const inGroup = type === 'group' || type === 'supergroup';
      const lines = [
        '<b>Кто я и где</b>',
        `chat_id: <code>${chatId}</code> (тип: ${type})`,
        `user_id: <code>${message.from?.id}</code>`,
        `username: @${escapeHtml(message.from?.username || '—')}`,
      ];
      if (inGroup) {
        lines.push(
          '',
          'chat_id группы отрицательный — это норма.',
          'Для белого списка в env.txt:',
          `<code>BOT_ALLOWED_USERS=${message.from?.id}</code>`,
          '',
          `Работа в группах: <b>${CONFIG.allowGroups ? 'включена' : 'выключена'}</b>`
          + `${CONFIG.allowGroups ? '' : ' (BOT_ALLOW_GROUPS=0)'}.`,
          `Проигнорировано сообщений без обращения ко мне: ${ignoredInGroup.get(chatId) ?? 0}.`,
          'Отвечаю только на упоминания? У @BotFather: /setprivacy → Disable — тогда вижу все сообщения.');
      }
      await sendMessage(chatId, lines.join('\n'), { replyTo, parseMode: 'HTML' });
      return true;
    }
    case '/new': case '/reset': case '/clear': {
      st.history = [];
      st.pendingFile = null;
      st.updatedAt = Date.now();
      saveStateSoon();
      await sendMessage(chatId, '🆕 Контекст очищен. Начинаем с чистого листа.', { replyTo });
      return true;
    }
    case '/retry': {
      if (sessionOf(chatId).busy) {
        await sendMessage(chatId, '⏳ Сейчас идёт ответ — /cancel, если нужно прервать.', { replyTo });
        return true;
      }
      if (!retryLast(chatId, replyTo)) await sendMessage(chatId, 'Нечего повторять — истории нет.', { replyTo });
      return true;
    }
    case '/cancel': case '/stop': {
      const s = sessionOf(chatId);
      const dropped = s.queue.length;
      s.queue = [];
      if (s.abort) {
        s.abort.abort();
        await sendMessage(chatId, `⏹ Останавливаю…${dropped ? ` Очередь очищена (${dropped}).` : ''}`, { replyTo });
      } else {
        await sendMessage(chatId, dropped ? `Очередь очищена (${dropped}).` : 'Сейчас нечего останавливать.', { replyTo });
      }
      return true;
    }
    case '/continue': case '/prodolzhit': {
      const last = lastAnswer(st);
      if (!last) {
        await sendMessage(chatId, 'Продолжать нечего — истории нет.', { replyTo });
        return true;
      }
      if (sessionOf(chatId).busy) {
        await sendMessage(chatId, '⏳ Сейчас идёт ответ — дождитесь или /cancel.', { replyTo });
        return true;
      }
      runTurn(chatId, CONTINUE_PROMPT, replyTo);
      return true;
    }
    case '/save': {
      const last = lastAnswer(st);
      if (!last) {
        await sendMessage(chatId, 'Пока нечего сохранять — сначала задайте вопрос.', { replyTo });
        return true;
      }
      await sendFileSmart(chatId, last, {
        name: fileNameFor(last, 'gigacode-answer'),
        caption: '📄 Последний ответ файлом',
        replyTo,
      });
      return true;
    }
    case '/export': {
      await doExport(chatId, /json/i.test(arg), replyTo);
      return true;
    }
    case '/settings': {
      await sendSettings(chatId, { replyTo });
      return true;
    }
    case '/model': {
      if (!arg) {
        const models = await proxyModels();
        const list = models.length ? models.map((m) => `• <code>${escapeHtml(m)}</code>`).join('\n') : '— (прокси недоступен)';
        await sendMessage(chatId, `Текущая модель: <code>${escapeHtml(st.model || CONFIG.model)}</code>\n\nДоступно:\n${list}\n\nСменить: <code>/model CodeChat</code>`, { replyTo, parseMode: 'HTML' });
        return true;
      }
      st.model = arg.split(/\s+/)[0];
      saveStateSoon();
      await sendMessage(chatId, `Модель: <code>${escapeHtml(st.model)}</code>`, { replyTo, parseMode: 'HTML' });
      return true;
    }
    case '/system': {
      if (!arg) {
        await sendMessage(chatId, `<b>Системный промпт</b>\n<pre>${escapeHtml(st.system || CONFIG.systemPrompt || '(пусто)')}</pre>\n\nИзменить: <code>/system Ты — эксперт по C#</code>\nСбросить: <code>/system -</code>`, { replyTo, parseMode: 'HTML' });
        return true;
      }
      st.system = arg === '-' ? '' : arg;
      saveStateSoon();
      await sendMessage(chatId, st.system ? '✅ Системный промпт обновлён.' : '✅ Системный промпт сброшен к стандартному.', { replyTo });
      return true;
    }
    case '/stats':
      await sendMessage(chatId, formatStats(chatId), { replyTo, parseMode: 'HTML' });
      return true;
    case '/health': {
      const h = await proxyHealth();
      const model = h.model ? `\nМодель по умолчанию: <code>${escapeHtml(h.model)}</code>` : '';
      let text;
      if (h.authenticated) {
        text = `✅ Прокси отвечает, авторизация в GigaCode в порядке.${model}`;
      } else if (h.status === 'unauthorized') {
        text = `🔒 Прокси работает, но не авторизован в GigaCode.${model}\n\n`
          + 'Войдите один раз через браузер: на компьютере, где запущен прокси, '
          + 'откройте <code>server.mjs</code> и пройдите вход (или выполните любой запрос к нему). '
          + 'Ссылка на вход печатается в логе прокси.';
      } else {
        text = `🔌 Прокси не отвечает на <code>${escapeHtml(CONFIG.proxyUrl)}</code>`
          + `${h.error ? ` (${escapeHtml(h.error)})` : ''}.\n\n`
          + 'Запустите его: <code>node server.mjs</code> — или включите автозапуск '
          + '<code>BOT_AUTOSTART_PROXY=1</code> (работает, если server.mjs лежит рядом с bot.mjs).';
      }
      await sendMessage(chatId, text, { replyTo, parseMode: 'HTML' });
      return true;
    }
    default:
      await sendMessage(chatId, 'Не знаю такой команды. /help', { replyTo });
      return true;
  }
}

// ---------------------------------------------------------------------------
// Обработка апдейтов
// ---------------------------------------------------------------------------

function isAllowed(message) {
  const user = message.from;
  if (!user || user.is_bot) return false;
  if (CONFIG.allowAll) return true;
  if (CONFIG.allowedUsers.length) return CONFIG.allowedUsers.includes(String(user.id));
  return null;   // режим «закрыто, пока не настроен белый список»
}

const botNames = new Set();

async function botMentioned(message, text) {
  if (message.reply_to_message?.from?.id === botId) return true;
  if (message.entities?.some((e) => e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${botUsername}`.toLowerCase())) return true;
  if (botNames.size) {
    for (const name of botNames) if (new RegExp(`\\b${name}\\b`, 'i').test(text)) return true;
  }
  return false;
}

let botId = 0;
let botUsername = '';

async function onMessage(message) {
  const chatType = message.chat?.type;
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  const chatId = message.chat.id;
  const rawText = message.text ?? message.caption ?? '';
  let text = rawText;
  const isCommand = /^\/\w+/.test(rawText.trim());

  const access = isAllowed(message);
  if (access === false) return;                                     // чужие — молча

  if (access === null) {
    // Белый список ещё не настроен. В группе не мусорим: подсказку шлём человеку в личку.
    const hint = `🔐 Бот закрыт. Ваш user id: <code>${message.from.id}</code>\n\n`
      + `Добавьте его в env.txt:\n<code>BOT_ALLOWED_USERS=${message.from.id}</code>\n`
      + 'и перезапустите бота (или поставьте <code>BOT_ALLOW_ALL=1</code>).';
    if (isGroup) {
      await sendMessage(message.from.id, hint, { parseMode: 'HTML' }).catch(() => {});
      log(`[GRP] chat=${chatId} user=${message.from.id}: белый список не настроен — подсказка ушла в личку`);
    } else {
      await sendMessage(chatId, hint, { replyTo: message.message_id, parseMode: 'HTML' });
    }
    return;
  }

  if (isGroup) {
    // В группе бот отвечает только когда к нему обратились: @упоминание, реплай на его
    // сообщение или команда. Иначе он встревал бы в каждый разговор.
    const addressed = isCommand || await botMentioned(message, rawText);
    if (!addressed) {
      const n = (ignoredInGroup.get(chatId) ?? 0) + 1;
      ignoredInGroup.set(chatId, n);
      // Логируем не каждое сообщение, иначе шумно; но первый случай видно всегда
      if (n === 1 || n % 20 === 0) {
        log(`[GRP] chat=${chatId}: ${n}-е сообщение без обращения ко мне — `
          + `отвечаю только на @${botUsername}, реплай на моё сообщение или команду`);
      }
      return;
    }

    if (!CONFIG.allowGroups) {
      // Объясняем причину, но не чаще раза в 10 минут на чат
      if (Date.now() - (groupNotice.get(chatId) ?? 0) > 600_000) {
        groupNotice.set(chatId, Date.now());
        await sendMessage(chatId,
          '⚙️ <b>Я здесь, но работа в группах выключена в настройках бота.</b>\n\n'
          + '1. В env.txt рядом с ботом: <code>BOT_ALLOW_GROUPS=1</code> — и перезапустить.\n'
          + '2. У @BotFather: <code>/setprivacy</code> → <b>Disable</b> — иначе Telegram '
          + 'вообще не передаёт мне сообщения без упоминания (после смены — заново добавить бота в группу).\n\n'
          + 'А в личке я отвечаю уже сейчас 😉',
          { replyTo: message.message_id, parseMode: 'HTML' });
      }
      log(`[GRP] chat=${chatId}: проигнорировано, BOT_ALLOW_GROUPS=0 (${ignoredInGroup.get(chatId)} сообщ.)`);
      return;
    }

    // Убираем @упоминание из вопроса, чтобы оно не уходило модели
    if (botUsername) {
      text = text.replace(new RegExp(`@${botUsername}`, 'gi'), ' ').replace(/[ \t]{2,}/g, ' ').trim();
    }
  }

  if (isCommand) {
    try {
      await handleCommand(message, chatId, text.trim());
    } catch (e) {
      warn(`command ${text.split(/\s+/)[0]}: ${e.message}`);
      await sendMessage(chatId, `⚠️ ${e.message}`, { replyTo: message.message_id }).catch(() => {});
    }
    return;
  }

  const st = chatState(chatId);

  // Лимит частоты (BOT_RATE_LIMIT), чтобы один человек не выел квоту
  if (rateLimited(message.from.id)) {
    await sendMessage(chatId, `🐢 Слишком часто. Лимит — ${CONFIG.rateLimit} запрос(ов) в минуту.`, { replyTo: message.message_id });
    return;
  }

  // Мультимодальности у модели нет — честно говорим, вместо пустого ответа
  // (BOT_TEXT_ONLY=0 — не отказывать, а просто игнорировать вложение)
  const kind = CONFIG.textOnly ? nonTextKind(message) : null;
  if (kind) {
    await sendMessage(chatId,
      `🚫 Модель работает только с текстом, ${kind} я не увижу.\n\n`
      + 'Пришлите текстом: описание, лог, фрагмент кода — или файл (.py, .js, .md, .log, .json, .csv).',
      { replyTo: message.message_id });
    return;
  }

  // Файл в контекст
  if (attachmentsOf(message).length) {
    try {
      const file = await fileToContext(message);
      if (file?.skip) {
        await sendMessage(chatId, `📎 ${file.skip}`, { replyTo: message.message_id });
        return;
      }
      if (file) {
        st.pendingFile = file;
        st.files.push({ name: file.name, chars: file.chars, at: Date.now() });
        saveStateSoon();
        await sendMessage(chatId,
          `📎 Прочитал <b>${escapeHtml(file.name)}</b> — ${file.lines} строк, ${file.chars} символов${file.truncated ? ' (обрезано)' : ''}.\n`
          + (text.trim() ? 'Отвечаю с учётом файла.' : 'Теперь задайте вопрос по этому файлу.'),
          { replyTo: message.message_id, parseMode: 'HTML' });
        if (!text.trim()) return;
      }
    } catch (e) {
      await sendMessage(chatId, `⚠️ Не удалось скачать файл: ${e.message}`, { replyTo: message.message_id });
      return;
    }
  }

  let question = text.trim();
  if (!question && !st.pendingFile) return;

  // Ответ на сообщение → цитата в вопросе
  const quoted = message.reply_to_message;
  if (quoted && quoted.message_id !== message.message_id && !quoted.from?.is_bot) {
    const quotedText = (quoted.text ?? quoted.caption ?? '').slice(0, 1500);
    if (quotedText) question = `В ответ на сообщение:\n"""\n${quotedText}\n"""\n\n${question}`;
  }

  if (st.pendingFile) {
    question = `Файл ${st.pendingFile.name} (${st.pendingFile.lines} строк):\n\`\`\`${st.pendingFile.name.split('.').pop()}\n${st.pendingFile.text}\n\`\`\`\n\n${question || 'Что можно улучшить в этом файле?'}`;
    st.pendingFile = null;
    saveStateSoon();
  }

  if (!question.trim()) return;
  if (question.length > 200000) question = question.slice(0, 200000);

  const session = sessionOf(chatId);
  if (session.busy) {
    // Не заставляем ждать молча: ставим вопрос в очередь на обработку
    if (session.queue.length >= CONFIG.queueMax) {
      await sendMessage(chatId,
        `⏳ Очередь заполнена (${session.queue.length}) — дождитесь ответа или /cancel.`,
        { replyTo: message.message_id });
      return;
    }
    session.queue.push({ question, replyTo: message.message_id });
    await sendMessage(chatId, `📥 В очереди: ${session.queue.length}`, { replyTo: message.message_id });
    return;
  }
  reactSeen(chatId, message.message_id);
  runTurn(chatId, question, message.message_id);
}

async function onCallbackQuery(query) {
  const chatId = query.message?.chat?.id;
  if (!chatId) return;
  const access = isAllowed({ from: query.from });
  if (access !== true) {
    await tgSafe('answerCallbackQuery', { callback_query_id: query.id, text: 'Нет доступа' });
    return;
  }
  const st = chatState(chatId);
  const messageId = query.message.message_id;
  const data = query.data || '';
  const answer = (text) => tgSafe('answerCallbackQuery', { callback_query_id: query.id, text });

  if (data === 'stop') {
    const s = sessionOf(chatId);
    const dropped = s.queue.length;
    s.queue = [];
    if (s.abort) s.abort.abort();
    await answer(dropped ? `Останавливаю, очередь очищена (${dropped})` : 'Останавливаю');
  } else if (data === 'new') {
    st.history = [];
    st.pendingFile = null;
    st.lastFinish = null;
    saveStateSoon();
    await answer('Контекст очищен');
    await sendMessage(chatId, '🆕 Новый диалог.');
  } else if (data === 'retry') {
    await answer('Повторяю');
    if (!sessionOf(chatId).busy) retryLast(chatId);
  } else if (data === 'continue') {
    await answer('Продолжаю');
    if (!sessionOf(chatId).busy) runTurn(chatId, CONTINUE_PROMPT, undefined);
  } else if (data === 'file') {
    const last = lastAnswer(st);
    if (!last) {
      await answer('Нечего сохранять');
    } else {
      await answer('Отправляю файлом');
      await sendFileSmart(chatId, last, { name: fileNameFor(last, 'gigacode-answer'), caption: '📄 Ответ файлом' });
    }
  } else if (data === 'export') {
    await answer('Выгружаю');
    await doExport(chatId, false);
  } else if (data === 'settings') {
    await answer();
    await sendSettings(chatId, { messageId });
  } else if (data === 'toggle:reasoning') {
    st.reasoning = !reasoningOn(st);
    saveStateSoon();
    await answer(st.reasoning ? 'Размышления включатся в следующем ответе' : 'Размышления скрыты');
    await sendSettings(chatId, { messageId });
  } else if (data === 'toggle:stream') {
    st.stream = !streamOn(st);
    saveStateSoon();
    await answer(st.stream ? 'Печатаю по мере генерации' : 'Присылаю ответ целиком');
    await sendSettings(chatId, { messageId });
  } else if (data === 'model:list') {
    await answer();
    await sendModelList(chatId, messageId);
  } else if (data.startsWith('model:')) {
    st.model = data.slice(6);
    saveStateSoon();
    await answer(`Модель: ${st.model}`);
    await sendSettings(chatId, { messageId });
  } else {
    await answer();
  }
}

// ---------------------------------------------------------------------------
// Автозапуск прокси
// ---------------------------------------------------------------------------

let proxyChild = null;

async function ensureProxy() {
  const health = await proxyHealth(3000);
  if (health.status === 'ok' || health.authenticated !== undefined) {
    log(`Прокси уже запущен: ${CONFIG.proxyUrl} (auth=${health.authenticated ? 'да' : 'нет'})`);
    return;
  }
  if (!CONFIG.autostartProxy) {
    warn(`Прокси не отвечает на ${CONFIG.proxyUrl}. Запустите server.mjs или включите BOT_AUTOSTART_PROXY=1.`);
    return;
  }
  const entry = path.join(CONFIG.proxyDir, 'server.mjs');
  if (!fs.existsSync(entry)) {
    warn(`BOT_AUTOSTART_PROXY=1, но ${entry} не найден.`);
    return;
  }
  log(`Запускаю прокси: node ${entry}`);
  proxyChild = spawn(process.execPath, [entry], {
    cwd: CONFIG.proxyDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const pipe = (stream, tag) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) log(`[proxy] ${line}`);
    });
  };
  pipe(proxyChild.stdout, 'out');
  pipe(proxyChild.stderr, 'err');
  proxyChild.on('exit', (code) => {
    warn(`Прокси завершился с кодом ${code}`);
    proxyChild = null;
  });

  for (let i = 0; i < 24; i++) {
    await sleep(1500);
    const h = await proxyHealth(3000);
    if (h.status === 'ok' || h.authenticated !== undefined) {
      log(`Прокси поднялся (auth=${h.authenticated ? 'да' : 'нет'})`);
      if (!h.authenticated) {
        log('Прокси не авторизован: выполните один запрос или запустите server.mjs вручную, чтобы пройти вход в браузере.');
      }
      return;
    }
  }
  warn('Прокси не ответил за 36 секунд — продолжаю без него.');
}

// ---------------------------------------------------------------------------
// Главный цикл (long polling)
// ---------------------------------------------------------------------------

let running = true;
let pollAbort = null;

async function pollLoop() {
  // После перезапуска Telegram отдаёт апдейты, которые уже могли быть
  // обработаны — иначе вопрос прозвучал бы дважды. Запоминаем, что видели.
  let offset = Number(chatStateAll().lastUpdateId) || 0;
  if (offset) log(`Продолжаю с update_id=${offset} (защита от повторной обработки)`);
  let failures = 0;

  const remember = (id) => {
    state.lastUpdateId = id;
    saveStateSoon();
  };

  while (running) {
    pollAbort = new AbortController();
    try {
      const updates = await tg('getUpdates', {
        offset,
        timeout: 50,
        allowed_updates: ['message', 'callback_query'],
      }, { timeoutMs: 70000, signal: pollAbort.signal });
      failures = 0;

      for (const update of updates) {
        offset = update.update_id + 1;
        remember(update.update_id);
        try {
          if (update.message) await onMessage(update.message);
          else if (update.callback_query) await onCallbackQuery(update.callback_query);
        } catch (e) {
          warn(`update ${update.update_id}: ${e.message}`);
        }
      }
    } catch (e) {
      if (!running) break;
      if (e.name === 'AbortError') continue;
      failures++;
      const conflict = /terminated by other getUpdates|webhook/i.test(e.message);
      if (conflict) {
        warn('Конфликт getUpdates: где-то запущена вторая копия бота. Останавливаюсь.');
        break;
      }
      const wait = Math.min(30, failures * 2);
      warn(`Ошибка polling: ${e.message} — повтор через ${wait}s`);
      await sleep(wait * 1000);
    }
  }
}

async function main() {
  log(`Конфиг: ${LOADED_ENV_FILES.join(', ') || 'только переменные окружения'}`);
  log(`Прокси: ${CONFIG.proxyUrl} · модель ${CONFIG.model} · состояние ${CONFIG.stateFile}`);

  const me = await tg('getMe', {}, { timeoutMs: 15000 });
  botId = me.id;
  botUsername = me.username || '';
  botNames.add(me.username || '');
  if (me.first_name) botNames.add(me.first_name);
  log(`Бот: @${botUsername} (id ${botId})`);

  await tgSafe('setMyCommands', {
    commands: [
      { command: 'new', description: 'Новый диалог' },
      { command: 'retry', description: 'Повторить последний ответ' },
      { command: 'continue', description: 'Продолжить ответ' },
      { command: 'cancel', description: 'Прервать генерацию и очередь' },
      { command: 'save', description: 'Ответ файлом' },
      { command: 'export', description: 'Выгрузить переписку' },
      { command: 'model', description: 'Модель' },
      { command: 'system', description: 'Системный промпт' },
      { command: 'settings', description: 'Настройки чата' },
      { command: 'stats', description: 'Контекст и статистика' },
      { command: 'health', description: 'Статус прокси' },
      { command: 'id', description: 'Мой user id' },
      { command: 'help', description: 'Справка' },
    ],
  });

  if (CONFIG.textOnly) {
    log('Режим «только текст»: картинки/голос/видео бот отклоняет с подсказкой '
      + '(BOT_TEXT_ONLY=0 — отключить это поведение).');
  }

  if (!CONFIG.allowAll && !CONFIG.allowedUsers.length) {
    warn('Белый список пуст: бот попросит каждого прислать его user id. '
      + 'Внесите id в BOT_ALLOWED_USERS или включите BOT_ALLOW_ALL=1.');
  }

  await ensureProxy();

  const h = await proxyHealth();
  if (h.status === 'unauthorized') {
    warn('Прокси запущен, но не авторизован в GigaCode: запросы вернут 401, пока не пройден вход в браузере.');
  } else if (h.status !== 'ok') {
    warn(`Прокси не отвечает на ${CONFIG.proxyUrl} (${h.status ?? h.error}). Бот всё равно запустится — /health покажет статус.`);
  }

  log('Слушаю Telegram (long polling). Ctrl+C — остановить.');
  await pollLoop();
}

async function shutdown(signal) {
  if (!running) return;
  running = false;
  log(`Получен ${signal}, останавливаюсь…`);
  saveStateSoon();
  await sleep(300);
  pollAbort?.abort();
  for (const s of sessions.values()) s.abort?.abort();
  if (proxyChild) {
    log('Останавливаю запущенный прокси…');
    proxyChild.kill('SIGTERM');
  }
  await sleep(200);
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => void shutdown(sig));

main().catch((e) => {
  warn(`Фатальная ошибка: ${e.message}`);
  process.exit(1);
});
