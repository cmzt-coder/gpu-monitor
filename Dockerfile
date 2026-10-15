# GPU 显存负载监控 · 运行时镜像
#
# 镜像里只放"运行时底座"，不打代码：代码从宿主挂载（见 docker-compose.yml 的 .:/app:ro）。
# 所以改完代码是 git pull + docker compose restart，不需要重建镜像。
#
# 为什么装这两个包：
#   util-linux  提供 dmesg，用来读内核日志里的 XID。镜像里没有它，页面只会说"读不到内核日志"
#   tzdata      让 TZ=Asia/Shanghai 在容器里解析得到（导出 CSV 的 time_local 依赖它）
#
# 基础镜像默认取 Docker Hub 官方。国内机器常常拉不动 Docker Hub（403 / 超时），
# 这时不用改这个文件：在 .env 里写一行 BASE_IMAGE=<能用的镜像源>/library/node:24-slim
# 即可（compose 会把它当 build arg 传进来），或者干脆用离线包，见 README「用 Docker 跑」。
ARG BASE_IMAGE=node:24-slim
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends util-linux tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 容器里以 root 运行是有意的：读宿主 /proc 下别人的进程、/etc/passwd、内核日志都需要，
# 换成普通用户会让「占用进程」列表变空（页面会给出权限提示）。
