# Build stage
FROM node:24-bookworm AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY . .
ARG VITE_BUILD_HASH
ENV VITE_BUILD_HASH=$VITE_BUILD_HASH
ARG VITE_EASYSCHEMATIC_OFFICE_ORIGIN=https://schematic-mcp.tateside.online
ENV VITE_EASYSCHEMATIC_OFFICE_ORIGIN=$VITE_EASYSCHEMATIC_OFFICE_ORIGIN
RUN npm run build

# Production stage
FROM nginx:bookworm
ENV TATESIDE_API_PORT=8788
COPY docker/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
