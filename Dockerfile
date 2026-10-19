FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN date -u +%Y-%m-%dT%H:%M:%SZ > BUILD

EXPOSE 3000

CMD ["node", "server.js"]
