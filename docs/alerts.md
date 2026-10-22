# 告警与硬件健康

> 告警指标全表、规则写法与阈值建议，以及 ECC / 行重映射 / XID 这三类「平时安静、一响就要换卡」的信号。
> 快速上手见 [README](../README.md)，部署与常驻见 [deployment.md](deployment.md)，参数见 [configuration.md](configuration.md)。

## 告警

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
| `serviceMemMiB` | 每个服务 | 该服务占用的显存合计（服务 = 容器 / systemd 单元 / 用户会话，见 [features.md](features.md) 的「进程的服务归属」一节） |
| `serviceSharePct` | 每个服务 | 该服务占用占整机显存总量的比例（多张卡时按各卡总量之和算） |
| `inferenceUp` / `inferenceModelsOk` / `inferenceProbeOk` | 每个推理服务 | 布尔值：`/health` 是否通过、模型名是否匹配、最近一次主动探针是否成功 |
| `inferenceRunning` / `inferenceWaiting` | 每个推理服务 | 运行中请求数 / 排队请求数 |
| `inferenceKvCachePct` | 每个推理服务 | KV Cache 使用率（vLLM 的 `1` 已换算成 `100%`） |
| `inferenceTtftAvgMs` / `inferenceProbeTtftMs` | 每个推理服务 | `/metrics` 直方图算出的首 token 平均延迟 / 探针的热态 TTFT |
| `inferenceTokensPerSec` / `inferenceErrorRatePct` / `inferencePreemptionsDelta` | 每个推理服务 | 生成吞吐、两次抓取之间的错误率与抢占次数 |
| `eccCorrectedAggregate` / `eccUncorrectedAggregate` | 每张卡 | 显存纠错计数（终身累计）；看趋势，不看单点 |
| `eccUncorrectedVolatile` | 每张卡 | 本次驱动加载以来的不可纠正错误数，适合配"出现就告警" |
| `xidRecent` / `xidCount` | 每张卡 | XID 错误数：最近 30 分钟 / 累计。**规则用 `xidRecent`**——累计值只涨，一旦触发就永远恢复不了 |
| `remapPending` / `remapFailure` | 每张卡 | 布尔值，行重映射"有待生效" / "失败"（失败是换卡依据） |
| `collectOk` | 服务 | 布尔值，`{"value": false}` 表示采集中断（至少持续 30 秒才触发） |

硬件健康类指标（ECC / XID / 行重映射）在**读不到数据时不会触发**——比如驱动不提供 ECC 字段、或没权限读内核日志拿到 XID。把"读不到"当成"没问题"是监控里最危险的错误，所以这里一律按"未知 = 不告警"处理，页面的「采集信息」里会写明读不到的原因。

几个现成的规则写法：

```json
{ "id": "ecc-uncorrected", "metric": "eccUncorrectedVolatile", "op": ">=", "threshold": 1,
  "for": "0s", "level": "critical", "label": "出现不可纠正的显存错误" }
{ "id": "remap-failure", "metric": "remapFailure", "op": "==", "value": true,
  "for": "0s", "level": "critical", "label": "行重映射失败（备用行不够用）" }
{ "id": "xid-any", "metric": "xidRecent", "op": ">=", "threshold": 1,
  "for": "0s", "level": "warning", "label": "出现 XID 错误" }
{ "id": "ecc-trend", "metric": "eccCorrectedAggregate", "op": ">=", "threshold": 100,
  "for": "0s", "level": "warning", "label": "可纠正错误累计过百（显存在退化）" }
```

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

### 推理服务告警

推理规则和普通规则写法完全一样，`service` 会按**实例 id 或显示名**做子串匹配：

```json
{ "id": "infer-down", "metric": "inferenceUp", "op": "==", "value": false,
  "for": "1m", "level": "critical", "label": "推理服务不可用" }
{ "id": "deepseek-queue", "metric": "inferenceWaiting", "service": "deepseek",
  "op": ">=", "threshold": 16, "for": "3m", "level": "warning", "label": "DeepSeek 排队堆积" }
{ "id": "infer-kv", "metric": "inferenceKvCachePct", "op": ">=", "threshold": 90,
  "for": "3m", "level": "warning", "label": "KV Cache 接近耗尽" }
{ "id": "infer-probe", "metric": "inferenceProbeOk", "op": "==", "value": false,
  "for": "5m", "level": "critical", "label": "主动探针连续失败" }
```

- **不写 `service`** 会对每个推理实例各判一次，适合"任何一个实例不可用都要提醒我"。
- `inferenceProbeOk` 只在 `probe.enabled=true` 时有值；因为 `idleOnly` 忙碌跳过的记录**不算失败**（没有数据就不判定），不会因为业务繁忙误报探针故障。
- `inferenceTtftAvgMs` 来自真实请求的直方图；`inferenceProbeTtftMs` 取探针的**热态**值。冷启动秒级抖动不要用来配告警阈值，除非你确实想监控冷启动。
- 推理快照默认在内存里保留 600 条（15 秒一轮约 2.5 小时），`for` 超过这段覆盖时告警文案会标「覆盖不足」；需要更长周期请把 `for` 控制在覆盖范围内，或后续扩展历史判定。
- 阈值必须按模型实测基线定：DeepSeek 这类模型热态 TTFT 可能只有 200ms，而冷启动 3~6 秒；通用模板里的 5000ms 只是兜底值。

几个使用要点：

- **`for` 超过内存窗口时会自动改查历史库**。默认内存窗口是 300 点 × 1 秒 = 5 分钟；配 `for: 30m` 这类长周期规则时，引擎会从历史库里取这段时间的数据判定（多条长周期规则共用一次查询，默认每 30 秒刷新缓存）。只有在**没有历史库**时（`--no-db`，或 Node 低于 22.13）才会退回"夹到窗口长度"，启动日志与页面都会明确提示。
- **历史数据点数过多时会按桶平均**。查回来的区间超过约 2000 个点（按默认 5 秒落库粒度约合 2.8 小时以上）会自动分桶，平均会抹平短于桶宽的尖峰。10 分钟、30 分钟这类常用规则用的都是原始粒度，不受影响；页面「采集信息 → 告警」里会标明当前是按原始粒度还是分桶判定。
- **抗抖动**：冷却期内不会重复通知，**包括"刚恢复又马上触发"的情况**；并且只有真的发出过"告警"，恢复正常时才会补一条"恢复"，不会出现没告警却收到恢复的怪邮件。
- **覆盖不足会明说**：如果拿到数据的时间跨度不够规则要求的 `for`（比如服务刚上线、库里历史还不够长），告警照发，但文案会写成"仅覆盖 12 秒，不足规则要求的 5 分钟"，不会假装已经持续了那么久。
- **密码建议放环境变量**：配置里支持 `${SMTP_PASS}` 这种占位符，写法是 `"pass": "${SMTP_PASS}"`，启动前 export 一下即可，不用把密码写进文件。若确实要写在文件里，记得 `chmod 600 alerts.json`。
- **改完配置不用重启**：`alerts.json` 一保存就自动重新加载（监听目录，所以编辑器"写临时文件再改名"的保存方式也能识别）。**配置写坏时不会把告警弄丢**——沿用上一次可用的规则，并在日志和页面「采集信息 → 告警」里写明原因；监控系统最怕的就是自己悄悄失效。想关掉热加载用 `--no-alerts-reload`。

先确认规则能不能触发、会发什么内容，用 `--alerts-dry-run`：只打印"本来要发什么"，不真的连 SMTP。

## 硬件健康：ECC / 行重映射 / XID

性能指标回答"这张卡忙不忙"，这三样回答的是**"这张卡是不是在变坏"**——推理卡长期高负载跑，显存老化是真实风险，而这几项出事时通常先表现为"任务莫名其妙报 CUDA 错误"，看性能曲线完全看不出来。

| 指标 | 是什么 | 怎么看 |
| --- | --- | --- |
| **ECC 可纠正** | 单比特错误，硬件自己纠了，程序无感 | 单个不危险，**危险的是增长速率** |
| **ECC 不可纠正** | 双比特错误，纠不回来 | 正在跑的任务可能拿到错误数据，要立刻处理 |
| **行重映射** | 某一行错误太多，固件用备用行顶替它 | 每重映射一次就是"这块显存确实坏了一部分"的实锤；**重映射失败 = 备用行也不够了，换卡依据** |
| **XID** | 驱动打在内核日志里的错误编号 | 编号跨度极大：63 只是记录了一次重映射，79 是 GPU 掉出 PCIe 总线 |

界面上这些信息在「各卡当前占用」每张卡的最后一行，**只在有情况时出现**（健康的那张卡不会写一堆 0）。ECC 的计数分两个尺度：`volatile` 是本次驱动加载以来、`aggregate` 是终身累计——判断"现在是不是在变坏"看前者。

**XID 需要读内核日志，因此要权限。** Ubuntu 默认 `kernel.dmesg_restrict=1`，非 root 读不到 `dmesg`。服务会按 `dmesg` → `journalctl -k` 的顺序尝试，都失败就在页面「采集信息 → XID 日志」里写明原因（**而不是显示 0 次**——"读不到"和"没有错误"是两回事，把前者当成后者是监控里最危险的错误）。想让它工作，选一条：

- 用 root 运行服务（`deploy/` 里的 systemd 模板默认就是 root，顺带也能看全占用进程）
- 把运行用户加进 `systemd-journal` 组，改走 `journalctl`
- 给 node 二进制加读日志的 capability：`sudo setcap cap_syslog+ep /opt/node24/bin/node`

想知道某台机器能不能读，跑这三条就行：

```bash
journalctl -k --no-pager -o short-iso -n 3 2>/tmp/je.txt | tail -3
cat /tmp/je.txt     # 出现 "not seeing messages" 之类的 Hint，说明只能看到部分日志
id                  # 有 adm 或 systemd-journal 组即可
```

实测：运行用户在 **`adm`** 组里时 `journalctl -k` 就能拿到完整内核日志（stderr 为空），不必换成 root。反过来，`journalctl` 在权限不足时会**退出码 0 却只给部分日志**——所以服务会识别那句 Hint 并当作"读不到"，否则就会把"看不到"显示成"累计 0 条"。

XID 的累计计数由服务自己维护：内核日志会轮转、重启就清空，所以不能每次只读当前缓冲。

