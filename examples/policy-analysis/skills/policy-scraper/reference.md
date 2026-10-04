# policy-scraper 参考资料

## 站点别名表（site_aliases）

> PlanningEngine 通过此表把自然语言描述（如「广东工信厅」）映射成站点 ID。

```yaml
site_aliases:
  fszsj:
    names: ["佛山政数局", "佛山政府数据局", "佛山数据局", "fszsj"]
    url: "https://www.foshan.gov.cn/fszsj/gkmlpt/index"
  fszj:
    names: ["佛山住建局", "住建局", "佛山住建", "fszj"]
    url: "https://fszj.foshan.gov.cn/gkmlpt/index"
  fsjtys:
    names: ["佛山交通局", "佛山交通", "fsjtys"]
    url: "https://jtys.foshan.gov.cn/gkmlpt/index"
  fsdr:
    names: ["佛山发改局", "佛山发改", "fsdr"]
    url: "http://fsdr.foshan.gov.cn/gkmlpt/index"
  fskjj:
    names: ["佛山科技局", "佛山科技", "fskjj"]
    url: "http://fskjj.foshan.gov.cn/gkmlpt/index"
  gdii:
    names: ["广东工信厅", "广东工业和信息化厅", "工信厅", "工信", "gdii"]
    url: "https://gdii.gd.gov.cn/gkmlpt/index"
  zfsg:
    names: ["广东政数局", "广东政务服务和数据管理局", "政数局", "zfsg"]
    url: "https://zfsg.gd.gov.cn/gkmlpt/index"
  zfcxjst:
    names: ["广东住建厅", "广东住房和城乡建设厅", "住建厅", "zfcxjst"]
    url: "https://zfcxjst.gd.gov.cn/gkmlpt/index"
```

## 自然语言提取示例

| 用户输入 | 提取结果 |
|---------|---------|
| 「采集广东工信厅 3 月政策」 | `{ year: 当前年, month: 3, sites: ["gdii"] }` |
| 「2026 年 2 月广东工信厅和佛山住建局」 | `{ year: 2026, month: 2, sites: ["gdii", "fszj"] }` |
| 「采集 2026 年 3 月全部政策」 | `{ year: 2026, month: 3 }`（缺省 sites = 全部）|
| 「最近的政策」 | `{ year: 当前年, month: 当前月-1 }`（在 reasoning 中说明）|

## 进度事件（CORAL_PROGRESS）

```python
emit_progress("init", "开始采集", percent=0)
emit_progress("scraping", "[3/8] 佛山政数局", step=3, total=8, percent=37)
emit_progress("done", "完成", percent=100)
```

详见 `docs/AUTHORING_PROGRESS.md`。

## 代理穿透机制

代理打开（HTTPS_PROXY 等环境变量）时，政府站点访问可能被劫持/阻断。脚本会读取 `.env` 中：

```env
POLICY_FORCE_DIRECT=true                       # 强制对政府站点直连
POLICY_NO_PROXY_DOMAINS=gov.cn,foshan.gov.cn,gd.gov.cn  # 命中域名直连
```

启动时会在浏览器（Selenium）和 requests 两条路径上都跳过代理。
