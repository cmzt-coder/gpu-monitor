# 部署与常驻

> 从「把代码放到服务器上」到「重启后自己起来」：预检、Node 版本、时区，以及四种常驻方式（前台 / 脚本 / systemd / cron 看门狗 / Docker）与健康检查。
> README 里有一份 30 秒版快速开始，本文是完整版。

## 快速开始

```bash
cd gpu-monitor

# 先体检一遍：Node 版本、nvidia-smi、驱动支持的扩展字段、宿主指标、磁盘空间、端口
node tools/preflight.mjs

# 有 GPU 的机器
./start-bg.sh

# 没有 GPU 的机器上先看效果（模拟数据）
./start-bg.sh --mock
```

打开 `http://<机器IP>:8090` 即可，停止用 `./stop.sh`。也可以直接 `node server.js --port 8090` 前台跑，效果一样。

### 部署前自检

`node tools/preflight.mjs` 会把"这台机器能不能跑、能跑成什么样"先体检一遍。它只读为主——不会建库、不会改配置，只在判断端口占用时临时绑定一下再立刻释放。最后给出结论与建议的启动命令，有阻塞项时退出码为 1，可以直接接进部署脚本。

```bash
node tools/preflight.mjs
node tools/preflight.mjs --port 8090 --db /opt/gpu-monitor/data/gpu-monitor.db
node tools/preflight.mjs --nvidia-smi /usr/local/bin/nvidia-smi   # 手动指定采集命令
```

检查项：Node 版本够不够开历史库、`nvidia-smi` 在不在、**这台机器的驱动支持哪些扩展字段**（不支持的逐条列出）、显卡与占用进程能否读到、宿主 CPU/内存/磁盘/网络哪些可用、历史库目录与剩余空间（按卡数估算一年体积）、告警配置有没有问题、端口是否被占用。

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

### Node 版本与升级（不动服务器上的其他项目）

两条底线：

- **Node 18+** 就能跑，实时监控、曲线、告警都正常；
- **Node 22.13+** 才有内置的 `node:sqlite`，才有历史库、长时间范围曲线、进程占用历史和长周期告警。

推荐**旁装**：把新版 Node 解到 `/opt` 单独给本项目用，完全不碰系统里的 `node`，因此对服务器上其他项目零影响。

```bash
# 0. 先看清现状：当前 node 在哪、是谁装的
which -a node && node -v
readlink -f "$(command -v node)"
dpkg -S "$(readlink -f "$(command -v node)")" 2>/dev/null || echo "不是 apt/dpkg 装的"

# 1. 下载官方二进制（x86_64；ARM 机器把 linux-x64 换成 linux-arm64）
#    国内网络慢就把域名换成 https://npmmirror.com/mirrors/node/
cd /tmp
curl -fsSLO https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz

# 2. 装到 /opt/node24，与系统 node 完全隔离
sudo mkdir -p /opt/node24
sudo tar -xJf node-v24.21.0-linux-x64.tar.xz -C /opt/node24 --strip-components=1
/opt/node24/bin/node -v          # 应输出 v24.21.0

# 3. 让 gpu-monitor 用这个 node 启动，系统 node 保持原样
SMTP_PASS=... ./start-bg.sh --node /opt/node24/bin/node
```

`--node` 也可以写成环境变量：`NODE_BIN=/opt/node24/bin/node ./start-bg.sh`。启动横幅第一行会打印实际用的 node 路径，重启后核对一下即可。换成 systemd 常驻时，把单元里 `ExecStart=` 的 node 路径一并改掉（见 [deploy/gpu-monitor.service](../deploy/gpu-monitor.service)）。

**为什么不直接把系统 node 升级掉？** 那是一次全局替换，会波及服务器上所有用 node 的东西：

| 影响面 | 怎么确认 |
| --- | --- |
| pm2 / forever 托管的应用会被新 node 重新拉起 | `pm2 list`、`which pm2` |
| systemd 单元里写死 node 路径的服务 | `systemctl list-units --type=service`，再筛 node |
| 编译过原生模块的项目（node-gyp、better-sqlite3 之类），Node ABI 一换就得重装依赖 | 项目里有没有 `node_modules` 下的 `.node` 文件 |
| 依赖旧 Node 行为的老构建链（老 webpack、node-sass…） | 各项目自己的构建 |

盘点一下现在到底有哪些 node 在跑：

```bash
ps -eo user,pid,cmd | grep -i '[n]ode'
```

确认没人依赖之后，再考虑原地升级。不同安装方式的升级手法不一样：`apt` 装的（Ubuntu 24.04 自带的 18.19.1 就是）通常要换 NodeSource 源再 `sudo apt-get install -y nodejs`，替换的是 `/usr/bin/node`，影响全局；`nvm` 装的用 `nvm install 24 && nvm alias default 24`，只影响 source 过 nvm 的交互式 shell，systemd 服务不受影响。

还有一点要有预期：**换上带 `node:sqlite` 的 Node 之后，历史库是从零开始攒的**，刚切过去时「3 天 / 7 天 / 30 天」这些区间只有从切换那一刻起的数据。

### 时区（导出的时间差几小时，就查这里）

云主机的系统时区默认常常是 **UTC**（`ls -l /etc/localtime` 会看到 `-> /usr/share/zoneinfo/Etc/UTC`），而用页面的人在东八区。这时导出的 `time_local` 会和 `timestamp_iso` 一模一样——看着像"修复没生效"，其实是这台机器的本地时间本来就是 UTC。

```bash
# 先确认是哪种情况
date '+%Z %z'
node -e 'console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)'
```

要固定成本地时间，推荐一次性写进配置文件（后面不用再管）：

```bash
cd /opt/gpu-monitor
cp gpu-monitor.conf.example gpu-monitor.conf
echo 'TZ=Asia/Shanghai' >> gpu-monitor.conf
chmod 600 gpu-monitor.conf          # 里面可能还有邮箱密码
```

之后 `./start-bg.sh --node /opt/node24/bin/node` 不带任何参数就是东八区。临时想换一种（比如排查问题时按 UTC 看一遍）也没问题，显式给的永远优先：

```bash
TZ=UTC ./start-bg.sh                # 这一次按 UTC 跑，不改配置文件
```

也可以单次直接给：

```bash
SMTP_PASS='你的授权码' ./start-bg.sh --node /opt/node24/bin/node --tz Asia/Shanghai
```

它**只改 gpu-monitor 这个进程的时区**：导出里的 `time_local`、CSV 文件名里的时间戳、日志时间都会跟着走。系统时区一个字节都不动，所以**这台机器上跑着的其他服务完全不受影响**——这也是为什么不要用 `sudo timedatectl set-timezone Asia/Shanghai` 去改：那会波及所有依赖 UTC 的服务（数据库、日志、调度器），改完才发现就晚了。

等价写法有三种，任选其一：

| 方式 | 写法 | 适用 |
| --- | --- | --- |
| 配置文件 | `gpu-monitor.conf` 里写一行 `TZ=Asia/Shanghai` | **一次配好，以后启动不用带参数**，见下面「本机部署配置」 |
| 启动参数 | `./start-bg.sh --tz Asia/Shanghai` | 临时或单次使用最直观 |
| 环境变量 | `TZ=Asia/Shanghai ./start-bg.sh` | Node 原生支持，写进自己的重启脚本也方便 |
| systemd | 单元里加 `Environment=TZ=Asia/Shanghai` | 走 systemd 托管时用（模板里有注释示例） |

启动横幅和页面上的导出弹窗都会写明**当前生效的时区**；如果时区还是 UTC 且没有显式固定，启动横幅会直接提示该怎么改——不会让你自己去猜为什么时间对不上。

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

### 本机部署配置（gpu-monitor.conf）

放"只属于这台机器"的值：时区、邮箱密码、端口、node 路径。项目根目录的 `gpu-monitor.conf` **不进版本库**（模板是 `gpu-monitor.conf.example`），所以每台机器各配一份，`git pull` 不会互相覆盖、也不会把密码提交上去。

```bash
cd /opt/gpu-monitor
cp gpu-monitor.conf.example gpu-monitor.conf
chmod 600 gpu-monitor.conf
$EDITOR gpu-monitor.conf
```

文件就是普通的 `KEY=VALUE` 行，`#` 开头是整行注释。常用几项：

| 键 | 作用 |
| --- | --- |
| `TZ` | 固定本服务时区，导出时间列 / CSV 文件名 / 日志时间都跟着走（见上面的「时区」一节） |
| `SMTP_PASS` | 告警邮件密码。`alerts.json` 里写 `${SMTP_PASS}` 占位，值放这里，就不必每次启动都在命令行上带一遍 |
| `PORT` / `INTERVAL` / `WINDOW` | 等价于同名启动参数的默认值 |
| `NODE_BIN` | 指定 node 路径，等价于 `--node` |

**优先级**：命令行/环境里显式给的 **>** 配置文件 **>** 内置默认。所以 `PORT=9000 ./start-bg.sh` 一定覆盖配置文件里的 `PORT`，排查问题时不会被"藏起来的默认值"绊住。

两点说明：

- 只有 `./start-bg.sh` / `./start.sh` 会读它。直接 `node server.js` 时不读——那种用法请用 `--tz` 或 `TZ=` 环境变量。
- 想临时指到别处的配置，用 `GPU_MONITOR_CONF=/path/to/other.conf ./start-bg.sh`。

### 开机自启（systemd，可选）

脚本方式能扛住 SSH 断开，但机器重启后不会自己起来。仓库里带了单元模板 [deploy/gpu-monitor.service](../deploy/gpu-monitor.service)：

```bash
sudo cp deploy/gpu-monitor.service /etc/systemd/system/
sudoedit /etc/systemd/system/gpu-monitor.service    # 按注释里标【改】的地方调整路径
sudo systemctl daemon-reload
sudo systemctl enable --now gpu-monitor
journalctl -u gpu-monitor -f
```

模板里已经处理好的几件事：

- **默认用 root 运行**：`nvidia-smi` 只能看到同一用户的占用进程，换成专用用户后页面上的进程列表会是空的。想最小权限就改成与业务进程相同的用户，效果一样。
- **邮件密码走环境文件**（`EnvironmentFile=-/etc/gpu-monitor.env`），不必写进 `alerts.json`；配了 `${SMTP_PASS}` 占位就必须提供这个变量，否则邮件发不出去。
- **停止时会把缓冲区落盘**（`KillSignal=SIGTERM` + `TimeoutStopSec=15`），不会丢最后几秒的数据。
- 附带了基础加固（`ProtectSystem=full`、`ProtectHome=read-only` 等）；历史库若放在别处，按注释放开 `ReadWritePaths`。

> 手动启动过的话，先用 `./stop.sh` 停掉再交给 systemd，避免两边抢同一个端口。

### 开机自启（没有 root 时：cron 看门狗）

机器上你没有 root（装不了 systemd 服务），或者不想为了自启引入 Docker，用三行 cron 也能拿到**开机自启 + 崩溃后自己起来 + 日志不涨**。它靠的是 `start-bg.sh` 自带的一个性质：**已经在跑就拒绝启动**（先看 PID 文件，再试绑端口），所以重复执行是安全的，不会起出两个实例。

> ⚠️ **装了这个之后，「停掉服务」的含义变了。** `./stop.sh` 之后最多 5 分钟，看门狗会把它重新拉起来。要真正停住（改配置、切换部署方式、排查问题），必须先暂停看门狗：`touch .run/pause` 停掉，干完活 `rm .run/pause` 再按需启动。不知道这条的人会看到「明明停了它又自己回来了」，很容易误判成服务有问题——**这一点请在交接时明确交代。**

```cron
# 开机自启
@reboot cd /opt/gpu-monitor && mkdir -p .run && ./start-bg.sh >> .run/cron.log 2>&1
# 看门狗：每 5 分钟看一次，没在跑就拉起来（存在 .run/pause 时跳过）
*/5 * * * * cd /opt/gpu-monitor && [ -f .run/pause ] || ./start-bg.sh >/dev/null 2>&1
# 日志只追加、不切割，每月 1 号清空一次（进程按追加方式写，清空后从新位置继续）
0 4 1 * * : > /opt/gpu-monitor/gpu-monitor.log
```

把 `/opt/gpu-monitor` 换成项目实际路径即可。安装与验证：

```bash
crontab -l > /tmp/crontab.bak.$(date +%Y%m%d)   # 先备份现有的 crontab
crontab -e                                      # 粘贴上面三行
crontab -l                                      # 复核，确认原有任务没被覆盖

# 验证看门狗（不用重启机器）：杀掉它，等 5 分钟看有没有自己回来
kill "$(cat /opt/gpu-monitor/.run/gpu-monitor.pid)"
cat /opt/gpu-monitor/.run/gpu-monitor.pid       # 5 分钟后应该是一个新 PID
curl -s -o /dev/null -w 'health %{http_code}\n' http://127.0.0.1:8090/api/health
```

两个容易踩的点：

- **cron 的 PATH 很干净**（通常只有 `/usr/bin:/bin`）。所以 `gpu-monitor.conf` 里的 `NODE_BIN=` 务必写成绝对路径，否则定时任务可能找不到 node。
- **三种常驻方式三选一**：systemd、Docker、这里的 cron 看门狗。别叠加——虽然 `start-bg.sh` 的端口检查会拦住第二个实例，但两边的重启策略会互相打架、日志也会吵。切换部署方式时记得 `crontab -e` 把那三行删掉。

> 这种方式**不额外授予任何权限**，所以它改变不了 XID 能不能读：那取决于运行用户有没有权限（见 [alerts.md](alerts.md) 的「硬件健康」一节）。如果当前用户读不到内核日志，用 cron 也照样读不到——那种情况走上一条 systemd（用 `SupplementaryGroups=` 精确授权），或者让管理员把运行用户加进 `adm` / `systemd-journal` 组。

### 用 Docker 跑（可选）

不想在宿主上装 Node、或者希望"升级 = 改挂载 + 重启容器"，可以用仓库自带的编排。镜像里只有运行时底座（Node 24 + `dmesg` + 时区数据），**代码不打进镜像**、从宿主只读挂载，所以 `git pull` 后 `docker compose restart` 就生效，不需要重建。

```bash
cp .env.example .env        # 填 SMTP_PASS；8 卡机器再加 INTERVAL=3000
cp inference.example.json inference.json   # 页面配置会写这个文件；先复制，避免 Docker 创建同名目录
docker compose up -d --build
docker compose logs -f
docker compose exec gpu-monitor node tools/notify-test.mjs     # 验邮件通道
```

需要在页面里编辑推理服务时，在 `.env` 设置随机长字符串 `GPU_MONITOR_ADMIN_TOKEN` 后重建容器。`inference.json` 是唯一单独放开读写权限的文件，代码目录仍然只读挂载。

难点只有一个：**这个看板的工作是"看透宿主"，所以容器拿到的权限比一般容器多**，`docker-compose.yml` 里逐条写了各自为了什么：

| 配置 | 为了什么 |
| --- | --- |
| `pid: host` | 占用进程表与「服务归属」要读宿主 `/proc/<pid>`；少了它，nvidia-smi 报的是宿主 PID，容器里找不到 |
| `uts: host` | 主机名用宿主的。容器默认的 hostname 是容器 ID，会被当成"主机标识"写进页面和历史库，重建容器还会变一次 |
| `network_mode: host` | 直接监听宿主 8090，行为和脚本方式一致（反代 / SSE 都不受影响） |
| `cap_add: [SYSLOG]` + `/dev/kmsg` | 读内核日志拿 XID（`kernel.dmesg_restrict=1` 时非 CAP_SYSLOG 读不到） |
| `/etc/passwd`、`/etc/group`、`/var/lib/docker` 只读挂载 | PID → 用户名、容器 ID → 容器名（挂目录而不是 `docker.sock`，不给容器 docker 控制权） |
| `/:/hostfs:ro` + `--disk /hostfs=/` | 磁盘容量要真实挂载点的 `statfs`；容器自己的 `/` 是 overlay 层，报它没意义。`路径=显示名` 是为了让页面照实显示 `/`，而不是容器里的 `/hostfs` |
| `deploy.reservations.devices` | nvidia-smi 来自宿主驱动，需要 NVIDIA Container Toolkit |

也就是说：这个容器不是隔离沙箱，它和"在宿主上用 root 跑一个服务"的安全边界差不多——真正的边界是"谁能访问 8090"。**顺带一个好处**：XID 不用再单独配权限（容器以 root 跑且带 `CAP_SYSLOG`），systemd 方案里那句 `SupplementaryGroups=adm` 在这里就不需要了。

宿主上的差异（端口 / 采集间隔 / 时区 / 邮件密码 / 监控哪个磁盘）全放 `.env`，不进版本库。历史库仍在宿主 `./data` 下，只是属主会变成 root——**回滚回脚本方式前记得 `sudo chown -R <用户>:<用户组> data`**。

**拉不动基础镜像怎么办（国内很常见）**：`docker compose build` 报 403、超时或 `failed to resolve source metadata`，是镜像源的问题，不是代码的问题。两条路：

1. **换源**：在 `.env` 里写一行，Dockerfile 不用改——
   `BASE_IMAGE=docker.m.daocloud.io/library/node:24-slim`（或 `docker.1panel.live/library/node:24-slim` 等任何能用的源前缀）。
2. **离线包**（一个源都不通时）：在能联网的机器上构建好再拷过去。注意架构要和服务器的 CPU 一致，服务器是 x86_64 就加 `--platform linux/amd64`：

   ```bash
   # 联网的机器上
   docker buildx build --platform linux/amd64 -t gpu-monitor-runtime:latest --load .
   docker save gpu-monitor-runtime:latest | gzip > gpu-monitor-runtime.tar.gz
   # 目标服务器上
   gunzip -c gpu-monitor-runtime.tar.gz | docker load
   docker compose up -d          # 本地已有镜像，不会再联网
   ```

### 健康检查

`GET /api/health` 返回 `200`（健康，或只有提醒）或 `503`（有致命项），body 里逐项列出采集、历史库、磁盘、告警的状态：

```bash
curl -s localhost:8090/api/health
curl -s -o /dev/null -w '%{http_code}\n' localhost:8090/api/health
```

它判定的是"服务本身还能不能干活"——采集是否新鲜（阈值会跟着空闲降频自动放宽）、历史库是否可写、磁盘还剩多少；显存高、温度高这类业务告警只作为信息回报，不会让服务变成不健康。探活请求不会打断空闲降频，所以可以放心接到定时探测上（`curl -fsS` 直接接现有监控即可）。

