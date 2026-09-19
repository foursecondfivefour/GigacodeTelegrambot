#!/usr/bin/env node
/**
 * Тесты краевых случаев: разметка, нарезка длинных ответов, ошибки прокси,
 * кнопка «Стоп», доступ по белому списку.
 *
 * Запуск:  node test/edge.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, splitHtml, escapeHtml, splitThink } from '../format.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const section = (t) => console.log(`\n— ${t}`);
function check(name, ok, extra = '') {
  if (ok) console.log(`  ✅ ${name}`);
  else {
    failed++;
    console.log(`  ❌ ${name}${extra ? `\n     ${extra}` : ''}`);
  }
}

// ===========================================================================
// 1. Модуль разметки (юнит-тесты, без сети)
// ===========================================================================
section('Разметка Markdown → HTML');

const r = (md) => renderMarkdown(md);

check('код-фенс с языком', r('```js\nconst a = 1 < 2;\n```') === '<pre><code class="language-js">\nconst a = 1 &lt; 2;\n</code></pre>', r('```js\nconst a = 1 < 2;\n```'));
check('HTML из ответа модели экранируется', r('<script>alert(1)</script>').includes('&lt;script&gt;') && !r('<script>alert(1)</script>').includes('<script>'));
check('амперсанд не ломает разметку', r('a & b **жирный**') === 'a &amp; b <b>жирный</b>', r('a & b **жирный**'));
check('незакрытый фенс закрывается', r('```\nabc').endsWith('</code></pre>'));
check('заголовок → жирный', r('## Заголовок') === '<b>Заголовок</b>');
check('нумерованный список сохраняет номер', r('1. раз\n2. два').startsWith('1) раз'));
check('маркированный список → •', r('- раз\n* два').split('\n')[0] === '• раз');
check('цитата → blockquote', r('> мысль') === '<blockquote>мысль</blockquote>');
check('инлайн-код не жирнеет', r('`**не жирный**`') === '<code>**не жирный**</code>', r('`**не жирный**`'));
check('звёздочки в арифметике не курсивят', r('2 * 3 * 4') === '2 * 3 * 4', r('2 * 3 * 4'));
check('курсив всё ещё работает', r('это *важно* и **тоже**') === 'это <i>важно</i> и <b>тоже</b>', r('это *важно* и **тоже**'));
check('звёздочка-сноска не ломает текст', r('см. сноску *  и текст') === 'см. сноску *  и текст', r('см. сноску *  и текст'));
check('ссылка markdown', r('[сайт](https://a.ru)') === '<a href="https://a.ru">сайт</a>');
check('голая ссылка становится кликабельной', r('см. https://a.ru/page') === 'см. <a href="https://a.ru/page">https://a.ru/page</a>', r('см. https://a.ru/page'));
check('таблица выравнивается в <pre>', r('| a | b |\n|---|---|\n| 1 | 22 |').includes('<pre>a | b\n1 | 22</pre>'), r('| a | b |\n|---|---|\n| 1 | 22 |'));
check('подчёркивания в именах не курсивят', r('file_name_here и my_var_test') === 'file_name_here и my_var_test', r('file_name_here и my_var_test'));

section('Разрезание длинных сообщений');
const long = [
  'Вот код:',
  '```python',
  ...Array.from({ length: 400 }, (_, i) => `line_${i} = 'значение ${i}'  # комментарий на русском`),
  '```',
  'Готово.',
].join('\n');
const html = renderMarkdown(long);
const parts = splitHtml(html, 3800);
check('длинный ответ нарезан на части', parts.length > 1, `частей: ${parts.length}`);
check('все части в лимите 4096', parts.every((p) => p.length <= 4096), `макс ${Math.max(...parts.map((p) => p.length))}`);
const balance = (s) => {
  const open = (s.match(/<(?!\/)[a-z][\w-]*[^>]*>/gi) || []).length;
  const close = (s.match(/<\/[a-z][\w-]*>/gi) || []).length;
  const preOpen = (s.match(/<pre>/g) || []).length;
  const preClose = (s.match(/<\/pre>/g) || []).length;
  return open === close && preOpen === preClose;
};
check('теги сбалансированы в каждой части', parts.every(balance), parts.map((p) => `${p.length}:${balance(p)}`).join(' '));
check('текст не потерян', parts.join('').replace(/<[^>]+>/g, '').replace(/\n/g, '').includes('line_399'));
check('код переоткрывается в следующей части', parts.slice(1).every((p) => p.includes('<pre><code') || !p.includes('line_')));

check('одна мега-строка режется принудительно', splitHtml(`<pre><code>${'x'.repeat(9000)}</code></pre>`, 3800).every((p) => p.length <= 4096));
check('splitThink вырезает размышления', splitThink('мысль<think>думаю</think>ответ').content.trim() === 'мысльответ');
check('splitThink на незакрытом теге', splitThink('a<think>б').content === 'a');
check('escapeHtml', escapeHtml('<b>&</b>') === '&lt;b&gt;&amp;&lt;/b&gt;');

// ===========================================================================
// 2. E2E: ошибки прокси, стоп-кнопка, доступ
// ===========================================================================
const TG_PORT = 8093;
const PROXY_PORT = 8094;
const sent = [];
const edits = [];
const callbacksAnswered = [];
let pendingUpdates = [];
let updateId = 2000;
let reqSeq = 0;
let proxyMode = 'ok';

function push(chatId, fromId, text, extra = {}) {
  pendingUpdates.push({
    update_id: updateId++,
    message: {
      message_id: updateId,
      from: { id: fromId, is_bot: false, first_name: 'T', username: 't' },
      chat: { id: chatId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
      ...extra,
    },
  });
}
function pushCallback(chatId, fromId, data) {
  pendingUpdates.push({
    update_id: updateId++,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: fromId, is_bot: false, first_name: 'T' },
      chat_instance: '1',
      data,
      message: { message_id: 9001, chat: { id: chatId, type: 'private' }, text: 'x' },
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
  const send = (o) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  if (method === 'getMe') return send({ ok: true, result: { id: 43, is_bot: true, first_name: 'MockBot', username: 'mock_bot' } });
  if (method === 'getUpdates') {
    // Реальный Telegram не отдаёт апдейты закрытому соединению и не «съедает» их.
    // Иначе мёртвый long-poll от прошлого запуска бота крадёт новый апдейт.
    let alive = true;
    const dead = () => !res.socket || res.socket.destroyed || !res.socket.writable;
    const rid = ++reqSeq;
    if (process.env.EDGE_DEBUG) console.log(`      · #${rid} getUpdates offset=${body.offset ?? 0} начат`);
    req.on('close', () => {
      alive = false;
      if (process.env.EDGE_DEBUG) console.log(`      · #${rid} соединение закрыто`);
    });
    res.on('close', () => { alive = false; });
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      if (alive && !dead()) { /* соединение живо */ } else {
        if (process.env.EDGE_DEBUG) console.log(`      · #${rid} клиент мёртв (close=${!alive}, socket=${dead()}), апдейты не съедены`);
        return;
      }
      const list = pendingUpdates.filter((u) => u.update_id >= (body.offset ?? 0));
      if (list.length) {
        pendingUpdates = pendingUpdates.filter((u) => u.update_id < (body.offset ?? 0));
        if (process.env.EDGE_DEBUG) console.log(`      · #${rid} → отдал ${list.map((u) => u.update_id).join(',')} (жив=${alive})`);
        return send({ ok: true, result: list });
      }
      await sleep(40);
    }
    return send({ ok: true, result: [] });
  }
  if (method === 'sendMessage') {
    sent.push({ ...body, _at: Date.now() });
    return send({ ok: true, result: { message_id: 6000 + sent.length, chat: { id: body.chat_id } } });
  }
  if (method === 'editMessageText') {
    // Telegram отдаёт два разных кода ошибки
    if (body.text === 'error:not-modified') return send({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' });
    if (/<невалидные теги>/.test(body.text ?? '')) return send({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: Unsupported start tag \"невалидные\"" });
    edits.push({ ...body, _at: Date.now() });
    return send({ ok: true, result: { message_id: body.message_id, chat: { id: body.chat_id } } });
  }
  if (method === 'answerCallbackQuery') {
    callbacksAnswered.push(body);
    return send({ ok: true, result: true });
  }
  return send({ ok: true, result: true });
});

let chunkDelay = 5;
let answerText = 'обычный ответ';
const proxyServer = http.createServer(async (req, res) => {
  const route = new URL(req.url, 'http://x').pathname.replace(/^\/v1/, '');
  if (route === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(proxyMode === 'unauth'
      ? { status: 'ok', authenticated: false, model: 'CodeChat' }
      : { status: 'ok', authenticated: true, model: 'CodeChat' }));
  }
  if (route === '/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'CodeChat' }] }));
  }
  if (route === '/chat/completions') {
    await new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => resolve(b));
    });
    if (proxyMode === '401') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'IAM_401: Not authenticated', type: 'authentication_error' } }));
    }
    if (proxyMode === '502') {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'INF_413: Payload too large' } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'CodeChat' };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
    for (const ch of answerText.match(/[\s\S]{1,10}/g) ?? []) {
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: ch }, finish_reason: null }] })}\n\n`);
      await sleep(chunkDelay);
    }
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  res.writeHead(404);
  res.end('{}');
});

const STATE = path.join(os.tmpdir(), `bot-state-edge-${process.pid}.json`);
async function waitFor(fn, ms = 20000, step = 100) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

let child = null;

/** Ждём, пока процесс бота действительно завершится (иначе он «съест» апдейт). */
function stopBot() {
  return new Promise((resolve) => {
    if (!child) return resolve();
    const c = child;
    child = null;
    c.once('exit', () => resolve());
    c.kill('SIGTERM');
    setTimeout(resolve, 4000);
  });
}

/** Ждём, пока Telegram-вызовы устоятся (защита от «хвостов» предыдущего теста). */
async function drain(quietMs = 1500, maxMs = 30000) {
  const until = Date.now() + maxMs;
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() < until) {
    const n = sent.length + edits.length * 0.001;
    if (n !== last) {
      last = n;
      stableSince = Date.now();
    } else if (Date.now() - stableSince > quietMs) return true;
    await sleep(150);
  }
  return false;
}

function startBot(extraEnv = {}) {
  return new Promise((resolve) => {
    child = spawn(process.execPath, [path.join(ROOT, 'bot.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        TELEGRAM_BOT_TOKEN: 'TEST:0000000000000000000000000000000000',
        TELEGRAM_API_BASE: `http://127.0.0.1:${TG_PORT}`,
        PROXY_URL: `http://127.0.0.1:${PROXY_PORT}/v1`,
        BOT_AUTOSTART_PROXY: '0',
        BOT_STATE_FILE: STATE,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logs = [];
    child.stdout.on('data', (c) => logs.push(c.toString()));
    child.stderr.on('data', (c) => logs.push(c.toString()));
    waitFor(() => logs.join('').includes('Слушаю Telegram'), 15000).then((ok) => resolve({ ok, logs }));
  });
}

async function main() {
  fs.rmSync(STATE, { force: true });
  await new Promise((r) => tgServer.listen(TG_PORT, '127.0.0.1', r));
  await new Promise((r) => proxyServer.listen(PROXY_PORT, '127.0.0.1', r));

  let started = await startBot({ BOT_ALLOW_ALL: '1' });
  check('бот поднялся', started.ok, started.logs.join('').slice(-400));

  // --- ошибка авторизации прокси
  section('Ошибки прокси');
  proxyMode = '401';
  push(1, 1, 'вопрос раз');
  await waitFor(() => edits.some((e) => /не авторизован/.test(e.text ?? '')));
  check('401 → понятное сообщение про вход в GigaCode', edits.some((e) => /не авторизован в GigaCode/.test(e.text ?? '')), JSON.stringify(edits.at(-1) ?? {}).slice(0, 300));
  check('к сообщению добавлены кнопки, а не «Стоп»', Boolean(edits.at(-1)?.reply_markup?.inline_keyboard?.[0]?.[0]?.text?.includes('Ещё раз')));

  proxyMode = '502';
  push(1, 1, 'вопрос два');
  await waitFor(() => edits.some((e) => /INF_413/.test(e.text ?? '')));
  check('текст ошибки прокси доходит до пользователя', edits.some((e) => /Payload too large/.test(e.text ?? '')));

  // --- остановка генерации кнопкой
  section('Кнопка «Стоп»');
  proxyMode = 'ok';
  chunkDelay = 60;
  answerText = 'Это очень длинный ответ, который точно не успеет догенерироваться до нажатия на кнопку «Стоп», потому что он печатается по кусочкам с задержкой.';
  const before = edits.length;
  push(1, 1, 'считай медленно');
  await waitFor(() => sent.some((m) => /⏳ Думаю/.test(m.text ?? '')), 10000);
  const startMessage = sent.filter((m) => /⏳ Думаю/.test(m.text ?? '')).at(-1);
  check('появилось сообщение-заглушка с кнопкой «Стоп»', startMessage?.reply_markup?.inline_keyboard?.[0]?.[0]?.text?.includes('Стоп'));
  await sleep(700);
  pushCallback(1, 1, 'stop');
  await waitFor(() => edits.length > before && edits.some((e) => /остановлено/i.test(e.text ?? '')));
  check('ответ прерван и помечен как остановленный', edits.some((e) => /остановлено/i.test(e.text ?? '')), JSON.stringify(edits.at(-1) ?? {}).slice(0, 300));
  check('нажатие кнопки подтверждено Telegram', callbacksAnswered.length > 0);
  await sleep(1500);
  const editsAfterStop = edits.length;
  await sleep(1200);
  check('после остановки новые правки не сыплются', edits.length === editsAfterStop, `${editsAfterStop} → ${edits.length}`);
  chunkDelay = 5;

  // --- error:not-modified не должен ломать поток
  section('Мелкие сбои Telegram');
  answerText = 'короткий ответ';
  const editsBefore = edits.length;
  push(1, 1, 'ещё вопрос');
  check('генерация прошла после ошибок Telegram', await waitFor(() => edits.length > editsBefore && edits.some((e) => /короткий ответ/.test(strip(e.text))), 15000));

  // --- очень длинный ответ → несколько сообщений
  section('Очень длинный ответ');
  sent.length = 0;
  answerText = `${Array.from({ length: 180 }, (_, i) => `Строка номер ${i}: немного содержательного текста про GigaCode и Telegram.`).join('\n')}`;
  push(1, 1, 'дай простыню');
  const okLong = await waitFor(() => sent.some((m) => /Строка номер 179/.test(m.text ?? '')), 45000);
  check('длинный ответ доставлен целиком (частями)', okLong, `частей: ${sent.length}`);
  check('все части ≤ 4096', sent.every((m) => (m.text ?? '').length <= 4096), `макс ${Math.max(...sent.map((m) => (m.text ?? '').length))}`);
  check('ни одна часть не пустая', sent.every((m) => (m.text ?? '').trim().length > 0));

  // --- белый список
  section('Доступ');
  await drain();                 // дописываем ответ предыдущего теста
  await stopBot();
  sent.length = 0;
  edits.length = 0;
  const started2 = await startBot({ BOT_ALLOW_ALL: '0', BOT_ALLOWED_USERS: '' });
  check('бот перезапустился в закрытом режиме', started2.ok);
  push(2, 999, 'пусти меня');
  await waitFor(() => sent.some((m) => /Бот закрыт/.test(m.text ?? '')));
  check('незнакомцу бот выдаёт его user id', sent.some((m) => /Бот закрыт/.test(m.text ?? '') && /999/.test(m.text ?? '')), JSON.stringify(sent.at(-1) ?? {}).slice(0, 300) + '\n     ЛОГ БОТА: ' + (started2.logs.join('').split('\n').slice(-6).join(' | ')));
  check('незнакомцу не отвечает модель (нет заглушки «Думаю»)', !sent.some((m) => /⏳/.test(m.text ?? '')));

  await stopBot();
  tgServer.close();
  proxyServer.close();
}

const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, '');

main()
  .catch((e) => {
    failed++;
    console.log(`Упало с ошибкой: ${e.stack}`);
  })
  .finally(() => {
    console.log(failed ? `\n❌ Провалено проверок: ${failed}` : '\n✅ Все проверки пройдены');
    process.exit(failed ? 1 : 0);
  });
