# 视汇 (VFusion) - 通用跨隔离网数据交换与汇聚平台架构方案 (v0.11.0)

> **文档性质说明**
>
> 本文档同时描述**已实现能力**与**目标架构蓝图**。为避免混淆，当前版本的实现边界如下：
>
> **已实现（可直接运行）**
> - 双端服务：视频网采集端 (5001) / 内网汇聚中台 (5002)，Node.js + Express
> - 单据打包与解包：Zip 封装、MD5 校验和、HMAC-SHA256 签名与验签
> - 零代码动态表单：Schema 可视化配置、双端动态渲染、动态表格与筛选
> - 传输通道：本地目录摆渡 + 第三方 FTP 服务器双端推送/轮询拉取
> - 持久化：**JSON 文件 + 嵌入式 SQLite**（非 PostgreSQL）
> - 身份认证：PBKDF2 口令哈希、HMAC 签名 Token、RBAC 角色校验
> - Webhook 转发、审计日志、CSV 导出、涉事人员档案库
>
> **尚未实现（属于 Roadmap 目标，文中架构图含此部分）**
> - PostgreSQL JSONB 存储与 JSONB 索引查询（当前为 SQLite + JSON 文件）
> - MinIO 对象存储（当前为本地文件系统）
> - Kafka / RabbitMQ 消息广播（当前仅 HTTP Webhook）
> - 机器学习视觉识别（人脸/车牌）；当前 `event_tags.js` 为**基于规则的字段标注**，不含模型推理
> - HTTPS/TLS 传输加密（`ssl_cert.js` 模块存在但未启用）
> - Schema 跨网自动摆渡同步（当前为手动导入导出）
>
> 文中出现 `JSONB`、`PostgreSQL`、`MinIO`、`Kafka` 等术语处，除非另有标注，均指目标架构而非当前实现。

## 一、 平台定位与设计理念 (Platform Positioning)

### 1.1 从“单一应用”到“零代码通用中台”
**视汇 (VFusion v0.11.0)** 定位为 **零代码/低代码通用型跨隔离网数据交换与汇聚中台 (Zero-Code Universal Cross-Network Data Platform)**。包含按页面模块化拆分的 HTML/CSS/JS 架构、视频网采集端已提交历史存照控制台（`GET /api/published-history`）、全量双端数据表格通用客户端分页器、任务上下文管理（任务名称、关联任务编号）、层级化任务归属存储（`storage/assets/tasks/{task_code}/{event_id}/`）、默认事件字段集（事件时间、交通方式、地点、经纬度、描述、涉事人员姓名/身份证/户籍）、**高密度数据表格**、**涉事人员档案弹窗**、**涉事人员历史档案一键提取与单向摆渡跨网自动归档**，以及**第三方外部 FTP 服务器双端可视化通道自动推送与抓取入库管道**功能。

平台致力于解决“业务扩展需要反复修改前端页面、后端接口和数据库”的痛点。无论是从当前的 5 个图片介绍字段扩展到 15 个字段，还是未来接入全新的业务类型，**管理员只需在平台可视化界面配置即可完成扩展，无需编写代码**。

### 1.2 五大通用设计原则
1. **零代码动态表单 (Zero-Code Dynamic Form)**：可视化配置字段（文本、下拉、时间、图片等），前端页面自动渲染录入表单，内网自动渲染表格与筛选器。
2. **多应用租户隔离 (Multi-App & Biz Isolation)**：通过 `app_id` 与 `biz_type` 区分业务来源，支持多系统共用通道。
3. **传输通道抽象 (Transport Abstraction)**：内置原生 FTP 第三方服务可视化通道支持（SFTP 为 Roadmap 目标），并适配网闸摆渡、NFS/SMB 共享目录等传输介质。
4. **标准报头 + 动态负荷 (Standard Header + Dynamic Payload)**：通用平台只解析公共报头，业务扩展字段以 JSON 动态存储，新增字段**零数据库结构变更**。
5. **插件化处理管道 (Plugin Pipeline Architecture)**：内网接收后支持挂载“通用 Web 展示”、“第三方系统 Webhook 转发”等后置插件；MQ 消息广播与视觉识别插件为 Roadmap 目标。

---

## 二、 零代码可视化字段扩展机制 (Zero-Code Field Expansion)

当业务需求从 5 个字段扩展到 15 个字段时，全流程无代码扩展机制如下：

```
                    ┌────────────────────────────────┐
                    │    管理员登录 VFusion 后台     │
                    │   (可视化表单设计器 Form Builder)│
                    └───────────────┬────────────────┘
                                    │
                       添加/修改字段 (如新增10个字段)
                                    │
                                    ↓
                     保存生成动态表单元数据 (Schema)
                                    │
           ┌────────────────────────┴────────────────────────┐
           │                                                 │
           ↓                                                 ↓
 视频网采集端 (Collector)                           内网展示端 (Core Portal)
 动态表单引擎自动渲染                              通用渲染引擎自动更新
 15 个输入框/下拉菜单/日期组件                     15 列表格 / 详情卡片 / 动态筛选条件
           │                                                 │
           └────────────────────────┬────────────────────────┘
                                    │
                                    ↓
                         底座数据库 JSONB 存储
                   (零 ALTER TABLE，零后端代码重构)
```

### 2.1 表单 Schema 配置定义 (JSON Schema 示例)

管理员在后台配置的表单规则会自动保存为 Schema 定义：

```json
{
  "biz_type": "person_snapshot",
  "biz_name": "人员抓拍事件",
  "fields": [
    {
      "key": "location",
      "label": "发生地点",
      "type": "select",
      "options": ["北门", "南门", "1号车间"],
      "required": true,
      "searchable": true,    // 是否作为内网检索条件
      "show_in_table": true  // 是否在表格列显示
    },
    {
      "key": "threat_level",
      "label": "威胁等级",
      "type": "radio",
      "options": ["低", "中", "高"],
      "required": true,
      "searchable": true,
      "show_in_table": true
    },
    {
      "key": "device_ip",
      "label": "抓拍设备IP",
      "type": "text",
      "required": false,
      "searchable": false,
      "show_in_table": false
    }
    // 后续在后台界面鼠标点击直接添加第6~15个字段，即时生效！
  ]
}
```

### 2.2 视频网前端：通用动态渲染组件 (`<vfusion-form />`)

视频网发布页面不需要为每套业务硬编码 Vue 表单，只需引入平台的动态表单组件：

```html
<!-- 视频网页面模板中只需写这一行 -->
<vfusion-form 
  app-id="sys_gate_security" 
  biz-type="person_snapshot"
  @submit="onPackageSubmit" 
/>
```

* 动态表单组件读取配置后，**自动渲染出 15 个对应的输入框、下拉框、校验规则**；
* 点击提交时，自动将 15 个字段打包为 `info.json` 的 `payload` 并触发 Zip 封装。

### 2.3 内网展示端：通用动态表格与组合查询

内网展示页面同样基于组件化引擎：
* **动态表格**：读取配置中 `show_in_table: true` 的字段，自动增加对应表格列。
* **动态筛选器**：读取 `searchable: true` 的字段，在搜索栏自动生成下拉过滤框或范围查询框。
* **底层查询**：当前实现为服务端读取记录集后按 `payload` 字段做内存过滤，前端负责分页；*目标架构*为迁移至 PostgreSQL 后基于 JSONB 索引自动构建查询谓词（如 `WHERE payload->>'threat_level' = '高'`）。

---

## 三、 通用中台整体架构 (Universal Architecture)

```
                              视频网 (Video Network)
                              
  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
  │   门禁抓拍系统   │    │   厂区巡检网站   │    │  第三方 FTP/设备 │
  └────────┬────────┘    └────────┬────────┘    └────────┬────────┘
           │                      │                      │
           └──────────────────────┼──────────────────────┘
                                  ↓
                  ┌──────────────────────────────┐
                  │    VFusion Dynamic Form      │
                  │  (零代码动态表单/校验/打包)   │
                  └───────────────┬──────────────┘
                                  │ 自动封装 vfusion_pkg_*.zip
                                  ↓
                  ┌──────────────────────────────┐
                  │     传输介质适配层 (Out)     │
                  │   (FTP / SFTP / 共享目录)    │
                  └───────────────┬──────────────┘
                                  │
                             网闸单向摆渡
                             (Data Diode)
                                  │
                                  ↓
                              内网 (Internal Network)
                                  │
                  ┌──────────────────────────────┐
                  │     传输介质适配层 (In)      │
                  └───────────────┬──────────────┘
                                  │
                  ┌──────────────────────────────┐
                  │    VFusion Core 解析引擎      │
                  │  (解包 / 校验 / 防重 / 归档)  │
                  └───────────────┬──────────────┘
                                  │
                  ┌──────────────────────────────┐
                  │  通用元数据 & 文件持久化层    │
                  │  (PostgreSQL JSONB + MinIO)  │
                  └───────────────┬──────────────┘
                                  │
         ┌────────────────────────┴────────────────────────┐
         │              插件化处理管道 (Pipeline)          │
         ├───────────────┬────────────────┬────────────────┤
         ↓               ↓                ↓                ↓
  ┌──────────────┐┌──────────────┐┌──────────────┐┌──────────────┐
  │  零代码动态  ││ Webhook 转发 ││ MQ 消息广播  ││  AI 识别插件 │
  │ 通用看板门户 ││ (第三方系统) ││(Kafka/Rabbit)││ (人脸/车牌)  │
  └──────────────┘└──────────────┘└──────────────┘└──────────────┘
```

---

## 四、 平台核心数据库设计 (Universal Schema)

采用 **关系型数据 + JSON 文档混合存储** 架构。

> **实现现状**：本章表结构为 PostgreSQL 目标设计。当前版本使用**嵌入式 SQLite**（`packages/common/db_sqlite.js`，表名 `events`）配合 JSON 文件存储，动态字段以 TEXT 列存 JSON 序列化字符串。字段语义与下表一致，迁移 PostgreSQL 时可将 TEXT 列直接改为 JSONB。

### 4.1 动态表单配置表 (`sys_form_schema`)
| 字段名 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` | BIGINT | 自增主键 |
| `app_id` | VARCHAR(64) | 应用ID |
| `biz_type` | VARCHAR(64) | 业务类型 |
| `schema_json` | JSONB | **表单控件布局、字段定义、校验规则 JSON** |
| `version` | INT | Schema 版本号 |
| `updated_at` | TIMESTAMP | 最后修改时间 |

### 4.2 业务事件主表 (`biz_event`)
| 字段名 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` | BIGINT | 自增主键 |
| `app_id` | VARCHAR(64) | 应用ID (索引) |
| `biz_type` | VARCHAR(64) | 业务类型 (索引) |
| `event_id` | VARCHAR(64) | 业务方原始事件ID (联合唯一索引) |
| `event_time` | TIMESTAMP | 发生时间 (索引) |
| `operator` | VARCHAR(64) | 操作人员/设备 |
| `payload` | JSONB | **业务所有动态字段 (5个或15个自动无感存储)** |
| `package_hash` | VARCHAR(64) | Zip 校验和 (防重) |
| `status` | INT | 处理状态 (0:已接收, 1:处理中, 2:已完成, -1:失败) |

---

## 五、 视频网与内网 Schema 可视化同步方案

在物理单向隔离环境下，当管理员在内网修改了表单配置（从 5 个字段改为 15 个字段），可通过以下方式同步至视频网：

1. **可视化导入导出（当前可用）**：在内网导出 `schema_*.json`，在视频网后台导入，即可完成视频网表单的零代码更新。
2. **自动摆渡同步（Roadmap）**：内网发布新 Schema 后，系统自动打包一个 `sys_schema_v2.zip` 走反向网闸/低级单向通道流转至视频网，视频网动态表单引擎收到后自动更新。

---

## 六、 未来演进路线 (Roadmap)

* [x] **Phase 1（底层中台引擎）**：实现通用解析引擎、解包摆渡、MD5+HMAC 校验与持久化（SQLite + JSON 文件）。
* [x] **Phase 2（零代码表单配置）**：上线可视化表单设计器 (Form Builder) 与双端动态渲染（当前为表格表单式配置，拖拽式设计器为后续增强）。
* [ ] **Phase 3（动态检索与看板）**：迁移 PostgreSQL JSONB，实现服务端 JSONB 动态索引查询与可视化看板聚合。
* [ ] **Phase 4（Schema 隔离摆渡同步）**：实现配置变更自动打包摆渡同步机制。
* [ ] **Phase 5（安全增强）**：启用 HTTPS/TLS（`ssl_cert.js` 已就绪）、实现令牌黑名单与刷新机制、接入真实视觉识别推理（当前为规则标注）。
* [ ] **Phase 6（存储与消息扩展）**：接入 MinIO 对象存储与 Kafka/RabbitMQ 消息广播。

---

## 七、 部署与安全须知 (Deployment & Security)

### 7.1 首次启动

```bash
npm install
npm run start:core        # 内网汇聚中台，默认 5002
npm run start:collector   # 视频网采集端，默认 5001
```

首次启动时系统会自动完成两件事，**请留意控制台输出**：

1. **生成随机密钥**：在 `storage/security.json` 中写入随机 `hmac_secret` 与 `token_secret`。若检测到历史遗留的默认密钥 `vfusion_secret_key_2026`，会自动轮换并告警。
2. **生成初始账号密码**：admin / operator / auditor 三个内置账号的初始密码为随机值，**仅在首次启动的控制台打印一次**，请立即登录修改。也可通过环境变量预设：

```bash
VFUSION_ADMIN_PASSWORD=<your-password>
VFUSION_OPERATOR_PASSWORD=<your-password>
VFUSION_AUDITOR_PASSWORD=<your-password>
# 视频网端对应 VFUSION_COLLECTOR_ADMIN_PASSWORD 等
```

### 7.2 双端密钥必须一致

视频网端签发数据包、内网端验签，二者的 `hmac_secret` **必须相同**，否则内网将拒收所有数据包（签名校验失败）。部署时请将内网 `storage/security.json` 中的 `hmac_secret` 同步至视频网端。

### 7.3 安全基线

| 项目 | 当前状态 |
| :--- | :--- |
| 数据包防篡改 | HMAC-SHA256 签名写入 `info.json` 并强制验签，未签名/被篡改的包一律拒收并移入死信区 |
| 接口鉴权 | 全部 API（登录除外）需携带有效 Bearer Token；Token 为 HMAC 签名且 12 小时过期 |
| 权限控制 | 用户管理、密钥配置、存储清理等管理类接口需 admin 角色 |
| 口令存储 | PBKDF2-SHA256（12 万轮 + 每用户随机盐）；旧格式口令在首次登录时自动升级 |
| 敏感信息 | FTP 口令不下发前端（以掩码返回）；`storage/` 已排除出版本控制 |
| 前端注入 | 后端数据统一经 `escapeHtml` 转义后渲染，并配置 CSP |

### 7.4 部署建议

* **限制监听范围**：服务默认监听 `0.0.0.0` 以便局域网访问。若无需跨机访问，建议改为 `127.0.0.1` 或以防火墙限制来源网段。
* **CORS 白名单**：如需跨域访问，通过 `VFUSION_ALLOWED_ORIGINS=https://a.example.com,https://b.example.com` 显式配置；未配置时仅允许同源。
* **启用 HTTPS**：当前默认 HTTP 传输，涉事人员身份证等敏感信息在链路上为明文。生产部署建议置于反向代理（Nginx/Caddy）之后启用 TLS。
* **备份 `storage/`**：该目录包含全部业务数据与密钥，且已排除出 Git，需纳入独立备份策略。
