// ── tg-autopilot / src/store.js ─────────────────────────────────────────────
// Персональные данные каждого владельца аккаунта.
// Всё разделено по userId — стили, история и настройки одного пользователя
// не видны другому. Это база для продажи подписки.
//
// Структура файлов:
//   data/users/<userId>/dialogs.json  — история: {"<chatId>":[{role,content,ts}]}
//   data/users/<userId>/settings.json — {"defaultStyle":"warm","chats":{...}}
//   data/users/<userId>/styles.json   — собственные стили: {"<styleId>":{...}}
//
// ts — unix-секунды. Запись буферизуется (debounce), чтобы не дёргать диск.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('data');
const USERS_DIR = path.join(ROOT, 'users');
const LEGACY_DIALOGS = path.join(ROOT, 'dialogs.json'); // формат до per-user

// userId нормализуем в строку: кэши и таймеры записи должны иметь один тип
// ключа, иначе flush не находит данные (число vs строка) и файлы не сохраняются
const uid = (userId) => String(userId);
const key = (chatId) => String(chatId);

const userDir = (userId) => path.join(USERS_DIR, uid(userId));
const dialogsFile = (userId) => path.join(userDir(userId), 'dialogs.json');
const settingsFile = (userId) => path.join(userDir(userId), 'settings.json');
const stylesFile = (userId) => path.join(userDir(userId), 'styles.json');

const readJson = (file, fallback) => {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
};

// ── Кэши в памяти: userId (строка) -> данные ────────────────────────────────
const dialogsCache = new Map();
const settingsCache = new Map();
const stylesCache = new Map();
const saveTimers = new Map();

/** Запись отложенная: несколько сообщений подряд — одно обращение к диску */
function scheduleSave(userId, kind) {
  const k = `${uid(userId)}:${kind}`;
  if (saveTimers.has(k)) return;
  saveTimers.set(
    k,
    setTimeout(() => {
      saveTimers.delete(k);
      try {
        flush(userId, kind);
      } catch (err) {
        console.error('Не удалось сохранить данные:', err.message);
      }
    }, 2000)
  );
}

function flush(userId, kind) {
  const k = uid(userId);
  if (kind === 'dialogs' && dialogsCache.has(k)) {
    writeJson(dialogsFile(k), dialogsCache.get(k));
  }
  if (kind === 'settings' && settingsCache.has(k)) {
    writeJson(settingsFile(k), settingsCache.get(k));
  }
  if (kind === 'styles' && stylesCache.has(k)) {
    writeJson(stylesFile(k), stylesCache.get(k));
  }
}

/** Записать всё накопленное немедленно (при выходе, в тестах) */
export function flushAll() {
  for (const [k, timer] of [...saveTimers]) {
    clearTimeout(timer);
    saveTimers.delete(k);
    const [userId, kind] = k.split(':');
    try {
      flush(userId, kind);
    } catch {}
  }
}

process.on('SIGINT', () => {
  flushAll();
  process.exit(0);
});

/**
 * Перенос данных старого формата (общий data/dialogs.json) в папку владельца.
 * Вызывается один раз при старте, когда владелец уже известен.
 */
export function migrateLegacy(userId) {
  const target = dialogsFile(userId);
  if (fs.existsSync(target)) return false;
  if (!fs.existsSync(LEGACY_DIALOGS)) return false;

  const legacy = readJson(LEGACY_DIALOGS, null);
  if (!legacy) return false;

  writeJson(target, legacy);
  console.log(
    `миграция: ${Object.keys(legacy).length} диалогов перенесено в data/users/${uid(userId)}/`
  );
  // Старый файл оставляем как резервную копию
  fs.renameSync(LEGACY_DIALOGS, `${LEGACY_DIALOGS}.migrated`);
  return true;
}

// ── История диалогов ────────────────────────────────────────────────────────
function loadDialogs(userId) {
  const k = uid(userId);
  if (dialogsCache.has(k)) return dialogsCache.get(k);
  const data = readJson(dialogsFile(k), {});
  dialogsCache.set(k, data);
  return data;
}

export function getDialog(userId, chatId) {
  const dialogs = loadDialogs(userId);
  const ck = key(chatId);
  if (!dialogs[ck]) dialogs[ck] = [];
  return dialogs[ck];
}

export function pushMessage(userId, chatId, role, content) {
  const dialog = getDialog(userId, chatId);
  dialog.push({ role, content, ts: Math.floor(Date.now() / 1000) });
  scheduleSave(userId, 'dialogs');
}

export function getHistory(userId, chatId, limit) {
  return getDialog(userId, chatId).slice(-limit);
}

// ── Настройки: стиль по умолчанию и стиль конкретного чата ──────────────────
function loadSettings(userId) {
  const k = uid(userId);
  if (settingsCache.has(k)) return settingsCache.get(k);
  const raw = readJson(settingsFile(k), {});
  const data = {
    defaultStyle: raw.defaultStyle || null,
    chats: raw.chats && typeof raw.chats === 'object' ? raw.chats : {},
  };
  settingsCache.set(k, data);
  return data;
}

export function getChatStyle(userId, chatId) {
  return loadSettings(userId).chats[key(chatId)]?.style || null;
}

export function setChatStyle(userId, chatId, styleId) {
  const s = loadSettings(userId);
  const ck = key(chatId);
  s.chats[ck] = { ...(s.chats[ck] || {}), style: styleId };
  scheduleSave(userId, 'settings');
}

/** Запомнить имя собеседницы — может пригодиться в статистике */
export function rememberChat(userId, chatId, name) {
  const s = loadSettings(userId);
  const ck = key(chatId);
  if (!name || s.chats[ck]?.name === name) return;
  s.chats[ck] = { ...(s.chats[ck] || {}), name };
  scheduleSave(userId, 'settings');
}

export function getDefaultStyle(userId) {
  return loadSettings(userId).defaultStyle;
}

export function setDefaultStyle(userId, styleId) {
  loadSettings(userId).defaultStyle = styleId;
  scheduleSave(userId, 'settings');
}

/** Известные чаты владельца (для статистики и будущих лимитов) */
export function listChats(userId) {
  const s = loadSettings(userId);
  const dialogs = loadDialogs(userId);
  const ids = new Set([...Object.keys(s.chats), ...Object.keys(dialogs)]);
  return [...ids].map((chatId) => ({
    chatId,
    name: s.chats[chatId]?.name || chatId,
    style: s.chats[chatId]?.style || null,
    messages: (dialogs[chatId] || []).length,
  }));
}

// ── Собственные стили пользователя ──────────────────────────────────────────
function loadCustomStyles(userId) {
  const k = uid(userId);
  if (stylesCache.has(k)) return stylesCache.get(k);
  const data = readJson(stylesFile(k), {});
  stylesCache.set(k, data);
  return data;
}

/** Все свои стили владельца */
export function getCustomStyles(userId) {
  return Object.values(loadCustomStyles(userId));
}

export function getCustomStyle(userId, styleId) {
  return loadCustomStyles(userId)[styleId] || null;
}

export function saveCustomStyle(userId, style) {
  const styles = loadCustomStyles(userId);
  styles[style.id] = style;
  scheduleSave(userId, 'styles');
}

export function deleteCustomStyle(userId, styleId) {
  const styles = loadCustomStyles(userId);
  if (!styles[styleId]) return false;
  delete styles[styleId];
  scheduleSave(userId, 'styles');
  return true;
}

/** Стиль, действующий для конкретного чата: свой для чата → стиль по умолчанию */
export function resolveStyleId(userId, chatId) {
  return getChatStyle(userId, chatId) || getDefaultStyle(userId) || null;
}
