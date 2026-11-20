# ---- Stage 1: build the static site ----
FROM node:22-alpine AS build
WORKDIR /app

# Install dependencies first so Docker can cache this layer
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Typecheck and build (output goes to /app/dist)
COPY . .
RUN npm run build

# ---- Stage 2: serve it with nginx ----
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
