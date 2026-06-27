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

# Create the data directory. On Railway, attach a Volume with mount path /data
# (the Dockerfile VOLUME instruction is not supported by Railway's builder).
RUN mkdir -p /data

EXPOSE 3000
CMD ["node", "server.js"]
