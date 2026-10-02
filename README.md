# 地铁隧道环片裂缝复测台账（sologsb101-1006）

面向地铁运营隧道结构维保班组与第三方监测单位，把区间内每环管片的裂缝逐条建档，并按测次复测比对裂缝发展情况。核心动作：录入区间与环片里程、登记裂缝部位与走向、按测次复测宽度长度、算发展速率、给出整治建议。

> 纯前端单页应用（SPA）：**无后端 / 无数据库服务 / 无 API**，全部数据保存在浏览器本地 IndexedDB。

## 一、Docker 一键启动（推荐）

在项目根目录（本 README 所在目录）执行：

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22806**

常用运维命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并删除容器
docker compose up -d --build      # 改代码后重新构建启动
```

如需更换宿主端口，修改 `.env` 中的 `FRONTEND_PORT` 后重新 `docker compose up -d`。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5 | `<script setup>` + Composition API |
| 语言 | TypeScript 5.7 | `strict` 严格模式，构建前执行 `vue-tsc --noEmit` |
| UI 组件 | Element Plus 2.9 | 表格、表单、弹窗、抽屉、标签、进度 |
| 状态管理 | Pinia 2.3 | `sectionStore` / `crackStore` / `surveyStore` |
| 路由 | Vue Router 4.5 | History 模式，nginx `try_files` 回退 |
| 本地持久化 | Dexie 4（IndexedDB） | 版本号 + `upgrade` 迁移 + 幂等播种 |
| 构建 | Vite 6 | 输出 `dist/`，按路由自动分包 |
| 运行 | nginx:alpine | 静态托管 + gzip + SPA 回退 |

## 三、目录结构

```
sologsb101-1006/
├── README.md
├── docker-compose.yml          # 不写 version；顶层 name: gbtunnelcrack
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html + gzip
    ├── .dockerignore
    ├── package.json / tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── types/              # section.ts ring.ts crack.ts survey.ts advice.ts
        ├── stores/             # sectionStore.ts crackStore.ts surveyStore.ts
        ├── components/common/  # LevelTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useCrackTrend.ts useIdbTable.ts
        ├── pages/              # SectionList.vue CrackEntry.vue SurveyCompare.vue TrendBoard.vue BackupView.vue
        ├── router/index.ts
        ├── utils/              # rate.ts db.ts export.ts
        ├── styles/main.css
        ├── App.vue
        └── main.ts
```

## 四、页面与路由

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/sections` | 区间与环片里程台账 | Section、Ring | 新建/编辑/删除区间与环片；按线路、结构型式筛选；里程区间二维筛选；展开环片查看裂缝 |
| `/cracks` | 裂缝初测录入 | Crack、Ring | 新增/编辑/删除裂缝；勾选批量改状态；单条状态流转（观察→待整治→已整治）；导出 CSV |
| `/surveys` | 复测测次与变化量对比 | Survey、Crack | 按测次追加读数（自动比对生成变化量）；SVG 折线对比历次宽度；编辑/删除测次 |
| `/trends` | 发展速率分级与预警 | Crack、Survey、Advice | 按月均速率降序排行；仅看预警开关；一键生成整治建议草稿；抽屉查看测次序列 |
| `/backup` | 整治建议与数据备份 | 全部模型 | 建议状态流转（待下发→已下发→已完成）；导出/导入全量 JSON；两班离线三向合并；导出 CSV；清空/重置演示数据 |

## 两班离线三向合并（`/backup`）

两个班组共用一版隧道台账，分头复测后无需服务器即可合并：

1. **导出基线**：从同一版台账各自「导出全量 JSON」。导出文件携带当前数据的**内容基线指纹**（`baselineId`）与删除墓碑，两侧基线一致。
2. **分头复测**：各自离线增删改（含删除环片/裂缝/测次/建议，删除会落**墓碑**而不是无痕消失）。
3. **读入对侧备份**：在 `/backup` 点「读入对侧备份并合并」，系统按 `base（共同基线）/ local（本机）/ remote（对侧）` 三向比对，生成可中断恢复的**合并暂存**（持久化在 IndexedDB `mergeStaging` 表）。
4. **自动接回 / 并列保留 / 核验**：
   - 仅一侧改过的记录（增/改/删）**自动接回**；
   - **裂缝、环片、测次两边都改过 → 默认并列保留**：对侧记录以确定性新 id 复制（`原id__dup_<备份指纹>`），环片并列会级联复制其下裂缝/测次/建议，裂缝并列会级联复制测次/建议，并打 `对侧并列·日期` 标记，核验人可在台账上区分；
   - **区间、整治建议**的双方改动，以及**删除与修改相撞**，列为冲突，**核验人逐条处理完才允许一起入库**。
5. **入库与重算**：一次性事务提交后，补入的测次**按日期重排序次**，变化量、月均速率、预警等级与建议判定依据自动重算；随后基线推进到合并后的新版本，建议立即重新导出分发给对方。
6. **幂等与容错**：
   - 合并中断/刷新后暂存现场保留，可一键「恢复核验」；
   - **重试导入同一备份不会多记一条**：备份指纹不含导出时间，已合并的直接拒绝、未提交的回到原暂存，并列复制 id 由指纹确定性派生；
   - **旧版备份（v1/v2，无基线）也能读入**，自动走保守模式（新增自动接回，改动/删除交核验人），缺字段行自动补齐。

## 五、数据存储说明

- **IndexedDB 库名**：`gbtunnelcrack`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：业务表 `sections`、`rings`、`cracks`、`surveys`、`advices`；合并支撑表 `tombstones`（删除墓碑）、`meta`（当前合并基线与已合并备份指纹）、`mergeStaging`（可恢复的合并暂存现场）
- **数据结构版本**：`DB_VERSION = 3`，含 `version(1)` → `version(2)` → `version(3)` 的 `stores()` 索引变更与 `upgrade()` 迁移逻辑（v2 补齐行修订号 `revision`、回填历史裂缝 `sectionId`、补齐变化量；v3 新增墓碑/元数据/合并暂存三张表，老数据升级后以当前库内容建立初始基线）
- **首屏自动播种**：`initDatabase()` 中 `if (await db.sections.count() === 0) await seedDatabase()`，播种 2 个区间 → 5 个环片 → 6 条裂缝 → 14 个测次 → 4 条建议的互相引用演示数据；播种为幂等操作，重复调用不会重复插入
- **localStorage 辅助键**：`gbtunnelcrack:db-version`（结构版本号）、`gbtunnelcrack:last-backup-at`（最近备份时间）、`gbtunnelcrack:ui-prefs`（上次选中区间、仅看预警开关）
- 应用为**无状态容器**：数据不落容器磁盘、不使用数据库服务、不挂载命名卷；清理浏览器数据即清空业务数据（可在 `/backup` 页重新播种）

## 六、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22806
npm run build      # vue-tsc --noEmit && vite build（类型检查 + 生产构建）
npm run preview    # 本地预览构建产物
```

> 提示：开发时浏览器直接使用本机 IndexedDB；若与 Docker 版本混用同一浏览器，数据是同一份（同源端口不同则为不同源，数据互相独立）。

## 七、判定口径

- 月均速率 `mm/月 = (本次宽度 − 上次宽度) ÷ 间隔天数 × 30`
- 分级阈值：`< 0.10` 一般，`0.10 ~ 0.25` 较重，`≥ 0.25` 严重
- 预警数 = 速率分级为「较重」及以上的裂缝数量
