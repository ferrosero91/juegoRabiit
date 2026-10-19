# juegoRabiit

Juego multijugador de cacería (3 zonas: bosque, cueva y volcán) usando **Node.js + WebSockets + RabbitMQ**.

## Stack

- **app**: Node.js (Express + `ws`) sirve el cliente y gestiona la partida.
- **rabbitmq**: `rabbitmq:3-management`, exchange `direct` `monstruos` y colas por zona.

## Ejecución local (Docker)

```bash
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

Variables de entorno:

| Variable   | Por defecto                          |
| ---------- | ------------------------------------ |
| `AMQP_URL` | `amqp://guest:guest@localhost:5672`  |
| `PORT`     | `3000`                               |

## Despliegue en Dokploy

1. Crea una aplicación de tipo **Docker Compose** y conecta este repositorio
   (`https://github.com/ferrosero91/juegoRabiit.git`), rama `main`.
2. Selecciona el archivo `docker-compose.yml` (raíz del repo).
3. En **Domains**, agrega un dominio y apóntalo al servicio **app**, puerto **3000**.
   Dokploy inyecta las etiquetas de Traefik automáticamente; el WebSocket (`wss`)
   funciona porque el cliente usa `location.host` y detecta `https`.
4. Despliega. La app espera a que RabbitMQ arranque (`depends_on`) y se conecta
   por la red interna del compose vía `amqp://guest:guest@rabbitmq:5672`.
5. (Opcional) Para exponer el panel de RabbitMQ, crea un dominio adicional
   apuntando al servicio **rabbitmq**, puerto **15672**.

> No hace falta definir red manual: Dokploy conecta los servicios a su red de Traefik.
