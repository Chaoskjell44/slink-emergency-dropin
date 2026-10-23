FROM node:26.12.1-alpine
LABEL org.opencontainers.image.title="Slink maintenance drop-in"
LABEL org.opencontainers.image.description="Temporary maintenance page for Slink; supports local or S3 image serving"

WORKDIR /app
COPY package.json server.js content.json ./
COPY public ./public/
RUN npm install --omit=dev

ENV PORT=3000
ENV IMAGES_DIR=/app/images
EXPOSE 3000

USER node
CMD ["node", "server.js"]
