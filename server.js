/**
 * Territorial.io — Сервер для Render.com
 * 
 * Render даёт один порт через process.env.PORT
 * Все игровые "серверы" мультиплексируются через один WS по пути /s0/, /s1/, ...
 * 
 * npm install ws
 */

"use strict";
const WebSocket = require("ws");
const http = require("http");

const PORT = process.env.PORT || 7130;
const MAP_SIZE = 500;
const TICK_MS = 56;

// ─── Битовые хелперы ─────────────────────────────────────────────────────────
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

class BitWriter {
  constructor(bits) {
    this.buf = new Uint8Array((bits + 7) >> 3);
    this.pos = 0;
  }
  write(n, v) {
    for (let i = n - 1; i >= 0; i--) {
      if ((v >> i) & 1) this.buf[this.pos >> 3] |= 1 << (7 - (this.pos & 7));
      this.pos++;
    }
  }
  get bytes() { return this.buf; }
}

// ─── Карта ───────────────────────────────────────────────────────────────────
class GameMap {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.owner = new Uint16Array(w * h);
  }
  get(x, y)       { return this.owner[y * this.w + x]; }
  set(x, y, id)   { this.owner[y * this.w + x] = id; }
  count(pid)       { let c = 0; for (const v of this.owner) if (v === pid) c++; return c; }
  spawn(x, y, pid) {
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++)
        this.set(
          Math.max(0, Math.min(x + dx, this.w - 1)),
          Math.max(0, Math.min(y + dy, this.h - 1)),
          pid
        );
  }
  clear(pid) { for (let i = 0; i < this.owner.length; i++) if (this.owner[i] === pid) this.owner[i] = 0; }
}

// ─── Игрок ───────────────────────────────────────────────────────────────────
let nextId = 1;
class Player {
  constructor(id, ws, name) {
    this.id = id; this.ws = ws; this.name = name;
    this.x = 0; this.y = 0;
    this.cells = 0; this.gold = 0;
    this.color = (id * 67) % 360;
  }
  send(data) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }
}

// ─── Игровая комната ─────────────────────────────────────────────────────────
class Room {
  constructor(sid) {
    this.sid = sid;
    this.players = new Map();
    this.map = new GameMap(MAP_SIZE, MAP_SIZE);
    this.tick = 0;
    setInterval(() => this._tick(), TICK_MS);
  }

  join(ws, name) {
    const id = nextId++;
    const p = new Player(id, ws, name);
    p.x = 10 + Math.floor(Math.random() * (MAP_SIZE - 20));
    p.y = 10 + Math.floor(Math.random() * (MAP_SIZE - 20));
    this.map.spawn(p.x, p.y, id);
    p.cells = this.map.count(id);
    this.players.set(id, p);
    console.log(`[Room ${this.sid}] join: "${name}" id=${id} total=${this.players.size}`);
    this._sendWelcome(p);
    this._broadcastPlayers();
    return p;
  }

  leave(pid) {
    const p = this.players.get(pid);
    if (!p) return;
    this.map.clear(pid);
    this.players.delete(pid);
    console.log(`[Room ${this.sid}] leave: "${p.name}" total=${this.players.size}`);
    this._broadcastPlayers();
  }

  onMessage(player, raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case "move":
        this._move(player, msg.x | 0, msg.y | 0);
        break;
      case "chat": {
        const out = JSON.stringify({ type: "chat", from: player.name, text: String(msg.text).slice(0, 200) });
        for (const p of this.players.values()) p.send(out);
        break;
      }
      case "ping":
        player.send(JSON.stringify({ type: "pong" }));
        break;
    }
  }

  _move(player, x, y) {
    x = Math.max(0, Math.min(x, this.map.w - 1));
    y = Math.max(0, Math.min(y, this.map.h - 1));
    // Рисуем линию до новой позиции (до 3 шагов за раз)
    let cx = player.x, cy = player.y;
    const sx = Math.sign(x - cx), sy = Math.sign(y - cy);
    for (let i = 0; i < 3 && (cx !== x || cy !== y); i++) {
      if (cx !== x) cx += sx;
      else cy += sy;
      this.map.set(cx, cy, player.id);
    }
    player.x = x; player.y = y;
    player.cells = this.map.count(player.id);
  }

  _sendWelcome(p) {
    p.send(JSON.stringify({
      type: "welcome",
      playerId: p.id,
      mapW: this.map.w,
      mapH: this.map.h,
      spawnX: p.x,
      spawnY: p.y,
      color: p.color,
    }));
  }

  _broadcastPlayers() {
    const list = [...this.players.values()].map(p => ({ id: p.id, name: p.name, cells: p.cells, color: p.color }));
    const msg = JSON.stringify({ type: "players", list });
    for (const p of this.players.values()) p.send(msg);
  }

  _broadcastMap() {
    const patches = [];
    const o = this.map.owner;
    for (let i = 0; i < o.length; i++)
      if (o[i]) patches.push({ x: i % this.map.w, y: (i / this.map.w) | 0, owner: o[i] });

    // Чанки по 500
    for (let i = 0; i < patches.length; i += 500) {
      const msg = JSON.stringify({ type: "mapPatch", patches: patches.slice(i, i + 500) });
      for (const p of this.players.values()) p.send(msg);
    }
  }

  _tick() {
    this.tick++;
    if (this.tick % 60 === 0 && this.players.size > 0) {
      this._broadcastMap();
      this._broadcastPlayers();
    }
  }
}

// ─── HTTP + WebSocket сервер ──────────────────────────────────────────────────
const rooms = Array.from({ length: 4 }, (_, i) => new Room(i));

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Territorial.io local server running\n");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  // URL вида /s0/, /s1/, /s2/, /s3/
  const match = (req.url || "").match(/\/s(\d+)\//);
  const sid = match ? Math.min(parseInt(match[1]), rooms.length - 1) : 0;
  const room = rooms[sid];

  let player = null;

  ws.on("message", (data) => {
    const raw = data.toString();
    if (!player) {
      let name = "Player";
      try { const m = JSON.parse(raw); if (m.name) name = String(m.name).slice(0, 32); } catch {}
      player = room.join(ws, name);
      return;
    }
    room.onMessage(player, raw);
  });

  ws.on("close", () => { if (player) room.leave(player.id); });
  ws.on("error", (e) => console.error("WS error:", e.message));
});

server.listen(PORT, () => {
  console.log(`✅ Territorial.io сервер запущен на порту ${PORT}`);
  console.log(`   WebSocket пути: /s0/ /s1/ /s2/ /s3/`);
});
