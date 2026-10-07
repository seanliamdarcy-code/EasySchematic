# Build stage
FROM node:24-bookworm AS builder
WORKDIR /app
ARG VITE_BUILD_HASH
ENV VITE_BUILD_HASH=$VITE_BUILD_HASH
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY . .
RUN npm run build

# Production stage
FROM nginx:bookworm
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
