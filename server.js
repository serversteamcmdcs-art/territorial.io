/**
 * Territorial.io — Сервер для Render.com
 * Реализует бинарный протокол клиента territorial.io
 * 
 * npm install ws
 * npm start
 */

"use strict";
const WebSocket = require("ws");
const http = require("http");

const PORT = process.env.PORT || 7130;

// ─── Битовые хелперы ─────────────────────────────────────────────────────────
class BitWriter {
  constructor() { this.bits = []; }

  write(n, v) {
    for (let i = n - 1; i >= 0; i--)
      this.bits.push((v >> i) & 1);
  }

  toBuffer() {
    const buf = new Uint8Array(Math.ceil(this.bits.length / 8));
    for (let i = 0; i < this.bits.length; i++)
      if (this.bits[i]) buf[i >> 3] |= 1 << (7 - (i & 7));
    return Buffer.from(buf);
  }
}

class BitReader {
  constructor(buf) {
    this.buf = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.pos = 0;
  }
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 1) | ((this.buf[this.pos >> 3] >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  get done() { return this.pos >= this.buf.length * 8; }
}

// ─── Протокол ────────────────────────────────────────────────────────────────

// Палитра цветов (пакет 0,0) — клиент ждёт её сразу после подключения
// Формат: 1=0, 6=0, 12=count, 6=bitsPerColor, count*(bitsPerColor бит)
function makeColorPalette() {
  // 64 цвета по 6 бит (значения 0-63, клиент масштабирует до 0-255)
  const colors = [];
  for (let i = 0; i < 64; i++) colors.push(i);

  const w = new BitWriter();
  w.write(1, 0);          // направление: сервер→клиент
  w.write(6, 0);          // subtype: 0 = color palette
  w.write(12, colors.length); // количество цветов
  w.write(6, 6);          // бит на цвет
  for (const c of colors) w.write(6, c);
  return w.toBuffer();
}

// Пакет "лобби" (0,2) — список серверов для выбора
// Формат из aUJ: state должен быть 6, читает данные серверов
// Пока пропускаем - клиент сам перейдёт в нужное состояние после палитры

// ─── Разбор JOIN пакета от клиента ──────────────────────────────────────────
// Формат aU4: 1=0, 6=13, 14=version(1118), 4=accountId, 7=buildDate,
//             1=isOfficial, 1=isIframe, 5=hour, 8=color0, 8=color1
function parseJoinPacket(buf) {
  const r = new BitReader(buf);
  const direction = r.read(1); // 0 = клиент→сервер
  const subtype   = r.read(6); // 13 = join

  if (direction !== 0 || subtype !== 13) return null;

  return {
    version:    r.read(14),
    accountId:  r.read(4),
    buildDate:  r.read(7),
    isOfficial: r.read(1),
    isIframe:   r.read(1),
    hour:       r.read(5),
    color0:     r.read(8),
    color1:     r.read(8),
  };
}

// ─── Игровые комнаты ─────────────────────────────────────────────────────────
const rooms = new Map(); // sid → Set<ws>

function getRoom(sid) {
  if (!rooms.has(sid)) rooms.set(sid, new Set());
  return rooms.get(sid);
}

// ─── HTTP + WebSocket ─────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200); res.end("territorial-io server ok\n");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  const match = (req.url || "").match(/\/s(\d+)\//);
  const sid = match ? parseInt(match[1]) : 0;
  const room = getRoom(sid);
  room.add(ws);

  console.log(`[s${sid}] connect  total=${room.size}`);

  // Сразу посылаем палитру цветов — клиент её ждёт как первый пакет
  try {
    ws.send(makeColorPalette());
    console.log(`[s${sid}] → sent color palette`);
  } catch(e) {
    console.error("palette send error:", e.message);
  }

  ws.on("message", (data) => {
    const buf = data instanceof Buffer ? data : Buffer.from(data);

    // Логируем для отладки
    console.log(`[s${sid}] ← ${buf.length} bytes: ${buf.slice(0,8).toString('hex')}...`);

    // Пробуем распознать тип пакета
    const r = new BitReader(buf);
    const dir = r.read(1);
    const sub = r.read(6);
    console.log(`[s${sid}]   dir=${dir} subtype=${sub}`);

    if (dir === 0 && sub === 13) {
      // JOIN пакет
      const info = parseJoinPacket(buf);
      console.log(`[s${sid}]   JOIN:`, info);
    }
  });

  ws.on("close", () => {
    room.delete(ws);
    console.log(`[s${sid}] disconnect  total=${room.size}`);
  });

  ws.on("error", (e) => console.error(`[s${sid}] error:`, e.message));
});

server.listen(PORT, () => {
  console.log(`✅ Territorial.io сервер запущен на порту ${PORT}`);
  console.log(`   WebSocket: /s0/ /s1/ /s2/ /s3/`);
  console.log(`   Протокол: бинарный (реверс-инжиниринг в процессе)`);
});
