---
name: geo-calc
version: "1.0.0"
description: "地理计算——首都坐标、两城市距离、时区换算、经纬度查询。当问题涉及'哪个城市更远/更大/更靠近赤道'等地理比较时使用 code-exec + 本技能的坐标数据。"
domain: tools
capabilities:
  - geographic_calculation
  - coordinate_lookup
  - distance_computation

input_schema:
  type: object
  required: [task]
  properties:
    task:
      type: string
      description: "地理计算任务描述"

output_schema:
  type: object
  properties:
    result:
      type: string

execution_mode: llm_only
cost_level: low
status: stable
tags: [地理, 计算, 工具]
---

# 地理计算（Geo Calc）

你是地理计算助手。核心方法：**用已知坐标 + haversine 公式计算，不要搜索**。

## 常用首都/大城市坐标（lat, lon）

```
# 欧洲
London: 51.5074, -0.1278
Paris: 48.8566, 2.3522
Berlin: 52.5200, 13.4050
Madrid: 40.4168, -3.7038
Rome: 41.9028, 12.4964
Helsinki: 60.1699, 24.9384
Athens: 37.9838, 23.7275
Oslo: 59.9139, 10.7522
Stockholm: 59.3293, 18.0686
Moscow: 55.7558, 37.6173
Kyiv: 50.4501, 30.5234

# 美洲
Washington DC: 38.9072, -77.0369
Ottawa: 45.4215, -75.6972
Mexico City: 19.4326, -99.1332
Brasilia: -15.7939, -47.8826
Buenos Aires: -34.6037, -58.3816
Santiago: -33.4489, -70.6693

# 亚太
Beijing: 39.9042, 116.4074
Tokyo: 35.6762, 139.6503
Seoul: 37.5665, 126.9780
New Delhi: 28.6139, 77.2090
Bangkok: 13.7563, 100.5018
Singapore: 1.3521, 103.8198
Canberra: -35.2809, 149.1300
Wellington: -41.2865, 174.276

# 非洲/中东
Cairo: 30.0444, 31.2357
Cape Town: -33.9249, 18.4241
Nairobi: -1.2921, 36.8219
Riyadh: 24.7136, 46.6753
Tehran: 35.6892, 51.3890
Ankara: 39.9334, 32.8597
```

## Haversine 距离公式（用 code-exec 跑）

```python
from math import radians, sin, cos, asin, sqrt

def haversine(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlon/2)**2
    return 6371 * 2 * asin(sqrt(a))  # km

# 示例：哪个离赤道更远？
london = (51.5074, -0.1278)
helsinki = (60.1699, 24.9384)
# 赤道纬度 = 0，所以 |latitude| 就是距赤道的角距离
print(f"London: |{london[0]}| = {abs(london[0]):.1f}°")
print(f"Helsinki: |{helsinki[0]}| = {abs(helsinki[0]):.1f}°")
```

## 常见问题模式

| 问题类型 | 解法 |
|---|---|
| "哪个城市更远" | haversine 距离计算 |
| "哪个更靠近赤道" | \|latitude\| 比较（越小越近） |
| "距离是多少公里" | haversine 公式 |
| "时差几小时" | 经度 ÷ 15 |
| "在南半球还是北半球" | latitude 正负 |

## 纪律
- 坐标不在上表时用 web-search 查一次，之后直接计算
- 不要反复搜索"London 到 Helsinki 有多远"——直接算
