# 架构与实现文档

> 本文档面向后续维护的 **AI 助手与开发者**，说明 `pixiv-bookmark-to-private.user.js` 的整体设计、关键实现细节与已知约束。阅读源码前先读本文档可快速建立心智模型。

## 1. 项目概览

- **类型**：单文件 Tampermonkey / Greasemonkey 用户脚本（无构建步骤、无依赖）。
- **入口文件**：`pixiv-bookmark-to-private.user.js`
- **作用**：在 Pixiv 收藏夹页面注入一个浮动按钮，一键将**所有公开收藏批量转为「不公开」**，并可选**仅转换 R18 内容**。
- **运行环境**：浏览器 + 用户脚本管理器（Tampermonkey 等），通过 `@match` 仅在收藏页生效。

### 匹配范围（`@match`）
```
https://www.pixiv.net/users/*/bookmarks/artworks*
```
脚本只在「某用户的收藏作品页」运行，依赖 URL 中的 `userId`。

### 依赖的 GM API（`@grant`）
| API | 用途 |
| --- | --- |
| `GM_registerMenuCommand` / `GM_unregisterMenuCommand` | 注册/刷新油猴菜单项（设置开关） |
| `GM_getValue` / `GM_setValue` | 持久化用户配置 |

### 自动更新
脚本头声明了 `@updateURL` / `@downloadURL`，指向 GitHub raw 地址（`xiaoluobo58/pivix-butler`），脚本管理器据此自动检查更新。修改版本号 `@version` 才会触发用户端更新。

---

## 2. 持久化配置

脚本启动时从 `GM_getValue` 读取三项配置（均可在油猴菜单修改并即时保存）：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `r18Only` | `false` | 是否仅转换 R18 作品（`xRestrict > 0`） |
| `reqInterval` | `800` | 每个写入请求之间的基础间隔毫秒数（调速器起始值）。兼容旧键 `batchDelay` |
| `scanPages` | `0` | 分页扫描模式：`0` = 全部扫完再转换；`N` = 每扫 N 页就转换一轮 |

---

## 3. 核心模块

代码集中在一个 IIFE 内，可分为以下职责块：

### 3.1 凭据获取
- **`getToken()`** —— 获取 CSRF token（`x-csrf-token`），按优先级多策略降级查找，保证对 Pixiv 不同页面架构的兼容：
  1. `window.__pixiv_bootstrapper` / `window.pixiv` 全局对象（旧版 Pixiv）
  2. `__NEXT_DATA__` 脚本标签里递归遍历找 32+ 位十六进制 `token`（Next.js 版 Pixiv）
  3. 遍历内联 `<script>`，正则匹配 `"token":"..."`
  4. 兜底：读取 cookie 中的 `tt` 字段
- **`getUserId()`** —— 从 `location.pathname` 用正则 `/\/users\/(\d+)/` 提取用户 ID。

### 3.2 网络层（关键：429 限速规避）

整体策略：**写入完全串行 + 自适应全局降速 + 抖动 + 尊重 `Retry-After`**，让节奏自动收敛到 Pixiv 可持续的速率（以耗时换稳定）。

- **`pace`（自适应调速器）** —— 模块作用域单例，所有写入间隔的唯一来源，`run()` 开始时重置为 `base`：
  - `base` = 配置 `reqInterval`；`current` = 运行时实际间隔。
  - `bump()`：命中 429 时 `current ×1.5`（上限 15s）——**整体永久降速**，是根治「老是 429」的关键（不再只退避单个请求）。
  - `ok()`：每次写入成功后 `current ×0.95` 缓慢回落（不低于 `base`），避免偶发抖动后永久变慢。
  - `wait()`：等待 `current` 并叠加 **±20% 随机抖动**，规避固定机器节奏。
- **`fetchWithRetry(input, init, btn)`** —— 包装 `fetch`，处理 429：
  - 命中 429 先 `pace.bump()`；等待时间**优先读响应头 `Retry-After`**（秒），无则用退避值。
  - 退避初始 `5s`、×1.5、上限 `60s`，并在按钮上**倒计时显示**。
  - 非 429 直接返回。**会无限重试 429**，直到成功。
- **`fetchPublicBookmarks(userId, offset, btn)`** —— 拉取公开收藏列表（`rest=show`），单页 `limit=100`，返回 `json.body`（含 `works[]` 与 `total`）。
- **`setPrivate(illustId, token, btn)`** —— 调用 `/ajax/illusts/bookmarks/add`，以 `restrict: 1`（不公开）重新收藏该作品，从而把公开收藏改为不公开。

> ⚠️ 注意：将收藏转为不公开的机制是「用 restrict=1 重新提交收藏」，而非删除再添加。

### 3.3 主流程 `run(btn)`
拿到 `token` 与 `userId` 后重置 `pace`，分两种模式执行（核心差异见下节）。写入**逐个串行**：每次 `await pace.wait()` → `setPrivate` → `pace.ok()`，由调速器统一节流（不再批量并发）。扫描翻页之间同样用 `pace.wait()` 节流。完成/出错都会更新按钮文案；出错时重新启用按钮以便重试。

### 3.4 UI 层
- **浮动按钮**：右下角固定定位，文案随 `r18Only` 切换（🔒 全部 / 🔞 仅R18），同时承担**进度与状态显示**（扫描中、转换中、倒计时、完成、出错）。
- **`toast(msg)`**：右下角短暂提示（2s 后移除），用于配置变更反馈。
- **`registerMenu()`**：注册三个油猴菜单项（R18 开关、写入间隔、扫描模式）。每次配置变更后**重新注册**菜单以刷新文案（先 unregister 再 register）。

---

## 4. 两种转换模式（最易混淆，重点理解）

### 模式 A：全部模式（`r18Only = false`）
```
循环：始终从 offset=0 拉取第一页 → 过滤出有 bookmarkData 的作品
     → 逐个串行转不公开（pace.wait 节流）→ 直到某次拉取为空
```
**原理**：转为不公开后，该作品会从「公开收藏」列表消失，所以列表会随转换自然缩短，反复取第一页即可，无需翻页。

### 模式 B：仅 R18 模式（`r18Only = true`）
因为非 R18 作品**不会**被转换、不会从公开列表消失，不能反复取第一页（否则死循环），必须真正翻页扫描：
```
外层循环（offset < total）：
  ├─ 内层扫描：每轮扫描 maxPages 页（scanPages 或全部）
  │    累积本轮 R18 作品（xRestrict > 0），offset += 100，页间 pace.wait 节流
  │    若某页不足 100 条 → 已到末尾（reachedEnd）
  ├─ 转换本轮收集的 R18 作品（逐个串行，pace.wait 节流）
  └─ 若已到末尾则结束；否则 offset -= 本轮转换数量（回退对齐）
```
- `scanPages = 0`：先扫完整个收藏夹再统一转换。
- `scanPages = N`：扫 N 页就转换一轮，再继续扫——适合收藏量大、想边扫边转、降低单次内存/失败成本的场景。

> ✅ offset 对齐：转换会使作品从公开列表消失、后续作品整体前移。代码在每轮转换后执行 `offset -= 本轮转换数量`，使分页与缩短后的列表重新对齐，避免跳过未扫描作品（v1.1.3 修复）。

---

## 5. 数据流图

```
用户点击按钮
   │
   ▼
getToken() + getUserId()  ──失败──▶ alert 提示未登录
   │ 成功
   ▼
┌─ r18Only? ─┐
│ false       │ true
▼             ▼
取 offset=0   分页扫描累积 R18 作品
循环转换       逐轮转换
   │             │
   └──────┬──────┘
          ▼
  setPrivate(逐个串行) ──▶ fetchWithRetry ──429──▶ pace.bump + Retry-After/退避倒计时重试
          │
          ▼
  按钮显示「✓ 完成，共 N 个」
```

---

## 6. 维护提示（给后续修改者）

- **改动后记得提升 `@version`**，否则用户端不会自动更新。
- Pixiv 接口与页面结构可能变化，重点关注：`getToken()` 的几条降级路径、`/ajax/...` 接口路径与字段（`works`、`total`、`bookmarkData`、`xRestrict`、`id`）。
- 写入串行（并发=1）、`reqInterval`、`pace` 的 bump/ok 系数、429 退避参数都是与 Pixiv 限流博弈的经验值，调整时注意不要过激触发更严格封禁。
- 无测试、无 lint、无构建：直接编辑单文件即可，验证方式是在浏览器装脚本实跑。
- 文案与注释以中文为主，沿用现有风格。
```
