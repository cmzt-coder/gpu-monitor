# 启动参数与 HTTP 接口

> 全部命令行参数与 `GET` 接口。参数也可以写进 [本机部署配置](deployment.md)（`gpu-monitor.conf`），那样启动时就不必带参数。

## 启动参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--port` / `-p` | `8090` | 监听端口（启动脚本的默认值；直接跑 `server.js` 时默认 8080），也可用环境变量 `PORT` |
| `--host` | `0.0.0.0` | 监听地址，也可用环境变量 `HOST` |
| `--interval` | `1000` | 采集间隔（毫秒） |
| `--window` | `300` | 内存中保留的采样点数，即页面曲线窗口 |
| `--nvidia-smi` | 自动探测 | 手动指定 nvidia-smi；不指定时按平台依次尝试 `PATH` → `/usr/bin` → `/usr/local/bin` → WSL2 → Windows 系统目录，也可用环境变量 `NVIDIA_SMI_BIN` |
| `--disk` | 平台默认 | 额外监控的挂载点，可重复：`--disk / --disk /data`。POSIX 默认 `/`，Windows 默认系统盘。想自定义页面上的显示名就写成 `路径=显示名`，例如容器里 `--disk /hostfs=/` 会显示成 `/` |
| `--no-system` | 关闭 | 关掉宿主 CPU / 内存 / 磁盘 / 网络采集，只留 GPU 指标 |
| `--no-extended` | 关闭 | 关掉扩展 GPU 指标（时钟 / P-State / 风扇 / PCIe / 编解码 / 节流原因） |
| `--db` | `data/gpu-monitor.db` | 历史库文件路径，也可用环境变量 `GPU_MONITOR_DB` |
| `--no-db` | 关闭 | 不落库，只保留内存窗口 |
| `--store-interval` | `5000` | 落库间隔（毫秒），与页面刷新间隔解耦 |
| `--retention-days` | `45` | 历史保留天数；默认 45 天，最多 45 天。填 0 或大于 45 的值也按 45 天处理，可填更小值 |
| `--no-store-processes` | 关闭 | 不把占用进程写进历史库 |
| `--proc-min` | `0` | 占用不到这个值（MiB）的进程**不写进**历史库；默认 `0` = 全记。只想看得清爽点请用页面上的「占用下限」，那个不丢数据 |
| `--reclaim` | 关闭 | 启动时把历史库整库重写一次，释放已删数据占用的空间（等价于 `db-maintenance --reclaim`） |
| `--no-push` | 关闭 | 关掉 SSE 推送，页面自动回到轮询 |
| `--alerts` | `alerts.json` | 告警配置文件路径，文件不存在则不启用告警 |
| `--no-alerts` | 关闭 | 不启用告警 |
| `--alerts-dry-run` | 关闭 | 只打印将要发送的通知，不真正发信 |
| `--no-alerts-reload` | 关闭 | 关掉告警配置热加载（默认改了 `alerts.json` 会自动重新加载） |
| `--inference` | `inference.json` | 推理服务监控配置（vLLM 等）；文件不存在则不启用 |
| `--no-inference` | 关闭 | 不启用推理服务监控 |
| `--no-inference-reload` | 关闭 | 关掉推理配置热加载（默认改了 `inference.json` 会自动重新加载） |
| `--idle-after` | `30` | 多久（秒）没有页面访问就转入空闲降频，`0` 表示不降频 |
| `--idle-interval` | `10000` | 空闲期间的采集间隔（毫秒） |
| `--tz` | 跟随系统时区 | 把**本服务**的时区固定成这个 IANA 名字（如 `Asia/Shanghai`）。影响导出里的 `time_local` 列、CSV 文件名、日志时间；也认 `TZ` 环境变量。**只对这个进程生效，不改系统时区，不影响这台机器上的其他服务**——详见 [deployment.md](deployment.md) 的「时区」一节 |
| 环境变量 `GPU_MONITOR_HOSTNAME` | 自动探测 | 覆盖页面上显示的主机名（同一个值也会写进历史库的 `node_id` 和导出文件名）。`--mock` 下默认是 `demo-host`：模拟数据本来就是假的，主机名也该是假的，否则拿它截图放进文档就把本机名带出去了 |
| `--mock` | 关闭 | 用模拟数据启动，便于无 GPU 环境联调 |

环境变量：`GPU_MONITOR_MOCK=1` 等价于 `--mock`；`GPU_MONITOR_MOCK_GPUS=8` 指定模拟卡数；`GPU_MONITOR_MOCK_HIGH=1` 让 0 号卡稳定在 90% 以上，用来检查告警配色。

## HTTP 接口

| 路径 | 说明 |
| --- | --- |
| `GET /api/state` | 当前状态：每张卡的显存/利用率/温度/功耗、进程列表、采集元信息 |
| `GET /api/inference` | 推理服务快照：每个 vLLM 实例的可用性、运行/等待队列、KV Cache、TTFT 与吞吐 |
| `GET /api/inference/history?range=24h&service=ID` | 推理服务历史序列（按时间桶平均）；`service` 可选 |
| `GET /api/inference/probes?range=24h&service=ID&result=ok&limit=20&offset=0` | 主动探针记录（冷/热 TTFT、总耗时、错误）；`result` 可选 `all` / `ok` / `fail` / `skipped`，返回 `total` 用于分页 |
| `GET /api/health` | 健康检查：`200` 健康或仅有提醒、`503` 有致命项；探活不会打断空闲降频 |
| `GET /api/stream` | SSE 推送：每采集一帧推一条，内容与 `/api/state` 同构；`--no-push` 时返回 404 |
| `GET /api/history?limit=N` | 内存中的采样窗口，页面打开时用于回填曲线 |
| `GET /api/history?range=7d&fields=basic` | 历史区间（`1h` / `3h` / `8h` / `12h` / `1d` / `3d` / `5d` / `7d` / `30d` / `45d`，或 `from`/`to`、`step`）；`fields=basic` 只返回画图需要的字段，长区间最多 1000 点 |
| `GET /api/processes?range=24h&limit=50` | 进程占用事件（谁在什么时候占上了哪张卡），区间写法同 `/api/history`，另返回 `total` 总数。`limit` 一次取多少条（上限 2000），`min` 是**占用下限**（MiB，如 `&min=1024` 只看 ≥ 1 GiB 的），默认取启动参数里的 `--proc-min` |
| `GET /api/export.csv` | 下载曲线原始数据（每行 = 一个采样点 × 一张卡）；加 `&fields=full` 会带上时钟 / P-State / 风扇 / PCIe / 编解码 / 节流等扩展列（需要历史库）。加 `&layout=wide` 换成宽表：一行一个采样点，每张卡各占一组列（`gpu0_mem_used_mib`、`gpu1_mem_used_mib`…），那一刻没有数据的卡该组留空。宽表只带基础指标，所以和 `fields=full` 互斥（同时给会返回 400） |
| `GET /api/export.system.csv` | 下载宿主指标（每行 = 一个采样点；磁盘只导出第一个挂载点，完整明细在 JSON 里） |
| `GET /api/export.processes.csv?range=24h` | 下载进程占用事件（每行 = 一次事件：时间 / 卡 / PID / 进程名 / 占用 / 服务 / 用户）。**必须带时间范围**，不带会返回 400；区间内的事件全部导出，不设条数上限 |
| `GET /api/export.inference.csv?range=24h&service=ID` | 下载推理服务采样（每行 = 一个实例在一个采样点的状态与指标） |
| `GET /api/export.inference-probes.csv?range=24h&service=ID` | 下载主动探针记录（每次冷/热请求一行） |
| `GET /api/export.json` | 下载当前完整状态 + 采样窗口 |

`/api/state` 里几个值得单独说明的字段：

- `gpus[]`：每张卡的实时指标。硬件健康相关的在 `eccMode` / `eccCorrectedVolatile` / `eccUncorrectedVolatile` / `eccCorrectedAggregate` / `eccUncorrectedAggregate`，以及 `remap`（`correctable` / `uncorrectable` / `pending` / `failure` / `banksMax`）和 `xid`（`count` / `lastCode` / `lastAt` / `recent`）。**读不到时这几个是 `null` / 缺失，不是 0**——"看不到"和"没有错误"必须能区分
- `services[]`：按服务汇总的显存占用（`service` / `memMiB` / `sharePct` / `processes` / `users[]`）
- `storage`：历史库状态（`mode` / `path` / `written` / `oldestTs` / `retentionDays` / `procMinMiB` …）
- `utilAverage`：近 1 小时的 GPU 利用率均值（`avg` / `samples` / `cards` / `oldestTs` / `newestTs` / `windowMs`），就是概览里「平均 GPU 利用率」那张卡片的数。`avg` 为 `null` 表示算不出来（没有历史库或区间内没有数据），**不是 0%**；`oldestTs` 用来判断这一小时有没有攒满——服务刚部署时 `oldestTs` 距今不足一小时，页面据此标注"实为最近 N 分钟"。服务端每 60 秒重算一次并缓存，不会让每个打开的页面各自拉一小时原始数据回来自己平均
- `alerts`：告警状态（`enabled` / `ruleCount` / `rules[]` / `firing[]` / `warnings[]` / `notifiedCount` …）
- `inference`：推理服务状态（`enabled` / `loaded` / `services[]` / `summary` / `warnings` …）。`loaded=false` 表示没配置 `inference.json`，页面不会显示推理卡片
- `remapStatus` / `xidStatus`：这两项的**采集状态**（是否读到、从哪读的、失败原因），对应页面「采集信息」里那两行
- `system`：宿主指标快照（`cpu` / `mem` / `swap` / `load` / `disk[]` / `net` / `uptimeSec` / `unsupported[]`）
- `fields`：扩展指标探测结果（`enabled`、`extended`、`count`、`unsupported[]`）
- `idle`：空闲降频状态（`active`、`currentIntervalMs`、`idleAfterMs`、`idleIntervalMs`）
- `systemEnabled`、`systemWarning`、`storeWarning`

`/api/history` 的采样点与 `/api/state` 的 `gpus[]` 同构（含上面那些硬件健康字段），另外多一个 `system`。

页面曲线使用 `fields=basic`，只取 `index / uuid / name / memUsedMiB / memTotalMiB / memUsedPct / utilGpuPct` 以及 CPU/内存百分比，避免把 ECC、XID、行重映射等扩展字段塞进长区间响应。历史查询结果在服务端缓存 30 秒；JSON 响应超过 1 KiB 且客户端支持 gzip 时会压缩。

导出接口接受与 `/api/history` 相同的区间参数（`?range=7d` / `?from=…&to=…` / `?step=`），带区间时会**流式写出**——大区间导出不会先整块读进内存。不带区间参数时行为与以前完全一致（导出内存窗口）。历史库最多保留 45 天，超出部分会被自动清理。

**时间列有两列，不是一个失误**：第一列 `time_local` 是**服务器本地时间**（`2026-10-14 14:25:03`），Excel / pandas 直接认成日期时间；第二列 `timestamp_iso` 是 **UTC**（`2026-10-14T06:25:03.000Z`），脚本读、跨时区对齐用。只给 UTC 的话，在东八区用 Excel 打开会看到比墙上时钟早 8 小时，像数据错了一样；只给本地时间又丢了时区信息，换台机器或改时区后老文件没法解释。服务器时区取系统设置，也可以用 `TZ=Asia/Shanghai` 显式指定（Node 原生支持）。页面导出弹窗里会写明当前服务器时区，不用猜。

默认 CSV 的列是固定的（本地时间、UTC 时间、卡号、名称、显存、利用率、温度、功耗）；加 `?fields=full` 会再追加 `clock_sm_mhz / clock_mem_mhz / pstate / fan_pct / pcie_gen / pcie_width / enc_util_pct / dec_util_pct / throttled / ecc_mode / ecc_corrected_volatile / ecc_uncorrected_volatile / ecc_corrected_aggregate / ecc_uncorrected_aggregate` 共十四列（`throttled` 用 0/1 表示，空值代表这次采集没拿到节流信息）。这些扩展字段只存在历史库里，所以没有启用历史库时会返回 400 并说明原因；页面的导出弹窗里勾「包含扩展指标」就是它，没有历史库时这个勾选项会自动置灰并说明原因。

**导出与时间范围的关系**：导出的时间范围由导出弹窗里那一组单独决定，默认「跟随曲线」——也就是曲线上方选的是什么（实时 → 内存窗口；1/3/8/12 小时、1/3/5/7 天 → 查库）就导什么。手动可选 1 小时、24 小时、7 天、30 天、45 天。只有**「当前完整快照」不含时间范围**（它导的是"此刻"，选中时那一组会自动置灰），其余三项都跟着走。

## 推理服务监控（vLLM）

推理服务的清单写在仓库根目录的 `inference.json` 里。它和 `alerts.json` 一样属于**本机配置**，已经进 `.gitignore`；仓库里只有 [`inference.example.json`](../inference.example.json) 模板。

从接口验证、页面新增服务到探针和故障排查的完整步骤，见 [新增推理服务配置流程](新增推理服务配置流程.md)。

只要启动进程设置了环境变量 `GPU_MONITOR_ADMIN_TOKEN`，页面「推理」页签右上角就会出现「配置」按钮。弹窗支持查看、新增、修改和删除服务；浏览器只会在当前标签页的 `sessionStorage` 中记住管理员令牌。未设置这个变量时，配置写接口保持关闭，普通监控页面不受影响。

保存流程会先校验完整配置，再原子写入 `inference.json`，覆盖前生成 `inference.json.bak.<时间>` 备份，并把配置文件和备份权限设为 `600`。配置接口使用版本哈希检查并发修改，另一个窗口已经保存过时会返回冲突，避免静默覆盖。

```json
{
  "enabled": true,
  "interval": "15s",
  "timeoutMs": 3000,
  "services": [
    {
      "id": "vllm-chat",
      "name": "Chat 模型",
      "baseUrl": "http://127.0.0.1:8000",
      "apiKeyEnv": "VLLM_CHAT_API_KEY",
      "model": "your-model-id",
      "kind": "chat",
      "paths": { "health": "/health", "models": "/v1/models", "metrics": "/metrics" }
    }
  ]
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `enabled` | 否 | `false` 表示整份配置关闭；默认开启 |
| `interval` | 否 | 抓取间隔，支持 `5s` / `1m`；默认 `15s`，最小 1 秒 |
| `timeoutMs` | 否 | 单个请求的超时，默认 3000 |
| `services[].id` | 是 | 稳定标识，只允许字母、数字、点、下划线和短横线；上线后不要改，否则历史会断档 |
| `services[].name` | 否 | 页面显示名，默认取 `id` |
| `services[].baseUrl` | 是 | 写到端口即可，不要带 `/v1`；末尾斜杠会自动去掉 |
| `services[].apiKeyEnv` | 二选一 | **环境变量名**，不是密钥本身。适合 Docker、systemd 和需要把密钥与配置分离的部署 |
| `services[].apiKey` | 二选一 | 直接密钥。页面里可以直接填写；只保存在本机 `inference.json`（权限 600），读取接口不会回显。同时存在时优先使用 `apiKey` |
| `services[].model` | 是 | 必须与 `/v1/models` 返回的 `id` 完全一致，用来发现配置漂移 |
| `services[].kind` | 否 | `chat` / `completions` / `embeddings` / `rerank`，默认 `chat` |
| `services[].maxConcurrency` | 否 | vLLM 的 `--max-num-seqs`；填了以后卡片会显示“运行中 / 并发上限”的占用比例 |
| `services[].paths` | 否 | 覆盖默认路径，反向代理改过路由时用 |
| `services[].headers` | 否 | 额外请求头，适合反向代理鉴权；同样只写 `${ENV_VAR}` 占位 |

### 主动探针

`services[].probe` 控制是否真的发一次推理请求。默认关闭；打开后按 `interval` 定时执行：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 打开后才执行探针 |
| `interval` | `10m` | 探针间隔，最短 10 秒；30 秒属于允许的高频配置，但会相应增加探测请求 |
| `timeoutMs` | `60000` | 单次请求超时；长上下文模型别用 3 秒 |
| `idleOnly` | `true` | 只在 `running + waiting == 0` 时探，避免叠加真实流量 |
| `startupGrace` | `5m` | 服务工作状态从 down 恢复为 up 后，开始跳过错峰探针；监控自身启动或配置重载时若服务已健康，不进入宽限期 |
| `warmup` | `true` | chat/completions 先发一次冷启动请求，再发一次热态请求；两条都会落库 |
| `stream` | `true` | 流式请求，才能测出真正的首 token 时间 |
| `maxTokens` | `32` | 生成上限。推理模型别设太小，否则 token 全被 reasoning 吃掉 |
| `prompt` / `input` / `query` / `documents` | `ping` / `pong` | chat/embeddings/rerank 各自的探针输入 |

探针结果会在推理卡片的“质量”分组显示冷热差距与成功率，完整记录在「推理」页签的探针表里。`idleOnly` 跳过时会写一条 `skipped=1` 的记录，说明是忙碌跳过，而不是服务失败。

### 指标分组

「推理」页签的每张服务卡片可以独立切换四组指标，互不影响：

| 分组 | 指标 |
| --- | --- |
| 负载 | 运行、等待、KV Cache、排队·容量、排队·延迟、抢占/分、并发占用、探针 |
| 延迟 | P95 TTFT、P95 总耗时、ITL P95、排队 P95、Prefill P95、Decode P95 |
| 吞吐 | 输入 tokens/s、输出 tokens/s、请求/分、每 step token 数 |
| 质量 | 错误率、中断率、前缀缓存命中率、探针成功率、冷热差距、最近探针时间 |

指标名称支持鼠标悬停和键盘聚焦提示；取不到的指标显示 `--` 并说明“该版本未提供 / 该功能未启用”。探针表支持 `全部 / 通过 / 失败 / 跳过` 过滤，以及每页 `20 / 50 / 100` 条的分页。

使用要点：

- **环境变量模式优先推荐**：每个服务各自独立 key 时，`apiKeyEnv` 指向不同变量名；Docker 部署时把变量写进 `.env`，compose 会整份注入容器。也可以在配置弹窗中选「直接密钥」，此时密钥写入本机 `inference.json`，文件不会进入 Git，且读取接口只返回“是否已设置”。修改环境变量本身仍需要重启进程；只修改 `inference.json` 会热重载。
- `/health` 与 `/metrics` 在 vLLM 里通常不需要 API Key；`/v1/models` 在启用 `--api-key` 后需要。抓不到模型列表时页面会把该服务标成「降级」并指出缺哪个环境变量，而不是直接判死。
- 配置文件改完会自动重载；JSON 写坏或某一条不合法时**沿用上一次可用的配置**，问题记在 `warnings` 里，不会把整页监控弄没。
- 怎么快速验证一台 vLLM 能不能接：`curl -sS http://<host>:<port>/health`、`curl -sS http://<host>:<port>/metrics | grep vllm:num_requests_running`、带 Bearer 请求一次 `/v1/models`。

