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
        ├── types/              # section.ts ring.ts crack.ts survey.ts advice.ts tombstone.ts merge.ts mergeMark.ts baseline.ts
        ├── stores/             # sectionStore.ts crackStore.ts surveyStore.ts mergeStore.ts
        ├── components/common/  # LevelTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useCrackTrend.ts useIdbTable.ts
        ├── pages/              # SectionList.vue CrackEntry.vue SurveyCompare.vue TrendBoard.vue MergeReview.vue BackupView.vue
        ├── router/index.ts
        ├── utils/              # rate.ts db.ts export.ts mergeHash.ts mergeUtil.ts mergeEngine.ts
        ├── styles/main.css
        ├── App.vue
        └── main.ts
```

## 四、页面与路由

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/sections` | 区间与环片里程台账 | Section、Ring | 新建/编辑/删除区间与环片；按线路、结构型式筛选；里程区间二维筛选；展开环片查看裂缝 |
| `/cracks` | 裂缝初测录入 | Crack、Ring | 新增/编辑/删除裂缝；勾选批量改状态；单条状态流转（观察→待整治→已整治）；导出 CSV；并列保留记录打标 |
| `/surveys` | 复测测次与变化量对比 | Survey、Crack | 按测次追加读数（自动比对生成变化量）；SVG 折线对比历次宽度；编辑/删除测次（撤去留痕） |
| `/trends` | 发展速率分级与预警 | Crack、Survey、Advice | 按月均速率降序排行；仅看预警开关；一键生成整治建议草稿；抽屉查看测次序列 |
| `/merge` | 离线合并三向比对核验 | 全部模型 | 导入对端备份后逐行比对：单改自动接回、裂缝/环片/测次双改并列保留、其余双改二选一；挂起暂存、断点续作 |
| `/backup` | 整治建议与数据备份 | 全部模型 | 建议状态流转；导出带基线全量 JSON（含删除墓碑）；离线合并导入 / 覆盖导入；并列副本与删除留痕查看；清空/重置 |

## 五、数据存储说明

- **IndexedDB 库名**：`gbtunnelcrack`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`sections`、`rings`、`cracks`、`surveys`、`advices`、`tombstones`（v3 新增：逻辑删除墓碑）
- **数据结构版本**：`DB_VERSION = 3`
  - v1 → v2：补齐行修订号 `revision`、用所属环片回填历史裂缝的 `sectionId` 冗余列、补齐缺失的变化量字段
  - v2 → v3：新增 `tombstones` 表；历史测次统一按日期重排序次并重算变化量
- **首屏自动播种**：`initDatabase()` 中 `if (await db.sections.count() === 0) await seedDatabase()`，播种 2 个区间 → 5 个环片 → 6 条裂缝 → 14 个测次 → 4 条建议的互相引用演示数据；播种为幂等操作，重复调用不会重复插入
- **localStorage 辅助键**：`gbtunnelcrack:db-version`（结构版本号）、`gbtunnelcrack:last-backup-at`（最近备份时间）、`gbtunnelcrack:ui-prefs`（上次选中区间、仅看预警开关）、`gbtunnelcrack:crew-name`（班组名）、`gbtunnelcrack:merge-baseline`（导出基线）、`gbtunnelcrack:merge-session`（合并暂存现场）、`gbtunnelcrack:merged-hashes`（已合并备份指纹）
- 应用为**无状态容器**：数据不落容器磁盘、不使用数据库服务、不挂载命名卷；清理浏览器数据即清空业务数据（可在 `/backup` 页重新播种）

## 六、两班组离线合并口径

导出基线后两班分头复测，回传备份做三向（本机 / 对端 / 基线）比对，不再只能整库覆盖：

1. **导出基线**：在 `/backup` 填班组名并「导出全量 JSON」，该快照同时记为合并基线（localStorage）；备份带内容指纹 sha256 与删除墓碑。
2. **分头复测**：两班组各自离线增删改；撤去记录为逻辑删除（墓碑随备份带走，仍可合并）。
3. **导入合并**：在 `/backup` 点「导入对端备份（离线合并）」→ 跳转 `/merge`：
   - **一侧改过的记录自动接回**（对端新增/修改/删除自动生效，本机改动本就在库）；
   - **裂缝、环片或测次两边都改过**：默认**并列保留**——对端版本克隆为独立副本（裂缝编号加「（班组版）」后缀、环片/测次带来源标记），核验人也可改选「取本机/取对端」；
   - 区间、建议双改不并列，由**核验人二选一**，未决可挂起；
   - **核验人处理完再一起入库**，挂起项保留在暂存会话。
4. **中断恢复**：合并现场（含两侧快照、比对条目、已入库清单）存 localStorage，刷新/重开后回到 `/merge` 继续。
5. **重试幂等**：同一 sha256 的备份已合并则拒绝重复导入；同会话重复提交跳过已提交条目，**不会多记一条**。
6. **旧版可读**：v1/v2 备份无 `tombstones` 字段，按空墓碑兼容读入。
7. **提交后重算**：测次补入/撤去后统一**按日期重排序次**，重算变化量、同步裂缝台账读数；**预警等级与「月均发展速率…」类自动建议依据跟着重算**（人工填写依据保留）。

> 覆盖导入（整库替换）仍保留在 `/backup` 作为兜底。缺少导出基线时按「双方新增」兜底合并，并在界面提示。

## 七、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22806
npm run build      # vue-tsc --noEmit && vite build（类型检查 + 生产构建）
npm run test:merge # 离线合并端到端冒烟测试（fake-indexeddb，三向比对/并列/墓碑/幂等/旧版兼容）
npm run preview    # 本地预览构建产物
```

> 提示：开发时浏览器直接使用本机 IndexedDB；若与 Docker 版本混用同一浏览器，数据是同一份（同源端口不同则为不同源，数据互相独立）。

## 八、判定口径

- 月均速率 `mm/月 = (本次宽度 − 上次宽度) ÷ 间隔天数 × 30`
- 分级阈值：`< 0.10` 一般，`0.10 ~ 0.25` 较重，`≥ 0.25` 严重
- 预警数 = 速率分级为「较重」及以上的裂缝数量
