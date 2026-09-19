#!/usr/bin/env node
/**
 * Автотест бота без реального Telegram и без GigaCode.
 *
 * Поднимает два локальных сервера-заглушки:
 *   • mock Telegram Bot API  — записывает все sendMessage/editMessageText;
 *   • mock GigaCode-прокси   — отдаёт SSE в формате OpenAI.
 *
 * Запускает bot.mjs как отдельный процесс, прогоняет сценарий команд
 * и проверяет, что в Telegram ушёл правильно отформатированный ответ,
 * а история диалога копится и очищается.
 *
 * Запуск:  node test/selftest.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TG_PORT = 8091;
const PROXY_PORT = 8092;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name, ok, extra = '') {
  if (ok) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${extra ? `\n     ${extra}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Mock Telegram Bot API
// ---------------------------------------------------------------------------
const sent = [];              // sendMessage
const edits = [];             // editMessageText
const other = [];             // прочие методы

let pendingUpdates = [];
let updateId = 1000;
const seenOffsets = [];

function pushMessage(chatId, fromId, text, extra = {}) {
  pendingUpdates.push({
    update_id: updateId++,
    message: {
      message_id: updateId,
      from: { id: fromId, is_bot: false, first_name: 'Tester', username: 'tester' },
      chat: { id: chatId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
      ...extra,
    },
  });
}

const tgServer = http.createServer(async (req, res) => {
  const body = await new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => resolve(b ? JSON.parse(b) : {}));
  });
  const method = req.url.split('/').pop().split('?')[0];
  const send = (obj) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (method === 'getMe') {
    return send({ ok: true, result: { id: 42, is_bot: true, first_name: 'MockBot', username: 'mock_bot' } });
  }
  if (method === 'getUpdates') {
    // Реальный Telegram не отдаёт апдейты закрытому соединению и не «съедает» их.
    // (иначе мёртвый long-poll от прошлого запуска бота крадёт апдейт)
    let alive = true;
    // Сокет — самый надёжный признак: у убитого процесса соединение
    // становится не-writable, а 'close' на req может не прийти.
    const dead = () => !res.socket || res.socket.destroyed || !res.socket.writable;
    req.on('close', () => { alive = false; });
    res.on('close', () => { alive = false; });
    seenOffsets.push(body.offset ?? 0);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (!alive || dead()) return;
      const list = pendingUpdates.filter((u) => u.update_id >= (body.offset ?? 0));
      if (list.length) {
        pendingUpdates = pendingUpdates.filter((u) => u.update_id < (body.offset ?? 0));
        return send({ ok: true, result: list });
      }
      await sleep(50);
    }
    return send({ ok: true, result: [] });
  }
  if (method === 'sendMessage') {
    sent.push({ ...body, _at: Date.now() });
    return send({ ok: true, result: { message_id: 5000 + sent.length, chat: { id: body.chat_id }, date: Math.floor(Date.now() / 1000) } });
  }
  if (method === 'editMessageText') {
    edits.push({ ...body, _at: Date.now() });
    return send({ ok: true, result: { message_id: body.message_id, chat: { id: body.chat_id } } });
  }
  if (method === 'setMyCommands' || method === 'sendChatAction' || method === 'answerCallbackQuery') {
    other.push({ method, ...body });
    return send({ ok: true, result: true });
  }
  return send({ ok: false, error_code: 404, description: `mock: unknown method ${method}` });
});

// ---------------------------------------------------------------------------
// Mock GigaCode-прокси
// ---------------------------------------------------------------------------
const received = [];

function sseLine(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const proxyServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = url.pathname.replace(/^\/v1/, '').replace(/^\/api\/v1/, '');

  if (route === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', authenticated: true, model: 'CodeChat' }));
  }
  if (route === '/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'CodeChat' }, { id: 'Gigacode-Inline-13B-v4.1' }] }));
  }
  if (route === '/chat/completions') {
    const body = await new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => resolve(JSON.parse(b)));
    });
    received.push(body);

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const id = 'chatcmpl-test';
    const base = { id, object: 'chat.completion.chunk', created: 1, model: body.model };
    res.write(sseLine({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }));
    res.write(': keep-alive\n\n');

    const answer = [
      `**Готово.** msgs=${body.messages.length} system=${body.messages[0]?.role}`,
      '',
      '```python',
      'def double(x):',
      '    return x * 2',
      '```',
      '',
      '- первый пункт',
      '- второй пункт со `кодом` и [ссылкой](https://gigacode.ru)',
      '',
      '| столбец | значение |',
      '|---------|----------|',
      '| a       | 1        |',
      '',
      '> цитата в ответе',
      '',
    ].join('\n');

    const parts = answer.match(/[\s\S]{1,12}/g) ?? [];
    for (const part of parts) {
      res.write(sseLine({ ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] }));
      await sleep(8);
    }
    res.write(sseLine({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    res.write(sseLine({ ...base, choices: [], usage: { prompt_tokens: 111, completion_tokens: 222, total_tokens: 333 } }));
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `mock: no route ${url.pathname}` } }));
});

// ---------------------------------------------------------------------------
// Сценарий
// ---------------------------------------------------------------------------

const CHAT = 777;
const USER = 12345;
const STATE = path.join(os.tmpdir(), `bot-state-selftest-${process.pid}.json`);

async function waitFor(fn, ms = 20000, step = 100) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

async function main() {
  for (const f of [STATE, `${STATE}.tmp`]) fs.rmSync(f, { force: true });

  await new Promise((r) => tgServer.listen(TG_PORT, '127.0.0.1', r));
  await new Promise((r) => proxyServer.listen(PROXY_PORT, '127.0.0.1', r));
  console.log(`mock Telegram :${TG_PORT}, mock GigaCode-прокси :${PROXY_PORT}`);

  const child = spawn(process.execPath, [path.join(ROOT, 'bot.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: 'TEST:0000000000000000000000000000000000',
      TELEGRAM_API_BASE: `http://127.0.0.1:${TG_PORT}`,
      PROXY_URL: `http://127.0.0.1:${PROXY_PORT}/v1`,
      PROXY_HOST: '127.0.0.1',
      PROXY_PORT: String(PROXY_PORT),
      BOT_AUTOSTART_PROXY: '0',
      BOT_ALLOW_ALL: '1',
      BOT_STATE_FILE: STATE,
      BOT_STREAM: '1',
      BOT_MAX_TOKENS: '0',
      GIGACODE_TRACE: '0',
      GIGACODE_DEBUG_CHUNKS: '0',
      GIGACODE_DEBUG_RAW: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const botLog = [];
  child.stdout.on('data', (c) => botLog.push(c.toString()));
  child.stderr.on('data', (c) => botLog.push(`[stderr] ${c.toString()}`));

  const ok = await waitFor(() => botLog.join('').includes('Слушаю Telegram'));
  check('бот запустился и опрашивает Telegram', ok, botLog.join('').slice(-800));
  if (!ok) return;

  // 1. /start
  pushMessage(CHAT, USER, '/start');
  await waitFor(() => sent.some((m) => /Привет/.test(m.text ?? '')));
  check('/start отвечает приветствием', sent.some((m) => /Привет/.test(m.text ?? '')));

  // 2. обычный вопрос → потоковый ответ
  pushMessage(CHAT, USER, 'Покажи функцию на Python');
  const gotAnswer = await waitFor(() => edits.some((e) => /<pre><code class="language-python">/.test(e.text ?? '')));
  const final = edits.findLast((e) => /<pre><code class="language-python">/.test(e.text ?? ''));
  check('ответ пришёл потоком и отформатирован', gotAnswer, JSON.stringify(edits.at(-1) ?? {}).slice(0, 400));
  check('Markdown → HTML: жирный текст', /<b>Готово\.<\/b>/.test(final?.text ?? ''), final?.text?.slice(0, 300));
  check('Markdown → HTML: ссылка', /<a href="https:\/\/gigacode\.ru">/.test(final?.text ?? ''));
  check('Markdown → HTML: инлайн-код', /<code>кодом<\/code>/.test(final?.text ?? ''));
  check('Markdown → HTML: цитата', /<blockquote>цитата в ответе<\/blockquote>/.test(final?.text ?? ''));
  check('Markdown → HTML: таблица выровнена в <pre>', /<pre>столбец \| значение/.test(final?.text ?? ''), final?.text?.slice(-400));
  check('к сообщению привязаны кнопки «Ещё раз / Новый диалог»', Boolean(final?.reply_markup?.inline_keyboard));
  check('во время генерации был «Стоп»', edits.some((e) => e.reply_markup?.inline_keyboard?.[0]?.[0]?.text?.includes('Стоп')));
  check('был статус «печатает»', other.some((o) => o.method === 'sendChatAction' && o.action === 'typing'));
  check('прокси получил stream=true', received[0]?.stream === true);
  check('прокси получил системный промпт первым сообщением', received[0]?.messages?.[0]?.role === 'system');

  // 3. второй вопрос → история должна вырасти
  pushMessage(CHAT, USER, 'А что такое замыкание?');
  const second = await waitFor(() => received.length >= 2);
  check('второй запрос ушёл на прокси', second);
  check('история накапливается (system + 3 сообщения = 4)', received[1]?.messages?.length === 4, `было ${received[1]?.messages?.length}`);
  check('предыдущий ответ попал в историю как assistant', received[1]?.messages?.[2]?.role === 'assistant');
  await waitFor(() => edits.filter((e) => /msgs=4/.test(e.text ?? '')).length > 0);

  // 4. состояние сохранилось на диск
  const saved = await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(STATE, 'utf8')).chats?.[CHAT]?.history?.length >= 4;
    } catch { return false; }
  });
  check('история сохранена в bot-state.json', saved);

  // 5. /stats и /new
  pushMessage(CHAT, USER, '/stats');
  await waitFor(() => sent.some((m) => /Сообщений в истории: 4/.test(m.text ?? '')));
  check('/stats показывает 4 сообщения', sent.some((m) => /Сообщений в истории: 4/.test(m.text ?? '')));

  pushMessage(CHAT, USER, '/new');
  await waitFor(() => sent.some((m) => /Контекст очищен/.test(m.text ?? '')));
  check('/new очищает контекст', sent.some((m) => /Контекст очищен/.test(m.text ?? '')));

  pushMessage(CHAT, USER, 'Привет ещё раз');
  const third = await waitFor(() => received.length >= 3);
  check('после /new история пустая (system + 1 = 2)', third && received[2]?.messages?.length === 2, `было ${received[2]?.messages?.length}`);

  // 6. /health и /model
  pushMessage(CHAT, USER, '/health');
  await waitFor(() => sent.some((m) => /Прокси отвечает, авторизация/.test(m.text ?? '')));
  check('/health видит авторизованный прокси', sent.some((m) => /Прокси отвечает, авторизация/.test(m.text ?? '')));

  pushMessage(CHAT, USER, '/model');
  await waitFor(() => sent.some((m) => /Доступно/.test(m.text ?? '')));
  check('/model перечисляет модели прокси', sent.some((m) => /CodeChat/.test(m.text ?? '') && /Доступно/.test(m.text ?? '')));

  // 7. длинный ответ режется на части по лимиту Telegram
  const longest = Math.max(...edits.map((e) => (e.text ?? '').length));
  check('ни одна правка не превышает лимит 4096 символов', longest <= 4096, `макс. ${longest}`);
  check('ни одно сообщение не превышает лимит', Math.max(...sent.map((m) => (m.text ?? '').length)) <= 4096);

  child.kill('SIGTERM');
  await sleep(500);
  tgServer.close();
  proxyServer.close();
}

main()
  .catch((e) => {
    failed++;
    console.log(`Проверка упала с ошибкой: ${e.stack}`);
  })
  .finally(() => {
    console.log(failed ? `\n❌ Провалено проверок: ${failed}` : '\n✅ Все проверки пройдены');
    process.exit(failed ? 1 : 0);
  });
