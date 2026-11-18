// ── tg-autopilot / src/stage.js ─────────────────────────────────────────────
// Определяет стадию отношений по истории диалога.
// Нужно, чтобы промпт не содержал приглашений на встречу, пока контакт не налажен:
// модель цепляется за слова из системного промпта, поэтому на ранней стадии
// блока про встречу в промпте быть не должно вообще.

const SUBSTANTIVE_LEN = 20; // короче — считаем репликой-поддакиванием

// ВАЖНО: в JS `\b` работает только по латинице/цифрам и НЕ видит границы
// кириллических слов. Поэтому здесь вместо \b — явные lookaround-проверки
// на кириллицу либо просто подстроки без границ.

/** Признаки того, что ответ — приглашение на встречу */
const DATE_PATTERNS = [
  /(встретимся|увидимся|встреча|свидание|свиданка)/i,
  /давай\s+(сходим|пойдём|пойдем|пересечёмся|пересечемся)/i,
  /скину\s+(точку|место|адрес|локацию)/i,
  /(завтра|послезавтра|в\s+пятницу|в\s+субботу|в\s+воскресенье)\s+(в|после|около)\s+\d/i,
  /(во\s+сколько|в\s+какое\s+время)/i,
  /(кофейн|кофе\s+вживую|погуляем)/i,
  /(подъезжай|подходи|жду\s+тебя)/i,
  /(твоя\s+территория|на\s+твоей\s+территории)/i,
];

/** Она спрашивает о нём */
const ASKS_ABOUT_ME = /(а\s+ты|у\s+тебя|твой|твоя|твоё|твое|ты\s+сам|ты\s+как|о\s+тебе)/i;

/**
 * Анализирует историю диалога и возвращает стадию.
 *
 * @param {Array<{role:'user'|'assistant', content:string}>} history
 * @returns {{stage: 1|2|3|4, herSubstantive: number, herQuestions: number,
 *            asksAboutMe: number, herInitiated: number}}
 *   stage 1 — знакомство, 2 — узнавание, 3 — близость, 4 — можно намекнуть на встречу
 */
export function analyzeStage(history) {
  const her = history.filter((m) => m.role === 'user');

  const herSubstantive = her.filter(
    (m) => (m.content || '').trim().length >= SUBSTANTIVE_LEN
  ).length;

  const herQuestions = her.filter((m) => /\?/.test(m.content || '')).length;

  // Спрашивала ли она о нём: «а ты», «у тебя», «твой», «ты сам»
  const asksAboutMe = her.filter((m) => ASKS_ABOUT_ME.test(m.content || '')).length;

  // Инициатива: сколько раз она писала после нашего сообщения (начинала новую реплику)
  let herInitiated = 0;
  for (let i = 1; i < history.length; i++) {
    if (history[i].role === 'user' && history[i - 1].role === 'assistant') {
      herInitiated++;
    }
  }

  let stage = 1;
  if (herSubstantive >= 25 && herInitiated >= 8 && asksAboutMe >= 3) stage = 4;
  else if (herSubstantive >= 14 && herInitiated >= 4) stage = 3;
  else if (herSubstantive >= 5) stage = 2;

  return { stage, herSubstantive, herQuestions, asksAboutMe, herInitiated };
}

/** Похоже ли, что текст — приглашение на встречу */
export function looksLikeInvite(text) {
  const t = text || '';
  return DATE_PATTERNS.some((re) => re.test(t));
}
