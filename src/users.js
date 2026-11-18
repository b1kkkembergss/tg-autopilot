// ── tg-autopilot / src/users.js ─────────────────────────────────────────────
// Реестр пользователей: план, пробный доступ, рефералы.
//
// Тарифы:
//   free  — встроенные стили, до 5 чатов, свои стили недоступны
//   trial — даётся за 3 приглашённых друзей: 1 свой стиль, 5 чатов, 5 дней
//   pro   — подписка: свои стили, все чаты
//   owner — владелец бота, без ограничений
//
// Файл: data/users.json
// {
//   "<userId>": {
//     "plan": "free",
//     "username": "nika",
//     "createdAt": "2026-11-17T12:00:00.000Z",
//     "connections": ["<business_connection_id>"],
//     "referredBy": 7166090548,
//     "referrals": { "count": 3, "invited": [111, 222, 333] },
//     "trial": { "grantedAt": "2026-11-17T12:00:00.000Z",
//                "expiresAt": "2026-11-22T12:00:00.000Z",
//                "maxChats": 5, "chats": [111, 222] }
//   }
// }
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const FILE = path.join(DATA_DIR, 'users.json');

/** Сколько друзей нужно пригласить для пробного доступа */
export const REFERRALS_REQUIRED = 1;
/** Параметры пробного доступа */
export const TRIAL_DAYS = 5;
export const TRIAL_MAX_CHATS = 5;
/** Лимит чатов на бесплатном тарифе */
export const FREE_MAX_CHATS = 5;
/** Сколько дней Pro даёт каждый приглашённый друг */
export const PRO_DAYS_PER_FRIEND = 3;

export const PLANS = {
  owner: {
    id: 'owner',
    name: 'Владелец',
    maxCustomStyles: 200,
    maxChats: Number.POSITIVE_INFINITY,
    canCustomStyles: true,
  },
  pro: {
    id: 'pro',
    name: 'Подписка',
    maxCustomStyles: 20,
    maxChats: Number.POSITIVE_INFINITY,
    canCustomStyles: true,
  },
  trial: {
    id: 'trial',
    name: 'Пробный доступ',
    maxCustomStyles: 1,
    maxChats: TRIAL_MAX_CHATS,
    canCustomStyles: true,
  },
  free: {
    id: 'free',
    name: 'Бесплатный',
    maxCustomStyles: 0,
    maxChats: FREE_MAX_CHATS,
    canCustomStyles: false,
  },
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = raw && typeof raw === 'object' ? raw : {};
  } catch {
    cache = {};
  }
  return cache;
}

function flush() {
  if (!cache) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cache, null, 2), 'utf8');
}

const blankUser = (plan = 'free', username = null) => ({
  plan,
  username,
  createdAt: new Date().toISOString(),
  connections: [],
  referredBy: null,
  referrals: { count: 0, invited: [] },
  trial: null,
  // Чаты, занимающие место в лимите тарифа
  usedChats: [],
});

/** Зарегистрировать пользователя (если новый) или обновить username */
export function ensureUser(userId, { username = null, plan = 'free' } = {}) {
  const users = load();
  const key = String(userId);
  if (!users[key]) {
    users[key] = blankUser(plan, username);
    flush();
    return users[key];
  }
  // Совместимость со старыми записями
  const u = users[key];
  if (!u.referrals) u.referrals = { count: 0, invited: [] };
  if (u.trial === undefined) u.trial = null;
  if (!Array.isArray(u.usedChats)) u.usedChats = [];
  if (username && u.username !== username) {
    u.username = username;
    flush();
  }
  return u;
}

export function getUser(userId) {
  return load()[String(userId)] || null;
}

export function saveUser(userId, patch) {
  ensureUser(userId);
  Object.assign(load()[String(userId)], patch);
  flush();
  return load()[String(userId)];
}

export function setUserPlan(userId, plan) {
  ensureUser(userId);
  load()[String(userId)].plan = PLANS[plan] ? plan : 'free';
  flush();
  return load()[String(userId)];
}

/** Запомнить business connection этого владельца */
export function rememberConnection(userId, connectionId) {
  const user = ensureUser(userId);
  if (!connectionId) return user;
  if (!user.connections.includes(connectionId)) {
    user.connections.push(connectionId);
    flush();
  }
  return user;
}

// ── Рефералы ────────────────────────────────────────────────────────────────
/**
 * Засчитать приглашённого друга.
 * @returns {{counted: boolean, reason?: string, trialGranted?: boolean}}
 */
export function addReferral(inviterId, invitedId) {
  const inviter = ensureUser(inviterId);
  const invited = ensureUser(invitedId);

  if (String(inviterId) === String(invitedId)) return { counted: false, reason: 'self' };
  if (invited.referredBy) return { counted: false, reason: 'already' };
  if (inviter.referrals.invited.includes(Number(invitedId)))
    return { counted: false, reason: 'dup' };

  invited.referredBy = Number(inviterId);
  inviter.referrals.count += 1;
  inviter.referrals.invited.push(Number(invitedId));

  let trialGranted = false;
  // Пробный доступ выдаём один раз — достаточно одного друга
  if (inviter.referrals.count >= REFERRALS_REQUIRED && !inviter.trial) {
    inviter.trial = grantTrial();
    trialGranted = true;
  }

  // Каждый приглашённый друг даёт пригласившему +3 дня Pro, срок суммируется
  activateSubscription(inviterId, PRO_DAYS_PER_FRIEND);
  const proUntil = load()[String(inviterId)].proExpiresAt;

  flush();
  return { counted: true, trialGranted, proUntil };
}

function grantTrial() {
  const now = Date.now();
  return {
    grantedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TRIAL_DAYS * 24 * 3600 * 1000).toISOString(),
    maxChats: TRIAL_MAX_CHATS,
    chats: [],
  };
}

/** Активен ли пробный доступ (не истёк) */
export function isTrialActive(userId) {
  const user = getUser(userId);
  if (!user?.trial?.expiresAt) return false;
  return new Date(user.trial.expiresAt).getTime() > Date.now();
}

/** Сколько дней пробного доступа осталось (0 если истёк) */
export function trialDaysLeft(userId) {
  const user = getUser(userId);
  if (!user?.trial?.expiresAt) return 0;
  const ms = new Date(user.trial.expiresAt).getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / (24 * 3600 * 1000)) : 0;
}

/** Действующий план: trial подменяет free, пока не истёк */
export function effectivePlan(userId) {
  const user = getUser(userId);
  const plan = user?.plan || 'free';
  if (plan === 'owner') return PLANS.owner;
  if (plan === 'pro') {
    // Подписка конечна: истекла — откат на бесплатный
    if (user.proExpiresAt && new Date(user.proExpiresAt).getTime() > Date.now()) {
      return PLANS.pro;
    }
    return PLANS.free;
  }
  if (isTrialActive(userId)) return PLANS.trial;
  return PLANS[plan] || PLANS.free;
}

/**
 * Включить подписку на days дней. Если она уже активна — срок продлевается
 * от текущей даты окончания, а не от сегодня.
 */
export function activateSubscription(userId, days) {
  const user = ensureUser(userId);
  const now = Date.now();
  const current = user.proExpiresAt ? new Date(user.proExpiresAt).getTime() : 0;
  const base = Math.max(now, current);
  user.plan = 'pro';
  user.proExpiresAt = new Date(base + days * 24 * 3600 * 1000).toISOString();
  flush();
  return user;
}

/** Сколько дней подписки осталось (0 — не активна) */
export function proDaysLeft(userId) {
  const user = getUser(userId);
  if (!user?.proExpiresAt) return 0;
  const ms = new Date(user.proExpiresAt).getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / (24 * 3600 * 1000)) : 0;
}

export function getLimits(userId) {
  return effectivePlan(userId);
}

/**
 * Может ли пользователь отвечать в этом чате с учётом лимита тарифа.
 * Первые N разных чатов занимают слоты, остальные блокируются до смены тарифа.
 * @returns {{allowed: boolean, used: number, limit: number}}
 */
export function registerChat(userId, chatId) {
  const plan = effectivePlan(userId);
  const limit = plan.maxChats;
  if (!Number.isFinite(limit)) return { allowed: true, used: 0, limit };

  const user = ensureUser(userId);
  const key = String(chatId);
  const used = user.usedChats || [];

  if (used.includes(key)) return { allowed: true, used: used.length, limit };
  if (used.length >= limit) return { allowed: false, used: used.length, limit };

  user.usedChats = [...used, key];
  flush();
  return { allowed: true, used: user.usedChats.length, limit };
}

export function listUsers() {
  return Object.entries(load()).map(([userId, v]) => ({ userId, ...v }));
}