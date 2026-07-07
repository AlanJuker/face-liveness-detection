# Etapa 1: compilación de la aplicación Angular
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Etapa 2: servidor Node (estáticos de la SPA + API de fotografías)
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY server ./server
COPY --from=build /app/dist/face-recognition-app/browser ./public
EXPOSE 3000
CMD ["node", "server/index.js"]
