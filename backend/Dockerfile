FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

RUN mkdir -p uploads outputs

EXPOSE 3000

CMD ["npm", "run", "dev"]
