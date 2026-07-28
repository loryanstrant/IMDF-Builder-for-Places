FROM node:18-alpine

# tzdata lets the TZ env var resolve to a real timezone on Alpine.
RUN apk add --no-cache tzdata

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

RUN mkdir -p uploads projects

EXPOSE 3009

CMD ["npm", "start"]
