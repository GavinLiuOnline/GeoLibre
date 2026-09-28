# GIS 服务端（services/gis-server）多阶段构建：
# 1) build 阶段在 monorepo 内跑 esbuild 打包（产物 dist/index.js 为自包含单文件，
#    内联 @geolibre/gis-shared 源码与全部依赖，仅依赖 Node 运行时）；
# 2) runtime 阶段只带 dist/index.js + public/（/admin 管理台），零 node_modules。
# 数据目录用 DATA_DIR 指到卷（场景/资产/发布产物/托管注册表全部落盘）。
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json tsconfig.base.json ./
COPY packages/gis-shared packages/gis-shared
COPY services/gis-server services/gis-server
RUN npm install --no-audit --no-fund --cache /tmp/npmcache \
  && npm run build -w @geolibre/gis-server

FROM node:22-alpine
WORKDIR /app
COPY --from=build /src/services/gis-server/dist/index.js dist/index.js
COPY services/gis-server/public public
ENV PORT=8080 \
    DATA_DIR=/data \
    NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/index.js"]
