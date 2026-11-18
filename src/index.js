// ── tg-autopilot / src/index.js ─────────────────────────────────────────────
// Бот-секретарь для Telegram Business.
// Читает входящие сообщения владельца (через Business Connection), генерирует
// ответ по выбранному стилю и отправляет его ОТ ИМЕНИ ВЛАДЕЛЬЦА.
//
// Мультипользовательский режим: каждый подключивший бота получает своё
// пространство данных (data/users/<userId>/) со своими стилями и историей.
// Это база для продажи подписки: планы и лимиты — в src/users.js.
import { config, validateConfig } from './config.js';
import { generateReply, NO_REPLY, summarizeDay } from './llm.js';
import {
  getHistory,
  pushMessage,
  rememberChat,
  getCustomStyles,
  getCustomStyle,
  saveCustomStyle,
  resolveStyleId,
  migrateLegacy,
  flushAll,
} from './store.js';
import { makeFetch } from './proxy.js';
import { isClosingMessage } from './text.js';
import {
  mainScreen,
  stylesScreen,
  styleScreen,
  digestScreen,
  plansScreen,
  inviteScreen,
  setupScreen,
  wizardScreen,
  handleCallback,
  canCreateStyle,
  styleLimitReason,
} from './menu.js';
import { getStyle, DEFAULT_STYLE_ID } from './styles.js';
import {
  ensureUser,
  rememberConnection,
  getLimits,
  getUser,
  addReferral,
  registerChat,
  activateSubscription,
  REFERRALS_REQUIRED,
  PRO_DAYS_PER_FRIEND,
  TRIAL_DAYS,
  TRIAL_MAX_CHATS,
} from './users.js';
import { getTariff, periodText, recordPayment } from './billing.js';
import { startWizard, acceptAnswer, isInWizard, cancelWizard } from './wizard.js';
import { buildDigest } from './digest.js';
import { addPromo, setStatus, getPromo, listPending } from './promo.js';

validateConfig();

const API = `https://api.telegram.org/bot${config.botToken}`;
const fetchWithProxy = makeFetch(); // fetch через HTTPS_PROXY, если задан

async function tg(method, params = {}) {
  const res = await fetchWithProxy(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${JSON.stringify(data)}`);
  return data.result;
}

// ── Состояние процесса ──────────────────────────────────────────────────────
// Отложенные ответы и повторы: ключ — `${userId}:${chatId}`
const pending = new Map();
const retryQueue = new Map();
// Эхо собственных сообщений и защита от повторной обработки
const ownMessageIds = new Set();
const processedMessageIds = new Set();

const msgKey = (chatId, messageId) => `${chatId}:${messageId}`;

// @username бота — нужен для ссылок-приглашений и быстрой настройки
let botUsername = '';

// Множества растут бесконечно — подрезаем, оставляя последние записи
function remember(set, value, limit = 1000) {
  set.add(value);
  if (set.size > limit) set.delete(set.values().next().value);
}

// business_connection_id -> userId владельца. Нужно, чтобы понять, чьи это данные.
const connectionOwner = new Map();
const connectionChecked = new Set();

const rand = (min, max) => min + Math.random() * (max - min);
const delayMs = () => rand(config.replyDelayMin, config.replyDelayMax) * 1000;

function allowedUser(name) {
  const n = (name || '').toLowerCase();
  if (config.excludeUsers.some((u) => n.includes(u))) return false;
  if (!config.targetUsers.length) return true;
  return config.targetUsers.some((u) => n.includes(u));
}

/**
 * Определяет владельца по business connection: из кэша или через API.
 * business_connection приходит только при изменении настроек, поэтому
 * при старте бота владельца приходится дозапрашивать.
 */
async function ownerOf(connectionId) {
  if (!connectionId) return null;
  if (connectionOwner.has(connectionId)) return connectionOwner.get(connectionId);
  if (connectionChecked.has(connectionId)) return null;
  connectionChecked.add(connectionId);
  try {
    const bc = await tg('getBusinessConnection', { business_connection_id: connectionId });
    const user = bc?.user;
    if (user?.id) {
      connectionOwner.set(connectionId, user.id);
      ensureUser(user.id, { username: user.username });
      // Первый запуск после обновления: переносим общую историю в папку владельца
      migrateLegacy(user.id);
      console.log(`владелец подключения: @${user.username} (id ${user.id})`);
      return user.id;
    }
  } catch (err) {
    console.warn('не удалось определить владельца:', err.message);
  }
  return null;
}

/**
 * Писал ли это сообщение владелец аккаунта.
 * В личном чате участников двое: собеседница (chat.id) и владелец.
 * Поэтому если заполнено `from` и его id не равен chat.id — писал владелец.
 * Если `from` отсутствует — это тоже исходящее сообщение бизнес-аккаунта
 * (у входящих в личке `from` всегда есть).
 */
function fromRecipientCompare(m, ownerId) {
  const from = m.from?.id;
  if (from == null) return true; // нет отправителя → сообщение исходящее
  if (from === m.chat?.id) return false; // отправитель — сама собеседница
  if (ownerId != null && from === ownerId) return true;
  const isPrivate = !m.chat?.type || m.chat.type === 'private';
  return isPrivate && from !== m.chat?.id;
}

async function sendAsUser(businessConnectionId, chatId, text) {
  const sent = await tg('sendMessage', {
    business_connection_id: businessConnectionId,
    chat_id: chatId,
    text,
  });
  // Telegram пришлёт это сообщение обратно как business_message —
  // без отметки бот принял бы его за входящее.
  if (sent?.message_id) remember(ownMessageIds, msgKey(chatId, sent.message_id));
  return sent;
}

// ── Генерация и отправка ответа ─────────────────────────────────────────────
async function replyTo(userId, businessConnectionId, chatId, name) {
  const queueKey = `${userId}:${chatId}`;
  try {
    const history = getHistory(userId, chatId, config.historyLimit);

    // Стиль общения: свой для чата, иначе по умолчанию у владельца.
    // Если тариф не даёт свои стили (пробный истёк), откатываемся на встроенный.
    const customStyles = getCustomStyles(userId);
    const limitsForStyle = getLimits(userId);
    let styleId = resolveStyleId(userId, chatId);
    let style = getStyle(styleId, customStyles);
    if (!style.builtin && !limitsForStyle.canCustomStyles) {
      console.log(`[${name}] свой стиль недоступен на тарифе — использую встроенный`);
      style = getStyle(DEFAULT_STYLE_ID, customStyles);
    }
    styleId = style.id;

    // Владелец уже ответил сам, пока бот выжидал — не вклиниваемся
    const last = history[history.length - 1];
    if (!last || last.role !== 'user') {
      console.log(`[${name}] последнее сообщение не её — не отвечаю`);
      return;
    }

    // Короткие закрывающие реплики («на связи», «ок») — не отвечаем
    if (isClosingMessage(last.content)) {
      console.log(`[${name}] разговор закрыт («${last.content.slice(0, 30)}») — не отвечаю`);
      return;
    }

    // Лимит чатов по тарифу: проверяем до генерации, чтобы не тратить токены
    const chatAccess = registerChat(userId, chatId);
    if (!chatAccess.allowed) {
      console.log(
        `[${name}] лимит чатов исчерпан (${chatAccess.used}/${chatAccess.limit}) — тариф`
      );
      const limits = getLimits(userId);
      await tg('sendMessage', {
        chat_id: userId,
        text:
          `⚠️ Лимит тарифа «${limits.name}»: бот работает в ${chatAccess.limit} чатах.\n\n` +
          'Пригласи 3 друзей по своей ссылке, чтобы открыть пробный доступ, ' +
          'или оформи подписку — тогда чаты без ограничений.',
      }).catch(() => {});
      return;
    }

    // «Печатает…» от имени владельца, пока думает LLM
    await tg('sendChatAction', {
      business_connection_id: businessConnectionId,
      chat_id: chatId,
      action: 'typing',
    }).catch(() => {});

    const text = await generateReply(history, style);
    if (text === NO_REPLY) {
      console.log(`[${name}] модель решила не отвечать — разговор закрыт`);
      return;
    }

    await sendAsUser(businessConnectionId, chatId, text);
    pushMessage(userId, chatId, 'assistant', text);
    console.log(`[${name}] отправлено (${style.name}): ${text}`);
  } catch (err) {
    console.error(`[${name}] ошибка ответа:`, err.message);
    // Сбой провайдера — не теряем сообщение, пробуем позже.
    // Прочие ошибки (нет права, битый чат) повторять бессмысленно.
    if (/50\d|429|fetch failed|timeout|socket/i.test(err.message)) {
      if (!retryQueue.has(queueKey)) {
        console.log(`[${name}] повторю через 60 сек`);
        retryQueue.set(
          queueKey,
          setTimeout(() => {
            retryQueue.delete(queueKey);
            replyTo(userId, businessConnectionId, chatId, name);
          }, 60_000)
        );
      }
    }
  }
}

function scheduleReply(userId, businessConnectionId, chatId, name) {
  const queueKey = `${userId}:${chatId}`;
  const wait = delayMs();
  console.log(`[${name}] ответ через ~${Math.round(wait / 1000)} сек`);
  if (pending.has(queueKey)) clearTimeout(pending.get(queueKey));
  pending.set(
    queueKey,
    setTimeout(() => {
      pending.delete(queueKey);
      replyTo(userId, businessConnectionId, chatId, name);
    }, wait)
  );
}

// ── Промо-ролики: отправка на модерацию ─────────────────────────────────────
import fs from 'node:fs';
import { Blob } from 'node:buffer';

/**
 * Отправляет видео владельцу с кнопками «Выложить»/«Отклонить».
 * sendVideo требует multipart, поэтому обычный JSON-хелпер не подходит.
 */
async function sendPromoVideo(chatId, videoPath, title, id) {
  const buffer = fs.readFileSync(videoPath);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', `<b>${id}</b>\n${title}\n\nВыложить на YouTube?`);
  form.append('parse_mode', 'HTML');
  form.append('supports_streaming', 'true');
  form.append(
    'reply_markup',
    JSON.stringify({
      inline_keyboard: [
        [
          { text: '✅ Выложить', callback_data: `promo:ok:${id}` },
          { text: '❌ Отклонить', callback_data: `promo:no:${id}` },
        ],
      ],
    })
  );
  form.append('video', new Blob([buffer], { type: 'video/mp4' }), `${id}.mp4`);

  const res = await fetch(`${API}/sendVideo`, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(`sendVideo: ${JSON.stringify(data).slice(0, 200)}`);
  return data.result;
}

/** Отправить все готовые ролики из папки на модерацию */
async function sendAllPromos(chatId, dir, metaFile) {
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  let sent = 0;
  for (const item of meta) {
    const filePath = `${dir}/${item.id}.mp4`;
    if (!fs.existsSync(filePath)) continue;
    try {
      const msg = await sendPromoVideo(chatId, filePath, item.title, item.id);
      addPromo({ id: item.id, filePath, title: item.title, messageId: msg.message_id });
      sent += 1;
      console.log(`промо отправлен: ${item.id}`);
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      console.error(`промо ${item.id}: ${err.message}`);
    }
  }
  return sent;
}

// ── Меню и мастер в личке с ботом ───────────────────────────────────────────
async function sendScreen(chatId, screen, editMessageId) {
  const params = {
    chat_id: chatId,
    text: screen.text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: screen.keyboard },
  };
  if (editMessageId) {
    await tg('editMessageText', { ...params, message_id: editMessageId }).catch(() =>
      tg('sendMessage', params)
    );
  } else {
    await tg('sendMessage', params);
  }
}

async function handleCallbackQuery(cq) {
  const userId = cq.from?.id;
  const answer = (text) =>
    tg('answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => {});
  if (!userId) return answer();

  const data = String(cq.data || '');

  // Модерация промо-роликов: решение сохраняется в очередь для скрипта публикации
  if (data.startsWith('promo:')) {
    const [, action, id] = data.split(':');
    const promo = getPromo(id);
    if (!promo) return answer('Ролик не найден');

    if (action === 'ok') {
      setStatus(id, 'approved');
      await answer('Отправлю на YouTube');
      await tg('editMessageCaption', {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        caption: `<b>${id}</b>\n${promo.title}\n\n✅ Одобрено — выложу на YouTube`,
        parse_mode: 'HTML',
      }).catch(() => {});
      console.log(`промо ${id}: ОДОБРЕНО`);
    } else {
      setStatus(id, 'rejected');
      await answer('Отклонено');
      await tg('editMessageCaption', {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        caption: `<b>${id}</b>\n${promo.title}\n\n❌ Отклонено`,
        parse_mode: 'HTML',
      }).catch(() => {});
      console.log(`промо ${id}: ОТКЛОНЕНО`);
    }
    return;
  }

  // Покупка подписки за звёзды: выставляем инвойс прямо в этот чат
  if (data.startsWith('buy:stars:')) {
    const tariff = getTariff(data.slice('buy:stars:'.length));
    if (!tariff) return answer('Тариф не найден');
    await answer();
    await tg('sendInvoice', {
      chat_id: cq.message.chat.id,
      title: `Подписка ${tariff.label}`,
      description: `Все чаты и свои стили — ${periodText(tariff.days)}`,
      payload: `sub:${tariff.id}`,
      currency: 'XTR',
      prices: [{ label: `Подписка ${tariff.label}`, amount: tariff.stars }],
    });
    console.log(`инвойс: ${tariff.id} (${tariff.stars}⭐) для @${cq.from?.username || userId}`);
    return;
  }

  // Запуск и отмена мастера создания стиля
  if (data === 'wiz:new') {
    if (!canCreateStyle(userId)) {
      return answer(styleLimitReason(userId).slice(0, 190));
    }
    cancelWizard(userId);
    const question = startWizard(userId);
    await answer('Начинаем');
    return sendScreen(cq.message.chat.id, wizardScreen(question), cq.message.message_id);
  }
  if (data === 'wiz:cancel') {
    cancelWizard(userId);
    await answer('Отменено');
    return sendScreen(cq.message.chat.id, mainScreen(userId, botUsername), cq.message.message_id);
  }

  const screen = handleCallback(userId, data, botUsername);

  // Сводка по перепискам: собираем историю, просим модель сжать её до сути
  if (screen?.action === 'digest') {
    await answer('Готовлю сводку…');
    try {
      const digest = buildDigest(userId, screen.hours);
      if (!digest.messages) {
        await tg('sendMessage', {
          chat_id: cq.message.chat.id,
          text: 'За этот период сообщений нет.',
        });
        return;
      }
      const summary = await summarizeDay(digest.text);
      const period = { 24: 'сегодня', 72: '3 дня', 168: 'неделю' }[screen.hours] || `${screen.hours} ч`;
      await tg('sendMessage', {
        chat_id: cq.message.chat.id,
        text: `${summary}\n\n<i>Сводка за ${period}: ${digest.chats} диалогов, ${digest.messages} сообщений</i>`,
        parse_mode: 'HTML',
      });
      console.log(`сводка: ${digest.chats} диалогов, ${digest.messages} сообщений`);
    } catch (err) {
      console.error('ошибка сводки:', err.message);
      await tg('sendMessage', {
        chat_id: cq.message.chat.id,
        text: `Не удалось собрать сводку: ${err.message.slice(0, 120)}`,
      });
    }
    return;
  }

  if (!screen) return answer('Неизвестная команда');

  await answer();
  await sendScreen(cq.message.chat.id, screen, cq.message.message_id);
  console.log(`меню: @${cq.from?.username || userId} нажал «${data}»`);
}

async function handleBotMessage(m) {
  const userId = m.from?.id;
  if (!userId) return;
  const text = (m.text || '').trim();

  const isNew = !getUser(userId);
  ensureUser(userId, { username: m.from.username });

  // Мастер создания стиля: каждое сообщение — ответ на очередной шаг
  if (isInWizard(userId)) {
    if (/^\/cancel/i.test(text)) {
      cancelWizard(userId);
      return sendScreen(m.chat.id, mainScreen(userId, botUsername));
    }
    const result = acceptAnswer(userId, text);
    if (!result.done) {
      return sendScreen(m.chat.id, wizardScreen(result.question));
    }
    saveCustomStyle(userId, result.style);
    console.log(`стиль создан: «${result.style.name}» у @${m.from.username || userId}`);
    await tg('sendMessage', {
      chat_id: m.chat.id,
      text: `✅ Стиль <b>${result.style.name}</b> создан. Открой его в разделе «Стили» и нажми «Сделать основным».`,
      parse_mode: 'HTML',
    });
    return sendScreen(m.chat.id, stylesScreen(userId));
  }

  if (!/^\/(start|style|styles|стиль|menu|promo)/i.test(text)) return;

  // /promo — отправить владельцу все готовые ролики на модерацию
  if (/^\/promo/i.test(text)) {
    const dir = config.promoDir;
    const metaFile = config.promoMeta;
    if (!dir || !fs.existsSync(metaFile)) {
      return tg('sendMessage', {
        chat_id: m.chat.id,
        text: 'Папка с роликами не настроена (PROMO_DIR / PROMO_META в .env).',
      });
    }
    await tg('sendMessage', { chat_id: m.chat.id, text: 'Отправляю ролики на проверку…' });
    const sent = await sendAllPromos(m.chat.id, dir, metaFile);
    return tg('sendMessage', {
      chat_id: m.chat.id,
      text: `Отправлено на проверку: ${sent}. Под каждым видео — кнопки.`,
    });
  }

  // payload из ссылки: /start ref_<id> — приглашение, /start setup — быстрая настройка
  const payload = text.split(/\s+/)[1] || '';

  if (payload.startsWith('ref_')) {
    await handleReferral(userId, payload.slice(4), m);
    return sendScreen(m.chat.id, mainScreen(userId, botUsername));
  }

  if (payload === 'setup') {
    return sendScreen(m.chat.id, setupScreen());
  }

  // Первый запуск: короткое приветствие и сразу личный кабинет
  if (isNew) {
    await tg('sendMessage', {
      chat_id: m.chat.id,
      text:
        '👋 <b>Привет!</b>\n\n' +
        'Это бот, который ведёт переписку за тебя в твоём Telegram.\n\n' +
        'Что дальше:\n' +
        '1. Подключи его к профилю — кнопка «Как подключить»\n' +
        '2. Выбери стиль общения\n' +
        '3. Бот начнёт отвечать от твоего имени',
      parse_mode: 'HTML',
    }).catch(() => {});
  }

  return sendScreen(m.chat.id, mainScreen(userId, botUsername));
}

/** Оплата прошла: включаем подписку и сообщаем об этом */
async function handleSuccessfulPayment(m, payment) {
  const userId = m.from?.id;
  if (!userId) return;
  ensureUser(userId, { username: m.from.username });

  // payload вида sub:<тариф>
  const tariffId = String(payment.invoice_payload || '').replace(/^sub:/, '');
  const tariff = getTariff(tariffId);
  if (!tariff) {
    console.error(`оплата с неизвестным payload: ${payment.invoice_payload}`);
    return;
  }

  const stars = payment.total_amount || tariff.stars;
  // Сначала фиксируем charge id: Telegram может прислать успешный платёж повторно.
  // Повторный апдейт не должен выдать подписку ещё раз.
  let ledgerResult;
  try {
    ledgerResult = recordPayment({
      userId,
      tariffId,
      stars,
      telegramChargeId: payment.telegram_payment_charge_id,
      providerChargeId: payment.provider_payment_charge_id,
    });
  } catch (err) {
    // Не лишаем покупателя подписки из-за сбоя записи статистики; лог нужен для сверки.
    console.error('не удалось записать платёж в журнал:', err.message);
  }
  if (ledgerResult?.recorded === false) {
    console.warn(`дубликат успешного платежа ${payment.telegram_payment_charge_id}, повторно не активирую`);
    return;
  }

  const user = activateSubscription(userId, tariff.days);
  const until = new Date(user.proExpiresAt).toLocaleDateString('ru-RU');

  console.log(`оплачено: ${stars}⭐ — ${tariff.label} для @${m.from.username || userId} до ${until}`);

  await tg('sendMessage', {
    chat_id: m.chat.id,
    parse_mode: 'HTML',
    text:
      `✅ <b>Подписка «${tariff.label}» активирована</b>\n\n` +
      `Действует до <b>${until}</b>: свои стили и все чаты без ограничений.\n\n` +
      `Списано: ${stars} ⭐`,
  });

  // Уведомляем админа о продаже
  const adminId = await ownerOf(Object.keys(connectionOwner)[0]).catch(() => null);
  if (adminId && adminId !== userId) {
    await tg('sendMessage', {
      chat_id: adminId,
      parse_mode: 'HTML',
      text: `💰 Продажа: <b>${tariff.label}</b> за ${stars}⭐\nПокупатель: @${m.from.username || userId} (${userId})`,
    }).catch(() => {});
  }
}

/** Учёт приглашения по ссылке */
async function handleReferral(userId, inviterRaw, m) {
  const inviterId = Number(inviterRaw);
  if (!Number.isFinite(inviterId)) return;

  const result = addReferral(inviterId, userId);
  if (!result.counted) {
    console.log(`реферал не засчитан: ${result.reason}`);
    return;
  }

  const inviter = getUser(inviterId);
  const count = inviter?.referrals?.count || 0;
  console.log(`реферал: ${userId} приглашён ${inviterId} (${count}/${REFERRALS_REQUIRED})`);

  const proUntil = result.proUntil
    ? new Date(result.proUntil).toLocaleDateString('ru-RU')
    : null;

  // Сообщаем пригласившему: триал (за первого) + +3 дня Pro за каждого
  const msg = result.trialGranted
    ? `🎉 Друг активировал бота!\n\n` +
      `Открыт пробный доступ: свой стиль на ${TRIAL_MAX_CHATS} чатов и ${TRIAL_DAYS} дней.\n` +
      `Плюс +${PRO_DAYS_PER_FRIEND} дня подписки Pro — активна до ${proUntil}.`
    : `👥 Ещё один друг активировал бота!\n\n+${PRO_DAYS_PER_FRIEND} дня подписки Pro — активна до ${proUntil}.`;

  tg('sendMessage', { chat_id: inviterId, text: msg }).catch(() => {});

  // И новому пользователю — что его пригласили
  tg('sendMessage', {
    chat_id: m.chat.id,
    text: 'Тебя пригласили. Показываю меню.',
  }).catch(() => {});
}

// ── Long polling ────────────────────────────────────────────────────────────
let offset = 0;

async function poll() {
  try {
    const updates = await tg('getUpdates', {
      offset,
      timeout: 30,
      allowed_updates: [
        'business_connection',
        'business_message',
        'edited_business_message',
        'deleted_business_messages',
        'callback_query',
        'message',
        'pre_checkout_query',
      ],
    });

    for (const u of updates) {
      offset = u.update_id + 1;

      // Кнопки меню
      if (u.callback_query) {
        await handleCallbackQuery(u.callback_query).catch((err) =>
          console.error('ошибка меню:', err.message)
        );
        continue;
      }

      // Подтверждение платежа перед списанием звёзд
      if (u.pre_checkout_query) {
        await tg('answerPreCheckoutQuery', {
          pre_checkout_query_id: u.pre_checkout_query.id,
          ok: true,
        }).catch(() => {});
        continue;
      }

      // Сообщения боту в личке (не бизнес-чат)
      if (u.message && !u.message.business_connection_id) {
        // Успешная оплата звёздами: включаем подписку немедленно
        const payment = u.message.successful_payment;
        if (payment) {
          await handleSuccessfulPayment(u.message, payment);
          continue;
        }
        await handleBotMessage(u.message).catch((err) =>
          console.error('ошибка меню:', err.message)
        );
        continue;
      }

      // Подключение/переподключение владельца
      if (u.business_connection) {
        const bc = u.business_connection;
        if (bc.user?.id) {
          connectionOwner.set(bc.id, bc.user.id);
          ensureUser(bc.user.id, { username: bc.user.username });
          rememberConnection(bc.user.id, bc.id);
        }
        console.log(
          `Business connection: @${bc.user?.username} (id ${bc.user?.id}), ` +
            `can_reply=${bc.can_reply}, enabled=${bc.is_enabled}`
        );
      }

      // Входящее сообщение в чате владельца
      if (u.business_message) {
        const m = u.business_message;
        const chatId = m.chat.id;
        const name =
          m.chat.first_name || m.chat.title || m.chat.username || String(chatId);
        const text = m.text || '';

        // Диагностика: видно, кем Telegram пометил сообщение.
        // Если бот снова начнёт отвечать сам себе — по этой строке понятно почему.
        console.log(
          `   raw: from=${m.from?.id} chat=${chatId} chatType=${m.chat?.type} ` +
            `bizBot=${m.sender_business_bot || '-'} msgId=${m.message_id}`
        );

        const userId = await ownerOf(m.business_connection_id);
        if (!userId) {
          console.warn(`[${name}] не определён владелец подключения — пропуск`);
          continue;
        }

        // 1. Сообщение самого владельца (написал с телефона) — отвечать нельзя.
        // В Bot API нет поля `out`, поэтому определяем по трём признакам:
        //   а) sender_business_bot — заполняется у исходящих от бизнес-аккаунта;
        //   б) from.id совпадает с владельцем подключения;
        //   в) в личном чате всего два участника, поэтому если отправитель
        //      не совпадает с chat.id — писал владелец, а не собеседница.
        // Признак (в) — запасной: работает даже если владельца не удалось узнать.
        const sentByBot = Boolean(m.sender_business_bot);
        const fromIsOwner = fromRecipientCompare(m, userId);
        const fromOwner = sentByBot || fromIsOwner;
        if (fromOwner) {
          console.log(
            `[${name}] сообщение владельца (from=${m.from?.id}, chat=${chatId}, bizBot=${sentByBot}) — пропуск`
          );
          // Владелец ответил сам — снимаем отложенный ответ бота
          const queueKey = `${userId}:${chatId}`;
          if (pending.has(queueKey)) {
            clearTimeout(pending.get(queueKey));
            pending.delete(queueKey);
            console.log(`[${name}] отменил свой отложенный ответ — владелец ответил сам`);
          }
          continue;
        }

        // 2. Эхо собственного сообщения
        if (ownMessageIds.has(msgKey(chatId, m.message_id))) {
          console.log(`[${name}] эхо своего сообщения — пропуск`);
          continue;
        }

        // 3. Уже обработанное сообщение (после перезапуска или дубля)
        if (processedMessageIds.has(msgKey(chatId, m.message_id))) {
          console.log(`[${name}] дубль message_id ${m.message_id} — пропуск`);
          continue;
        }

        if (!text) continue; // стикеры и фото без подписи пропускаем
        if (!allowedUser(m.chat.username || name)) {
          console.log(`[${name}] не в списке целей — игнор`);
          continue;
        }

        remember(processedMessageIds, msgKey(chatId, m.message_id));
        pushMessage(userId, chatId, 'user', text);
        rememberChat(userId, chatId, name);
        console.log(`[${name}] получено: ${text}`);
        scheduleReply(userId, m.business_connection_id, chatId, name);
      }
    }
  } catch (err) {
    // Пока VPN-клиент выключен, прокси недоступен — бот просто ждёт его
    // и продолжит сам, как только он появится. Лог не спамим.
    const proxyDown = /ECONNREFUSED|ENOTFOUND|connect/i.test(err.message);
    const now = Date.now();
    if (proxyDown) {
      if (now - lastProxyNotice > 30_000) {
        lastProxyNotice = now;
        console.error('VPN-клиент (Happ) не подключён — жду. Включи его, и бот продолжит сам.');
      }
    } else {
      console.error('Polling error:', err.message);
    }
    await new Promise((r) => setTimeout(r, proxyDown ? 5000 : 3000));
  }
  setImmediate(poll);
}

let lastProxyNotice = 0;

async function main() {
  // Telegram API без VPN часто недоступен: если прокси выключен —
  // не умираем, а ждём включения и продолжаем сами.
  for (let attempt = 1; ; attempt++) {
    try {
      const me = await tg('getMe');
      botUsername = me.username || '';
      console.log(`Бот @${me.username} запущен.`);
      console.log('Ожидание подключений Business... Убедись, что подключил бота:');
      console.log('  Настройки → Telegram for Business → Автоматизация чатов');
      console.log(`Быстрая настройка: https://t.me/${botUsername}?start=setup`);
      poll();
      return;
    } catch (err) {
      const wait = 30;
      console.error(`старт не удался (${err.message.slice(0, 80)})`);
      console.error(`повтор через ${wait} сек. Если включил VPN — подключусь автоматически.`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

main().catch((err) => {
  console.error('Фатальная ошибка:', err);
  process.exit(1);
});

// Перед выходом записать накопленные данные
process.on('SIGTERM', () => {
  flushAll();
  process.exit(0);
});

// Страховка: одиночный сбой сети не должен убивать бота.
// Все ожидаемые ошибки уже ловятся локально; сюда доходит только экзотика.
process.on('uncaughtException', (err) => {
  console.error('необработанная ошибка (бот продолжает работу):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('необработанный промис (бот продолжает работу):', String(reason).slice(0, 200));
});
