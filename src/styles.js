// ── tg-autopilot / src/styles.js ────────────────────────────────────────────
// Стили общения. Встроенные — чистые шаблоны манеры, без личных данных:
// ни имени, ни города, ни упоминания сайта знакомств. Всё личное задаётся
// либо в .env (PERSONA_*), либо в собственном стиле через мастер в боте.
//
// Схема стиля:
// {
//   id, name, description,
//   builtin: boolean,
//   persona: { name, age, city, context, occupation, facts },  // любое поле опционально
//   tone:    "как звучит речь"                                  // обязательно
//   rules:   ["чего не делать", ...]
//   goals:   ["к чему вести разговор", ...]
//   stageFlow: 'warm' | 'cold' | 'none'   // как вести себя по мере сближения
//   createdAt: ISO-строка (для своих стилей)
// }

export const BUILTIN_STYLES = {
  warm: {
    id: 'warm',
    name: 'Тёплый',
    description: 'Живой и дружелюбный: юмор, интерес к собеседнику, поддержание разговора.',
    builtin: true,
    audience: '',
    purpose: '',
    persona: {},
    tone:
      'уверенный, с юмором, слегка дерзкий; пишу коротко, 1-3 предложения; ' +
      'пишу с маленькой буквы; подкалываю по-доброму, без пошлости; ' +
      'задаю вопросы и запоминаю детали, чтобы возвращаться к ним позже',
    rules: [
      'Держи тёплый живой тон, подкалывай по-доброму, но без пошлости.',
      'Проявляй интерес: спрашивай, запоминай детали, возвращайся к ним.',
    ],
    goals: [
      'Заинтересовать собеседника собой и узнать его по-настоящему.',
      'Вести разговор к личной встрече, когда появится взаимный интерес.',
    ],
    stageFlow: 'warm',
  },

  cold: {
    id: 'cold',
    name: 'Холодный',
    description: 'Другой человек: вежливый, но отстранённый. Цинизм, грамотная речь, без лишних вопросов.',
    builtin: true,
    audience: '',
    purpose: '',
    persona: {},
    tone:
      'холодный и отстранённый; вежливо, но без тепла; речь грамотная и правильная, ' +
      'без сленга, без уменьшительных слов, без эмодзи; фразы короткие и сухие; ' +
      'пишу с заглавной буквы и с нормальной пунктуацией',
    rules: [
      'Тон ровный и отстранённый, будто тебе в целом всё равно.',
      'Цинизм выражай суждениями и иронией, а не грубостью. Не хами и не оскорбляй.',
      'НЕ флиртуй, не шути игриво, не делай комплиментов.',
      'НЕ задавай больше одного вопроса за сообщение. Можно не задавать вовсе.',
      'НЕ показывай заинтересованности больше, чем нужно для поддержания разговора.',
    ],
    goals: [
      'Поддерживать разговор вежливо и холодно, не раскрываясь.',
      'Не сближаться: на предложения о встрече отвечать уклончиво.',
    ],
    stageFlow: 'cold',
  },
};

export const DEFAULT_STYLE_ID = 'warm';

/** Стиль по id: сначала встроенные, потом свои */
export function getStyle(id, customStyles = []) {
  if (id && BUILTIN_STYLES[id]) return BUILTIN_STYLES[id];
  const custom = customStyles.find((s) => s.id === id);
  if (custom) return custom;
  return BUILTIN_STYLES[DEFAULT_STYLE_ID];
}

/** Список для меню: встроенные + свои */
export function styleList(customStyles = []) {
  const builtin = Object.values(BUILTIN_STYLES).map(({ id, name, description, builtin: b }) => ({
    id,
    name,
    description,
    builtin: b,
  }));
  const custom = customStyles.map(({ id, name, description }) => ({
    id,
    name,
    description,
    builtin: false,
  }));
  return [...builtin, ...custom];
}

/** Текст правил и целей стиля — блоком в промпт */
export function styleBlocks(style) {
  const rules = (style.rules || []).map((r) => `- ${r}`).join('\n');
  const goals = (style.goals || []).map((g) => `- ${g}`).join('\n');
  const parts = [];
  if (rules) parts.push(`ЧЕГО ДЕЛАТЬ НЕЛЬЗЯ / КАК ДЕРЖАТЬСЯ:\n${rules}`);
  if (goals) parts.push(`К ЧЕМУ ВЕСТИ РАЗГОВОР:\n${goals}`);
  return parts.join('\n\n');
}

/** Персона стиля: его собственные данные или данные из .env */
export function stylePersona(style, env) {
  const p = style.persona || {};
  const pick = (a, b) => (a && String(a).trim() ? a : b);
  return {
    name: pick(p.name, env.name),
    age: pick(p.age, env.age),
    city: pick(p.city, env.city),
    context: pick(p.context, env.context),
    occupation: pick(p.occupation, env.occupation),
    facts: pick(p.facts, env.facts),
  };
}

/** Строка персоны для промпта. Пустые поля просто не упоминаются. */
export function personaLine(persona) {
  const bits = [];
  if (persona.name) bits.push(`${persona.name}`);
  if (persona.age) bits.push(`${persona.age} лет`);
  if (persona.occupation) bits.push(persona.occupation);
  if (persona.city) bits.push(`живёт в ${persona.city}`);
  return bits.join(', ');
}

/** Проверка стиля, созданного пользователем */
export function validateCustomStyle(style) {
  const errors = [];
  if (!style || typeof style !== 'object') return ['пустой стиль'];
  if (!style.name || !String(style.name).trim()) errors.push('не задано название');
  if (!style.tone || String(style.tone).trim().length < 10) errors.push('слишком короткое описание манеры');
  return errors;
}

export const MAX_STYLE_NAME = 40;
export const MAX_STYLE_TEXT = 600;
