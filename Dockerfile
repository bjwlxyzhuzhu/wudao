# 研思智境 / 舞安智护 —— 单容器镜像
# 说明：本镜像不安装任何第三方运行时依赖（项目零依赖），
# 但姿态识别需要 MediaPipe 前端资产，若不随构建上下文提供，
# 则在构建阶段从上游获取（需构建机可访问 registry.npmjs.org 与
# storage.googleapis.com）。获取脚本会校验 tarball 与模型的校验和。
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    YANZHI_DATA_DIR=/app/data

WORKDIR /app

# curl 仅用于容器健康检查
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY LICENSE NOTICE ./
COPY licenses ./licenses

# 构建期准备姿态资产。若构建上下文中已包含 public/vendor/mediapipe/，
# 则跳过下载（便于离线构建与内网部署）。
RUN if [ -f public/vendor/mediapipe/vision_bundle.mjs ]; then \
      echo "使用构建上下文中已提供的 MediaPipe 资产"; \
    else \
      echo "从上游获取 MediaPipe 资产…"; \
      node scripts/setup-pose-assets.mjs; \
    fi \
 && node -e "const m=require('./public/vendor/mediapipe/asset-manifest.json');console.log('MediaPipe',m.version,'model',m.model_sha256.slice(0,12))" \
 && cp -f public/vendor/mediapipe/LICENSE /app/NOTICE-mediapipe-Apache-2.0.txt 2>/dev/null || true

# 启动自检：确认服务端模块可以加载（语法/依赖问题在构建期暴露）
RUN node --check server/server.js && node --check server/dance/service.js

RUN mkdir -p /app/data \
 && chown -R node:node /app

USER node
VOLUME ["/app/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/api/health >/dev/null || exit 1

CMD ["node", "server/server.js"]
