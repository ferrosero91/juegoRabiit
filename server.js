const express = require('express');
const http = require('http');
const path = require('path');
const amqp = require('amqplib');
const { WebSocketServer } = require('ws');

const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672';
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const MATCH_MS = 60000;
const COUNTDOWN_MS = 3000;
const LOBBY_SOLO_MS = 4000;
const LOBBY_MULTI_MS = 2000;
const COMBO_WINDOW_MS = 3000;
const MAX_HEALTH = 100;

const ZONES = {
  bosque: [
    { name: 'Lobo', icon: '🐺', points: 10, hp: 1, behavior: 'normal', size: 1.0, speed: 1.0 },
    { name: 'Araña gigante', icon: '🕷️', points: 15, hp: 1, behavior: 'zigzag', size: 0.9, speed: 1.35 },
    { name: 'Oso', icon: '🐻', points: 25, hp: 2, behavior: 'normal', size: 1.2, speed: 0.8 },
    { name: 'Jabalí', icon: '🐗', points: 12, hp: 1, behavior: 'zigzag', size: 1.0, speed: 1.1 },
  ],
  cueva: [
    { name: 'Murciélago', icon: '🦇', points: 10, hp: 1, behavior: 'zigzag', size: 0.8, speed: 1.45 },
    { name: 'Serpiente', icon: '🐍', points: 20, hp: 1, behavior: 'homing', size: 1.0, speed: 0.95 },
    { name: 'Escorpión', icon: '🦂', points: 30, hp: 2, behavior: 'normal', size: 1.0, speed: 0.9 },
    { name: 'Troll', icon: '👹', points: 18, hp: 2, behavior: 'heavy', size: 1.3, speed: 0.7 },
  ],
  volcan: [
    { name: 'Elemental', icon: '🔥', points: 25, hp: 2, behavior: 'heavy', size: 1.2, speed: 0.75 },
    { name: 'Dragón', icon: '🐉', points: 50, hp: 3, behavior: 'boss', size: 1.55, speed: 0.55 },
    { name: 'Golem', icon: '🗿', points: 40, hp: 3, behavior: 'normal', size: 1.4, speed: 0.6 },
    { name: 'Fénix', icon: '🦅', points: 35, hp: 2, behavior: 'zigzag', size: 1.1, speed: 1.2 },
  ],
};

const players = new Map();
let joining = 0;
const alive = new Map();
const scores = new Map();
const hits = new Map();
let nextId = 1;
let ch = null;
let reconnectTimer = null;

let phase = 'lobby';
let health = MAX_HEALTH;
let matchStart = 0;
let spawnTimer = null;
let endTimer = null;
let countdownTimer = null;
let lobbyTimer = null;
let tickTimer = null;
const ttlTimers = new Set();

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const broadcast = (msg) => players.forEach((_, ws) => send(ws, msg));
const ranking = () =>
  [...scores].map(([name, points]) => ({ name, points, hits: hits.get(name) || 0 }))
    .sort((a, b) => b.points - a.points || b.hits - a.hits).slice(0, MAX_PLAYERS);

function clearTimers() {
  if (spawnTimer)    { clearTimeout(spawnTimer);    spawnTimer    = null; }
  if (endTimer)      { clearTimeout(endTimer);      endTimer      = null; }
  if (countdownTimer){ clearTimeout(countdownTimer);countdownTimer= null; }
  if (lobbyTimer)    { clearTimeout(lobbyTimer);    lobbyTimer    = null; }
  if (tickTimer)     { clearInterval(tickTimer);    tickTimer     = null; }
  ttlTimers.forEach((t) => clearTimeout(t));
  ttlTimers.clear();
}

function broadcastState() {
  const timeLeft = phase === 'playing' ? Math.max(0, MATCH_MS - (Date.now() - matchStart)) : 0;
  broadcast({ type: 'estado', phase, players: players.size, maxPlayers: MAX_PLAYERS, timeLeft, health, maxHealth: MAX_HEALTH, ranking: ranking() });
}

function scheduleLobby() {
  if (phase !== 'lobby') return;
  if (lobbyTimer) clearTimeout(lobbyTimer);
  if (players.size === 0) return;
  const delay = players.size >= 2 ? LOBBY_MULTI_MS : LOBBY_SOLO_MS;
  lobbyTimer = setTimeout(() => {
    if (phase === 'lobby' && players.size >= 1) startCountdown();
  }, delay);
}

function startCountdown() {
  if (phase !== 'lobby') return;
  phase = 'countdown';
  clearTimers();
  broadcast({ type: 'countdown', seconds: COUNTDOWN_MS / 1000 });
  broadcastState();
  countdownTimer = setTimeout(startMatch, COUNTDOWN_MS);
}

function spawnInterval() {
  const t = Math.min(1, (Date.now() - matchStart) / MATCH_MS);
  return Math.round(2200 - 1000 * t);
}
function monsterTTL() {
  const t = Math.min(1, (Date.now() - matchStart) / MATCH_MS);
  return Math.round(8000 - 3000 * t);
}

function spawnMonster() {
  if (phase !== 'playing') return;
  const keys = Object.keys(ZONES);
  const zone = keys[Math.floor(Math.random() * keys.length)];
  const base = ZONES[zone][Math.floor(Math.random() * ZONES[zone].length)];
  const ttl = monsterTTL();
  const monster = { id: nextId++, zone, ...base, ttl };
  alive.set(monster.id, { ...monster, hp: base.hp, maxHp: base.hp });
  const ttlTimer = setTimeout(() => {
    ttlTimers.delete(ttlTimer);
    if (alive.has(monster.id) && phase === 'playing') {
      alive.delete(monster.id);
      const damage = Math.max(3, Math.round(6 * (monster.size || 1)));
      health = Math.max(0, health - damage);
      broadcast({ type: 'escapo', id: monster.id, damage, health, maxHealth: MAX_HEALTH });
      if (health <= 0) { endMatch('derrota'); return; }
      broadcastState();
    }
  }, ttl + 300);
  ttlTimers.add(ttlTimer);
  broadcast({ type: 'monstruo', monster });
  spawnTimer = setTimeout(spawnMonster, spawnInterval());
}

function startMatch() {
  phase = 'playing';
  health = MAX_HEALTH;
  matchStart = Date.now();
  alive.clear();
  scores.forEach((_, name) => scores.set(name, 0));
  hits.forEach((_, name)   => hits.set(name, 0));
  clearTimers();
  broadcast({ type: 'inicio', duration: MATCH_MS });
  broadcastState();
  spawnMonster();
  endTimer   = setTimeout(endMatch, MATCH_MS);
  tickTimer  = setInterval(broadcastState, 1000);
}

function endMatch(reason = 'tiempo') {
  if (phase !== 'playing') return;
  phase = 'ended';
  clearTimers();
  alive.clear();
  broadcast({ type: 'fin', reason, health, maxHealth: MAX_HEALTH, ranking: ranking() });
  broadcastState();
  setTimeout(resetToLobby, 12000);
}

function resetToLobby() {
  phase = 'lobby';
  alive.clear();
  clearTimers();
  scores.forEach((_, name) => scores.set(name, 0));
  hits.forEach((_, name)   => hits.set(name, 0));
  broadcastState();
  scheduleLobby();
}

function handleGolpe(channel, msg) {
  if (!msg) return;
  let data;
  try { data = JSON.parse(msg.content.toString()); } catch { try { channel.ack(msg); } catch {} return; }
  try { channel.ack(msg); } catch {}
  const { player } = data;
  const id = Number(data.id);
  if (!Number.isFinite(id) || !player) return;
  const p = [...players.values()].find((x) => x.name === player);
  if (!p) return;
  const monster = alive.get(id);
  if (!monster) return;

  monster.hp -= 1;
  if (monster.hp > 0) {
    broadcast({ type: 'golpe_ok', id, hp: monster.hp, maxHp: monster.maxHp });
    return;
  }
  alive.delete(id);
  const now = Date.now();
  if (now - (p.lastHit || 0) <= COMBO_WINDOW_MS) p.combo = (p.combo || 0) + 1;
  else p.combo = 1;
  p.lastHit = now;
  const mult = Math.min(p.combo, 5);
  const yf   = Number.isFinite(Number(data.y)) ? Math.min(1, Math.max(0, Number(data.y))) : 1;
  const heightMult = Math.round((1 + (1 - yf) * 2) * 10) / 10;
  const gained = Math.round(monster.points * mult * heightMult);
  scores.set(player, (scores.get(player) || 0) + gained);
  hits.set(player,   (hits.get(player)   || 0) + 1);
  broadcast({ type: 'derrotado', id, by: player, monster, gained, combo: p.combo, mult, heightMult, ranking: ranking() });
}

function consumePlayer(channel, ws, queue) {
  return channel.consume(queue, (m) => {
    if (!m) return;
    try { channel.ack(m); } catch {}
    send(ws, { type: 'monstruo', monster: JSON.parse(m.content.toString()) });
  });
}

async function setupChannel(channel) {
  await channel.assertExchange('monstruos', 'direct', { durable: false });
  await channel.assertExchange('acciones',  'direct', { durable: false });
  await channel.assertQueue('golpes', { durable: false });
  await channel.bindQueue('golpes', 'acciones', 'golpe');
  await channel.consume('golpes', (msg) => handleGolpe(channel, msg));
}

async function rebindPlayers(channel) {
  for (const [ws, p] of players) {
    try {
      const { queue } = await channel.assertQueue('', { exclusive: true, autoDelete: true });
      p.queue = queue;
      await Promise.all([...p.zones].map((z) => channel.bindQueue(queue, 'monstruos', z)));
      const { consumerTag } = await consumePlayer(channel, ws, queue);
      p.tag = consumerTag;
    } catch (e) {
      console.error(`No se pudo re-vincular a ${p && p.name}:`, e.message);
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  console.error('RabbitMQ no disponible. Reintentando en 3s...');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectRabbit();
  }, 3000);
}

async function connectRabbit() {
  try {
    const conn = await amqp.connect(AMQP_URL);
    conn.on('error', (e) => console.error('RabbitMQ error:', e.message));
    conn.on('close', () => { if (ch) ch = null; scheduleReconnect(); });
    const channel = await conn.createChannel();
    channel.on('error', (e) => console.error('Canal error:', e.message));
    channel.on('close', () => { if (ch === channel) ch = null; scheduleReconnect(); });
    await setupChannel(channel);
    ch = channel;
    console.log('🐰 Conectado a RabbitMQ');
    if (players.size) await rebindPlayers(channel);
  } catch (e) {
    console.error('No se pudo conectar a RabbitMQ:', e.message);
    scheduleReconnect();
  }
}

async function main() {
  const app    = express();
  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    },
  }));
  const server = http.createServer(app);
  const wss    = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    let p = null;

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      try {
        if (msg.type === 'unirse' && !p) {
          if (players.size + joining >= MAX_PLAYERS) {
            send(ws, { type: 'lleno' }); ws.close(); return;
          }
          if (!ch) {
            send(ws, { type: 'aviso', text: 'Servidor reconectando, reintenta en unos segundos' });
            ws.close(); return;
          }
          joining++;
          const name = String(msg.name || '').trim().slice(0, 16) || 'Jugador' + Math.floor(Math.random() * 100);
          const channel = ch;
          const { queue } = await channel.assertQueue('', { exclusive: true, autoDelete: true });
          p = { name, queue, zones: new Set(Object.keys(ZONES)), combo: 0, lastHit: 0 };
          await Promise.all([...p.zones].map((z) => channel.bindQueue(queue, 'monstruos', z)));
          players.set(ws, p);
          joining = Math.max(0, joining - 1);
          if (!scores.has(name)) scores.set(name, 0);
          if (!hits.has(name))   hits.set(name, 0);
          const { consumerTag } = await consumePlayer(channel, ws, queue);
          p.tag = consumerTag;
          send(ws, { type: 'bienvenida', name, queue, zones: [...p.zones], ranking: ranking(), maxPlayers: MAX_PLAYERS });
          broadcast({ type: 'aviso', text: `${name} se unió (${players.size}/${MAX_PLAYERS})` });
          broadcastState();
          scheduleLobby();

        } else if (p && msg.type === 'zona' && ZONES[msg.zone] && ch) {
          if (msg.on) { await ch.bindQueue(p.queue, 'monstruos', msg.zone);   p.zones.add(msg.zone); }
          else        { await ch.unbindQueue(p.queue, 'monstruos', msg.zone); p.zones.delete(msg.zone); }
          send(ws, { type: 'zonas', zones: [...p.zones], queue: p.queue });

        } else if (p && msg.type === 'iniciar' && phase === 'lobby' && players.size >= 1) {
          startCountdown();

        } else if (p && msg.type === 'golpe') {
          const id = Number(msg.id);
          if (!Number.isFinite(id) || !ch) return;
          const y = Number(msg.y);
          ch.publish('acciones', 'golpe', Buffer.from(JSON.stringify({ id, player: p.name, y: Number.isFinite(y) ? y : 1 })));
        }
      } catch (e) {
        console.error(e.message);
        if (!p) joining = Math.max(0, joining - 1);
      }
    });

    ws.on('close', async () => {
      if (!p) { joining = Math.max(0, joining - 1); return; }
      players.delete(ws);
      if (ch && p.tag) { try { await ch.cancel(p.tag); } catch {} }
      broadcast({ type: 'aviso', text: `${p.name} salió de la partida` });
      broadcastState();
      if (players.size === 0) resetToLobby();
      else scheduleLobby();
    });
  });

  server.listen(PORT, () => console.log(`🎮 Servidor en http://localhost:${PORT}`));
  connectRabbit();
}

main().catch((e) => { console.error('Error fatal:', e.message); process.exit(1); });
