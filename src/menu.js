// ── tg-autopilot / src/menu.js ──────────────────────────────────────────────
// Интерфейс бота: личный кабинет и разделы.
//
// Экраны:
//   main    — 👤 личный кабинет: тариф, расход чатов, друзья, точки входа
//   styles  — 🎨 список стилей
//   style   — карточка одного стиля (сделать основным / удалить)
//   digest  — 📊 выбор периода сводки
//   plans   — 💳 тарифы и пробный доступ
//   invite  — 👥 ссылка-приглашение и прогресс
//   setup   — ⚡ как подключить бота
//
// callback_data:
//   menu:main | menu:styles | menu:style:<id> | menu:digest | menu:plans
//   menu:invite | menu:setup
//   set:default:<id> | wiz:new | wiz:del:<id> | wiz:cancel
//   digest:24 | digest:72 | digest:168

import { styleList, getStyle, DEFAULT_STYLE_ID } from './styles.js';
import {
  getCustomStyles,
  getCustomStyle,
  deleteCustomStyle,
  getDefaultStyle,
  setDefaultStyle,
} from './store.js';
import {
  getLimits,
  getUser,
  isTrialActive,
  trialDaysLeft,
  proDaysLeft,
  REFERRALS_REQUIRED,
  PRO_DAYS_PER_FRIEND,
  TRIAL_DAYS,
  TRIAL_MAX_CHATS,
} from './users.js';
import { tariffList, BUY_STARS_LINK, ADMIN_LINK } from './billing.js';

// ── Ссылки ──────────────────────────────────────────────────────────────────
export const inviteLink = (botUsername, userId) =>
  `https://t.me/${botUsername}?start=ref_${userId}`;
export const setupLink = (botUsername) => `https://t.me/${botUsername}?start=setup`;

const shareLink = (botUsername, userId) =>
  'https://t.me/share/url?url=' +
  encodeURIComponent(inviteLink(botUsername, userId)) +
  '&text=' +
  encodeURIComponent('Бот, который ведёт переписку за тебя');

const BACK = (target = 'menu:main') => ({ text: '← Назад', callback_data: target });

/** «за 1 друга» / «за 3 друзей» — грамматика числа */
const friendsPhrase = (n) => `за ${n} ${n === 1 ? 'друга' : 'друзей'}`;

// ── Личный кабинет ──────────────────────────────────────────────────────────
export function mainScreen(userId, botUsername = '') {
  const custom = getCustomStyles(userId);
  const defId = getDefaultStyle(userId) || DEFAULT_STYLE_ID;
  const def = getStyle(defId, custom);
  const limits = getLimits(userId);
  const user = getUser(userId) || {};
  const invited = user.referrals?.count || 0;
  const usedChats = (user.usedChats || []).length;
  const trialActive = isTrialActive(userId);

  const lines = ['👤 <b>Личный кабинет</b>', ''];

  // Тариф и его лимиты
  const chatLine = Number.isFinite(limits.maxChats)
    ? `${usedChats} из ${limits.maxChats}`
    : 'без ограничений';
  lines.push(`Тариф: <b>${limits.name}</b>`);
  lines.push(`Чатов подключено: <b>${chatLine}</b>`);

  if (trialActive) {
    lines.push(`⏳ Пробный доступ: ещё <b>${trialDaysLeft(userId)} дн.</b>`);
  } else if (!limits.canCustomStyles) {
    lines.push(`Друзей приглашено: <b>${invited} из ${REFERRALS_REQUIRED}</b>`);
  }

  lines.push('', `Стиль по умолчанию: <b>${def.name}</b>`, def.description);

  // Подсказка новичку
  if (!user.connections?.length) {
    lines.push(
      '',
      '⚡ Бот ещё не подключён к профилю. Нажми «Как подключить» — это минута.'
    );
  }

  const keyboard = [
    [
      { text: '🎨 Стили', callback_data: 'menu:styles' },
      { text: '📊 Сводка', callback_data: 'menu:digest' },
    ],
    [
      { text: '💳 Тарифы', callback_data: 'menu:plans' },
      { text: '👥 Пригласить друга', callback_data: 'menu:invite' },
    ],
    [
      { text: '⚡ Как подключить', callback_data: 'menu:setup' },
      { text: '🆘 Поддержка', url: OWNER_CONTACT },
    ],
  ];

  return { text: lines.join('\n'), keyboard };
}

// ── Стили ───────────────────────────────────────────────────────────────────
export function stylesScreen(userId) {
  const custom = getCustomStyles(userId);
  const defId = getDefaultStyle(userId) || DEFAULT_STYLE_ID;
  const limits = getLimits(userId);

  const lines = ['🎨 <b>Стили общения</b>', '', `Тариф: <b>${limits.name}</b>`];

  if (!limits.canCustomStyles) {
    lines.push(
      '',
      'Встроенные стили доступны всегда.',
      `Свои стили открываются ${friendsPhrase(REFERRALS_REQUIRED)} или по подписке.`,
      `Каждый друг даёт +${PRO_DAYS_PER_FRIEND} дня подписки Pro.`
    );
  } else {
    const left = Math.max(0, limits.maxCustomStyles - custom.length);
    lines.push(`Своих стилей можно создать ещё: <b>${left}</b>`);
  }

  lines.push('', 'Нажми на стиль, чтобы открыть карточку.');

  const keyboard = [];

  for (const s of styleList([])) {
    const mark = s.id === defId ? '✓ ' : '';
    keyboard.push([{ text: `${mark}${s.name}`, callback_data: `menu:style:${s.id}` }]);
  }
  for (const c of custom) {
    const mark = c.id === defId ? '✓ ' : '';
    keyboard.push([{ text: `${mark}${c.name}`, callback_data: `menu:style:${c.id}` }]);
  }

  if (canCreateStyle(userId)) {
    keyboard.push([{ text: '➕ Создать свой стиль', callback_data: 'wiz:new' }]);
  } else if (!limits.canCustomStyles) {
    keyboard.push([{ text: '🔒 Свои стили — по подписке', callback_data: 'menu:plans' }]);
  } else {
    keyboard.push([{ text: '➕ Лимит стилей исчерпан', callback_data: 'menu:plans' }]);
  }

  keyboard.push([BACK('menu:main')]);
  return { text: lines.join('\n'), keyboard };
}

/** Карточка стиля */
export function styleScreen(userId, styleId) {
  const custom = getCustomStyles(userId);
  const style = getStyle(styleId, custom);
  const defId = getDefaultStyle(userId) || DEFAULT_STYLE_ID;
  const isDefault = style.id === defId;

  const lines = [
    `<b>${style.name}</b>${style.builtin ? ' · встроенный' : ' · свой'}`,
    '',
    style.description,
  ];

  if (style.audience) lines.push('', `<b>С кем:</b> ${style.audience}`);
  if (style.purpose) lines.push(`<b>Цель:</b> ${style.purpose}`);
  if (style.tone) lines.push('', `<b>Манера:</b> ${style.tone}`);
  if (style.rules?.length) lines.push('', `<b>Запреты:</b> ${style.rules.join('; ')}`);
  if (style.goals?.length) lines.push('', `<b>Как вести:</b> ${style.goals.join('; ')}`);

  const p = style.persona || {};
  const personaBits = [p.name, p.age && `${p.age} лет`, p.city, p.context].filter(Boolean);
  if (personaBits.length) lines.push('', `<b>Персона:</b> ${personaBits.join(', ')}`);

  const keyboard = [];
  keyboard.push(
    isDefault
      ? [{ text: '✓ Используется по умолчанию', callback_data: 'menu:main' }]
      : [{ text: '⭐ Сделать основным', callback_data: `set:default:${style.id}` }]
  );
  if (!style.builtin) {
    keyboard.push([{ text: '🗑 Удалить стиль', callback_data: `wiz:del:${style.id}` }]);
  }
  keyboard.push([BACK('menu:styles')]);

  return { text: lines.join('\n'), keyboard };
}

// ── Сводка ──────────────────────────────────────────────────────────────────
export function digestScreen() {
  const text = [
    '📊 <b>Сводка по перепискам</b>',
    '',
    'Соберу главное по всем диалогам: о чём говорили, чем закончилось, где нужен твой ответ.',
    '',
    'Выбери период:',
  ].join('\n');

  return {
    text,
    keyboard: [
      [{ text: 'За сегодня', callback_data: 'digest:24' }],
      [{ text: 'За 3 дня', callback_data: 'digest:72' }],
      [{ text: 'За неделю', callback_data: 'digest:168' }],
      [BACK('menu:main')],
    ],
  };
}

// ── Ссылка владельца: подписка и поддержка ──────────────────────────────────
export const OWNER_CONTACT = 'https://t.me/Richhantr';

// ── Тарифы ──────────────────────────────────────────────────────────────────
export function plansScreen(userId, botUsername = '') {
  const limits = getLimits(userId);
  const trialActive = isTrialActive(userId);
  const proLeft = proDaysLeft(userId);

  const lines = ['💳 <b>Тарифы</b>', ''];

  // Текущий статус
  if (limits.id === 'pro') {
    lines.push(
      `Подписка активна: осталось <b>${proLeft} дн.</b>`,
      'Все чаты и свои стили доступны. Покупка продлевает срок.'
    );
  } else if (trialActive) {
    lines.push(
      `Сейчас: <b>Пробный доступ</b> (ещё ${trialDaysLeft(userId)} дн.), до ${TRIAL_MAX_CHATS} чатов`,
      'Купи подписку, чтобы не потерять функции после окончания.'
    );
  } else {
    lines.push(
      `Сейчас: <b>Бесплатный</b> — до 5 чатов, встроенные стили`,
      '',
      'Подписка открывает: <b>свои стили</b> и <b>все чаты без ограничений</b>.'
    );
  }

  if (limits.id !== 'pro') {
    lines.push('', '<b>Выбери период:</b>');
  }

  const keyboard = [];

  // Лестница цен — оплата звёздами прямо в Telegram
  for (const t of tariffList()) {
    const mark = t.best ? '🔥 ' : '';
    keyboard.push([
      {
        text: `${mark}${t.label} — ${t.stars} ⭐`,
        callback_data: `buy:stars:${t.id}`,
      },
    ]);
  }

  // Способы оплаты
  keyboard.push([{ text: '⭐ Пополнить звёзды', url: BUY_STARS_LINK }]);
  keyboard.push([{ text: '👤 Оплатить через админа', url: ADMIN_LINK }]);

  // Приглашение — бесплатный способ получить пробный
  if (limits.id === 'free') {
    keyboard.push([
      { text: `👥 Или ${friendsPhrase(REFERRALS_REQUIRED)} — бесплатно`, callback_data: 'menu:invite' },
    ]);
  }

  keyboard.push([BACK('menu:main')]);

  return { text: lines.join('\n'), keyboard };
}

// ── Приглашения ─────────────────────────────────────────────────────────────
export function inviteScreen(userId, botUsername = '') {
  const user = getUser(userId) || {};
  const invited = user.referrals?.count || 0;
  const left = Math.max(0, REFERRALS_REQUIRED - invited);
  const trialActive = isTrialActive(userId);
  const link = inviteLink(botUsername, userId);

  const lines = [
    '👥 <b>Пригласи друзей</b>',
    '',
    `Приглашено: <b>${invited} из ${REFERRALS_REQUIRED}</b>`,
  ];

  if (trialActive) {
    lines.push(
      `⏳ Пробный доступ уже открыт: ещё ${trialDaysLeft(userId)} дн.`,
      `Каждый следующий друг даёт +${PRO_DAYS_PER_FRIEND} дня подписки Pro.`
    );
  } else if (left > 0) {
    lines.push(
      `Осталось пригласить: <b>${left}</b>.`,
      `За ${REFERRALS_REQUIRED === 1 ? '1 друга' : REFERRALS_REQUIRED + ' друзей'} откроется свой стиль на ${TRIAL_MAX_CHATS} чатов и ${TRIAL_DAYS} дней.`,
      `И каждый друг даёт +${PRO_DAYS_PER_FRIEND} дня подписки Pro.`
    );
  }

  lines.push('', 'Твоя ссылка:', `<code>${link}</code>`);

  const keyboard = [[{ text: '📤 Поделиться ссылкой', url: shareLink(botUsername, userId) }]];
  keyboard.push([{ text: '📋 Открыть ссылку', url: link }]);
  keyboard.push([BACK('menu:main')]);

  return { text: lines.join('\n'), keyboard };
}

// ── Как подключить ──────────────────────────────────────────────────────────
export function setupScreen() {
  const text = [
    '⚡ <b>Как подключить бота</b>',
    '',
    '1. Открой свой профиль: нажми на аватар в правом верхнем углу',
    '2. Нажми «Изменить» — откроется страница профиля',
    '3. Прокрути вниз до пункта «Автоматизация чатов»',
    '4. Выбери этого бота и разреши ему отвечать в чатах',
    '',
    'Готово — бот начнёт вести переписку от твоего имени.',
  ].join('\n');

  return {
    text,
    keyboard: [[BACK('menu:main')]],
  };
}

/** Экран-заглушка на время мастера */
export function wizardScreen(question) {
  return {
    text: question,
    keyboard: [[{ text: 'Отменить', callback_data: 'wiz:cancel' }]],
  };
}

// ── Ограничения ─────────────────────────────────────────────────────────────
/** Проверка: можно ли создать свой стиль по текущему тарифу */
export function canCreateStyle(userId) {
  const limits = getLimits(userId);
  if (!limits.canCustomStyles) return false;
  return getCustomStyles(userId).length < limits.maxCustomStyles;
}

/** Причина отказа — для понятного сообщения */
export function styleLimitReason(userId) {
  const limits = getLimits(userId);
  if (!limits.canCustomStyles) {
    return `Свои стили по подписке или за ${REFERRALS_REQUIRED} друзей.`;
  }
  return `Лимит своих стилей на тарифе «${limits.name}»: ${limits.maxCustomStyles}.`;
}

// ── Роутинг кнопок ──────────────────────────────────────────────────────────
/**
 * Обработка нажатия кнопки.
 * @returns {{text, keyboard}|{action:'digest', hours:number}|null}
 */
export function handleCallback(userId, data, botUsername = '') {
  const parts = String(data || '').split(':');
  const [scope, action, arg] = parts;

  if (scope === 'menu') {
    switch (action) {
      case 'main':
        return mainScreen(userId, botUsername);
      case 'styles':
        return stylesScreen(userId);
      case 'style':
        return styleScreen(userId, arg);
      case 'digest':
        return digestScreen();
      case 'plans':
        return plansScreen(userId, botUsername);
      case 'invite':
        return inviteScreen(userId, botUsername);
      case 'setup':
        return setupScreen();
      default:
        return null;
    }
  }

  if (scope === 'set' && action === 'default') {
    setDefaultStyle(userId, arg);
    return styleScreen(userId, arg);
  }

  if (scope === 'digest') {
    return { action: 'digest', hours: Number(action) || 24 };
  }

  if (scope === 'wiz' && action === 'del') {
    const style = getCustomStyle(userId, arg);
    // Нельзя удалить стиль, который сейчас по умолчанию
    if (style && (getDefaultStyle(userId) || DEFAULT_STYLE_ID) === arg) {
      setDefaultStyle(userId, DEFAULT_STYLE_ID);
    }
    deleteCustomStyle(userId, arg);
    return stylesScreen(userId);
  }

  return null;
}