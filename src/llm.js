// ── tg-autopilot / src/llm.js ────────────────────────────────────────────────
// Генерация ответа через OpenAI-совместимый API или Anthropic.
// Возвращает чистый текст ответа без пояснений.
import { config } from './config.js';
import { makeFetch } from './proxy.js';
import { humanize } from './text.js';
import { analyzeStage, looksLikeInvite } from './stage.js';
import { getStyle, styleBlocks, stylePersona, personaLine, DEFAULT_STYLE_ID } from './styles.js';

// LLM-запросы идут в обход VPN (LLM_PROXY пуст): балансировщик xray меняет
// выходной IP, и провайдер блокирует ключ за 4+ IP за 10 минут.
const fetchViaNet = makeFetch(config.llmProxyUrl);

/** Маркер «отвечать не нужно» — возвращается моделью, когда разговор закрыт */
export const NO_REPLY = '[NO_REPLY]';

const BASE_PROMPT = (style, persona) => {
  const who = personaLine(persona);
  const audience = style.audience ? `Ты переписываешься с: ${style.audience}.` : '';
  const context = persona.context ? `Контекст знакомства: ${persona.context}.` : '';
  const purpose = style.purpose ? `Цель переписки: ${style.purpose}.` : '';
  const facts = persona.facts ? `Дополнительно о тебе: ${persona.facts}.` : '';

  return `Ты ведёшь переписку в мессенджере от имени живого человека.${who ? ` ${who}.` : ''}
${audience}
${context}
${purpose}
${facts}

МАНЕРА РЕЧИ (главное — держись её):
${style.tone}

${styleBlocks(style)}

Общие правила:
- Отвечай ТОЛЬКО текстом сообщения, которое ты отправишь. Без кавычек, без префиксов, без пояснений.
- Держи сообщения короткими: 1-3 предложения, как в живом мессенджере.
- НИКОГДА не используй длинное тире (—) и среднее тире (–). Вместо тире ставь запятую, точку или обычный дефис.
- Не используй книжные обороты и штампы вроде «стоит отметить», «важно понимать», «таким образом».
- Реагируй на то, что пишет собеседник. Подхватывай детали и возвращайся к ним позже.
- Никакой пошлости, давления или навязчивости.
- Не признавайся, что ты ИИ или автопилот, не упоминай нейросети.
- Не проси деньги, не переходи на внешние ссылки.
- Не придумывай факты о себе сверх того, что задано выше. Если чего-то не знаешь — уходи от ответа легко, без вранья в деталях.
- Не комментируй количество сообщений собеседника, повторы приветствий и «ты уже второй раз пишешь». В истории могут быть дубли из-за технических накладок: не обращай на них внимания и продолжай разговор по смыслу последнего сообщения.`;
};

// Поведение по мере сближения зависит от стиля:
//   warm   — постепенное развитие, встреча в конце
//   cold   — дистанция, без сближения
//   custom — ориентируемся только на цели, заданные в стиле
const STAGE_PROMPT = (info, style) => {
  if (style.stageFlow === 'cold') {
    return `Держи сухой отстранённый тон. Не выпытывай, не заискивай, не проявляй инициативу больше необходимого.
Не стремись к встрече: если собеседница сама предложит, отвечай уклончиво и без энтузиазма.`;
  }

  if (style.stageFlow === 'custom') {
    return `Веди разговор так, как описано в целях выше. Не форсируй сближение и не предлагай встречу, если это не следует из целей стиля.`;
  }

  switch (info.stage) {
    case 1:
      return `Вы только начали общаться. Задача: заинтересовать её собой и узнать её.
Сейчас категорически нельзя:
- предлагать встречу, свидание, кофе, «увидеться» любым способом;
- спрашивать про её город, район, адрес, свободное время, график;
- говорить «давай сходим», «скину место», «во сколько».
Просто общайся: задавай вопросы о ней, шути, рассказывай короткие истории о себе. Встреча захочет она сама, но не сегодня.`;

    case 2:
      return `Вы уже немного раззнакомились. Продолжай узнавать её по-настоящему: чем живёт, что цепляет, о чём мечтает, что бесит на работе. Делись своим: короткие истории, мнения.
Сейчас всё ещё нельзя:
- предлагать встречу, свидание, «увидеться», кофе, погулять;
- спрашивать про свободное время и график.
Задача: стать для неё интересным собеседником, а не организатором досуга.`;

    case 3:
      return `Вы уже нормально общаетесь, есть взаимный интерес. Создавай близость: лёгкие личные темы, общие шутки, ощущение, что вы давно знакомы.
Встречу пока НЕ предлагай прямо. Максимум очень лёгкий намёк вскользь, без дня, времени и места.`;

    default:
      return `Контакт есть: она сама пишет, отвечает развёрнуто, спрашивает о тебе. Теперь можно аккуратно упомянуть встречу, но только как случайную мысль, а не как предложение с датой.
Не назначай день, время и место в лоб. Пусть это будет её идея или общая.`;
  }
};

const CLOSING_RULES = (NO_REPLY) => `КОГДА НЕ ОТВЕЧАТЬ:
Если разговор естественно закрыт — она попрощалась, ушла по делам, или её последнее сообщение это просто подтверждение («на связи», «ок», «ага», «понял», «договорились», «побежала», «до вечера», «👍») — верни РОВНО строку ${NO_REPLY} и ничего больше.
Молчание в конце разговора выглядит живым. Навязчивое «ну что там?» после прощания убивает интерес.`;

const SYSTEM_PROMPT = (info, style, persona) =>
  `${BASE_PROMPT(style, persona)}${STAGE_PROMPT(info, style)}

${CLOSING_RULES(NO_REPLY)}`;

// Запрос к LLM с автоповтором: 5xx и 429 у провайдеров случаются часто
// (наблюдали 502 upstream_unavailable), а пустой content — у reasoning-моделей,
// когда бюджет токенов ушёл в размышления. 4xx кроме 429 не повторяем.
// tokenlavka на 502 сама просит подождать 30-60 сек — паузы соответствующие.
const RETRY_ATTEMPTS = 4;
const RETRY_DELAYS = [5000, 12000, 25000]; // для 5xx
const RETRY_DELAYS_429 = [4000, 9000, 18000]; // для rate limit

// Последовательная очередь: провайдеры ограничивают параллельные запросы (429),
// а бот может отвечать сразу в несколько чатов. Запросы идут по одному.
let llmChain = Promise.resolve();
function enqueue(fn) {
  const run = llmChain.then(fn, fn); // цепочка продолжается даже после ошибки
  llmChain = run.catch(() => {});
  return run;
}

async function fetchWithRetry(url, options, label) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetchViaNet(url, options);
      const text = await res.text();
      if (res.ok) return JSON.parse(text);

      const err = new Error(`${label} ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      if (res.status < 500 && res.status !== 429) throw err;
      lastErr = err;
    } catch (err) {
      if (err.status && err.status < 500 && err.status !== 429) throw err;
      lastErr = err;
    }
    if (attempt < RETRY_ATTEMPTS) {
      const delays = lastErr.status === 429 ? RETRY_DELAYS_429 : RETRY_DELAYS;
      const wait = delays[Math.min(attempt - 1, delays.length - 1)];
      console.warn(`LLM: попытка ${attempt} не удалась (${lastErr.message.slice(0, 70)}), повтор через ${Math.round(wait/1000)} с`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function callOpenAI(messages) {
  const data = await fetchWithRetry(
    `${config.llmBaseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify({
        model: config.llmModel,
        messages,
        max_tokens: config.llmMaxTokens,
        temperature: 0.9,
      }),
    },
    'LLM API'
  );
  if (data.error) throw new Error(`LLM API: ${JSON.stringify(data.error).slice(0, 200)}`);
  return (data.choices?.[0]?.message?.content || '').trim();
}

async function callAnthropic(messages) {
  const system = messages.find((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  const data = await fetchWithRetry(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.llmApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.llmModel,
        system: system ? system.content : undefined,
        messages: rest,
        max_tokens: config.llmMaxTokens,
      }),
    },
    'Anthropic API'
  );
  return (data.content?.[0]?.text || '').trim();
}

/**
 * @param {Array<{role:'user'|'assistant', content:string}>} history — диалог
 * (собеседница = user, твой аккаунт = assistant)
 * @param {object} [style] — объект стиля (встроенный или созданный пользователем).
 *   Если не задан, используется стиль по умолчанию.
 */
export async function generateReply(history, style) {
  const activeStyle = style || getStyle(DEFAULT_STYLE_ID);
  // Персона: своя у стиля, иначе из .env (PERSONA_*)
  const persona = stylePersona(activeStyle, {
    name: config.personaName,
    age: config.personaAge,
    city: config.personaCity,
    context: config.personaContext,
    occupation: config.personaOccupation,
    facts: config.personaFacts,
  });
  const info = analyzeStage(history);
  const buildMessages = () => [
    { role: 'system', content: SYSTEM_PROMPT(info, activeStyle, persona) },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];
  const call = config.llmProvider === 'anthropic' ? callAnthropic : callOpenAI;

  console.log(
    `стиль «${activeStyle.name}» | стадия ${info.stage} (её сообщений: ${info.herSubstantive}, инициатив: ${info.herInitiated})`
  );

  return enqueue(async () => {
    let text = await call(buildMessages());
    if (!text) {
      console.warn('LLM вернул пустой ответ — повтор с увеличенным лимитом токенов');
      const saved = config.llmMaxTokens;
      config.llmMaxTokens = saved * 2;
      try {
        text = await call(buildMessages());
      } finally {
        config.llmMaxTokens = saved;
      }
    }
    if (!text) throw new Error('LLM вернул пустой ответ');
    // Модель решила, что разговор закрыт — сигналим вызывающему не отправлять
    if (text.includes(NO_REPLY)) return NO_REPLY;

    // Страховка: на ранних стадиях модель иногда всё равно зовёт на встречу.
    // Перегенерируем с жёстким запретом.
    if (isInviteForbidden(info, activeStyle) && looksLikeInvite(text)) {
      console.warn(`стиль «${activeStyle.name}», стадия ${info.stage}: ответ похож на приглашение — перегенерация`);
      const strict = [
        {
          role: 'system',
          content:
            SYSTEM_PROMPT(info, activeStyle, persona) +
            '\n\nВНИМАНИЕ: твой прошлый ответ содержал приглашение на встречу, это запрещено. Ответь заново без единого упоминания встречи, свидания, кофе, места, времени и её свободного времени.',
        },
        ...history.map((m) => ({ role: m.role, content: m.content })),
      ];
      const retry = await call(strict);
      if (retry && !retry.includes(NO_REPLY) && !looksLikeInvite(retry)) {
        text = retry;
      } else {
        console.warn('перегенерация не помогла — отправляю исходный вариант');
      }
    }

    // Убираем длинные тире: главный признак текста от нейросети
    return humanize(text);
  });
}

/** Запрещено ли приглашение на встречу для этого стиля и стадии */
function isInviteForbidden(info, style) {
  if (style.stageFlow === 'cold') return true; // холодному стилю приглашения не свойственны
  if (style.stageFlow === 'custom') return true; // свои стили ведут разговор по своим целям
  return info.stage < 4;
}

// ── Сводка по перепискам ────────────────────────────────────────────────────
const DIGEST_PROMPT = `Ты делаешь сводку по перепискам за день для владельца аккаунта.

На вход подаются расшифровки диалогов. Верни короткую сводку на русском в таком виде:

<b>За день</b>
• <b>Имя</b>: о чём говорили, чем закончилось, что нужно сделать (если нужно)

Требования:
- Один пункт на диалог, максимум 2 строки.
- Пиши только то, что реально есть в переписке. Не выдумывай.
- Если есть незакрытое действие (договорились о встрече, обещал написать, клиент ждёт ответа) — выдели это.
- Если диалог ни о чём — так и напиши: «без конкретики».
- Не пересказывай каждое сообщение, выделяй суть.
- Никаких длинных тире, пиши обычными дефисами или запятыми.
- Разметка: только <b> для имён, • для пунктов.`;

/**
 * Сводка по перепискам: принимает уже подготовленный текст диалогов.
 * @param {string} dialoguesText
 * @returns {Promise<string>}
 */
export async function summarizeDay(dialoguesText) {
  const call = config.llmProvider === 'anthropic' ? callAnthropic : callOpenAI;
  const messages = [
    { role: 'system', content: DIGEST_PROMPT },
    { role: 'user', content: dialoguesText },
  ];
  return enqueue(async () => {
    let text = await call(messages);
    if (!text) {
      const saved = config.llmMaxTokens;
      config.llmMaxTokens = saved * 2;
      try {
        text = await call(messages);
      } finally {
        config.llmMaxTokens = saved;
      }
    }
    if (!text) throw new Error('LLM вернул пустую сводку');
    return humanize(text);
  });
}
