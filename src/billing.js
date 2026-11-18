// ── tg-autopilot / src/billing.js ───────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';

const PAYMENTS_FILE = path.resolve('data', 'payments.json');

/** Записать успешный платёж; Telegram charge id обеспечивает дедупликацию */
export function recordPayment({ userId, tariffId, stars, telegramChargeId, providerChargeId }) {
  fs.mkdirSync(path.dirname(PAYMENTS_FILE), { recursive: true });
  let payments = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(PAYMENTS_FILE, 'utf8'));
    if (Array.isArray(parsed)) payments = parsed;
  } catch {}

  if (payments.some((p) => p.telegramChargeId === telegramChargeId)) {
    return { recorded: false, reason: 'duplicate' };
  }

  const payment = {
    userId: String(userId),
    tariffId,
    stars: Number(stars) || 0,
    telegramChargeId,
    providerChargeId: providerChargeId || '',
    createdAt: new Date().toISOString(),
  };
  payments.push(payment);
  fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(payments, null, 2), 'utf8');
  return { recorded: true, payment };
}

export function getPaymentLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PAYMENTS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Агрегаты для админ-панели. since — timestamp ms; null означает всё время. */
export function paymentStats(since = null) {
  const payments = getPaymentLedger().filter(
    (p) => !since || new Date(p.createdAt).getTime() >= since
  );
  return {
    count: payments.length,
    stars: payments.reduce((sum, p) => sum + (Number(p.stars) || 0), 0),
    byTariff: payments.reduce((acc, p) => {
      acc[p.tariffId] = (acc[p.tariffId] || 0) + 1;
      return acc;
    }, {}),
    payments,
  };
}

// Тарифная сетка и цены в Telegram Stars.
// stars — сумма в звёздах (платёж проходит прямо в Telegram, без внешних
// сервисов), days — на сколько дней включается подписка.
//
// Способы оплаты: звёзды с баланса, покупка звёзд по ссылке, через админа.

export const ADMIN_LINK = 'https://t.me/Richhantr';
export const BUY_STARS_LINK =
  'https://t.me/need/vpn?startapp=stars--KAMAPULYAezzhi';

export const TARIFFS = {
  week: {
    id: 'week',
    label: 'Неделя',
    days: 7,
    stars: 149,
    perks: 'свой стиль и все чаты на неделю',
  },
  month: {
    id: 'month',
    label: 'Месяц',
    days: 30,
    stars: 490,
    perks: 'свой стиль и все чаты на месяц',
    best: true,
  },
  q3: {
    id: 'q3',
    label: '3 месяца',
    days: 90,
    stars: 1290,
    perks: 'то же на 3 месяца, выгоднее помесячной',
  },
  year: {
    id: 'year',
    label: 'Год',
    days: 365,
    stars: 4400,
    perks: 'максимальная выгода — примерно 367₽ в месяц',
  },
};

export const tariffList = () => Object.values(TARIFFS);

export const getTariff = (id) => TARIFFS[id] || null;

/** Человекочитаемый период: «7 дней», «месяц», «год» */
export function periodText(days) {
  if (days === 7) return '7 дней';
  if (days === 30) return 'месяц';
  if (days === 90) return '3 месяца';
  if (days === 365) return 'год';
  return `${days} дней`;
}

/** Дата окончания подписки: прибавляем days к текущей (или к действующей) */
export function expiryFrom(nowIso, days) {
  const base = nowIso ? new Date(nowIso).getTime() : Date.now();
  const from = Math.max(base, Date.now());
  return new Date(from + days * 24 * 3600 * 1000).toISOString();
}
