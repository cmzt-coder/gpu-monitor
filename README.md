# GPU 显存负载监控

一台机器、多张显卡的显存负载实时看板。零依赖：只用 Node 内置模块 + `nvidia-smi`，不需要 Docker，不需要 `npm install`。

![界面预览](docs/preview.png)

## 功能

- 一机多卡实时曲线：每张卡一条「显存占用」曲线 + 一条「GPU 利用率」曲线，窗口默认 300 点（约 5 分钟）
- 当前占用：整机显存已用/总量、平均利用率、最高温度，以及每张卡的进度条明细
- 占用进程列表：PID / 进程名 / 显存占用 / 占该卡比例，可按 GPU 过滤（点右上角的 chip）
- 显卡运行状态：SM / 显存时钟、P-State、风扇转速、编解码占用，以及**节流原因**（功耗墙、温度墙、硬件降速…）。这一栏能回答"这张卡是真忙还是在降频"，驱动不支持的字段会自动隐藏
- 宿主系统资源：CPU 使用率、内存使用率、交换分区、系统负载、磁盘容量、网络吞吐，CPU 与内存单独一条曲线
- 一键下载：`下载 CSV` 导出 GPU 曲线原始数据，`下载系统 CSV` 导出宿主指标，`下载 JSON` 导出当前完整状态（含进程列表与宿主指标）
- 90% 警戒线、≥90% 与高温的配色告警，异常时给出可复制的排查命令
- 跨平台：同一份代码在 Linux / Windows 上自动探测 `nvidia-smi`，macOS 上明确提示"平台不支持"而不是笼统报错
- 空闲降频：页面关掉之后自动把采集间隔放慢（默认 30 秒无人访问后降到 10 秒），窗口保持连续、回来时曲线不断档

## 平台支持

启动时会自动判断当前系统与硬件环境，`nvidia-smi` 的探测顺序是：`--nvidia-smi` 指定 → `PATH` → 各平台常见安装位置。

| 平台 | 支持情况 | 采集方式 |
| --- | --- | --- |
| Linux | ✅ 完整支持 | `nvidia-smi`（`PATH`、`/usr/bin`、`/usr/local/bin`，也自动识别 WSL2 的 `/usr/lib/wsl/lib`） |
| Windows | ✅ 完整支持 | `nvidia-smi.exe`（`PATH`、`C:\Windows\System32`、`C:\Program Files\NVIDIA Corporation\NVSMI`） |
| macOS | ❌ 不适用 | NVIDIA 官方驱动已停止支持，系统里没有 `nvidia-smi`；页面会明确提示，服务本身能正常启动 |

当前只支持 NVIDIA。AMD（`rocm-smi`）、Intel（`xpu-smi`）尚未实现，探测层预留了扩展位置。

最新版的 GPU 指标（时钟 / P-State / 风扇 / PCIe / 编解码 / 节流原因）是**扩展字段**：不同驱动版本支持程度不一样，服务启动时会逐个探测，不支持的自动跳过并在页面「采集信息 → 扩展 GPU 指标」里说明。用 `--no-extended` 可以整个关掉，只保留基础指标。

### 宿主指标的可用范围

宿主指标来自 Node 内置能力加 Linux 的 `/proc`，取不到的字段会明确写「当前平台不支持」，不会用 0 冒充：

| 指标 | Linux | Windows | macOS |
| --- | --- | --- | --- |
| CPU 使用率 | ✅ | ✅ | ✅ |
| 内存使用率 | ✅（`/proc/meminfo`，用 `MemAvailable` 算已用） | ✅ | ✅ |
| 交换分区 | ✅ | ❌ | ❌ |
| 系统负载 | ✅ | ❌（Windows 没有 loadavg 语义） | ✅ |
| 磁盘容量 | ✅ | ✅（默认系统盘，可用 `--disk` 追加） | ✅ |
| 网络吞吐 | ✅（`/proc/net/dev`） | ❌ | ❌ |
| 系统运行时长 | ✅ | ✅ | ✅ |

Windows 上没有内置的网卡字节数与交换分区数据源，这两项会显示为「当前平台不支持」。macOS 上内存用系统接口取值，`free` 的统计口径与 Linux 不同，数字会偏保守。

## 快速开始

```bash
cd gpu-monitor

# 有 GPU 的机器
./start-bg.sh

# 没有 GPU 的机器上先看效果（模拟数据）
./start-bg.sh --mock
```

打开 `http://<机器IP>:8090` 即可，停止用 `./stop.sh`。也可以直接 `node server.js --port 8090` 前台跑，效果一样。

Windows 上没有 shell 脚本（`.sh` 在 Windows 上跑不了），直接在终端启动：

```powershell
node server.js --port 8090

# 需要后台常驻（关掉终端不退出）
Start-Process -WindowStyle Hidden node -ArgumentList "server.js","--port","8090"
```

停止时用任务管理器结束 node 进程，或 `taskkill /F /IM node.exe`（注意会结束所有 node 进程）。

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
| `--nvidia-smi` | 自动探测 | 手动指定 nvidia-smi；不指定时按平台依次尝试 `PATH` → `/usr/bin` → `/usr/local/bin` → WSL2 → Windows 系统目录，也可用环境变量 `NVIDIA_SMI_BIN` |
| `--disk` | 平台默认 | 额外监控的挂载点，可重复：`--disk / --disk /data`。POSIX 默认 `/`，Windows 默认系统盘 |
| `--no-system` | 关闭 | 关掉宿主 CPU / 内存 / 磁盘 / 网络采集，只留 GPU 指标 |
| `--no-extended` | 关闭 | 关掉扩展 GPU 指标（时钟 / P-State / 风扇 / PCIe / 编解码 / 节流原因） |
| `--idle-after` | `30` | 多久（秒）没有页面访问就转入空闲降频，`0` 表示不降频 |
| `--idle-interval` | `10000` | 空闲期间的采集间隔（毫秒） |
| `--mock` | 关闭 | 用模拟数据启动，便于无 GPU 环境联调 |

环境变量：`GPU_MONITOR_MOCK=1` 等价于 `--mock`；`GPU_MONITOR_MOCK_GPUS=8` 指定模拟卡数；`GPU_MONITOR_MOCK_HIGH=1` 让 0 号卡稳定在 90% 以上，用来检查告警配色。

## HTTP 接口

| 路径 | 说明 |
| --- | --- |
| `GET /api/state` | 当前状态：每张卡的显存/利用率/温度/功耗、进程列表、采集元信息 |
| `GET /api/history?limit=N` | 内存中的采样窗口，页面打开时用于回填曲线 |
| `GET /api/export.csv` | 下载曲线原始数据（每行 = 一个采样点 × 一张卡） |
| `GET /api/export.system.csv` | 下载宿主指标（每行 = 一个采样点；磁盘只导出第一个挂载点，完整明细在 JSON 里） |
| `GET /api/export.json` | 下载当前完整状态 + 采样窗口 |

`/api/state` 在原有字段之外新增了：

- `system`：宿主指标快照（`cpu` / `mem` / `swap` / `load` / `disk[]` / `net` / `uptimeSec` / `unsupported[]`）
- `fields`：扩展指标探测结果（`enabled`、`extended`、`count`、`unsupported[]`）
- `idle`：空闲降频状态（`active`、`currentIntervalMs`、`idleAfterMs`、`idleIntervalMs`）
- `systemEnabled`、`systemWarning`

原有的 `gpus`、`processes`、`platform`、`collector`、`error` 等字段语义未变，`/api/history` 的采样点新增了 `system` 字段。

## 实现说明

- 数据来源：`nvidia-smi --query-gpu=...` 取显卡指标，`nvidia-smi --query-compute-apps=...` 取占用进程，用 GPU UUID 关联
- 平台探测在 `src/platform.js`：识别系统/架构，并按平台找 `nvidia-smi`；找不到时**不阻塞服务启动**，每 30 秒自动重试一次（后装驱动、挂载显卡都不用重启服务）
- 探测结果通过 `/api/state` 的 `platform` 与 `collector` 字段暴露给页面，所以提示能区分"平台不支持"和"驱动异常"
- 数据仅保留在内存中（环形缓冲，默认 300 点），不落盘、不做历史归档；重启服务后曲线重新开始
- GPU 字段表驱动：查询构造、CSV 解析、老驱动探测都由同一张字段表生成，加一个指标只需要在 `src/nvidia.js` 的字段表里加一行
- 扩展字段逐项探测：老驱动遇到不认识的字段会让整条查询失败，所以启动时先试一次，从报错里找出不支持的字段剔除后重试，结果缓存；基础字段缺失才会真正报错
- 采集与 HTTP 分离：调度逻辑（`src/collector.js`）、宿主指标（`src/system.js`）、GPU 采集（`src/nvidia.js`）互相独立，HTTP 层只做路由与静态文件。环形缓冲是独立的 `History` 类，将来换成 SQL 落库只需要替换它
- 空闲降频是按"最近一次 HTTP 请求"判断的：超过 `--idle-after` 秒没有请求就把间隔放大到 `--idle-interval`，而不是彻底停采，这样窗口不会出现空洞
- 前端零框架、零构建：原生 `fetch` 轮询，曲线用 Canvas 手绘；页面标签页隐藏时暂停轮询
- 服务零依赖：只用 `node:http` / `node:child_process` 等内置模块，部署时不需要 `npm install`
- 仓库带 `.gitattributes`，强制 `.sh` 用 LF 换行——在 Windows 上编辑过脚本后提交，也不会把换行符改成 CRLF 而弄坏 Linux 上的执行

## 常见问题

**进程列表为空？** `nvidia-smi` 默认只能看到同一用户的进程。用 root 启动服务，或改用与业务进程相同的用户启动，页面会给出对应提示。

**端口被占用？** 启动脚本会在启动前先试绑一次端口，被占用时直接中止并打印占用者，例如：`端口 8090 已被占用（占用者：node，PID 3942127），已中止启动，例如：./start-bg.sh --port 8091`。换一个端口重跑即可；用 `node server.js` 直接起时则由服务自身报错退出。

**脚本提示"没有找到 node"？** 那台机器还没装 Node.js 18+。装完再跑；如果 node 装在非标准路径，用 `NODE_BIN=/path/to/node ./start-bg.sh` 指定。

**在 macOS 上打开？** 会提示"当前平台无法监控显存（macOS）"，这是预期行为：NVIDIA 官方驱动早已不支持 macOS，系统里没有 `nvidia-smi`。服务能正常启动，采集信息面板里会列出探测过的所有位置。

**AMD / Intel 显卡？** 当前只支持 NVIDIA（`nvidia-smi`）。新增厂商需要按 `src/platform.js` 的接口增加一个探测分支和对应的解析，解析部分可参考 `src/nvidia.js`。

**页面显示"采集失败"？** 页面会给出报错原因、平台相关的排查建议，以及"探测过的位置"清单（每个位置为什么不可用），先在服务器终端跑一次 `nvidia-smi -L` 确认能出数据。

**内存 / 网络显示"当前平台不支持"？** 这是预期行为：Windows 没有内置的交换分区与网卡字节数来源。CPU、内存、磁盘、运行时长仍然可用。

**卡片上没有时钟 / P-State / 风扇？** 说明这台机器的驱动不支持这些扩展字段，服务已经自动跳过并在「采集信息 → 扩展 GPU 指标」里列出了被跳过的字段。驱动升级后重启服务会重新探测。

**"空闲降频中"是什么？** 没有页面在访问时，服务会把采集间隔放慢到 `--idle-interval`（默认 10 秒），以降低 `nvidia-smi` 的调用开销。数据仍在采集，打开页面后会立刻恢复满速。不想降频就用 `--idle-after 0`。

**想看宿主机 CPU / 内存的历史？** 用 `下载系统 CSV`，或者 `下载 JSON` 里已经包含了完整的逐盘明细。

## 本地自检

```bash
node tools/smoke-test.mjs   # 解析 / 环形缓冲 / CSV 导出 / 模拟数据源 / 平台探测 / CRLF 解析
```
