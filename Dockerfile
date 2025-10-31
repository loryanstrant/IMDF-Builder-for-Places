FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

RUN mkdir -p uploads projects

EXPOSE 3000

CMD ["npm", "start"]
