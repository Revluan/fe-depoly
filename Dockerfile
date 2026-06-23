# ──────────────────────────────────────────────────────────────
# 阶段 1：构建（builder）
# ──────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# 先只复制 package.json + lockfile，利用 docker 层缓存
# 只要 package*.json 没变，npm ci 这一层就命中缓存，秒级完成
COPY package.json package-lock.json ./

RUN npm ci

# 再复制源码
COPY . .

# 构建（生产模式）
RUN npm run build -- --mode production

# ──────────────────────────────────────────────────────────────
# 阶段 2：运行（runner）
# ──────────────────────────────────────────────────────────────
FROM nginx:alpine AS runner

# 设置时区（日志时间正确）
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

# 复制 nginx 站点配置
COPY nginx/conf.d/fe-depoly.conf /etc/nginx/conf.d/default.conf

# 从 builder 阶段复制构建产物到 nginx 默认目录
COPY --from=builder /app/dist /usr/share/nginx/html

# 健康检查：每 30s 拉一次 /healthz，失败 3 次标记 unhealthy
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost/healthz || exit 1

EXPOSE 80

# 前台运行 nginx（docker 必须前台运行，否则容器立即退出）
CMD ["nginx", "-g", "daemon off;"]