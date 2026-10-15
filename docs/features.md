# 平台支持与功能详解

> 本文是 [README](../README.md) 的展开：它能读到哪些指标、平台支持的边界，以及「服务归属」「历史库」这些功能背后的实现口径。
> 快速上手看 README 的「快速开始」，部署与常驻看 [deployment.md](deployment.md)。

## 平台支持

启动时会自动判断当前系统与硬件环境，`nvidia-smi` 的探测顺序是：`--nvidia-smi` 指定 → `PATH` → 各平台常见安装位置。

| 平台 | 支持情况 | 采集方式 |
| --- | --- | --- |
| Linux | ✅ 完整支持 | `nvidia-smi`（`PATH`、`/usr/bin`、`/usr/local/bin`，也自动识别 WSL2 的 `/usr/lib/wsl/lib`） |
| Windows | ✅ 完整支持 | `nvidia-smi.exe`（`PATH`、`C:\Windows\System32`、`C:\Program Files\NVIDIA Corporation\NVSMI`） |
| macOS | ❌ 不适用 | NVIDIA 官方驱动已停止支持，系统里没有 `nvidia-smi`；页面会明确提示，服务本身能正常启动 |

当前只支持 NVIDIA。AMD（`rocm-smi`）、Intel（`xpu-smi`）尚未实现，探测层预留了扩展位置。

最新版的 GPU 指标（时钟 / P-State / 风扇 / PCIe / 编解码 / 节流原因 / **ECC 错误计数**）是**扩展字段**：不同驱动版本支持程度不一样，服务启动时会逐个探测，不支持的自动跳过并在页面「采集信息 → 扩展 GPU 指标」里说明。用 `--no-extended` 可以整个关掉，只保留基础指标。

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

