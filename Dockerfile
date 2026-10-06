# 1단계: 클라이언트 빌드
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# 2단계: 실행. 서버는 Node의 TypeScript 타입 제거 기능으로 .ts를 바로 실행하므로 서버 빌드 단계가 없다.
FROM node:24-slim
WORKDIR /app
ENV PORT=3000 DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
VOLUME /data
EXPOSE 3000
CMD ["node", "server/main.ts"]
