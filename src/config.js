// ── tg-autopilot / src/config.js ────────────────────────────────────────────
import 'dotenv/config';

const num = (v, def) => (v === undefined || v === '' ? def : Number(v));
const list = (v) =>
  (v || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

// Приоритет: TG_PROXY из .env → системный HTTPS_PROXY → без прокси.
// Схемы socks/socks5/socks5h не поддерживаются (CONNECT-туннель умеет http) — отбрасываем.
const pickProxy = () => {
  const fromEnv = process.env.TG_PROXY || '';
  const fromSystem = process.env.HTTPS_PROXY || '';
  const chosen = fromEnv || fromSystem;
  if (/^socks/i.test(chosen)) return '';
  return chosen;
};

export const config = {
  botToken: process.env.BOT_TOKEN,
  proxyUrl: pickProxy(),

  // LLM ходит напрямую (пусто), если не задан LLM_PROXY.
  // Через VPN нельзя: балансировщик меняет выходной IP, а провайдер блокирует
  // ключ при использовании с 4+ IP за 10 минут (429).
  llmProxyUrl: process.env.LLM_PROXY || '',
  llmProvider: (process.env.LLM_PROVIDER || 'openai').toLowerCase(),
  llmBaseUrl: (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  llmApiKey: process.env.LLM_API_KEY,
  llmModel: process.env.LLM_MODEL,
  // reasoning-модели тратят токены на размышления: нужен запас, иначе content пустой
  llmMaxTokens: num(process.env.LLM_MAX_TOKENS, 1600),

  replyDelayMin: num(process.env.REPLY_DELAY_MIN, 20),
  replyDelayMax: num(process.env.REPLY_DELAY_MAX, 90),
  historyLimit: num(process.env.HISTORY_LIMIT, 40),

  // Персона по умолчанию. Используется, если у стиля не заданы свои данные.
  // Пустые поля не упоминаются в промпте: ничего не вшито жёстко.
  personaName: process.env.PERSONA_NAME || '',
  personaAge: process.env.PERSONA_AGE || '',
  personaCity: process.env.PERSONA_CITY || '',
  personaContext: process.env.PERSONA_CONTEXT || '',
  personaOccupation: process.env.PERSONA_OCCUPATION || '',
  personaFacts: process.env.PERSONA_FACTS || '',
  personaStyle: process.env.PERSONA_STYLE || '',
  personaStyle:
    process.env.PERSONA_STYLE || 'дружелюбный, лёгкий флирт, коротко',
  firstMessage: process.env.FIRST_MESSAGE || '',

  targetUsers: list(process.env.TARGET_USERS), // пусто = все разрешённые
  excludeUsers: list(process.env.EXCLUDE_USERS),

  // Промо-ролики: папка с MP4 и метаданными для команды /promo
  promoDir: process.env.PROMO_DIR || '',
  promoMeta: process.env.PROMO_META || '',
};

export function validateConfig() {
  const errors = [];
  if (!config.botToken) errors.push('BOT_TOKEN не задан (создай бота в @BotFather)');
  if (!config.llmApiKey) errors.push('LLM_API_KEY не задан');
  if (!config.llmModel) errors.push('LLM_MODEL не задан');
  if (config.replyDelayMin < 5) errors.push('REPLY_DELAY_MIN < 5 — слишком быстро');
  if (config.replyDelayMax < config.replyDelayMin) errors.push('REPLY_DELAY_MAX меньше REPLY_DELAY_MIN');
  if (errors.length) {
    console.error('Ошибки конфигурации:\n  - ' + errors.join('\n  - '));
    console.error('\nСкопируй .env.example в .env и заполни.');
    process.exit(1);
  }
}
