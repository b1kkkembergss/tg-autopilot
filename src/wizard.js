// ── tg-autopilot / src/wizard.js ────────────────────────────────────────────
// Мастер создания собственного стиля. Бот ведёт владельца по пунктам
// и собирает стиль из ответов. Стиль универсальный: подходит не только для
// знакомств, но и для продаж, поддержки, переговоров, дружеского общения.
//
// Готовый стиль сохраняется персонально у этого пользователя
// (data/users/<userId>/styles.json).
//
// Состояние мастера живёт в памяти процесса: если бот перезапустится
// посреди заполнения, владелец просто запустит мастер заново.

import { MAX_STYLE_NAME, MAX_STYLE_TEXT, validateCustomStyle } from './styles.js';

const wizards = new Map(); // userId -> {stepIndex, draft}

/** Пропустить шаг — ввести «-» */
const isSkip = (text) => /^(-|—|нет|пропустить|skip)$/i.test((text || '').trim());

/**
 * Шаги мастера. field — куда сложить значение в черновике стиля.
 * max — ограничение длины, чтобы промпт не разросся.
 */
const STEPS = [
  {
    field: 'name',
    title: 'Название',
    question:
      '<b>1/10 · Название стиля</b>\n\nКак ты будешь узнавать его в меню.\n\n' +
      'Например: «Знакомства», «Продажи», «Поддержка клиентов», «Дружеский».',
    max: MAX_STYLE_NAME,
  },
  {
    field: 'audience',
    title: 'С кем общение',
    question:
      '<b>2/10 · С кем общаешься</b>\n\nОпиши собеседника.\n\n' +
      'Например: «девушки с сайта знакомств», «клиенты по недвижимости», ' +
      '«покупатели в магазине», «друзья и знакомые».',
    max: 200,
  },
  {
    field: 'purpose',
    title: 'Цель',
    question:
      '<b>3/10 · Цель общения</b>\n\nЧего ты хочешь добиться в переписке.\n\n' +
      'Например: «познакомиться и встретиться», «довести до покупки», ' +
      '«решить проблему клиента», «просто поддержать общение».',
    max: 300,
  },
  {
    field: 'personaName',
    title: 'Имя',
    question: '<b>4/10 · Имя</b>, которым представляешься в этом стиле.\n\nЕсли не важно — отправь «-».',
    max: 40,
  },
  {
    field: 'personaOccupation',
    title: 'Чем занимаешься',
    question:
      '<b>5/10 · Чем занимаешься</b> — чтобы отвечать на вопросы о себе.\n\n' +
      'Например: «работаю в автосервисе, по вечерам играю на гитаре». Или «-».',
    max: 200,
  },
  {
    field: 'personaCity',
    title: 'Город',
    question: '<b>6/10 · Город</b>, если хочешь, чтобы он упоминался. Или «-».',
    max: 60,
  },
  {
    field: 'personaContext',
    title: 'Откуда знакомство',
    question:
      '<b>7/10 · Как вы познакомились</b> — контекст, откуда ты знаешь собеседника.\n\n' +
      'Например: «с сайта знакомств», «пришёл с заявки на сайте», «общий чат». Или «-».',
    max: 120,
  },
  {
    field: 'tone',
    title: 'Манера речи',
    question:
      '<b>8/10 · Манера общения</b> — опиши своими словами, как звучит речь.\n\n' +
      'Например: «коротко, с иронией, без лишних вопросов, пишу с большой буквы» ' +
      'или «вежливо и по делу, без воды».',
    max: MAX_STYLE_TEXT,
  },
  {
    field: 'rules',
    title: 'Запреты',
    question:
      '<b>9/10 · Чего не делать</b> — через запятую или каждый пункт с новой строки.\n\n' +
      'Например: «не флиртовать, не давить, не обещать сроков». Или «-».',
    max: MAX_STYLE_TEXT,
  },
  {
    field: 'goals',
    title: 'Как вести разговор',
    question:
      '<b>10/10 · Как вести разговор</b> — что делать по шагам.\n\n' +
      'Например: «узнать потребность, показать варианты, договориться о звонке» ' +
      'или «просто общаться, не сближаться». Или «-».',
    max: MAX_STYLE_TEXT,
  },
];

export const STEP_COUNT = STEPS.length;

export const isInWizard = (userId) => wizards.has(String(userId));

export function cancelWizard(userId) {
  return wizards.delete(String(userId));
}

/** Начать мастер. Возвращает первый вопрос. */
export function startWizard(userId) {
  wizards.set(String(userId), { stepIndex: 0, draft: { persona: {} } });
  return questionText(0);
}

const questionText = (index) => `${STEPS[index].question}\n\n<i>Отмена — /cancel</i>`;

/** Разбор списка: «a, b, c» или по строкам → ['a','b','c'] */
const toList = (text) =>
  String(text)
    .split(/[\n;]+|,(?![^(]*\))/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Принять ответ владельца.
 * @returns {{done: false, question: string} | {done: true, style: object}}
 */
export function acceptAnswer(userId, rawText) {
  const state = wizards.get(String(userId));
  if (!state) return { done: false, question: null };

  const step = STEPS[state.stepIndex];
  const text = String(rawText || '').trim().slice(0, step.max);
  const skip = isSkip(text);

  if (!skip && text) {
    if (step.field === 'personaName') state.draft.persona.name = text;
    else if (step.field === 'personaOccupation') state.draft.persona.occupation = text;
    else if (step.field === 'personaCity') state.draft.persona.city = text;
    else if (step.field === 'personaContext') state.draft.persona.context = text;
    else if (step.field === 'rules') state.draft.rules = toList(text);
    else if (step.field === 'goals') state.draft.goals = toList(text);
    else state.draft[step.field] = text;
  }

  state.stepIndex += 1;

  // Финальная проверка: без названия и манеры стиль не собрать
  if (state.stepIndex >= STEPS.length) {
    const style = finalize(state.draft);
    const errors = validateCustomStyle(style);
    if (errors.length) {
      const toneIndex = STEPS.findIndex((s) => s.field === 'tone');
      state.stepIndex = toneIndex;
      return {
        done: false,
        question: `Не получилось собрать стиль: ${errors.join(', ')}.\n\nОпиши манеру общения подробнее:`,
      };
    }
    wizards.delete(String(userId));
    return { done: true, style };
  }

  return { done: false, question: questionText(state.stepIndex) };
}

/** Собираем готовый объект стиля */
function finalize(draft) {
  const persona = {};
  for (const [k, v] of Object.entries(draft.persona || {})) {
    if (v && String(v).trim()) persona[k] = String(v).trim();
  }
  return {
    id: `custom_${Date.now().toString(36)}`,
    name: (draft.name || '').trim() || 'Мой стиль',
    description: buildDescription(draft, persona),
    builtin: false,
    audience: (draft.audience || '').trim(),
    purpose: (draft.purpose || '').trim(),
    persona,
    tone: (draft.tone || '').trim(),
    rules: draft.rules || [],
    goals: draft.goals || [],
    stageFlow: 'custom',
    createdAt: new Date().toISOString(),
  };
}

function buildDescription(draft, persona) {
  const bits = [];
  if (persona.name) bits.push(`от имени ${persona.name}`);
  if (draft.audience) bits.push(draft.audience);
  if (draft.purpose) bits.push(`цель: ${draft.purpose}`);
  const joined = bits.join(' · ');
  const tone = (draft.tone || '').trim();
  const short = tone.length > 70 ? `${tone.slice(0, 70)}…` : tone;
  return [joined, short].filter(Boolean).join('\n') || 'Свой стиль';
}
