# Telegram Private Chatbot：Turnstile 防骚扰版

[English](<README_EN.md>) | [原项目](https://github.com/jikssha/telegram_private_chatbot)

基于原项目 v5.3 的 Cloudflare Workers Telegram 双向私聊机器人。继续使用一个 Worker 和 `TOPIC_MAP` KV，不需要另外部署验证码网站。

## 功能概览

- 未 trust 用户每次验证成功后享有24小时有效期；trust 用户永久免验证、免关键词过滤。
- Turnstile 网页通过后自动提交，再由对应 Telegram 账号点击最新的签名确认按钮；首次消息验证前暂存。
- 支持黑名单、用户话题管理、管理员按钮菜单，以及通过 Bot 设置全局关键词名单。
- 管理员命令兼容 `/command@你的机器人用户名`，只处理发给当前 Bot 的命令。
- Telegram 命令作用域可让管理命令只显示在指定管理群的管理员菜单里。
- 保留原有话题映射、永久 trust 和黑名单数据；仓库不包含实际密钥、账号或 KV namespace ID。

## 消息处理规则

1. **黑名单优先**：封禁用户的私聊消息静默丢弃，即使此前被 trust 也不能发送。
2. **永久信任**：`/trust` 用户免验证码、免关键词过滤；正常消息限流和关闭对话规则仍适用。
3. **陌生人关键词过滤**：其他用户的文本和媒体说明先匹配当前有效关键词名单（Bot 设置优先，未设置时使用 `FILTER_KEYWORDS`）。命中后静默丢弃，不暂存、不转发、不自动封禁。已经通过验证码但未 trust 的用户也继续过滤。
4. **每天验证**：未 trust 用户验证成功后 **24 小时**有效，不按自然日零点重置。到期后的第一条正常消息需要重新验证。
5. **首次消息暂存**：收到正常消息时发送 Turnstile 网页链接；网页上的 Turnstile 验证通过后自动提交，机器人发送新的「确认验证」消息。点击最新按钮并核验该 Telegram 账号身份后，自动转发暂存消息。确认按钮含绑定挑战、账号和有效期的签名，避免等待网页通过标记的跨地区 KV 传播。

验证链接 **5 分钟**有效，最多保留前 **10 条不同消息**；超出数量、链接过期或转发失败时需要重发。`/start` 仅启动验证或提示发送消息，其他私聊指令静默拦截。暂存消息在回放时重新检查关键词、封禁与验证状态。

关键词以英文逗号、中文逗号或换行分隔，使用**不区分大小写的字面子串匹配**，并统一全角字符、移除常见零宽字符。例如：

```text
广告,赌博,SCAM
刷单
```

管理员可在管理群使用 `/keywords` 查看名单，`/setkeywords 广告,赌博,SCAM` 替换全局名单，或用 `/menu` 的关键词管理入口。名单存入 KV 的 `settings:filter_keywords`，优先于后台 `FILTER_KEYWORDS`；只有从未通过 Bot 设置时才使用后台默认值。`/clearkeywords` 经按钮确认后保存空名单、关闭过滤，不会恢复后台默认值。每次设置最多100个词、每词128字符、总计2048字符，自动规范化去重；跨地区传播可能约需一分钟，无需重新部署。

有效名单为空时不启用过滤。不会识别图片内文字、语音或文件内容；不要把范围太大的普通词加入过滤规则。

未 trust 用户的文本和媒体说明使用已检查的消息快照发送，防止在验证期间编辑原消息绕过过滤；trust 用户仍保留原消息转发方式。相册部分消息被过滤后，其余消息照常发送，仅剩一项时按单条媒体发送。

## 管理员指令

只有配置群组内的管理员能执行指令或给用户回信。可用 `ADMIN_IDS` 额外授权指定 Telegram UID，但这些用户的操作仍必须发生在配置的群组里。

| 指令 | 说明 |
| --- | --- |
| `/menu` | 打开群内按钮菜单；General 提供黑名单、关键词管理和 UID 指引，用户话题另提供该用户管理入口，更改状态需二次确认。 |
| `/keywords` | 查看全局关键词名单和设置指引。 |
| `/setkeywords 词1,词2` | 替换全局关键词名单，规范化并去重。 |
| `/clearkeywords` | 二次确认后清空名单，关闭过滤。 |
| `/block [UID] [原因]` | 加入黑名单。话题内可省略 UID；指定 UID 时可管理尚未创建话题的陌生人。 |
| `/unblock [UID]` | 移出黑名单。不会恢复封禁前的验证或 trust，需重新验证或重新 trust。 |
| `/ban`、`/unban` | `/block`、`/unblock` 的兼容别名，同样支持 UID。 |
| `/blocklist [cursor]` | 分页查看黑名单，下一页命令随结果返回。 |
| `/trust [UID]` | 永久信任并清除未完成的验证码；不自动解除黑名单。 |
| `/untrust [UID]` | 撤销永久信任与验证状态，下次消息需验证。 |
| `/reset [UID]` | 清除验证、trust 与未完成的验证码，下次消息需验证。 |
| `/close`、`/open` | 在用户话题内关闭或恢复对话。 |
| `/info` | 在用户话题内查看 UID、话题和验证/封禁状态。 |
| `/cleanup` | 清理已失效的话题映射，保留永久 trust 和黑名单。 |

General 话题中指定 UID 的例子：

```text
/block 123456789 广告骚扰
/blocklist
/unblock 123456789
/trust 123456789
/untrust 123456789
```

全部管理员命令都支持带机器人用户名的形式，例如 `/trust@your_bot 123456789`、`/info@your_bot`。带后缀时通过 Telegram `getMe` 核对当前 Bot 用户名；发给其他机器人的命令和未知 `/` 指令会忽略，不会作为回复转发给用户。裸命令及参数用法保持不变。

### 命令菜单显示范围

BotFather 的普通 `/setcommands` 设置默认列表。要让管理命令仅在指定管理群显示，需要通过 Telegram Bot API 的 `setMyCommands` 设置作用域；这是 Telegram 端的一次性配置，Worker 不会自动设置，新 Bot 需要单独配置。

| 作用域 | 菜单内容 |
| --- | --- |
| `default` | 只显示 `start`，作为私聊和其他群的默认菜单。 |
| `chat`，指定管理群 | 只显示 `start`，供该群普通成员使用。 |
| `chat_administrators`，同一管理群 | 显示下面的完整管理员列表。 |
| `chat_member`，同一管理群及指定 UID | 仅在需要给 `ADMIN_IDS` 额外授权的非群管理员显示菜单时设置；不会授予权限。 |

给 `setMyCommands` 的默认请求示例：

```json
{
  "scope": { "type": "default" },
  "language_code": "",
  "commands": [{ "command": "start", "description": "开始验证或发送消息" }]
}
```

给管理群管理员设置菜单时，将 `scope` 改为下面的值，并将 `commands` 替换为管理员列表中的命令/描述对象。把占位值换成自己的管理群 ID，不要把真实 Token 或请求日志提交到仓库。

```json
{ "type": "chat_administrators", "chat_id": "<SUPERGROUP_ID>" }
```

管理员命令列表（命令名不带 `/`）：

```text
menu - 打开管理员按钮菜单
info - 查看当前话题用户的信息与状态
block - 封禁话题用户，或指定 UID 和原因
unblock - 解封话题用户，或指定 UID
blocklist - 查看黑名单及下一页指令
trust - 永久信任用户，免验证码和关键词过滤
untrust - 取消信任，下次发送消息需重新验证
reset - 重置用户验证，同时取消永久信任
close - 关闭当前用户会话
open - 重新打开当前用户会话
cleanup - 清理失效话题映射，保留信任和黑名单
keywords - 查看全局关键词过滤名单
setkeywords - 替换关键词名单，使用逗号或换行分隔
clearkeywords - 确认后清空关键词名单并关闭过滤
ban - 封禁用户，block 的兼容别名
unban - 解封用户，unblock 的兼容别名
```

- 分别检查无语言限制的列表（`language_code: ""`）及已配置的语言列表，例如中文 `zh`、英文 `en`；用同一作用域和语言调用 `getMyCommands` 读回确认。
- 如果曾配置 `all_private_chats`、`all_group_chats`、`all_chat_administrators` 或成员专用列表，它们可能覆盖默认菜单；按需要用 `deleteMyCommands` 清除旧覆盖，再设置上述作用域。
- 隐藏菜单不是权限控制：普通用户仍可手动输入命令，但 Worker 会检查管理群和管理员身份。
- Telegram 客户端可能缓存旧菜单，可退出聊天重新进入。不要再把完整管理员列表写入 BotFather 默认列表，否则会重新全局显示。

## 部署

### 1. Telegram 和 Worker

- 向 [@BotFather](https://t.me/BotFather) 申请机器人，保存 Bot Token。
- 创建启用 Topics 的超级群组，把机器人设置为管理员并授予 Manage Topics 权限。获取以 `-100` 开头的群组 ID。
- 在 BotFather 关闭 Group Privacy，以便机器人接收群组回复。
- 当前采用 Cloudflare 编辑器**手动部署**：打开目标 Worker，在编辑器粘贴 [worker.js](<worker.js>)。仓库更新只运行 CI 检查，不自动发布 Worker。
- 创建 Workers KV namespace，以名称 `TOPIC_MAP` 绑定到 Worker。

### 2. 创建 Turnstile widget

在 Cloudflare Dashboard 的 **Turnstile** 页面创建 widget，选择 Managed 模式。把 Worker 的实际访问域名加入允许的 hostname（只填主机名，不带 `https://` 或路径）。获取 Site Key 和 Secret Key。

网页和 Telegram Webhook 共用这个 Worker：根路径 `/` 接收 Telegram 更新，`/verify` 提供验证码页面。

### 3. 环境变量与密钥

| 名称 | 必填 | 类型/示例 |
| --- | --- | --- |
| `TOPIC_MAP` | 是 | KV binding |
| `BOT_TOKEN` | 是 | Secret，机器人 Token |
| `SUPERGROUP_ID` | 是 | 普通变量，例如 `-1001234567890` |
| `WEBHOOK_SECRET` | 是 | Secret，随机生成，1–256 个英文大小写字母、数字、`_` 或 `-` |
| `PUBLIC_URL` | 是 | 普通变量，例如 `https://your-bot.example.com`，必须是该 Worker 的 HTTPS 根地址，不带子路径、查询参数或账号信息 |
| `TURNSTILE_SITE_KEY` | 是 | 普通变量，公开的 Site Key |
| `TURNSTILE_SECRET_KEY` | 是 | Secret，服务器端验证码校验密钥 |
| `FILTER_KEYWORDS` | 否 | 普通变量，仅在未通过 Bot 保存名单时作为默认值；逗号或换行分隔 |
| `ADMIN_IDS` | 否 | 普通变量，逗号/空白分隔的额外授权 UID |
| `API_BASE` | 否 | Telegram API 的可信 HTTPS 代理地址；默认官方 API |

密钥不要写进仓库。配置后重新部署。Turnstile 未配置完整时，未验证陌生人的消息**不会转发**，也不会降级到问答验证。

### 4. 注册 Webhook（含密钥）

在自己可信的终端执行，替换三个占位符。密钥与 Worker 的 `WEBHOOK_SECRET` 必须完全一致：

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  --data-urlencode "url=<PUBLIC_URL>/" \
  --data-urlencode "secret_token=<WEBHOOK_SECRET>" \
  --data-urlencode 'allowed_updates=["message","callback_query"]'
```

必须返回 `ok: true`。不要把包含真实 Token 的命令、终端历史或截图公开。更新 `WEBHOOK_SECRET` 后必须重新注册 Webhook。没有正确密钥请求头的更新会返回 401；未配置密钥则返回 503。

### 5. 上线自测

- 用未 trust 账号发送正常文本：管理员不应立即收到，应该先看到验证码链接。
- 完成网页验证码：页面应自动提交，Telegram 应收到新的签名确认消息；点击最新按钮，首次消息应进入独立话题。
- 在 General 和用户话题测试 `/menu`、关键词入口及操作确认；从命令菜单选择带 Bot 后缀的 `/info`，应返回用户信息。
- 检查私聊和管理群普通成员只显示 `start`，管理群管理员显示完整管理列表。
- 在 24 小时内再次发消息不重复验证；管理员可用 `/reset UID` 测试重新验证流程。
- 配置关键词后用文字和图片说明测试：未 trust 账号被过滤；trust 账号不被过滤。
- `/block UID` 后应静默拒收；`/blocklist` 应包含该 UID；`/unblock UID` 后需重新验证。
- 检查自定义域名、Turnstile 允许的 hostname 与 `PUBLIC_URL` 一致。Telegram 内置浏览器无法完成验证时，尝试系统浏览器。

## 升级原 v5.3

原有 KV 的 `banned:UID`、话题映射和 `verified:UID = trusted` 保留。原问答验证的 `verified:UID = 1` 不再算作有效验证，未 trust 用户升级后首次发送正常消息必须完成 Turnstile。旧问答按钮不再有效。

### 手动发布的安全切换顺序

1. 先在独立 Worker、独立 KV、独立测试 Bot/话题群完成验收，不复用生产 KV 或生产 Bot 的 Webhook。
2. 在生产 Worker 后台新增 `PUBLIC_URL`、Turnstile 两个 Key、`WEBHOOK_SECRET` 和需要的关键词。保持 Worker 名称、群组 ID、原有 `TOPIC_MAP` 不变。
3. **先给原版机器人注册带新 `secret_token` 的 Webhook**：原版不检查这个请求头，仍可工作。使用 `allowed_updates` 包含 `message` 和 `callback_query`，不要清空待处理更新。
4. 确认旧版正常收发后，在 Cloudflare 编辑器中替换为已验收的 [worker.js](<worker.js>)，保存并部署。新代码会检查相同的密钥请求头。
5. 发布后再验证正常文本、验证码、管理员回复、媒体说明过滤、trust 和黑名单。失败时回滚代码版本；保持 Webhook 密钥和 KV 不变，原版仍能接收带密钥的请求。

仓库中的 [wrangler.toml](<wrangler.toml>) 只保留 KV 绑定占位示例，不包含实际 namespace ID。手动粘贴代码时，现有后台 `TOPIC_MAP` 绑定保持不变。若另行使用 Wrangler 部署，必须在 Git 忽略的本地配置中填写目标 Worker 的真实 namespace ID，并使用 `keep_vars = true` 保留后台普通变量；不能直接用占位配置执行真实部署。

没有完成配置和带密钥的 Webhook 注册，新版会拒收更新；不要先替换生产代码再补配置。

## 本地测试与限制

Node.js 22+，安装锁定版本的官方开发工具：

```bash
npm ci
npm run check
npm test
npm run build
```

`npm test` 同时执行 Node 模拟测试和真实 workerd/Miniflare 测试；后者使用本地 KV 和生产兼容日期 `2024-11-30`，覆盖旧数据升级、验证与双向消息路径。外部 Telegram / Siteverify 请求被拦截，不会发送真实消息。`npm run build` 是官方 Wrangler dry-run，不上传生产代码。

GitHub 的 [Worker checks](<.github/workflows/check.yml>) 会在 push 和 PR 自动运行这些检查，不包含部署权限。它不替代手动发布前的配置核对和真实 Telegram 验收。

- KV 是跨节点最终一致的存储，实例内进行了验证操作串行化，但不是全局原子锁；高并发下限流、消息去重和封禁生效时间不能保证强一致。严格保证需要迁移状态到 Durable Objects。
- 临时消息队列同样使用 KV，频繁写入可能遇到平台限制；有丢失或转发失败时用户需要重发。
- 验证链接是短期敏感链接，不要转发。网页通过只记录验证码结果，必须再由对应 Telegram 账号确认；它不保证真人无法找别人代做验证码。
- 媒体组延迟发送前会复查验证、关键词与封禁状态；这是逐条文本/说明过滤，不是整个相册的内容审查。
- 真实服务的可用性取决于 Cloudflare/Telegram、免费配额及配置；本地测试不替代部署后的实测。

参考：[Telegram 命令作用域](https://core.telegram.org/api/bots/commands)、[setMyCommands](https://core.telegram.org/bots/api#setmycommands)、[Turnstile 前端接入](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/)、[Siteverify 服务端校验](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)、[Telegram setWebhook](https://core.telegram.org/bots/api#setwebhook)。

## License

基于原项目 MIT License，见 [LICENSE](<LICENSE>)。
