# juegoRabiit

Juego multijugador de cacería (3 zonas: bosque, cueva y volcán) usando **Node.js + WebSockets + RabbitMQ**.

## Stack

- **app**: Node.js (Express + `ws`) sirve el cliente y gestiona la partida.
- **rabbitmq**: `rabbitmq:3-management`, exchange `direct` `monstruos` y colas por zona.

## Ejecución local (Docker)

El compose usa la red externa `dokploy-network` (la que usa Traefik en Dokploy).
Para probar en local, créala una vez:

```bash
docker network create dokploy-network 2>/dev/null || true
docker compose up -d --build
```

Abre http://localhost:3000

Panel de RabbitMQ (solo local): http://localhost:15672 (guest / guest).

Para ver el panel en local, descomenta temporalmente el mapeo de puertos de `rabbitmq` en `docker-compose.yml`.

## Ejecución local (sin Docker)

```bash
docker compose up -d rabbitmq   # solo RabbitMQ
npm install
npm start                       # http://localhost:3000
```

### Robustez

- Reconexión automática a RabbitMQ con reintento cada 3s; al volver, recrea el
  exchange/colas y re-vincula las colas de cada jugador (no se pierde la partida).
- Los timers de expiración de monstruos se limpian al terminar la partida.
- Soportado hasta `MAX_PLAYERS = 8` jugadores simultáneos.

### Configuración de sala (anfitrión)

El primer jugador que entra es el **anfitrión**. Desde la sala de espera puede elegir:

- **Capacidad**: 2–8 jugadores (los demás quedan bloqueados si está llena).
- **Duración**: 30 s a 5 min.

La partida arranca con el botón o automáticamente al llenarse. Al terminar, se
muestran los resultados y, tras unos segundos, **se reinicia sola una nueva ronda**
con todos los datos limpios (puntos, monstruos, marcadores) para los conectados.

Variables de entorno:

| Variable   | Por defecto                          |
| ---------- | ------------------------------------ |
| `AMQP_URL` | `amqp://guest:guest@localhost:5672`  |
| `PORT`     | `3000`                               |

## Despliegue en Dokploy

1. Crea una aplicación de tipo **Docker Compose** y conecta este repositorio
   (`https://github.com/ferrosero91/juegoRabiit.git`), rama `main`.
2. Selecciona el archivo `docker-compose.yml` (raíz del repo).
3. En **Domains**, agrega un dominio apuntando al servicio **app**, puerto **3000**.
   El WebSocket (`wss`) funciona porque el cliente usa `location.host` y detecta `https`.
4. **Redespliega** tras configurar el dominio (los compose solo aplican cambios de
   dominio al recrear el contenedor).
5. (Opcional) Dominio adicional al servicio **rabbitmq**, puerto **15672** para el panel.

### Puntos críticos de Dokploy

- El servicio **app** va en la red **`dokploy-network`** (ya configurado). Si Traefik
  no ve el contenedor, la app carga pero da **502/404** aunque esté viva.
- **No** mapees `ports` al host (usamos `expose`); el dominio usa el puerto 3000.
- La app escucha en `0.0.0.0` (Express por defecto), no en `127.0.0.1`.
- Si usas la pestaña Domains de Dokploy, cada cambio requiere **redeploy**.

### Caché y verificación de despliegue

- El servidor envía `Cache-Control: no-store, no-cache, must-revalidate` + `Pragma: no-cache`
  + `Expires: 0` en **todas** las respuestas, y desactiva `ETag`/`Last-Modified`, para que
  el navegador nunca sirva un `index.html` viejo.
- Si aun así ves caché en producción, suele ser un **CDN/proxy delante** (p. ej. Cloudflare):
  purga la caché del dominio o ponlo en modo *Development*.
- Verifica qué build está sirviendo el contenedor en `GET /version`:
  `{"build":"...","uptime":...}`. El `build` también aparece en el log de arranque.
- Tras `git push`, entra a Dokploy y pulsa **Redeploy** (o activa *Auto Deploy* con webhook)
  para reconstruir la imagen; si no, seguirás viendo el build anterior.
