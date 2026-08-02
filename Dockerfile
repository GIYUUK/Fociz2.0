FROM node:20-alpine
WORKDIR /app
COPY server.js .
COPY fociz.html .
COPY manifest.json .
COPY sw.js .
EXPOSE 8080
CMD ["node", "server.js"]
