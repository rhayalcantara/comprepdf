# Imagen de PRODUCCIÓN del backend.
# Contexto de build = raíz del repo (ver docker-compose.yml): la imagen necesita
# también database/migrations, que el backend aplica al arrancar.

# --- etapa 1: compilar TypeScript ---
FROM node:20-alpine AS build
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# --- etapa 2: runtime solo con dependencias de producción ---
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY database/migrations ./database/migrations
RUN mkdir -p uploads outputs && chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/api/v1/health || exit 1

CMD ["node", "dist/app.js"]
