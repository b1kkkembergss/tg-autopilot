// ── tg-autopilot / src/admin_bot.js ─────────────────────────────────────────
// Отдельный админ-бот. Токен берётся только из ADMIN_BOT_TOKEN в локальном .env.
// Все команды и callbacks строго ограничены ADMIN_USER_ID.
//
// Команды: /admin, /stats, /payments [today|month|all], /users, /user <id>, /promos
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { makeFetch } from './proxy.js';
import { listUsers, effectivePlan, isTrialActive, trialDaysLeft, proDaysLeft, activateSubscription } from './users.js';
import { getPaymentLedger, paymentStats, getTariff } from './billing.js';
import { getCustomStyles, listChats } from './store.js';
import { listPending, listApproved, listRejected } from './promo.js';

const TOKEN = process.env.ADMIN_BOT_TOKEN || '';
const ADMIN_ID = Number(process.env.ADMIN_USER_ID || '7166090548');
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : '';
const dataFetch = makeFetch();

if (!TOKEN) {
  console.error('ADMIN_BOT_TOKEN не задан. Отзови засвеченный токен в @BotFather, создай новый и внеси только в локальный .env.');
  process.exit(1);
}

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

async function tg(method, params = {}) {
  const res = await dataFetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description || JSON.stringify(data)}`);
  return data.result;
}

function dashboard() {
  const users = listUsers();
  const counts = { owner: 0, pro: 0, trial: 0, free: 0 };
  let activeTrials = 0;
  let referrals = 0;
  let chats = 0;
  let styles = 0;
  for (const u of users) {
    const plan = effectivePlan(u.userId);
    counts[plan.id] = (counts[plan.id] || 0) + 1;
    if (isTrialActive(u.userId)) activeTrials++;
    referrals += u.referrals?.count || 0;
    chats += listChats(u.userId).length;
    styles += getCustomStyles(u.userId).length;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = paymentStats(today.getTime());
  const all = paymentStats();
  const lines = [
    '<b>🛠 Админ-панель Blinjop</b>', '',
    `<b>Пользователи:</b> ${users.length}`,
    `🆓 Бесплатный: ${counts.free || 0} | ⏳ Триал активен: ${activeTrials}`,
    `⭐ Pro: ${counts.pro || 0} | 👑 Владелец: ${counts.owner || 0}`,
    `💬 Чатов: ${chats} | 🎨 Своих стилей: ${styles}`,
    `👥 Рефералов засчитано: ${referrals}`,
    '', '<b>Платежи Stars:</b>',
    `Сегодня: ${day.count} оплат / ${day.stars} ⭐`,
    `Всего: ${all.count} оплат / ${all.stars} ⭐`,
    '', `📹 Ролики на модерации: ${listPending().length}`,
  ];
  return {
    text: lines.join('\n'),
    keyboard: [
      [{ text: '💳 Платежи', callback_data: 'a:payments:all' }, { text: '📅 Сегодня', callback_data: 'a:payments:today' }],
      [{ text: '👥 Пользователи', callback_data: 'a:users:0' }, { text: '📹 Ролики', callback_data: 'a:promos' }],
      [{ text: '🔄 Обновить', callback_data: 'a:home' }],
    ],
  };
}

function paymentsScreen(period = 'all') {
  let since = null;
  let title = 'за всё время';
  if (period === 'today') {
    const d = new Date(); d.setHours(0, 0, 0, 0); since = d.getTime(); title = 'сегодня';
  } else if (period === 'month') {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); since = d.getTime(); title = 'за месяц';
  }
  const stats = paymentStats(since);
  const byTariff = Object.entries(stats.byTariff).map(([id, count]) => `• ${esc(getTariff(id)?.label || id)}: ${count}`);
  const recent = stats.payments.slice(-10).reverse().map((p) => {
    const t = getTariff(p.tariffId);
    return `• ${new Date(p.createdAt).toLocaleString('ru-RU')}: <code>${esc(p.userId)}</code>, ${esc(t?.label || p.tariffId)}, ${p.stars} ⭐`;
  });
  return {
    text: [
      `<b>💳 Платежи ${title}</b>`, '',
      `Успешных оплат: <b>${stats.count}</b>`, `Сумма: <b>${stats.stars} ⭐</b>`,
      ...(byTariff.length ? ['', '<b>По тарифам:</b>', ...byTariff] : []),
      ...(recent.length ? ['', '<b>Последние оплаты:</b>', ...recent] : []),
    ].join('\n'),
    keyboard: [
      [{ text: 'Сегодня', callback_data: 'a:payments:today' }, { text: 'Месяц', callback_data: 'a:payments:month' }],
      [{ text: 'Всё время', callback_data: 'a:payments:all' }, { text: '← Панель', callback_data: 'a:home' }],
    ],
  };
}

function usersScreen(page = 0) {
  const users = listUsers().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const pageSize = 10;
  const slice = users.slice(page * pageSize, (page + 1) * pageSize);
  const lines = [`<b>👥 Пользователи (${users.length})</b>`, '', ...slice.map((u) => {
    const plan = effectivePlan(u.userId);
    const username = u.username ? `@${esc(u.username)}` : 'без username';
    const exp = proDaysLeft(u.userId) ? ` · Pro ${proDaysLeft(u.userId)} дн.` : '';
    const trial = isTrialActive(u.userId) ? ` · триал ${trialDaysLeft(u.userId)} дн.` : '';
    return `• <code>${esc(u.userId)}</code> ${username}\n  ${esc(plan.name)}${exp}${trial} · реф.: ${u.referrals?.count || 0}`;
  })];
  const keyboard = slice.map((u) => [{ text: `${u.username ? '@'+u.username : u.userId} · профиль`, callback_data: `a:user:${u.userId}` }]);
  const nav = [];
  if (page > 0) nav.push({ text: '← Назад', callback_data: `a:users:${page - 1}` });
  if ((page + 1) * pageSize < users.length) nav.push({ text: 'Далее →', callback_data: `a:users:${page + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: '🏠 Панель', callback_data: 'a:home' }]);
  return { text: lines.join('\n'), keyboard };
}

function userScreen(userId) {
  const u = listUsers().find((x) => String(x.userId) === String(userId));
  if (!u) return { text: 'Пользователь не найден.', keyboard: [[{ text: '← Пользователи', callback_data: 'a:users:0' }]] };
  const plan = effectivePlan(userId);
  const chats = listChats(userId);
  const styles = getCustomStyles(userId);
  const lines = [
    '<b>Профиль пользователя</b>', '',
    `ID: <code>${esc(userId)}</code>`,
    `Username: ${u.username ? '@'+esc(u.username) : '—'}`,
    `Тариф: <b>${esc(plan.name)}</b>`,
    `Регистрация: ${new Date(u.createdAt).toLocaleDateString('ru-RU')}`,
    `Чатов: ${chats.length} / ${Number.isFinite(plan.maxChats) ? plan.maxChats : '∞'}`,
    `Своих стилей: ${styles.length}`, `Приглашено: ${u.referrals?.count || 0}`,
  ];
  if (isTrialActive(userId)) lines.push(`Триал до: ${new Date(u.trial.expiresAt).toLocaleString('ru-RU')}`);
  if (proDaysLeft(userId)) lines.push(`Pro до: ${new Date(u.proExpiresAt).toLocaleString('ru-RU')}`);
  return {
    text: lines.join('\n'),
    keyboard: [
      [{ text: '+3 дня Pro', callback_data: `a:grant:${userId}:3` }, { text: '+30 дней Pro', callback_data: `a:grant:${userId}:30` }],
      [{ text: '← Пользователи', callback_data: 'a:users:0' }, { text: '🏠 Панель', callback_data: 'a:home' }],
    ],
  };
}

function promosScreen() {
  const pending = listPending();
  const approved = listApproved();
  const rejected = listRejected();
  return {
    text: [
      '<b>📹 Промо-ролики</b>', '', `На модерации: ${pending.length}`,
      `Одобрено: ${approved.length}`, `Отклонено: ${rejected.length}`,
      '', 'Одобрение фиксируется в очереди; публикация выполняется скриптом.',
    ].join('\n'),
    keyboard: [[{ text: '🏠 Панель', callback_data: 'a:home' }]],
  };
}

async function sendScreen(chatId, messageId, screen) {
  await tg('editMessageText', {
    chat_id: chatId, message_id: messageId, text: screen.text,
    parse_mode: 'HTML', reply_markup: { inline_keyboard: screen.keyboard },
  }).catch(() => {});
}

async function handleCallback(cq) {
  const from = cq.from;
  if (!from || Number(from.id) !== ADMIN_ID) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Доступ запрещён', show_alert: true }).catch(() => {});
    return;
  }
  const [root, action, a, b] = String(cq.data || '').split(':');
  if (root !== 'a') return;
  let screen;
  if (action === 'home') screen = dashboard();
  else if (action === 'payments') screen = paymentsScreen(a || 'all');
  else if (action === 'users') screen = usersScreen(Number(a) || 0);
  else if (action === 'user') screen = userScreen(a);
  else if (action === 'promos') screen = promosScreen();
  else if (action === 'grant') {
    const id = Number(a), days = Math.max(1, Math.min(365, Number(b) || 3));
    activateSubscription(id, days);
    screen = userScreen(id);
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: `Выдано +${days} дней Pro` }).catch(() => {});
  }
  if (!screen) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Неизвестная команда' }).catch(() => {});
  await tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
  await sendScreen(cq.message.chat.id, cq.message.message_id, screen);
}

async function handleMessage(m) {
  const from = m.from;
  if (!from || Number(from.id) !== ADMIN_ID) {
    console.warn('admin bot: denied user', from?.id);
    return;
  }
  const text = String(m.text || '').trim();
  let screen;
  if (/^\/(start|admin|stats)$/i.test(text)) screen = dashboard();
  else if (/^\/payments\s*(today|month|all)?$/i.test(text)) screen = paymentsScreen(text.split(/\s+/)[1] || 'all');
  else if (/^\/users$/i.test(text)) screen = usersScreen(0);
  else if (/^\/promos$/i.test(text)) screen = promosScreen();
  else if (/^\/user\s+\d+$/i.test(text)) screen = userScreen(text.split(/\s+/)[1]);
  else {
    await tg('sendMessage', { chat_id: m.chat.id, text: 'Команды: /admin, /stats, /payments [today|month|all], /users, /user <id>, /promos' });
    return;
  }
  await tg('sendMessage', { chat_id: m.chat.id, text: screen.text, parse_mode: 'HTML', reply_markup: { inline_keyboard: screen.keyboard } });
}

async function poll() {
  let offset = 0;
  while (true) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.callback_query) await handleCallback(u.callback_query).catch((e) => console.error('callback:', e.message));
        else if (u.message) await handleMessage(u.message).catch((e) => console.error('message:', e.message));
      }
    } catch (e) {
      console.error('admin polling:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function main() {
  if (!ADMIN_ID) throw new Error('ADMIN_USER_ID не задан: админ-бот закрыт по умолчанию');
  const me = await tg('getMe');
  console.log(`Админ-бот @${me.username} запущен; allowlist=${ADMIN_ID}`);
  poll();
}

main().catch((e) => {
  console.error('admin bot startup:', e.message);
  process.exitCode = 1;
});
