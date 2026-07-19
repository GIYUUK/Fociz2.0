FROM node:20-alpine
WORKDIR /app
COPY server.js .
COPY fociz.html .
EXPOSE 8080
CMD ["node", "server.js"]
