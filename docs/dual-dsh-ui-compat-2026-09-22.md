# 0.6.0 双 DSH 版本兼容（0.1.5 + 0.1.6/0.1.7）实施记录

日期：2026-09-22
状态：**已实现并通过一轮 review 修订（同日第二轮）**——分支 `LYS86/main`；`pnpm run check` 全绿（typecheck / 352 测试 / build）；三个真实宿主只读冒烟通过（修订后重验 0.1.5-rc.1 与 0.1.6-alpha.2）；尚缺浏览器级视觉确认；版本号保持 `0.5.4`，`0.6.0` bump 留给完整功能的 release commit（见 §10.3）
关联：PR #42（DSH 0.1.6 适配）、issue #41（0.1.6-alpha.2 下 UI 入口消失）
目标：发布的 `dsh-workbuddy-connect 0.6.0` 同时支持 DSH `0.1.5-rc` 系列与 `0.1.6-alpha.2+` 系列（含 `0.1.7-alpha.1`），**不采用**「0.6.0 只支持 0.1.6、0.1.5 用户停留在 0.5.4」的方案

---

## 1. 结论先行

**同一个 client bundle 注册两个设置界面 seam，由 slot 声明生命周期自动选择宿主走哪条，无任何版本字符串判断。**

- DSH 0.1.5 / 0.1.6-alpha.1：设置 → 插件 里的两张 keyed 卡（`settings.plugin.item`，键 `workbuddy` / `workbuddy-ai`）
- DSH 0.1.6-alpha.2+ / 0.1.7-alpha.1：侧栏 Plugins 页 → `dsh-workbuddy-connect` 配置页（`plugins.bundle.config`，键为包名），页内渲染两张卡
- `registerConfigurableProviders` 维持 PR #42 的删除，两代行为一致（依据见 §5）
- peer 范围 `^0.1.5-rc.1 || ^0.1.6-alpha.1 || ^0.1.7-alpha.1`（semver 实测，见 §6）

## 2. 背景与输入

- issue #41：DSH 0.1.6-alpha.2 移除设置里的插件目录，改内置 Plugins 页，0.5.4 的卡片 UI 无入口
- PR #42（贡献者 LYS86，2 个提交）：完成了 0.1.6 适配但**删除**了旧 seam、把 peer 全量切到 `^0.1.6-alpha.2`、把 `dsh.client.inject` 里 settings-plugins 换成 plugin-manager——即「单版本迁移」
- 本次任务在其分支上改造为「双版本兼容」，保留其 0.1.6 工作，恢复 0.1.5 兼容

## 3. 核心机制发现（review 时请重点核对）

以下均来自官方包/仓库源码核实，非推测：

1. **`ctx.slots.inject(name, cb)` 按 slot 声明生命周期工作**（`packages/client/modules` runtime 文档原文）：声明已存在则同步执行 cb；否则等声明提交后执行；宿主永不声明该 slot 则 cb 永不执行且**不报错**。这是双 seam 免版本判断的基础。直接 `core.register` 进未声明 slot 才会抛 `not declared`（有测试钉住）。
2. **`dsh.client.inject` 的浏览器消费层对缺失包宽容**：`ClientModuleSystem.arriveGraphRow` 中 `if (dependency !== undefined) await ...`——inject 边指向宿主不存在的包时跳过；条目组合层 `ClientEntries.create` 只传 `{name}`，不消费 inject 边。因此即便列了不存在的包也大概率不崩，但本实现仍把两个 slot owner 都移出 inject（保守 + 无需激活顺序保证）。
3. **slot 声明者的版本边界**（npm 包逐一核实）：
   - `dsh-client-ui-plugin-manager` 仅存在于 `0.1.6-alpha.2` 起（0.1.5 系列没有）
   - `dsh-client-ui-settings-plugins@0.1.6-alpha.1` **仍声明** `settings.plugin.item`；`@0.1.6-alpha.2` 起不再声明（`slot-contract.d.ts` 消失、client.js 无引用）——即 0.1.6-alpha.1 是旧 seam 可用的过渡版本，故纳入 peer 范围
   - `plugins.bundle.config` 契约在 0.1.6-alpha.2 与 0.1.7-alpha.1 一致（keyed slot）
4. **两个宿主 boot graph 实测**（冒烟，见 §8）：0.1.5-rc.1 含 settings-plugins、不含 plugin-manager；0.1.6-alpha.2 / 0.1.7-alpha.1 含 plugin-manager（且含 0.1.6 版 settings-plugins，但其不再声明旧 slot）→ **两代各自恰好只渲染一个 seam，无重复 UI**。
5. **卡片根元素**（第一轮为 `<div>`，第二轮修订为 `<li>`，见 §10.2）：0.1.5 设置页的卡片列表 CSS 为 `display:flex; list-style:none`，无 `li` 专属选择器；第一轮据此用 `<div>` 视觉等价。review 指出 div-in-ul 破坏列表语义，第二轮改为 `<li>` + `listStyle:'none'`，新配置页外层改语义化 `<ul>` 并清掉 margin/padding/listStyle。

## 4. 实现内容（分支 `LYS86/main`，第一轮提交 `33d9260`，第二轮修订 `2e61e97`；下表为**当前状态**，第二轮的增量见 §10）

| 文件 | 改动 |
|---|---|
| `src/client/index.tsx` | 恢复 `settings.plugin.item` 两个 keyed card 注册（0.5.4 原始形态）+ 保留 `plugins.bundle.config` 注册；双 slot owner 均为 type-only import；inject 服务列表不变；第二轮把全部注册改为 per-contribution guard（§10.1） |
| `src/client/WorkBuddyPluginCard.tsx` | 文档注释更新（双 seat）；根元素 `<li>` + `listStyle:'none'`（第一轮曾用 `<div>`，第二轮按 review 改回列表语义，见 §10.2） |
| `src/client/WorkBuddyConfigPage.tsx` | 保留 PR #42 的页面结构，注释补充 0.1.5 侧仍走旧 seam；第二轮外层改语义化 `<ul>` 并清列表默认样式（§10.2） |
| `src/index.ts` | 仅注释：settings section 双职说明（0.1.5 卡片派发锚点 + settings.yaml/TUI）、`registerConfigurableProviders` 删除依据 |
| `package.json` | 第一轮曾 bump `0.6.0`，**第二轮已回退 `0.5.4`**（0.6.0 留给完整功能的 release commit，见 §10.3）；`dsh.client.inject` 只留两代共有 6 包（移除 plugin-manager、未加回 settings-plugins）；peer 全部 `^0.1.5-rc.1 \|\| ^0.1.6-alpha.1 \|\| ^0.1.7-alpha.1`；devDeps 增 `dsh-client-ui-settings-plugins@0.1.5-rc.2`（旧 slot 类型，编译期专用） |
| `README.md` / `README.en.md` | 版本矩阵加 0.6.0 行；明确「不要求为装本插件升级到 0.1.6」、两代配置入口位置差异、Models 页不再显示不可编辑卡片；0.3.2–0.5.4 行修正为仅 0.1.5 系列；第二轮收紧为「计划中的 0.6.0」语气 + 逐项列举核心覆盖（§10.4） |
| `tests/slot-registration.spec.ts` | 重写为三段：旧 seam（双 key 共存/投影/同 key 同优先级拒绝/缺 key 报错）、新 seam（PR #42 原有）、共存与能力边界（同 registry 双 slot 三注册互不干扰；未声明 slot 直接 register 抛 `not declared`——即必须走 `ctx.slots.inject` 的原因） |
| `tests/client-fallback.spec.ts` | **当前直接导入真实 `apply()` 做隔离测试**（6 用例，§10.1）；第一轮的「镜像 apply 体 + 双 seam 用例」已随第二轮重写删除——镜像与 DRIFT WARNING 机制不复存在 |
| `tests/settings-integration.spec.ts` | section 契约断言重锚定：每个 variant id 必须是 served settings namespace（0.1.5 卡片键）；目录条目缺席断言与 provider/模型解析回归保留 |

Host 侧行为零改动：provider 注册、凭据生命周期、token refresh、catalog 三级降级、probe、图片输入、context window、CLI、heartbeat 全部未触碰。

## 5. `registerConfigurableProviders` 决策：维持删除（两代统一）

- Models 设置页（`ui-settings-models`）**自 0.1.2 就存在**，两代 join 逻辑相同：有目录条目 → 渲染为 configured 行（即 PR #42 要删的「不可编辑卡片」，0.1.5 上同样存在）；无条目的活路由以 `settingsNs: ''` 附在行尾，`namespaces.has('')` 恒 false → `configured`/`configurable`/`addable` 三个列表都不渲染（`ModelsSection.tsx` 逐行核实）
- 模型选择器分组标题来自 adapter 自身 `providerInfo().name`（`createWorkBuddyAdapter` 已带 displayName）与 catalog RPC，与目录无关；`/model`、对话调用走 adapter——均不受删除影响
- 其余消费者仅新版 desktop welcome 流程（WorkBuddy 非 API-key 配置型，本就不该出现）
- 结论：删除在两代行为一致且安全，无需兼容层。`settings-integration.spec.ts` 有对应回归（`listProviders` 含双 provider + `listModels`/`resolveModelInfo` 正常 + 目录为空）

## 6. peer 范围与 semver 陷阱（node-semver 实测）

| 范围 | 0.1.5-rc.1~3 | 0.1.6-alpha.1 | 0.1.6-alpha.2 | 0.1.6 正式 | 0.1.7-alpha.1 |
|---|---|---|---|---|---|
| `^0.1.5-rc.1`（旧） | ✓ | ✗ | ✗ | ✓ | ✗ |
| `^0.1.6-alpha.2`（PR #42） | ✗ | ✗ | ✓ | ✓ | ✗ |
| **`^0.1.5-rc.1 \|\| ^0.1.6-alpha.1 \|\| ^0.1.7-alpha.1`（本实现）** | ✓ | ✓ | ✓ | ✓ | ✓ |

要点：semver prerelease 元组规则使跨 tuple 的 prerelease 互不匹配（`^0.1.6-alpha.2` 不含 `0.1.7-alpha.1`；`>=0.1.5` 连 `0.1.5-rc.1` 都不含）。**未来 0.1.8+ prerelease 需追加一段**——这是规则所限，不是遗漏。devDeps 保持 0.1.6-alpha.2 阵容（编译用），peer constraint 才是发布约束。

## 7. `dsh.client.inject` 最终列表

```text
@deepseek-ai/dsh-api-remotes
@deepseek-ai/dsh-api-session-controller
@deepseek-ai/dsh-client-ui-renderer
@deepseek-ai/dsh-client-ui-conversation
@deepseek-ai/dsh-client-ui-model-selection
@deepseek-ai/dsh-client-locale
```

两代宿主均含这 6 包；`settings-plugins` / `plugin-manager` 均不列入（type-only import 编译期擦除，已验证构建产物仅 require react）。

## 8. 验证矩阵

| 验证项 | 方式 | 结果 |
|---|---|---|
| typecheck / vitest / build | `pnpm run check` | 第一轮 348/348；第二轮修订后 **352/352** 通过；产物纯度两轮均验（client bundle 仅 require react/jsx-runtime，无 settings-plugins / plugin-manager 的 runtime require） |
| 0.1.5-rc.1 真实宿主 | 一次性 `DSH_HOME` + link 安装 + `dsh web`（只读） | peer 零警告；boot graph 含本插件 client.js；status 路由返回 signed-in + live catalog；日志零错误 |
| 0.1.6-alpha.2 真实宿主 | 同上 | 同上全绿；图谱含 plugin-manager |
| 0.1.7-alpha.1 真实宿主 | 同上 | 同上全绿 |
| seam 无重复 | boot graph 对比 + npm 包源码 | 0.1.5 无 plugin-manager；0.1.6+ 的 settings-plugins 不再声明旧 slot → 各代恰渲染一个 seam |
| Models 页行为 | 源码分析（§5） | 无 WorkBuddy 行、选择器/调用不受影响 |
| **浏览器视觉确认** | **未做** | 卡片/配置页实际渲染、probe 检测按钮、context-window 开关——需真机浏览器 smoke（建议：社区桌面 2.0.9＝0.1.5-rc.1 内核查两张卡；web 升 0.1.6-alpha.2/0.1.7-alpha.1 查 Plugins 页） |

另：官方 `apps/desktop`（Electron 壳包 Web UI、与 dsh 版本锁定发布、尚未公开分发）与本方案正交——双 seam 按 slot 存在性自适应，对任何携带任一 UI 的宿主成立。

## 9. Review 指引与待决事项

Review 建议入手点：

1. `src/client/index.tsx` 的 `apply()`——双 seam 注册与 per-contribution guard 边界（第二轮起 `tests/client-fallback.spec.ts` **直接导入真实 `apply()`** 驱动隔离断言，无镜像体需要人工同步）
2. `tests/slot-registration.spec.ts` 第三个 describe（能力边界）——如果 review 者想验证「未声明 slot 不崩」，机制事实在官方 runtime 的 declaration-lifetime 文档
3. `package.json` peer 三段范围的取舍（§6）
4. `registerConfigurableProviders` 删除依据（§5）——如不认可，回退方案是恢复调用 + 接受 0.1.5 Models 页重现两张不可编辑卡片

待决 / 后续（不属于本任务，勿顺手做）：

- #36 模型开关、#39/#40 凭据存储加密改造（另有调查文档 `wb-credential-encryption-2026-09-22.md`）
- 0.1.8+ prerelease 出现时给 peer 追加一段
- 浏览器级 smoke 通过后：按仓库惯例补 `chore: release 0.6.0` 流程——版本 bump 到 0.6.0 在**该 release commit 中完成**（当前 `package.json` 保持已发布的 `0.5.4`；第一轮曾误 bump，第二轮已回退，见 §10.3）
- merge 策略：本分支基于 PR #42 的 `LYS86/main`，merge 前需决定是否让贡献者先 rebase 或直接在其分支上续 commit（当前为后者）

---

## 10. Review 修订轮（2026-09-22 第二轮）

第一轮方案通过 review，本轮只修 4 个 review 点，不改动双 seam / capability 自适应 / peer 策略 / 目录删除等已通过的设计。

### 10.1 Per-contribution 错误隔离

**问题**：第一轮的 `apply()` 用一个外层 try/catch 包住全部注册，存在两个漏洞——(a) 某个 `ctx.slots.inject()` 同步抛错时，后续 contribution 不再执行；(b) slot 回调在宿主稍后声明 slot 时才执行，彼时 `apply()` 早已返回，同步 try/catch 根本捕获不到回调内的 `ctx.slots.register()` 抛错。

**修改**（`src/client/index.tsx`）：

- 新增 `guardClientContribution<T>(label, fn): T | undefined`：执行单个 contribution，失败降级为带 label 的 `console.error`，成功透传返回值
- 每个 contribution 在**两个边界**各自 guard：eager 的 `ctx.slots.inject()` / `ctx.inject()` 调用，与 deferred 回调内部的 `ctx.slots.register()`。slot 回调必须返回 `SlotInjectionEffect`（disposer），guard 失败分支以 `NOOP_DISPOSER` 兜底
- 隔离粒度：locale 副本、**每张旧卡各自独立**（workbuddy / workbuddy-ai 两个 label）、Plugins 页配置项、probe seat（其 `ctx.inject` 回调与内层 slot 回调也各自 guard）——任一失败不影响其余注册，也永不抛入 DSH loader
- `t = ctx.locale.bind(...)` 位于 guard 之外：locale 服务整体坏掉时 `bind` 抛错会让 `apply` 抛出（此时所有 UI 文案均不可用，属宿主级故障，host provider 不受影响）——这是有意保留的边界，非遗漏

**测试**（`tests/client-fallback.spec.ts` 重写，6 个用例）：**不再镜像**——真实 `apply()` 的运行时依赖只有 React 与本地模块（DSH import 全部 type-only 擦除，实测可导入），spec 直接驱动真实入口 + 可注入失败的 fake 宿主，逐项断言贡献间独立性：第一张卡 register 失败 → 第二张卡/配置页/probe 仍注册；配置页失败 → probe 仍在；probe 失败 → 两 seam 完整；locale 失败 → 其余全注册；全量 API 崩坏 → 4 个独立降级日志、`apply` 不抛。drift 风险随镜像删除而消除。spec 同时移入 `tsconfig.client.json` 项目（需 jsx）。

### 10.2 `<ul>/<li>` 列表语义

- `WorkBuddyPluginCard` 根元素 `<div>` → **`<li>`**，`cardStyle` 增 `listStyle: 'none'`（两 seat 均无列表标记；0.1.5 宿主的 `<ul class="cards">` 语义恢复合法）
- `WorkBuddyConfigPage` 外层 `<div>` → 语义化 **`<ul>`**，样式在原 column/gap 布局上显式清 `listStyle / margin / padding`
- 卡片内部结构与视觉零改动；`plugin-card.spec.ts`（16 项）无根元素断言，全过

### 10.3 版本号不提前 bump

`package.json` 从第一轮的 `0.6.0` **回退 `0.5.4`**：0.6.0 计划还包含 #36 模型开关与 #39/#40 凭据加密兼容，dual UI compat 只是第一部分，正式 bump 留给完整功能合并后的 release commit（仓库惯例为独立 `chore: release` 提交）。

### 10.4 README prerelease 承诺收紧

- node-semver 实测最终范围 `^0.1.5-rc.1 || ^0.1.6-alpha.1 || ^0.1.7-alpha.1`：覆盖 0.1.5-rc.1/2/3、0.1.6-alpha.1/2、**0.1.6 正式**、0.1.7-alpha.1、**0.1.7 正式**；**不含 0.1.8-alpha.1**
- 两份 README 的核心列改为逐项列举 + 明示「更新的 prerelease（如 0.1.8-alpha.x）不自动覆盖，需插件显式跟进 peer range」；删除「0.1.6-alpha.1 及以上」这类开放式承诺
- 全部 `0.6.0 起` 的已发布语气改为「计划中的 0.6.0（开发中，尚未发布）」，安装指引注明「待 0.6.0 发布后」

### 10.5 本轮验证

- `pnpm run check`：typecheck ✓ / **352/352** ✓ / build ✓
- 产物纯度：`lib/client.js` 仅 `require("react")` / `require("react/jsx-runtime")`，未引入 settings-plugins / plugin-manager 的 runtime require
- 轻量冒烟（client 注册逻辑变更，重验两端宿主，均只读）：0.1.5-rc.1 与 0.1.6-alpha.2 各自启动、client bundle 进入 boot graph、status 路由 signed-in + live catalog、日志零错误
- 0.1.7-alpha.1 未重验（本轮改动不影响宿主半边与 seam 选择逻辑，第一轮结论仍成立；如需可随时按同法重跑）

### 10.6 本轮修改文件

`src/client/index.tsx`、`src/client/WorkBuddyPluginCard.tsx`、`src/client/WorkBuddyConfigPage.tsx`、`tests/client-fallback.spec.ts`、`tsconfig.json`、`tsconfig.client.json`、`package.json`（版本回退）、`README.md`、`README.en.md`、`docs/dual-dsh-ui-compat-2026-09-22.md`、`lib/`（重建产物）

### 10.7 文档同步（第二轮后的 editorial 修正）

review 指出本文件 §4/§9 残留 3 处第一轮旧陈述与代码不符，已修正为当前状态并注明对应 §10 小节：§4 卡片根元素（`<div>` → `<li>`）、§4 ConfigPage 行（补充 `<ul>` 改动）、§4/§9 的 client-fallback spec（镜像体 → 真实 `apply()` 直测）、§9 的版本预置（0.6.0 已回退 0.5.4）。§4 表头同时补记第二轮提交号 `2e61e97`。纯文档修正，无代码变更。
