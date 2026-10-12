# GPU 显存负载监控

一台机器、多张显卡的显存负载实时看板。零依赖：只用 Node 内置模块 + `nvidia-smi`，不需要 Docker，不需要 `npm install`。

![界面预览](docs/preview.png)

## 功能

- 一机多卡实时曲线：每张卡一条「显存占用」曲线 + 一条「GPU 利用率」曲线，窗口默认 300 点（约 5 分钟）
- 当前占用：整机显存已用/总量、平均利用率、最高温度，以及每张卡的进度条明细
- 占用进程列表：PID / 进程名 / 显存占用 / 占该卡比例，可按 GPU 过滤（点右上角的 chip）
- 一键下载：`下载 CSV` 导出曲线原始数据，`下载 JSON` 导出当前完整状态（含进程列表）
- 90% 警戒线、≥90% 与高温的配色告警，异常时给出可复制的排查命令

## 快速开始

```bash
cd gpu-monitor

# 有 GPU 的机器
./start-bg.sh

# 没有 GPU 的机器上先看效果（模拟数据）
./start-bg.sh --mock
```

打开 `http://<机器IP>:8090` 即可，停止用 `./stop.sh`。也可以直接 `node server.js --port 8090` 前台跑，效果一样。

## 部署到服务器

```bash
# 1. 把 gpu-monitor 目录拷到服务器（scp / rsync 都行）
scp -r gpu-monitor user@server:/opt/

# 2. 在服务器上启动（前台跑，Ctrl+C 退出）
cd /opt/gpu-monitor
node server.js --port 8090
```

默认监听 `0.0.0.0`，局域网内用 `http://<服务器IP>:8090` 访问。

## 启动脚本

项目根目录自带三个脚本，参数和 `server.js` 完全一致：

| 脚本 | 作用 |
| --- | --- |
| `./start.sh` | 前台启动，日志直接打在终端，`Ctrl+C` 结束 |
| `./start-bg.sh` | 后台启动（nohup），PID 写入 `.run/gpu-monitor.pid`，日志追加到 `gpu-monitor.log` |
| `./stop.sh` | 停止后台服务，先 SIGTERM 优雅退出，10 秒内没退出再 SIGKILL |

```bash
./start-bg.sh                                 # 默认 8090
./start-bg.sh --port 8081                     # 换端口
NODE_BIN=/usr/local/bin/node ./start-bg.sh    # 指定 node 路径
tail -f gpu-monitor.log                       # 实时看日志
./stop.sh                                     # 停止
```

脚本的默认端口是 **8090**（`server.js` 自身默认还是 8080，脚本会显式传 `--port`，所以以 8090 为准）。

上传后如果可执行位丢了，先 `chmod +x *.sh`，或者用 `bash start-bg.sh` 直接跑。脚本会自己检查 node 是否存在及版本、端口是否被占用、服务是否已在运行、PID 文件是否过期，出问题会直接给中文提示。端口检查是直接让 node 试绑一次端口，被占用时**立即中止启动**（不会把服务拉起来），并打印占用端口的进程和可换的端口号。

### 开机自启（systemd，可选）

脚本方式能扛住 SSH 断开，但服务器重启后不会自己起来。需要开机自启就用 systemd：

```bash
sudo tee /etc/systemd/system/gpu-monitor.service > /dev/null <<'EOF'
[Unit]
Description=GPU memory load monitor
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/gpu-monitor
ExecStart=/usr/bin/node /opt/gpu-monitor/server.js --port 8090
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now gpu-monitor
```

> `ExecStart` 里的 node 路径用 `which node` 的结果替换；如果手动启动过，先用 `./stop.sh` 停掉，避免和 systemd 抢同一个端口。

## 启动参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--port` / `-p` | `8090` | 监听端口（启动脚本的默认值；直接跑 `server.js` 时默认 8080），也可用环境变量 `PORT` |
| `--host` | `0.0.0.0` | 监听地址，也可用环境变量 `HOST` |
| `--interval` | `1000` | 采集间隔（毫秒） |
| `--window` | `300` | 内存中保留的采样点数，即页面曲线窗口 |
| `--nvidia-smi` | `nvidia-smi` | nvidia-smi 路径，也可用环境变量 `NVIDIA_SMI_BIN` |
| `--mock` | 关闭 | 用模拟数据启动，便于无 GPU 环境联调 |

环境变量：`GPU_MONITOR_MOCK=1` 等价于 `--mock`；`GPU_MONITOR_MOCK_GPUS=8` 指定模拟卡数；`GPU_MONITOR_MOCK_HIGH=1` 让 0 号卡稳定在 90% 以上，用来检查告警配色。

## HTTP 接口

| 路径 | 说明 |
| --- | --- |
| `GET /api/state` | 当前状态：每张卡的显存/利用率/温度/功耗、进程列表、采集元信息 |
| `GET /api/history?limit=N` | 内存中的采样窗口，页面打开时用于回填曲线 |
| `GET /api/export.csv` | 下载曲线原始数据（每行 = 一个采样点 × 一张卡） |
| `GET /api/export.json` | 下载当前完整状态 + 采样窗口 |

## 实现说明

- 数据来源：`nvidia-smi --query-gpu=...` 取显卡指标，`nvidia-smi --query-compute-apps=...` 取占用进程，用 GPU UUID 关联
- 数据仅保留在内存中（环形缓冲，默认 300 点），不落盘、不做历史归档；重启服务后曲线重新开始
- 前端零框架、零构建：原生 `fetch` 轮询，曲线用 Canvas 手绘；页面标签页隐藏时暂停轮询
- 服务零依赖：只用 `node:http` / `node:child_process` 等内置模块，部署时不需要 `npm install`

## 常见问题

**进程列表为空？** `nvidia-smi` 默认只能看到同一用户的进程。用 root 启动服务，或改用与业务进程相同的用户启动，页面会给出对应提示。

**端口被占用？** 启动脚本会在启动前先试绑一次端口，被占用时直接中止并打印占用者，例如：`端口 8090 已被占用（占用者：node，PID 3942127），已中止启动，例如：./start-bg.sh --port 8091`。换一个端口重跑即可；用 `node server.js` 直接起时则由服务自身报错退出。

**脚本提示"没有找到 node"？** 那台机器还没装 Node.js 18+。装完再跑；如果 node 装在非标准路径，用 `NODE_BIN=/path/to/node ./start-bg.sh` 指定。

**AMD / Intel 显卡？** 当前只支持 NVIDIA（`nvidia-smi`）。换成 `rocm-smi` 需要改 `src/nvidia.js` 里的采集与解析。

**页面显示"采集失败"？** 页面会给出报错原因和一条可直接复制的 `nvidia-smi` 命令，先在服务器终端跑一次确认能出数据。

## 本地自检

```bash
node tools/smoke-test.mjs   # 解析 / 环形缓冲 / CSV 导出 / 模拟数据源
```
