const WebSocket = require("ws");
const wss = new WebSocket.Server({ port: 3000 });

const MAP = 32;

let players = {};
let map = [];

// карта
for (let y = 0; y < MAP; y++) {
  map[y] = [];
  for (let x = 0; x < MAP; x++) {
    map[y][x] = { owner: 0, army: 0 };
  }
}

// отправка бинарного пакета
function send(ws, buffer) {
  ws.send(buffer);
}

// init пакет
function sendInit(ws, id) {
  const buf = new Uint8Array(2);
  buf[0] = 1; // тип
  buf[1] = id;
  send(ws, buf);
}

// update пакет
function sendUpdate() {
  const buf = new Uint8Array(1 + MAP * MAP * 2);
  buf[0] = 2;

  let i = 1;

  for (let y = 0; y < MAP; y++) {
    for (let x = 0; x < MAP; x++) {
      buf[i++] = map[y][x].owner || 0;
      buf[i++] = Math.min(map[y][x].army, 255);
    }
  }

  wss.clients.forEach(c => {
    if (c.readyState === 1) c.send(buf);
  });
}

// тик
setInterval(() => {
  for (let y = 0; y < MAP; y++) {
    for (let x = 0; x < MAP; x++) {
      if (map[y][x].owner) map[y][x].army++;
    }
  }
  sendUpdate();
}, 200);

// подключение
wss.on("connection", (ws) => {
  const id = Math.floor(Math.random() * 200) + 1;

  players[id] = ws;

  // спавн
  let x = Math.floor(Math.random() * MAP);
  let y = Math.floor(Math.random() * MAP);
  map[y][x] = { owner: id, army: 20 };

  sendInit(ws, id);

  ws.on("message", (msg) => {
    const data = new Uint8Array(msg);

    if (data[0] === 3) { // attack
      const fx = data[1];
      const fy = data[2];
      const tx = data[3];
      const ty = data[4];

      const a = map[fy]?.[fx];
      const b = map[ty]?.[tx];

      if (!a || !b) return;
      if (a.owner !== id) return;

      let power = Math.floor(a.army / 2);
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
  });
});

console.log("🚀 Binary server ws://localhost:3000");
