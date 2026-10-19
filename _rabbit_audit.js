const WebSocket = require('ws');
const amqp = require('amqplib');
const http = require('http');
const { execSync } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0; const R = [];
const ok = (n, c, e = '') => { if (c) { pass++; R.push('PASS  ' + n); } else { fail++; R.push('FAIL  ' + n + '   ' + e); } };
const H = 'Basic ' + Buffer.from('guest:guest').toString('base64');

function mgmt(path) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port: 15672, path: '/api' + path, headers: { Authorization: H } }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch { res(d); } });
    });
    req.on('error', rej); req.setTimeout(4000, () => req.destroy(new Error('mgmt timeout')));
  });
}
async function waitMgmt(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { await mgmt('/overview'); return true; } catch { await sleep(500); } }
  return false;
}

class C {
  constructor(n) { this.n = n; this.ev = []; }
  connect() { return new Promise((res, rej) => { this.ws = new WebSocket('ws://localhost:3000'); this.ws.on('open', res); this.ws.on('error', rej); this.ws.on('message', r => { try { this.ev.push(JSON.parse(r)); } catch {} }); }); }
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  arr(t, p) { return this.ev.filter(e => e.type === t && (!p || p(e))); }
  find(t, p) { return this.ev.find(e => e.type === t && (!p || p(e))); }
  async wait(t, p, ms = 3000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const f = this.find(t, p); if (f) return f; await sleep(40); } return null; }
  close() { try { this.ws.close(); } catch {} }
}

let conn, ch;
async function openAmqp() {
  conn = await amqp.connect('amqp://guest:guest@localhost:5672', { heartbeat: 10 });
  conn.on('error', () => {}); conn.on('close', () => {});
  ch = await conn.createChannel();
  ch.on('error', () => {}); ch.on('close', () => {});
  await ch.assertExchange('monstruos', 'direct', { durable: false });
}
async function reopenAmqp() { try { await ch.close(); } catch {} try { await conn.close(); } catch {} await openAmqp(); }
const pubZona = (zone, payload) => { try { return ch.publish('monstruos', zone, Buffer.from(JSON.stringify(payload))); } catch { return false; } };
const mkMonster = (id, zone) => ({ type: 'monstruo', monster: { id, zone, name: 'X', icon: '🐺', points: 10, hp: 1, size: 1, speed: 1, behavior: 'normal', ttl: 8000 } });

async function section(name, fn) { try { await fn(); } catch (e) { fail++; R.push('ERROR [' + name + '] ' + e.message); } }

(async () => {
  console.log('== AUDITORÍA RabbitMQ ==\n');
  await openAmqp();

  await section('1 Topología', async () => {
    console.log('[1] Topología (API management)');
    const exM = await mgmt('/exchanges/%2F/monstruos');
    const exA = await mgmt('/exchanges/%2F/acciones');
    ok('exchange "monstruos" existe', !!exM && exM.name === 'monstruos', JSON.stringify(exM));
    ok('exchange "monstruos" es direct', exM && exM.type === 'direct', exM && exM.type);
    ok('exchange "acciones" existe', !!exA && exA.name === 'acciones');
    ok('exchange "acciones" es direct', exA && exA.type === 'direct', exA && exA.type);
    const bA = await mgmt('/exchanges/%2F/acciones/bindings/source');
    const golpeBind = Array.isArray(bA) && bA.find(b => b.destination === 'golpes' && b.routing_key === 'golpe');
    ok('exchange "acciones" enlaza cola "golpes" con key "golpe"', !!golpeBind, JSON.stringify(bA));
  });

  const P1 = new C('P1'); await P1.connect();
  await section('2 Colas por jugador', async () => {
    console.log('[2] Colas exclusivas por jugador');
    P1.send({ type: 'unirse', name: 'Uno' });
    const w1 = await P1.wait('bienvenida'); ok('P1 bienvenida con nombre de cola', !!(w1 && w1.queue), JSON.stringify(w1));
    global.P2 = new C('P2'); await global.P2.connect(); global.P2.send({ type: 'unirse', name: 'Dos' });
    const w2 = await global.P2.wait('bienvenida'); ok('P2 bienvenida con nombre de cola', !!(w2 && w2.queue));
    global.w1 = w1; global.w2 = w2;
    ok('cada jugador tiene cola distinta', w1.queue !== w2.queue);
    await sleep(400);
    const binds = await mgmt('/exchanges/%2F/monstruos/bindings/source');
    const q1b = (Array.isArray(binds) ? binds : []).filter(b => b.destination === w1.queue).map(b => b.routing_key).sort();
    ok('cola de P1 enlazada a las 3 zonas', q1b.join(',') === 'bosque,cueva,volcan', q1b.join(','));
  });

  await section('3 Enrutamiento', async () => {
    console.log('[3] Enrutamiento direct por routing key');
    const { P2, w1 } = global;
    P1.ev.length = 0; P2.ev.length = 0;
    pubZona('bosque', mkMonster(500001, 'bosque'));
    await sleep(600);
    ok('P1 recibe monstruo bosque', P1.arr('monstruo', e => e.monster.id === 500001).length === 1, 'n=' + P1.arr('monstruo', e => e.monster.id === 500001).length);
    ok('P2 recibe monstruo bosque (fanout a cada cola)', P2.arr('monstruo', e => e.monster.id === 500001).length === 1);
    ok('entrega EXACTAMENTE 1 copia a P1 (sin duplicados)', P1.arr('monstruo', e => e.monster.id === 500001).length === 1);
    P1.send({ type: 'zona', zone: 'cueva', on: false });
    await P1.wait('zonas', z => !z.zones.includes('cueva'));
    P1.ev.length = 0; P2.ev.length = 0;
    pubZona('cueva', mkMonster(500002, 'cueva'));
    await sleep(600);
    ok('P1 (cueva off) NO recibe cueva', P1.arr('monstruo', e => e.monster.id === 500002).length === 0, 'n=' + P1.arr('monstruo', e => e.monster.id === 500002).length);
    ok('P2 (cueva on) SÍ recibe cueva', P2.arr('monstruo', e => e.monster.id === 500002).length === 1);
    const binds2 = await mgmt('/exchanges/%2F/monstruos/bindings/source');
    const q1b2 = (Array.isArray(binds2) ? binds2 : []).filter(b => b.destination === w1.queue).map(b => b.routing_key).sort();
    ok('binding de P1 actualizado (2 zonas)', q1b2.join(',') === 'bosque,volcan', q1b2.join(','));
  });

  await section('4 Limpieza', async () => {
    console.log('[4] Limpieza de cola exclusiva al salir');
    const { P2, w2 } = global;
    const q2 = w2.queue;
    P2.close();
    await sleep(1500);
    let exists = true;
    for (let i = 0; i < 12 && exists; i++) { const qs = await mgmt('/queues/%2F'); exists = Array.isArray(qs) && qs.some(q => q.name === q2); if (exists) await sleep(400); }
    ok('cola de P2 eliminada al desconectar', !exists, 'queue ' + q2 + (exists ? ' aún existe' : ''));
  });

  await section('5 First-arrive-wins', async () => {
    console.log('[5] acciones/golpes: first-arrive-wins');
    P1.send({ type: 'iniciar' });
    await P1.wait('inicio', null, 6000);
    const mon = await P1.wait('monstruo', null, 8000);
    ok('monstruo del juego recibido por Rabbit', !!(mon && mon.monster), JSON.stringify(mon));
    const target = mon && mon.monster;
    if (target) {
      P1.ev.length = 0;
      for (let i = 0; i < 6; i++) { try { ch.publish('acciones', 'golpe', Buffer.from(JSON.stringify({ id: target.id, player: 'Uno', y: 0 }))); } catch {} }
      await sleep(1500);
      const der = P1.arr('derrotado', d => d.id === target.id);
      ok('exactamente 1 derrotado para el monstruo (no doble conteo por golpes simultáneos)', der.length === 1, 'n=' + der.length);
    }
    await P1.wait('fin', null, 25000);
  });

  const P3 = new C('P3'); await P3.connect();
  await section('6 Reconexión', async () => {
    console.log('[6] Reconexión tras reiniciar RabbitMQ (docker restart)');
    P3.send({ type: 'unirse', name: 'Tres' });
    await P3.wait('bienvenida');
    await sleep(400);
    try { execSync('docker restart caceria-rabbit-rabbitmq-1', { stdio: 'ignore' }); ok('rabbitmq reiniciado (docker restart)', true); }
    catch (e) { ok('rabbitmq reiniciado (docker restart)', false, e.message); }

    let recovered = false, attempts = 0, rabbitBack = false;
    for (let i = 0; i < 30 && !recovered; i++) {
      attempts++;
      if (!rabbitBack) rabbitBack = await waitMgmt(4000);
      await sleep(1200);
      try {
        await reopenAmqp();
        P3.ev.length = 0;
        pubZona('bosque', mkMonster(700000 + i, 'bosque'));
        await sleep(900);
        recovered = P3.arr('monstruo', e => e.monster.id === 700000 + i).length === 1;
      } catch { /* rabbit aún no listo */ }
    }
    ok('el servidor reconectó y re-vinculó al jugador tras el reinicio', recovered, 'intentos=' + attempts + ' rabbitBack=' + rabbitBack);
    ok('el jugador sigue recibiendo monstruos tras la reconexión', P3.arr('monstruo').length > 0);
  });

  await sleep(300);
  P3.close(); P1.close();
  await sleep(500);
  try { await ch.close(); } catch {} try { await conn.close(); } catch {}

  console.log('\n' + R.join('\n'));
  console.log(`\nRESULTADO: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('\n' + R.join('\n')); console.error('FATAL', e.message); process.exit(2); });
