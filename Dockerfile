# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

# Railway sets PORT; DATA_DIR should point at the mounted volume.
ENV NODE_ENV=production \
    DATA_DIR=/data

# Create the volume mount point.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000
CMD ["node", "server.js"]
