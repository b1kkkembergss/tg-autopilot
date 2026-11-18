// ── tg-autopilot / src/proxy.js ─────────────────────────────────────────────
// fetch-совместимая функция, работающая через HTTP-прокси (TG_PROXY),
// например http://127.0.0.1:10809 (xray/v2rayN, HTTP-inbound).
// HTTPS-запросы идут CONNECT-туннелем через прокси, далее обычный TLS.
// Без TG_PROXY возвращает глобальный fetch — поведение не меняется.
import http from 'node:http';
import https from 'node:https';
import { config } from './config.js';

const CONNECT_TIMEOUT_MS = 15000;
// Long polling держит соединение до 30 сек — таймаут запроса должен быть больше.
// Туннель иногда рвётся на установке TLS — ретраим установку, но не сами запросы.
const REQUEST_TIMEOUT_MS = 90000;
const TLS_RETRY = 2;

function parseProxy(raw) {
  if (!raw) return null;
  let u = raw.trim();
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  try {
    return new URL(u);
  } catch {
    console.warn(`HTTPS_PROXY не разобрался (${raw}) — работаем напрямую`);
    return null;
  }
}

function connectThrough(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (proxy.username) {
      const auth = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`;
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(auth).toString('base64');
    }
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers,
    });
    const fail = (err) => {
      req.destroy();
      reject(err);
    };
    req.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error('proxy CONNECT timeout')));
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) {
        // Обрыв соединения после того, как запрос уже завершён или отменён,
        // выбрасывал необработанное 'error' и убивал весь процесс.
        // Реальные ошибки запроса ловятся в requestViaProxyOnce.
        socket.on('error', () => {});
        resolve(socket);
      } else {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`));
      }
    });
    req.on('error', fail);
    req.end();
  });
}

function requestViaProxyOnce(proxy, urlStr, options) {
  return new Promise((resolve, reject) => {
    const target = new URL(urlStr);
    if (target.protocol !== 'https:') {
      return reject(new Error(`Прокси-режим поддерживает только https, получено ${target.protocol}`));
    }
    connectThrough(proxy, target.hostname, target.port || 443)
      .then((socket) => {
        const req = https.request({
          socket, // TLS поверх уже открытого туннеля
          hostname: target.hostname,
          port: target.port || 443,
          servername: target.hostname,
          method: options.method || 'GET',
          path: target.pathname + target.search,
          headers: { ...(options.headers || {}) },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks);
            resolve(new Response(body, {
              status: res.statusCode,
              statusText: res.statusMessage || '',
              headers: res.headers,
            }));
          });
          res.on('error', reject);
        });
        req.on('error', reject);
        // 90 сек: getUpdates с timeout=30 + запас на медленный прокси
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
          req.destroy(new Error('request via proxy timeout'));
        });
        if (options.body) req.write(options.body);
        req.end();
      })
      .catch(reject);
  });
}

async function requestViaProxy(proxy, urlStr, options) {
  // Туннель/TLS иногда рвётся на установке (наблюдали на tokify) — ретраим.
  // POST не ретраим на неидемпотентных действиях, если ответ уже мог уйти:
  // ошибки до записи body — безопасны, TLS-обрыв тела запроса — тоже.
  let lastErr;
  for (let attempt = 0; attempt <= TLS_RETRY; attempt++) {
    try {
      return await requestViaProxyOnce(proxy, urlStr, options);
    } catch (err) {
      lastErr = err;
      const beforeSent = /CONNECT|TLS|socket/i.test(err.message);
      if (!beforeSent && attempt < TLS_RETRY) {
        // ошибка после отправки — один повтор всё же допустим для GET
        if ((options.method || 'GET') !== 'GET' && !options.body) throw err;
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * @param {string} [proxyUrl] — если не задан, берётся config.proxyUrl (TG_PROXY).
 *   Пустая строка = работать напрямую, без прокси.
 */
export function makeFetch(proxyUrl = config.proxyUrl) {
  const proxy = parseProxy(proxyUrl);
  if (!proxy) {
    return globalThis.fetch;
  }
  console.log(`Прокси: ${proxy.protocol}//${proxy.hostname}:${proxy.port}`);
  return (url, options = {}) => requestViaProxy(proxy, String(url), options);
}
