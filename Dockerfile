FROM node:22-alpine

WORKDIR /app

# Dependências primeiro (cache de camada). Sem DATABASE_URL o produto roda
# com ZERO dependências; `pg` entra aqui por ser opcional.
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORTA=8787
EXPOSE 8787

USER node

CMD ["node", "server/server.mjs"]
