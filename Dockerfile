# GPU 显存负载监控 · 运行时镜像
#
# 镜像里只放"运行时底座"，不打代码：代码从宿主挂载（见 docker-compose.yml 的 .:/app:ro）。
# 所以改完代码是 git pull + docker compose restart，不需要重建镜像。
#
# 为什么装这两个包：
#   util-linux  提供 dmesg，用来读内核日志里的 XID。镜像里没有它，页面只会说"读不到内核日志"
#   tzdata      让 TZ=Asia/Shanghai 在容器里解析得到（导出 CSV 的 time_local 依赖它）
FROM node:24-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends util-linux tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 容器里以 root 运行是有意的：读宿主 /proc 下别人的进程、/etc/passwd、内核日志都需要，
# 换成普通用户会让「占用进程」列表变空（页面会给出权限提示）。
