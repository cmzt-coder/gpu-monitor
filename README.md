# GPU 显存负载监控

一台机器、多张显卡的显存负载实时看板。零依赖：只用 Node 内置模块 + `nvidia-smi`，不需要 Docker，不需要 `npm install`。

![界面预览](docs/preview.png)

## 功能

- 一机多卡实时曲线：每张卡一条「显存占用」曲线 + 一条「GPU 利用率」曲线，窗口默认 300 点（约 5 分钟）
- **服务显存曲线**：把占卡进程按服务（容器 / systemd 单元 / 用户会话）汇总成一条曲线，最多画占用最高的 5 个、其余并入「其他」。一张卡被多个服务共用时，这张图能回答"是谁在什么时候把显存吃上去的"，比整卡百分比有用得多
- 当前占用：整机显存已用/总量、平均利用率、最高温度，以及每张卡的进度条明细
- 占用进程列表：PID / 进程名 / **服务归属** / 显存占用 / 占该卡比例，可按 GPU 过滤（点右上角的 chip）
- 进程占用历史：按"进程身份变化 + 每 5 分钟快照"留档，可以回答"谁在什么时候占上了哪张卡"（可选 1 小时 / 24 小时 / 7 天 / 30 天）
- 显卡运行状态：SM / 显存时钟、P-State、风扇转速、编解码占用，以及**节流原因**（功耗墙、温度墙、硬件降速…）。这一栏能回答"这张卡是真忙还是在降频"，驱动不支持的字段会自动隐藏
- 宿主系统资源：CPU 使用率、内存使用率、交换分区、系统负载、磁盘容量、网络吞吐，CPU 与内存单独一条曲线
- 一键下载：`下载 CSV` 导出 GPU 曲线原始数据，`下载系统 CSV` 导出宿主指标，`下载 JSON` 导出当前完整状态（含进程列表与宿主指标）
- 历史存档：按 SQLite 落库（`data/gpu-monitor.db`），重启不丢；页面顶部可切 实时 / 3 天 / 7 天 / 30 天 / 60 天 / 90 天 / 全部，导出会跟着当前选择走（切到历史区间时曲线是历史值，顶部指标与右侧卡片仍是当前实时值，界面上会标注清楚）
- 实时推送：默认用 SSE 把每一帧推给浏览器，比轮询更省；推送不可用时自动退回轮询（`--no-push` 可强制关掉）
- 告警：显存 / 温度 / 节流 / 利用率 / 宿主内存 / 磁盘 / 采集中断都能配阈值，还能**按服务**（哪个容器、哪个 systemd 单元占了多少）单独设规则；支持"持续多久才算触发"和冷却抑制；通知渠道内置**邮件**、Webhook 和控制台日志
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

### 历史库

历史存在 SQLite 里，用的是 Node 22.13+ 默认提供的 `node:sqlite`，**依然不需要 `npm install`**。Node 版本低于 22.13（`node:sqlite` 在 22.5 才首次引入，而且直到 22.13 都还要额外加 `--experimental-sqlite` 参数）或者带了 `--no-db` 时，服务照常运行，只是页面会明确写「未启用历史库」，`/api/history?range=…` 会退回内存窗口并说明原因。

### 进程的「服务归属」是怎么来的

「当前占用进程」和「进程占用历史」两张表里都有一列**服务**，按这个顺序判断（Linux 上读 `/proc`，其它平台留空）：

1. **容器** —— 读 `/proc/<pid>/cgroup` 拿到容器 ID。这是共享机器上最有用的那一级：像 vLLM 会把进程标题改写成 `VLLM::EngineCore`，光看命令行根本分不出是哪个服务，但 cgroup 里的容器 ID 能唯一确定它属于哪个容器。
2. **systemd 单元** —— 例如 `train.service`。
3. **用户会话** —— 从终端/IDE 直接跑起来的进程（`session-N.scope`、`user@1000.service`）。
4. 都不是就留一个 `–`，不编造服务名。

鼠标悬停在服务那一格上会显示**运行用户**和**完整命令行**——判断"这个进程能不能动"时通常最需要这两条信息。

两个需要知道的限制：

- **容器名需要一点权限**。容器 ID 谁都能读，但从 ID 反查容器名要读 `/var/lib/docker/containers/<id>/config.v2.json`（root）或调 `docker inspect`（在 docker 组里）。拿不到名字时会显示**容器 ID 的前 12 位**——同一个容器的进程仍然会显示同一个值，你拿它跟 `docker ps` 一对比就知道是哪个容器。用 root 跑服务（systemd 模板默认就是）时名字会自动出来。
- **`/proc` 读不到就留空**。某些加固内核设了 `hidepid`，或进程属于你无权查看的用户时，这一列会是 `–`；采集本身不受影响。

想确认这台机器能解析到什么程度，随便挑一个占卡进程试一下：

```bash
p=<一个占卡的 PID>
head -1 /proc/$p/cgroup          # 有 docker-...scope 就说明是容器
stat -c '%U' /proc/$p            # 运行用户
tr '\0' ' ' < /proc/$p/cmdline   # 完整命令行
```

两个刻意的设计：

- **落库粒度与页面刷新解耦**：屏幕上看 1 秒粒度（`--interval`），库里按 `--store-interval`（默认 5 秒）抽稀。体积差 5 倍，历史趋势几乎无损失。
- **进程按事件留档**：只在进程身份变化时写一行（相当于"谁在什么时候占上了卡"），另外每 5 分钟补一次快照，不再逐采样点刷重复行。

- **默认永久保留**：历史留着才翻得回去，而按天清理是静默的数据丢失，所以默认不清。要给个上限就加 `--retention-days <天>`（超过的行会在启动时和之后每小时清一次）。

体积参考：单卡 5 秒粒度约 7 MiB/天，一年 2.5 GiB；8 张卡一年约 20 GiB。实际大小在页面「采集信息 → 历史库」里能看到，嫌大就调大 `--store-interval`。

#### 库文件的长期维护

新建的库默认开启 SQLite 的**增量回收**：每小时清理过期数据时，会把释放出来的页还给文件系统，同时截断 WAL 日志。所以给了 `--retention-days` 之后，稳态运行（写入速率恒定、保留期固定）下文件大小会自己稳定下来，不需要额外操作。默认的永久保留模式下没有"过期数据"可清，文件就是随数据一直长。

需要手动处理的是"水位变化"的情况——调大了 `--store-interval`，或者给 `--retention-days` 设了天数后又改小。这时文件会停在历史最高水位，删掉的空间不会自动还回来：

```bash
node tools/db-maintenance.mjs            # 看状态：数据范围、文件大小、可回收空间、回收是否开启
node tools/db-maintenance.mjs --prune --retention-days 30   # 清一次 30 天前的数据（不给天数不会删任何行）
node tools/db-maintenance.mjs --reclaim  # 整库重写，把可回收空间还给文件系统
```

`--reclaim` 会重写整个文件，大库需要一点时间和等量磁盘空间，建议放在维护窗口做。也可以直接用 `node server.js --reclaim` 在启动时做一次同样的重写。页面「采集信息 → 历史库」里可回收空间超过 32 MB 时会把它标出来。

### 告警

告警规则和通知渠道都写在同一个配置文件里，从示例复制一份开始：

```bash
cp alerts.example.json alerts.json
${EDITOR:-vi} alerts.json     # 改 SMTP 地址与收件人
./start-bg.sh                 # 服务启动时会自动读取 alerts.json
```

规则长这样：

```json
{ "id": "vram-high", "metric": "memUsedPct", "op": ">=", "threshold": 90, "for": "2m", "level": "warning" }
```

- `for`：条件要**持续**满足这么久才算触发，避免瞬时抖动就发信；单位 `s` / `m` / `h`，纯数字按秒算
- `cooldown`（写在配置顶层，默认 10 分钟）：同一条告警在这段时间内不重复通知
- `historyCache`（写在配置顶层，默认 30 秒）：长周期规则查历史库的缓存周期
- `minSamples`（可选，默认 2）：判定"持续满足"至少要看几个采样点；`for` 比采集间隔还短时会自动放宽到 1 个，避免规则时灵时不灵
- `level`：`warning` 或 `critical`，只影响文案与邮件主题

可用的 `metric`：

| 指标 | 范围 | 说明 |
| --- | --- | --- |
| `memUsedPct` / `memUsedMiB` | 每张卡 | 显存占用率 / 占用容量 |
| `utilGpuPct` / `utilMemPct` | 每张卡 | GPU 利用率 / 显存带宽占用 |
| `tempC` / `powerW` | 每张卡 | 温度 / 功耗 |
| `throttled` | 每张卡 | 布尔值，`{"op": "==", "value": true}` 表示"出现任何节流原因" |
| `hostCpuPct` / `hostMemUsedPct` / `hostSwapUsedPct` / `hostDiskUsedPct` | 整机 | 宿主指标，磁盘取所有挂载点里最满的那个 |
| `serviceMemMiB` | 每个服务 | 该服务占用的显存合计（服务 = 容器 / systemd 单元 / 用户会话，见上面的「服务归属」） |
| `serviceSharePct` | 每个服务 | 该服务占用占整机显存总量的比例（多张卡时按各卡总量之和算） |
| `collectOk` | 服务 | 布尔值，`{"value": false}` 表示采集中断（至少持续 30 秒才触发） |

**一张卡被多个服务共享时，服务维度的规则比整卡阈值有用得多。** 整卡只能告诉你"这张卡快满了"，服务维度能告诉你"是谁快把卡吃满了"：

```json
{ "id": "vllm-embed-vram", "metric": "serviceMemMiB", "service": "vllm-embed",
  "op": ">=", "threshold": 10240, "for": "2m", "level": "warning" }
```

- `service` 是**子串匹配**（不区分大小写）：写 `vllm-embed` 能匹配到「容器 vllm-embed」，写 `用户会话` 能匹配到所有从终端直接跑起来的进程。
- **不写 `service`** 就会对每个服务各判一次，适合"任何服务超过 20 GB 都要提醒我"这种兜底规则。
- 服务中途消失（容器停了）时按 0 处理，所以"占用过高"的告警会**自动恢复**，不会停在上一次的值上一直响。
- 判定"是哪个服务"依赖 `/proc`（也就是上面「服务归属」那一节说的容器 / systemd / 会话），所以这一维度和「服务」列一样有 `–` 的情况——归到「未识别」的那个桶里，也能对它设规则。

服务维度的值会跟着每个采样点落库，所以 `for` 一样能配到几分钟甚至更长（没有历史库时受内存窗口限制，与其它指标一致）。

几个使用要点：

- **`for` 超过内存窗口时会自动改查历史库**。默认内存窗口是 300 点 × 1 秒 = 5 分钟；配 `for: 30m` 这类长周期规则时，引擎会从历史库里取这段时间的数据判定（多条长周期规则共用一次查询，默认每 30 秒刷新缓存）。只有在**没有历史库**时（`--no-db`，或 Node 低于 22.13）才会退回"夹到窗口长度"，启动日志与页面都会明确提示。
- **历史数据点数过多时会按桶平均**。查回来的区间超过约 2000 个点（按默认 5 秒落库粒度约合 2.8 小时以上）会自动分桶，平均会抹平短于桶宽的尖峰。10 分钟、30 分钟这类常用规则用的都是原始粒度，不受影响；页面「采集信息 → 告警」里会标明当前是按原始粒度还是分桶判定。
- **抗抖动**：冷却期内不会重复通知，**包括"刚恢复又马上触发"的情况**；并且只有真的发出过"告警"，恢复正常时才会补一条"恢复"，不会出现没告警却收到恢复的怪邮件。
- **覆盖不足会明说**：如果拿到数据的时间跨度不够规则要求的 `for`（比如服务刚上线、库里历史还不够长），告警照发，但文案会写成"仅覆盖 12 秒，不足规则要求的 5 分钟"，不会假装已经持续了那么久。
- **密码建议放环境变量**：配置里支持 `${SMTP_PASS}` 这种占位符，写法是 `"pass": "${SMTP_PASS}"`，启动前 export 一下即可，不用把密码写进文件。若确实要写在文件里，记得 `chmod 600 alerts.json`。
- **改完配置不用重启**：`alerts.json` 一保存就自动重新加载（监听目录，所以编辑器"写临时文件再改名"的保存方式也能识别）。**配置写坏时不会把告警弄丢**——沿用上一次可用的规则，并在日志和页面「采集信息 → 告警」里写明原因；监控系统最怕的就是自己悄悄失效。想关掉热加载用 `--no-alerts-reload`。

先确认规则能不能触发、会发什么内容，用 `--alerts-dry-run`：只打印"本来要发什么"，不真的连 SMTP。

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

`--node` 也可以写成环境变量：`NODE_BIN=/opt/node24/bin/node ./start-bg.sh`。启动横幅第一行会打印实际用的 node 路径，重启后核对一下即可。换成 systemd 常驻时，把单元里 `ExecStart=` 的 node 路径一并改掉（见 [deploy/gpu-monitor.service](deploy/gpu-monitor.service)）。

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

脚本方式能扛住 SSH 断开，但机器重启后不会自己起来。仓库里带了单元模板 [deploy/gpu-monitor.service](deploy/gpu-monitor.service)：

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

### 健康检查

`GET /api/health` 返回 `200`（健康，或只有提醒）或 `503`（有致命项），body 里逐项列出采集、历史库、磁盘、告警的状态：

```bash
curl -s localhost:8090/api/health
curl -s -o /dev/null -w '%{http_code}\n' localhost:8090/api/health
```

它判定的是"服务本身还能不能干活"——采集是否新鲜（阈值会跟着空闲降频自动放宽）、历史库是否可写、磁盘还剩多少；显存高、温度高这类业务告警只作为信息回报，不会让服务变成不健康。探活请求不会打断空闲降频，所以可以放心接到定时探测上（`curl -fsS` 直接接现有监控即可）。

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
| `--db` | `data/gpu-monitor.db` | 历史库文件路径，也可用环境变量 `GPU_MONITOR_DB` |
| `--no-db` | 关闭 | 不落库，只保留内存窗口 |
| `--store-interval` | `5000` | 落库间隔（毫秒），与页面刷新间隔解耦 |
| `--retention-days` | `0` | 历史保留天数；默认 `0` = 永久保留，填天数才按天清理 |
| `--no-store-processes` | 关闭 | 不把占用进程写进历史库 |
| `--reclaim` | 关闭 | 启动时把历史库整库重写一次，释放已删数据占用的空间（等价于 `db-maintenance --reclaim`） |
| `--no-push` | 关闭 | 关掉 SSE 推送，页面自动回到轮询 |
| `--alerts` | `alerts.json` | 告警配置文件路径，文件不存在则不启用告警 |
| `--no-alerts` | 关闭 | 不启用告警 |
| `--alerts-dry-run` | 关闭 | 只打印将要发送的通知，不真正发信 |
| `--no-alerts-reload` | 关闭 | 关掉告警配置热加载（默认改了 `alerts.json` 会自动重新加载） |
| `--idle-after` | `30` | 多久（秒）没有页面访问就转入空闲降频，`0` 表示不降频 |
| `--idle-interval` | `10000` | 空闲期间的采集间隔（毫秒） |
| `--mock` | 关闭 | 用模拟数据启动，便于无 GPU 环境联调 |

环境变量：`GPU_MONITOR_MOCK=1` 等价于 `--mock`；`GPU_MONITOR_MOCK_GPUS=8` 指定模拟卡数；`GPU_MONITOR_MOCK_HIGH=1` 让 0 号卡稳定在 90% 以上，用来检查告警配色。

## HTTP 接口

| 路径 | 说明 |
| --- | --- |
| `GET /api/state` | 当前状态：每张卡的显存/利用率/温度/功耗、进程列表、采集元信息 |
| `GET /api/health` | 健康检查：`200` 健康或仅有提醒、`503` 有致命项；探活不会打断空闲降频 |
| `GET /api/stream` | SSE 推送：每采集一帧推一条，内容与 `/api/state` 同构；`--no-push` 时返回 404 |
| `GET /api/history?limit=N` | 内存中的采样窗口，页面打开时用于回填曲线 |
| `GET /api/history?range=7d` | 历史区间（`3d` / `7d` / `30d` / `60d` / `90d` / `all`，或 `from`/`to`、`step`） |
| `GET /api/processes?range=24h&limit=200` | 进程占用事件（谁在什么时候占上了哪张卡），区间写法同 `/api/history`，另返回 `total` 总数 |
| `GET /api/export.csv` | 下载曲线原始数据（每行 = 一个采样点 × 一张卡）；加 `&fields=full` 会带上时钟 / P-State / 风扇 / PCIe / 编解码 / 节流等扩展列（需要历史库） |
| `GET /api/export.system.csv` | 下载宿主指标（每行 = 一个采样点；磁盘只导出第一个挂载点，完整明细在 JSON 里） |
| `GET /api/export.json` | 下载当前完整状态 + 采样窗口 |

`/api/state` 在原有字段之外新增了：

- `system`：宿主指标快照（`cpu` / `mem` / `swap` / `load` / `disk[]` / `net` / `uptimeSec` / `unsupported[]`）
- `fields`：扩展指标探测结果（`enabled`、`extended`、`count`、`unsupported[]`）
- `idle`：空闲降频状态（`active`、`currentIntervalMs`、`idleAfterMs`、`idleIntervalMs`）
- `systemEnabled`、`systemWarning`

原有的 `gpus`、`processes`、`platform`、`collector`、`error` 等字段语义未变，`/api/history` 的采样点新增了 `system` 字段。

导出接口接受与 `/api/history` 相同的区间参数（`?range=7d` / `?from=…&to=…` / `?step=`），带区间时会**流式写出**——90 天那种几十万行的导出不会先整块读进内存。不带区间参数时行为与以前完全一致（导出内存窗口）。

默认 CSV 的列是固定的（时间、卡号、名称、显存、利用率、温度、功耗）；加 `?fields=full` 会再追加 `clock_sm_mhz / clock_mem_mhz / pstate / fan_pct / pcie_gen / pcie_width / enc_util_pct / dec_util_pct / throttled` 九列（`throttled` 用 0/1 表示，空值代表这次采集没拿到节流信息）。这些扩展字段只存在历史库里，所以没有启用历史库时会返回 400 并说明原因。页面曲线卡片右侧的「扩展字段 CSV」按钮就是这个导出，没启用历史库时会自动置灰。

## 实现说明

- 数据来源：`nvidia-smi --query-gpu=...` 取显卡指标，`nvidia-smi --query-compute-apps=...` 取占用进程，用 GPU UUID 关联
- 平台探测在 `src/platform.js`：识别系统/架构，并按平台找 `nvidia-smi`；找不到时**不阻塞服务启动**，每 30 秒自动重试一次（后装驱动、挂载显卡都不用重启服务）
- 探测结果通过 `/api/state` 的 `platform` 与 `collector` 字段暴露给页面，所以提示能区分"平台不支持"和"驱动异常"
- 数据仅保留在内存中（环形缓冲，默认 300 点），不落盘、不做历史归档；重启服务后曲线重新开始
- GPU 字段表驱动：查询构造、CSV 解析、老驱动探测都由同一张字段表生成，加一个指标只需要在 `src/nvidia.js` 的字段表里加一行
- 扩展字段逐项探测：老驱动遇到不认识的字段会让整条查询失败，所以启动时先试一次，从报错里找出不支持的字段剔除后重试，结果缓存；基础字段缺失才会真正报错
- 采集与 HTTP 分离：调度逻辑（`src/collector.js`）、宿主指标（`src/system.js`）、GPU 采集（`src/nvidia.js`）互相独立，HTTP 层只做路由与静态文件。环形缓冲是独立的 `History` 类，将来换成 SQL 落库只需要替换它
- 空闲降频是按"最近一次 HTTP 请求"判断的：超过 `--idle-after` 秒没有请求就把间隔放大到 `--idle-interval`，而不是彻底停采，这样窗口不会出现空洞
- 历史库分层：`src/store/rows.js` 管"存什么"（行映射、节流位掩码），`sqlite-store.js` 管"怎么存"（缓冲批量写、游标分页读、保留清理）。换数据库或换表结构时只动这一层
- 区间查询的步长按**真实行数**推导而不是按配置间隔估算：刚建库或采集断断续续时，估算会把行数严重高估，7 天的区间会被压成一两个点
- 写入失败（磁盘满、库文件被删）不会影响实时采集，只会在页面上留一条提示；退出时会把缓冲区里的行落盘再关库
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

**历史库提示"不可用"？** 大概率是 Node 版本低于 22.13（没有内置 `node:sqlite`）。升级 Node 即可；不升级也不影响实时监控，只是没有历史。页面「采集信息 → 历史库」会写明具体原因。

**切到"7 天"只有一两个点？** 那是库里确实还没有那么多数据，或者那段区间内服务没在跑。曲线副标题会写清点数与分桶粒度。

**数据会不会一直涨？** 会，因为**默认就是永久保留**——单卡 5 秒粒度约 7 MiB/天，一年 2.5 GiB，8 卡一年约 20 GiB。真要有个上限就加 `--retention-days <天>`；想更省空间优先调大 `--store-interval` 而不是砍历史。

**页面上的「全部」为什么不是全部？** 时间范围里的「全部」指的是**库里现存的全部**，不是"历史上的全部"。默认永久保留时两者是一回事；如果你给 `--retention-days` 设过天数，更早的行已经被清理掉了，这时「全部」就等于那个天数。选中「全部」时曲线副标题会写明当前保留期，不会让你猜。

**库文件比预期大？** 稳态运行下文件大小会自己稳定（删除的页会被新数据复用）。如果你调过落库间隔或保留期，文件会停在历史最高水位——页面「采集信息 → 历史库」里显示有可回收空间时，跑一次 `node tools/db-maintenance.mjs --reclaim` 即可。

**不确定服务器能不能跑？** 先跑 `node tools/preflight.mjs`，它会逐项给出结论和阻塞原因，比启动后看报错快。

**告警为什么不发信？** 按顺序看三处：① 启动横幅那行「告警」是否显示规则条数，没配置会写「未启用（没有找到 alerts.json）」；② 页面顶部有没有出现告警条（出现了说明判定没问题，那就是发送环节）；③ 日志里有没有 `email 通知失败：…`。先用 `--alerts-dry-run` 跑一遍能快速区分"没触发"和"发不出去"。

页面顶部的告警面板在**配好规则后就常驻**，不管当前有没有触发：没有触发时它是中性配色，写着「当前无告警，N 条规则未触发」，展开「规则清单」能看到每条规则的条件、级别和实时状态。`--alerts-dry-run` 会在标题旁挂一个「dry-run：只打印不发送」的角标——**只看到这个角标没消失，就说明告警还没真正发信**。

**想立刻确认邮件通道通不通？** 不用等规则触发（阈值配得高时可能几天都不触发一次），也不用重启服务：

```bash
SMTP_PASS=你的密码 node tools/notify-test.mjs            # 真发一封测试通知
node tools/notify-test.mjs --dry-run                     # 只看要发给谁、走哪个服务器
```

它复用服务里同一套 notifier / SMTP 实现和同一份 `alerts.json`，只读配置、不碰库、不影响正在跑的服务；发出去的是写清了"这是测试"的消息，不会和真告警混淆。配置里用 `${SMTP_PASS}` 占位时，记得把环境变量和命令写在同一行。

**规则里的 for 好像没生效？** 看页面「采集信息 → 告警」那一行，它会写明长周期规则当前是查历史库、按内存窗口，还是分桶判定。没有历史库时（`--no-db` 或 Node 低于 22.13）长周期的 `for` 会被夹到内存窗口长度，启动日志里也有提示。

**SMTP 连不上？** 内置的 SMTP 客户端只覆盖明文、STARTTLS、隐式 TLS（465）与 AUTH LOGIN/PLAIN，够用于内网 relay。如果你们的邮件服务要求 OAuth 或其他认证方式，可以先把通知渠道换成 `webhook`（指向自建脚本），由脚本去发信。

## 本地自检

```bash
node tools/smoke-test.mjs   # 冒烟测试：解析、环形缓冲、CSV 导出、模拟数据源、历史库、告警判定、SMTP 协议
```

仓库里其余几个工具，都是"只读优先、出问题给中文原因"的路子：

| 工具 | 用途 |
| --- | --- |
| `tools/preflight.mjs` | 部署前体检：Node 版本、`nvidia-smi`、驱动支持的扩展字段、磁盘空间、端口占用 |
| `tools/notify-test.mjs` | 通知通道自检：按 `alerts.json` 发一条测试通知，验证邮件 / Webhook 通不通 |
| `tools/db-maintenance.mjs` | 历史库维护：看状态、按保留期清理、回收被删数据占用的空间 |
