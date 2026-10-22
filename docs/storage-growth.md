# 历史库数据量增长与已知限制

> 适用范围：使用 SQLite 历史库（`data/gpu-monitor.db`）的单机部署。
> 状态：**已知限制，尚未实施优化**。当前策略是记录增长情况，达到触发条件后再处理。

## 结论

- 当前实现按固定节奏写入 GPU、宿主、进程、推理采样和探针记录，数据库会持续增长，这是预期行为。
- 在单机、8 卡、4 个推理服务、永久保留的典型配置下，增长量级约为每天 **26～29 万行**、**30～40 MiB**；90 天约 3 GB，一年约 12～15 GB。
- 磁盘容量通常不是瓶颈（现代数据盘可轻松容纳），但**备份耗时、导出耗时和首次查询性能**会随库体积增加。
- 新增数据中，`inference_probe`（主动探针）是增长最快的表。调整探针间隔可以显著降低增速。

## 增长来源

以 8 卡、4 个推理服务、`--store-interval 5000`、推理抓取 15 秒为例：

| 表 | 估算行数/天 | 说明 |
| --- | ---: | --- |
| `gpu_sample` | 约 13.8 万 | 8 卡 × 每 5 秒一行 |
| `host_sample` | 约 1.7 万 | 每 5 秒一行 |
| `service_sample` | 约 7～8 万 | 每个采样点按服务各一行 |
| `gpu_process` | 视进程变化 | 身份变化时写事件，另每 5 分钟补快照 |
| `inference_sample` | 约 2.3 万 | 4 个服务 × 每 15 秒一行 |
| `inference_probe` | 约 0.7～1.7 万 | 取决于探针间隔、`warmup` 和跳过情况 |

探针行数的典型计算：

- chat 服务 `warmup: true`：每轮 2 行（冷 + 热）
- embedding / rerank：每轮 1 行
- DeepSeek 30 秒、其余服务 5 分钟时，约 **6,900 行/天**
- 四个服务全部 30 秒、chat 全部 warmup 时，最高可到 **1.7 万行/天**

实测参考：一台 8 卡机器在启用推理监控前后，数据库约 200 MiB、跨度约 8 天；推理功能启用后增速会高于这个平均值。

## 已知限制

1. **只有全局保留期**
   目前只有 `--retention-days`，没有按表或按数据类型的独立保留策略。要永久保留 GPU 历史，就不能只给探针表设置清理周期。

2. **跳过记录也会落库**
   `idleOnly` 因服务忙碌而跳过时仍会写一条 `skipped=1` 的记录。连续跳过会产生大量低信息量行，虽然便于排查“为什么没探”，但会放大增长。

3. **探针 CSV 导出有 50,000 行上限**
   `/api/export.inference-probes.csv` 当前取最近 50,000 条。按混合间隔大约覆盖 7 天，长时间范围导出会被截断。推理服务采样 CSV 则是流式导出，没有这个上限。

4. **没有库体积告警**
   健康检查只关注磁盘剩余空间和写入是否正常，不会在数据库文件过大时提醒。需要人工查看 `/api/state` 的 `storage.sizeBytes`。

5. **备份与导出变慢**
   全量备份 SQLite 文件会随体积线性变慢；大范围导出也会占用更多时间和 I/O。

## 候选优化方向（尚未决策）

- 给 `inference_probe` 单独设置保留期，例如 30 或 90 天；GPU 历史继续永久保留。
- 合并连续相同原因的 `skipped` 记录：同一服务连续跳过时每 5 分钟只留一条。
- 按服务继续调整探针间隔，只对关键服务开启高频探针。
- 把探针导出改成和采样导出一样的流式分页，取消 50,000 行上限。
- 增加库体积阈值告警，例如超过 2 GB / 5 GB 时提示。
- 定期执行 `tools/db-maintenance.mjs`，在删除历史后回收空闲页。

## 如何检查当前体积

```bash
curl -s http://127.0.0.1:8090/api/state | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const st = JSON.parse(s).storage;
  console.log({
    mode: st.mode,
    path: st.path,
    sizeMiB: (st.sizeBytes / 1048576).toFixed(1),
    walMiB: (st.walBytes / 1048576).toFixed(1),
    retentionDays: st.retentionDays,
    written: st.written,
  });
})'
```

查看探针行数：

```bash
curl -s 'http://127.0.0.1:8090/api/inference/probes?range=24h&limit=1' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("24h probes",JSON.parse(s).total))'
```

库维护：

```bash
node tools/db-maintenance.mjs
node tools/db-maintenance.mjs --prune --reclaim
```

## 触发条件

出现以下任一情况时，再启动专项优化：

- 数据库文件超过 **2～3 GB**
- 备份时间明显变长，或备份窗口不够用
- 历史查询、导出出现明显卡顿
- 需要长期保留 90 天以上的探针明细
- 磁盘剩余空间开始接近告警阈值

## 相关文档

- [启动参数与 HTTP 接口](configuration.md)
- [部署与常驻](deployment.md)
- [平台支持与功能详解](features.md)
