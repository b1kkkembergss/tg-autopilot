// ── tg-autopilot / src/digest.js ────────────────────────────────────────────
// Сборка сводки по перепискам за период: берём историю владельца,
// оставляем сообщения за последние N часов и готовим текст для LLM.
// Готовую формулировку делает llm.summarizeDay().

import { listChats, getHistory } from './store.js';

const HOUR = 3600;

/**
 * Собирает расшифровки диалогов за период.
 * @param {string|number} userId
 * @param {number} hours — за сколько часов брать сообщения
 * @returns {{text: string, chats: number, messages: number}}
 */
export function buildDigest(userId, hours = 24) {
  const since = Math.floor(Date.now() / 1000) - hours * HOUR;
  const chats = listChats(userId);
  const parts = [];
  let messageCount = 0;

  for (const chat of chats) {
    // Берём с запасом: за период сообщений может быть мало,
    // но нужен контекст, чтобы понять, о чём вообще речь
    const history = getHistory(userId, chat.chatId, 400);
    const recent = history.filter((m) => (m.ts || 0) >= since);
    if (!recent.length) continue;

    const lines = recent.map(
      (m) => `${m.role === 'user' ? 'Собеседник' : 'Я'}: ${String(m.content).slice(0, 300)}`
    );
    parts.push(`--- ${chat.name} (${recent.length} сообщений) ---\n${lines.join('\n')}`);
    messageCount += recent.length;
  }

  return { text: parts.join('\n\n'), chats: parts.length, messages: messageCount };
}

/** Есть ли вообще активность за период */
export function hasActivity(userId, hours = 24) {
  return buildDigest(userId, hours).messages > 0;
}
