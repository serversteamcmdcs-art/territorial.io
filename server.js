/**
 * Territorial.io Clone — Game Server
 * Node.js + WebSocket
 * 
 * npm install ws
 * node server.js
 */

const WebSocket = require("ws");

const PORT = 8080;
const MAP_SIZE = 200;        // 200x200 клеток
const TICK_RATE = 100;       // мс между тиками
const ATTACK_SPEED = 0.35;   // доля территории за атаку
const MAX_PLAYERS = 50;

const wss = new WebSocket.Server({ port: PORT });

// ──────────────────────────────────────────────
// Состояние игры
// ──────────────────────────────────────────────

// map[y][x] = playerId или 0 (нейтраль)
let map = Array.from({ length: MAP_SIZE }, () => new Uint8Array(MAP_SIZE));

let players = {};   // id → Player
let nextId = 1;

const COLORS = [
  "#e74c3c","#3498db","#2ecc71","#f39c12","#9b59b6",
  "#1abc9c","#e67e22","#e91e63","#00bcd4","#8bc34a",
  "#ff5722","#607d8b","#795548","#ff9800","#03a9f4",
];

function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function randomSpawn() {
  // Ищем свободное место
  for (let attempt = 0; attempt < 200; attempt++) {
    const x = 5 + Math.floor(Math.random() * (MAP_SIZE - 10));
    const y = 5 + Math.floor(Math.random() * (MAP_SIZE - 10));
    if (map[y][x] === 0) return { x, y };
  }
  return { x: Math.floor(MAP_SIZE / 2), y: Math.floor(MAP_SIZE / 2) };
}

class Player {
  constructor(id, ws, name) {
    this.id = id;
    this.ws = ws;
    this.name = name.slice(0, 20) || ("Player" + id);
    this.color = randomColor();
    this.alive = true;
    this.score = 0;       // клетки территории
    this.kills = 0;

    // Спавн — дать стартовую территорию 3x3
    const { x, y } = randomSpawn();
    this.x = x;
    this.y = y;

    // Заполняем стартовый квадрат
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < MAP_SIZE && ny >= 0 && ny < MAP_SIZE) {
          map[ny][nx] = id;
          this.score++;
        }
      }
    }

    // Направление движения
    this.dirX = 0;
    this.dirY = 0;
    this.moveTimer = 0;   // мс до следующего шага
    this.moveDelay = 180; // мс между шагами (скорость)

    // Шлейф (trail) — клетки вне своей территории
    this.trail = [];
    this.inTrail = false;
  }

  send(obj) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }
}

// ──────────────────────────────────────────────
// Подключение игроков
// ──────────────────────────────────────────────

wss.on("connection", (ws) => {
  const id = nextId++;
  if (id > 254) { ws.close(); return; } // Uint8 лимит

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "join") {
      const player = new Player(id, ws, msg.name || "");
      players[id] = player;

      // Отправляем начальное состояние
      player.send({
        type: "init",
        id,
        mapSize: MAP_SIZE,
        color: player.color,
        name: player.name,
        x: player.x,
        y: player.y,
        map: serializeMap(),
        players: serializePlayers(),
      });

      // Уведомляем всех о новом игроке
      broadcast({
        type: "player_join",
        id,
        name: player.name,
        color: player.color,
        x: player.x,
        y: player.y,
      }, id);

      console.log(`[+] ${player.name} (id=${id}) joined. Players: ${Object.keys(players).length}`);
    }

    if (msg.type === "dir") {
      const p = players[id];
      if (!p || !p.alive) return;
      const dx = Math.sign(Math.round(msg.dx || 0));
      const dy = Math.sign(Math.round(msg.dy || 0));
      // Запрещаем диагональ
      if (dx !== 0 && dy !== 0) return;
      p.dirX = dx;
      p.dirY = dy;
    }
  });

  ws.on("close", () => {
    const p = players[id];
    if (p) {
      removePlayer(id);
      console.log(`[-] ${p.name} (id=${id}) left. Players: ${Object.keys(players).length}`);
    }
  });
});

// ──────────────────────────────────────────────
// Игровой тик
// ──────────────────────────────────────────────

let lastTick = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt = now - lastTick;
  lastTick = now;

  const mapChanges = [];   // [{x,y,owner}]
  const deaths = [];

  for (const id in players) {
    const p = players[id];
    if (!p.alive || (p.dirX === 0 && p.dirY === 0)) continue;

    p.moveTimer -= dt;
    if (p.moveTimer > 0) continue;
    p.moveTimer = p.moveDelay;

    const nx = p.x + p.dirX;
    const ny = p.y + p.dirY;

    // Стена
    if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) continue;

    const cell = map[ny][nx];

    // Столкновение со своим шлейфом → смерть
    if (p.inTrail && p.trail.some(t => t.x === nx && t.y === ny)) {
      deaths.push({ id, killer: 0, reason: "self" });
      continue;
    }

    // Движение
    p.x = nx;
    p.y = ny;

    if (cell === Number(id)) {
      // Вернулись на свою территорию — захватываем шлейф
      if (p.inTrail && p.trail.length > 0) {
        const filled = fillTrail(p);
        filled.forEach(c => mapChanges.push(c));
        p.trail = [];
        p.inTrail = false;
      }
    } else {
      // Не своя клетка — добавляем в шлейф
      if (!p.inTrail) p.inTrail = true;
      p.trail.push({ x: nx, y: ny });

      // Убиваем владельца если наступили на его шлейф
      const victim = findPlayerWithTrailAt(nx, ny, id);
      if (victim) {
        deaths.push({ id: victim.id, killer: Number(id), reason: "trail" });
      }

      // Захватываем клетку
      const prevOwner = map[ny][nx];
      map[ny][nx] = Number(id);
      if (prevOwner && players[prevOwner]) players[prevOwner].score--;
      p.score++;
      mapChanges.push({ x: nx, y: ny, owner: Number(id) });
    }
  }

  // Обрабатываем смерти
  for (const d of deaths) {
    if (!players[d.id]) continue;
    const victim = players[d.id];
    victim.alive = false;

    // Освобождаем территорию
    const freed = [];
    for (let y = 0; y < MAP_SIZE; y++) {
      for (let x = 0; x < MAP_SIZE; x++) {
        if (map[y][x] === d.id) {
          map[y][x] = 0;
          freed.push({ x, y, owner: 0 });
        }
      }
    }

    if (d.killer && players[d.killer]) {
      players[d.killer].kills++;
    }

    broadcast({
      type: "death",
      id: d.id,
      name: victim.name,
      killer: d.killer,
      killerName: d.killer && players[d.killer] ? players[d.killer].name : "",
      reason: d.reason,
      mapChanges: freed,
    });

    victim.ws.send(JSON.stringify({ type: "you_died", killer: d.killer }));
    removePlayer(d.id);
  }

  // Рассылаем изменения карты
  if (mapChanges.length > 0) {
    broadcast({ type: "map_update", changes: mapChanges });
  }

  // Рассылаем позиции игроков
  const positions = {};
  for (const id in players) {
    const p = players[id];
    positions[id] = {
      x: p.x, y: p.y,
      score: p.score,
      trail: p.trail,
    };
  }
  broadcast({ type: "positions", data: positions });

}, TICK_RATE);

// Таблица лидеров каждые 2 секунды
setInterval(() => {
  const lb = Object.values(players)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(p => ({ id: p.id, name: p.name, score: p.score, kills: p.kills, color: p.color }));
  broadcast({ type: "leaderboard", data: lb });
}, 2000);

// ──────────────────────────────────────────────
// Вспомогательные функции
// ──────────────────────────────────────────────

function fillTrail(player) {
  // Простой алгоритм: все клетки шлейфа становятся территорией игрока
  // Плюс flood fill замкнутой области (упрощённо — только шлейф)
  const changes = [];
  for (const cell of player.trail) {
    const prev = map[cell.y][cell.x];
    if (prev !== player.id) {
      if (prev && players[prev]) players[prev].score--;
      map[cell.y][cell.x] = player.id;
      player.score++;
      changes.push({ x: cell.x, y: cell.y, owner: player.id });
    }
  }
  return changes;
}

function findPlayerWithTrailAt(x, y, excludeId) {
  for (const id in players) {
    if (Number(id) === excludeId) continue;
    const p = players[id];
    if (p.inTrail && p.trail.some(t => t.x === x && t.y === y)) return p;
  }
  return null;
}

function removePlayer(id) {
  delete players[id];
  broadcast({ type: "player_leave", id: Number(id) });
}

function serializeMap() {
  // Компактно: массив MAP_SIZE строк по MAP_SIZE байт
  return Array.from(map, row => Array.from(row));
}

function serializePlayers() {
  const result = {};
  for (const id in players) {
    const p = players[id];
    result[id] = { name: p.name, color: p.color, x: p.x, y: p.y, score: p.score };
  }
  return result;
}

function broadcast(obj, excludeId) {
  const msg = JSON.stringify(obj);
  for (const id in players) {
    if (Number(id) === excludeId) continue;
    const p = players[id];
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  }
}

console.log(`[Server] Territorial.io clone running on ws://localhost:${PORT}`);
