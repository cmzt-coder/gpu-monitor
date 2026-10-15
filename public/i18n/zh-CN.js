/**
 * 中文文案（基线语言）。
 *
 * 约定：
 *   - key 平铺、点分、全小写：`<区域>.<组件>.<角色>[.<变体>]`
 *   - 占位符写成 `{名字}`，永远不要用位置参数——中英语序不同，位置参数必翻车
 *   - 需要单复数的 key 用 `.one` / `.other` 两条（中文两条一样，但结构要和英文对齐）
 *   - 单位（GB / MiB / % / °C / W）不翻译，不进这张表
 *
 * 这张表是"哪条文案存在"的唯一事实来源：en-US.js 必须与它 key 完全对齐，
 * tools/smoke-test.mjs 里有断言守着。
 *
 * 注意：`data-i18n` 只挂在「JS 不会重写」的节点上。像 #orient-sub、#status-text、
 * 各卡片 sub、KPI 数值这些由渲染函数每秒写入的节点，不走声明式，直接在渲染处调 t()。
 */
export const zhCN = {
  /* ---------- 页面级 ---------- */
  'app.title': 'GPU 显存负载监控',
  'app.skipToWork': '跳到工作区',

  /* ---------- 顶栏：状态胶囊 / 导出 / 展示模式 / 语言 ---------- */
  'status.loading': '连接中',
  'export.open': '导出',
  'nav.group.view': '展示模式',
  'nav.view.single': '单页',
  'nav.view.nav': '导航',
  'nav.group.language': '语言',

  /* ---------- 页签 ---------- */
  'nav.group.pages': '页面导航',
  'nav.tab.overview': '总览',
  'nav.tab.curve': '曲线',
  'nav.tab.processes': '进程',
  'nav.tab.system': '系统',

  /* ---------- 采集异常提示条 ---------- */
  'notice.title': '采集异常',
  'common.retry': '重试',

  /* ---------- 告警面板（外框是静态的，条目与清单由 JS 渲染） ---------- */
  'alerts.title': '告警',

  /* ---------- KPI 五张卡（标签与单位是静态的，数值由 JS 写入） ---------- */
  'kpi.group.machine': '整机概览',
  'kpi.count.label': 'GPU 数量',
  'kpi.count.unit': '张',
  'kpi.mem.label': '显存已用 / 总量',
  'kpi.mem.unit': '/',
  'kpi.util.label': '平均 GPU 利用率',
  'kpi.temp.label': '最高温度',
  'kpi.proc.label': '占用进程',
  'kpi.proc.unit': '个',

  /* ---------- 曲线卡片 ---------- */
  'chart.title': '曲线',
  'chart.group.range': '选择曲线时间范围',
  'chart.legend.mem': '显存占用',
  'chart.legend.util': 'GPU 利用率',
  'chart.legend.limit': '90% 警戒线',

  /* ---------- 服务显存曲线 ---------- */
  'svc.title': '服务显存曲线',
  'svc.canvas.label': '按服务汇总的显存占用曲线',

  /* ---------- 系统资源 ---------- */
  'sys.title': '系统资源',
  'sys.legend.cpu': 'CPU 使用率',
  'sys.legend.mem': '内存使用率',
  'sys.canvas.label': '宿主 CPU 与内存使用率的实时曲线',

  /* ---------- 当前占用进程 ---------- */
  'proc.title': '当前占用进程',
  'proc.group.filter': '按 GPU 过滤进程',
  'proc.table.caption': '当前占用显存的进程，可按 GPU 过滤',
  'proc.table.th.gpu': 'GPU',
  'proc.table.th.pid': 'PID',
  'proc.table.th.process': '进程',
  'proc.table.th.service': '服务',
  'proc.table.th.mem': '显存占用',
  'proc.table.th.share': '占该卡比例',
  'proc.empty.title': '没有检测到占用显存的进程',

  /* ---------- 进程占用历史 ---------- */
  'procHist.title': '进程占用历史',
  'procHist.group.range': '选择进程历史的时间范围',
  'procHist.group.min': '只看占用超过该值的进程',
  'procHist.table.caption': '历史进程占用记录，按时间从新到旧',
  'procHist.table.th.time': '时间',
  'procHist.table.th.mem': '显存',
  'procHist.more': '加载更多',

  /* ---------- 右列：各卡当前占用 / 采集信息 ---------- */
  'aside.group': '当前占用与采集信息',
  'cards.title': '各卡当前占用',
  'meta.title': '采集信息',

  /* ---------- 导出弹窗（外框静态，选项与提示由 JS 渲染） ---------- */
  'export.title': '导出数据',
  'export.close': '关闭',
  'export.group.content': '导出内容',
  'export.group.layout': '布局',
  'export.group.range': '时间范围',
  'export.layout.group': '选择导出的表格布局',
  'export.range.group': '选择导出的时间范围',
  'export.full.label': '包含扩展指标（时钟 / P-State / 风扇 / PCIe / 编解码 / 节流 / ECC）',
  'export.cancel': '取消',
  'export.confirm': '下载',
};
