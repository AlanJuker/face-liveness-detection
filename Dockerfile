# Etapa 1: compilación de la aplicación Angular
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Etapa 2: servidor estático nginx
FROM nginx:1.27-alpine
# nginx ejecuta envsubst sobre los templates al arrancar, lo que permite
# usar el puerto dinámico ($PORT) que asigna Railway.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist/face-recognition-app/browser /usr/share/nginx/html
ENV PORT=80
EXPOSE 80
