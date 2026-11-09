# Serveur « Gestion des fonds » pour l'hébergement cloud (téléphones, tablettes, navigateurs).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DB_MODE=cloud PORT=3000
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY public ./public
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/api/sante || exit 1
CMD ["node", "server/index.js"]
