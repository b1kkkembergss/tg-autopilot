// ── tg-autopilot / src/promo.js ─────────────────────────────────────────────
// Приём промо-роликов на модерацию: бот отправляет видео владельцу
// с кнопками «Выложить» / «Отклонить». Выбор сохраняется в очередь,
// которую забирает скрипт публикации.
//
// Очередь: data/promo_queue.json
// {
//   "<id>": {
//     "id": "p01", "path": "C:/...p01.mp4", "title": "...",
//     "status": "pending" | "approved" | "rejected",
//     "messageId": 12345, "createdAt": "2026-11-17T12:00:00.000Z"
//   }
// }
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const FILE = path.join(DATA_DIR, 'promo_queue.json');

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

/** Добавить ролик в очередь на модерацию */
export function addPromo({ id, filePath, title, messageId = null }) {
  const queue = load();
  queue[id] = {
    id,
    path: filePath,
    title,
    status: 'pending',
    messageId,
    createdAt: new Date().toISOString(),
  };
  flush();
  return queue[id];
}

export function setStatus(id, status) {
  const queue = load();
  if (!queue[id]) return null;
  queue[id].status = status;
  queue[id].decidedAt = new Date().toISOString();
  flush();
  return queue[id];
}

export function getPromo(id) {
  return load()[id] || null;
}

/** Ожидают решения — их забирает скрипт публикации */
export function listPending() {
  return Object.values(load()).filter((v) => v.status === 'pending');
}

export function listApproved() {
  return Object.values(load()).filter((v) => v.status === 'approved');
}

export function listRejected() {
  return Object.values(load()).filter((v) => v.status === 'rejected');
}

export function listAll() {
  return Object.values(load());
}
