/**
 * Territorial.io WebSocket Proxy + Protocol Sniffer
 * 
 * Запускает локальный WS сервер, проксирует трафик к оригинальному серверу
 * и логирует все пакеты для реверс-инжиниринга протокола.
 * 
 * Установка: npm install ws
 * Запуск:    node server.js
 */

const WebSocket = require("ws");
const fs = require("fs");

const PORT = 8080;
const TARGET = "wss://territorial.io/s52/";
const LOG_FILE = "packets.log";

const wss = new WebSocket.Server({ port: PORT });

let sessionCount = 0;

console.log(`[Proxy] Listening on ws://localhost:${PORT}`);
console.log(`[Proxy] Forwarding to ${TARGET}`);
console.log(`[Proxy] Packets logged to ${LOG_FILE}\n`);

// Очищаем лог при старте
fs.writeFileSync(LOG_FILE, `=== Territorial.io Protocol Sniffer ===\nStarted: ${new Date().toISOString()}\n\n`);

function log(sessionId, direction, data) {
  const timestamp = Date.now();
  let entry = `[${timestamp}] [Session ${sessionId}] [${direction}]\n`;

  if (data instanceof Buffer || data instanceof Uint8Array) {
    // Бинарные данные — выводим в hex и бинарном виде
    const bytes = Buffer.from(data);
    entry += `  Bytes (${bytes.length}): ${bytes.toString("hex")}\n`;
    entry += `  Binary: ${Array.from(bytes).map(b => b.toString(2).padStart(8, "0")).join(" ")}\n`;

    // Попытка декодировать биты по известной структуре первого пакета
    if (direction === "CLIENT->SERVER" && bytes.length > 0) {
      try {
        entry += `  Parsed bits: ${parseBits(bytes)}\n`;
      } catch (e) {}
    }
  } else {
    entry += `  Text: ${data}\n`;
  }

  entry += "\n";

  process.stdout.write(entry);
  fs.appendFileSync(LOG_FILE, entry);
}

function parseBits(buf) {
  // Читаем биты из буфера
  let bits = [];
  for (let b of buf) {
    for (let i = 7; i >= 0; i--) {
      bits.push((b >> i) & 1);
    }
  }

  let pos = 0;
  function read(n) {
    let val = 0;
    for (let i = 0; i < n; i++) {
      val = (val << 1) | (bits[pos++] || 0);
    }
    return val;
  }

  const results = [];

  // Первый пакет handshake структура:
  // 1 бит - тип пакета
  // 6 бит - версия
  // 2 бита - id аккаунта
  // 1 бит - isEmbed
  // 1 бит - isIframe
  // 1 бит - mode
  // 7 бит * N - символы имени

  const packetType = read(1);
  const version = read(6);
  const accountId = read(2);
  const isEmbed = read(1);
  const isIframe = read(1);
  const mode = read(1);

  results.push(`type=${packetType} ver=${version} accountId=${accountId} embed=${isEmbed} iframe=${isIframe} mode=${mode}`);

  // Читаем имя
  let name = "";
  while (pos + 7 <= bits.length) {
    const charCode = read(7);
    if (charCode === 0) break;
    name += String.fromCharCode(charCode);
  }
  if (name) results.push(`name="${name}"`);

  return results.join(", ");
}

wss.on("connection", (clientWs) => {
  const sessionId = ++sessionCount;
  console.log(`[Session ${sessionId}] Client connected`);

  // Подключаемся к реальному серверу
  const serverWs = new WebSocket(TARGET);

  serverWs.on("open", () => {
    console.log(`[Session ${sessionId}] Connected to territorial.io`);
  });

  // Клиент → Сервер
  clientWs.on("message", (data, isBinary) => {
    log(sessionId, "CLIENT->SERVER", data);
    if (serverWs.readyState === WebSocket.OPEN) {
      serverWs.send(data, { binary: isBinary });
    }
  });

  // Сервер → Клиент
  serverWs.on("message", (data, isBinary) => {
    log(sessionId, "SERVER->CLIENT", data);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  clientWs.on("close", () => {
    console.log(`[Session ${sessionId}] Client disconnected`);
    serverWs.close();
  });

  serverWs.on("close", () => {
    console.log(`[Session ${sessionId}] Server disconnected`);
    clientWs.close();
  });

  serverWs.on("error", (err) => {
    console.error(`[Session ${sessionId}] Server error:`, err.message);
  });

  clientWs.on("error", (err) => {
    console.error(`[Session ${sessionId}] Client error:`, err.message);
  });
});
