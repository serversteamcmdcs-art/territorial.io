const http = require("http");
const fs = require("fs");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const MAP_SIZE = 80;
const TICK = 200;
const BOTS = 5;

let players = {};
let sockets = {};
let map = [];

// ===== HTTP сервер (для Render) =====
const server = http.createServer((req, res) => {
  let file = "public/index.html";
  if (req.url !== "/") file = "public" + req.url;

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("404");
    }
    res.writeHead(200);
    res.end(data);
  });
});

// ===== WebSocket =====
const wss = new WebSocket.Server({ server });

// ===== карта =====
function initMap() {
  map = [];
  for (let y = 0; y < MAP_SIZE; y++) {
    let row = [];
    for (let x = 0; x < MAP_SIZE; x++) {
      row.push({ owner: null, army: 0 });
    }
    map.push(row);
  }
}

// ===== спавн =====
function spawn(id) {
  let x, y;
  do {
    x = Math.floor(Math.random() * MAP_SIZE);
    y = Math.floor(Math.random() * MAP_SIZE);
  } while (map[y][x].owner);

  map[y][x] = { owner: id, army: 30 };
}

// ===== рассылка =====
function broadcast(data) {
  const msg = JSON.stringify(data);
  Object.values(sockets).forEach(ws => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

// ===== атака =====
function attack(id, from, to) {
  let a = map[from.y]?.[from.x];
  let b = map[to.y]?.[to.x];

  if (!a || !b) return;
  if (a.owner !== id) return;
  if (a.army < 2) return;

  let power = Math.floor(a.army * 0.5);
  a.army -= power;

  if (b.owner === id) {
    b.army += power;
  } else {
    b.army -= power;

    if (b.army <= 0) {
      b.owner = id;
      b.army = Math.abs(b.army);
    }
  }
}

// ===== боты =====
function botAI(id) {
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      let c = map[y][x];
      if (c.owner === id && c.army > 20) {
        let dirs = [
          { x: 1, y: 0 }, { x: -1, y: 0 },
          { x: 0, y: 1 }, { x: 0, y: -1 }
        ];

        let d = dirs[Math.floor(Math.random() * dirs.length)];

        attack(id, { x, y }, { x: x + d.x, y: y + d.y });
      }
    }
  }
}

// ===== тик =====
function tick() {
  // рост армии
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      let c = map[y][x];
      if (c.owner) c.army += 1;
    }
  }

  // боты
  Object.keys(players).forEach(id => {
    if (players[id].bot) botAI(id);
  });

  broadcast({ type: "update", map });
}

// ===== запуск =====
initMap();

// создаём ботов
for (let i = 0; i < BOTS; i++) {
  let id = "bot_" + i;
  players[id] = { id, bot: true };
  spawn(id);
}

setInterval(tick, TICK);

// ===== подключение =====
wss.on("connection", (ws) => {
  const id = "p" + Math.random().toString(36).slice(2, 7);

  players[id] = { id };
  sockets[id] = ws;

  spawn(id);

  ws.send(JSON.stringify({
    type: "init",
    id,
    map
  }));

  ws.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    if (data.type === "attack") {
      attack(id, data.from, data.to);
    }
  });

  ws.on("close", () => {
    delete players[id];
    delete sockets[id];
  });
});

server.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});
