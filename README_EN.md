# Telegram Private Chatbot: Turnstile moderation edition

[简体中文](<README.md>) | [Upstream project](https://github.com/jikssha/telegram_private_chatbot)

Based on upstream v5.3. A single Cloudflare Worker handles Telegram private messages, forum topics and the Turnstile verification page. State remains in the `TOPIC_MAP` KV binding.

## Features

- Rolling24-hour verification for non-trusted users; permanent trust bypasses verification and filtering.
- Turnstile success automatically submits the webpage, followed by signed confirmation from the matching Telegram account.
- First-message queuing, blacklist management, topic-user buttons and global keyword settings through Bot commands.
- Administrator commands support `/command@your_bot` and ignore commands addressed to other bots.
- Telegram command scopes can restrict management menus to administrators of one group.
- Existing topic mappings, permanent trust and blocks remain compatible. Actual credentials, account identifiers and KV namespace IDs are excluded from the repository.

## Policy

- **Blocked users** are silently ignored, including trusted users.
- **Trusted users** bypass verification and keyword filtering, but remain subject to message rate limits and closed conversations.
- **Other users** have text and media captions filtered before queuing/forwarding, even after successful verification. Matches are silently dropped, not automatically blocked.
- Verification lasts **24 hours after success**, not until midnight. The first ordinary message after expiry requires verification again.
- First messages wait for Turnstile success on the webpage, which automatically submits the token, then press the button in the bot's newest confirmation message. Its signed proof binds the challenge, account and expiry, avoiding a wait for the website's passed flag to propagate across KV regions. Only the matching Telegram account can confirm and forward queued messages.

Links expire after five minutes. The queue retains the first ten unique messages; overflow, expired queues and failed deliveries require resending. `/start` starts verification or asks the user to send a message; other private commands are ignored. Queued messages are checked again against current policy during replay.

Manage the global list in the admin group with `/keywords`, `/setkeywords word1,word2`, or the keyword entry in `/menu`. Bot settings persist in KV as `settings:filter_keywords` and replace the dashboard `FILTER_KEYWORDS` default. `/clearkeywords` requires button confirmation, persists an empty override and disables filtering without restoring the dashboard default. Up to 100 words, 128 characters per word and 2048 characters total; values are normalized and deduplicated. Regional propagation may take about a minute; no redeploy is needed.

Use English/Chinese commas or newlines as separators. Matching is case-insensitive, normalizes compatibility/full-width characters and removes common zero-width characters. Images, audio and file contents are not inspected.

Non-trusted text/captions are sent from checked snapshots, so editing the original while verification is pending cannot bypass filtering. Trusted users keep original-message forwarding. If filtering leaves only one member of an album, it is sent individually instead of as an invalid one-item media group.

## Admin commands

Only administrators of the configured group, or users additionally authorized through `ADMIN_IDS`, can manage users and send replies. All actions must occur in that group.

| Command | Effect |
| --- | --- |
| `/menu` | Open the group button menu: blacklist/keyword settings/UID help in General, with additional topic-user management in a user topic. State changes prompt for confirmation. |
| `/keywords` | View the global list and setup instructions. |
| `/setkeywords word1,word2` | Replace, normalize and deduplicate the global list. |
| `/clearkeywords` | Clear the list and disable filtering after button confirmation. |
| `/block [UID] [reason]` | Block the topic user, or a specified positive Telegram UID without needing a topic. |
| `/unblock [UID]` | Remove the block. Prior trust/verification is not restored. |
| `/ban`, `/unban` | Compatible aliases, also accept a UID. |
| `/blocklist [cursor]` | Paginated blacklist, with the next-page command in the result. |
| `/trust [UID]` | Permanently bypass verification and filtering; does not remove a block. |
| `/untrust [UID]` | Revoke trust and verification. |
| `/reset [UID]` | Clear trust, verification and pending challenge. |
| `/close`, `/open` | Close or reopen the conversation in its user topic. |
| `/info` | Show topic user information and moderation status. |
| `/cleanup` | Remove deleted-topic mappings; keep permanent trust and blocks. |

Explicit-UID moderation commands also work in General. All administrator commands accept `/command@your_bot`, including UID/reason arguments. Addressed commands query Telegram `getMe` to validate the current bot's username. Other bots' commands and unknown slash commands are ignored, never forwarded as replies; bare commands remain valid.

### Command menu scopes

BotFather's ordinary `/setcommands` sets the default list. Restricting management commands to one group requires Telegram Bot API `setMyCommands` scopes. This is a one-time Telegram-side configuration, not automatically applied by the Worker; configure each new bot separately.

| Scope | Commands |
| --- | --- |
| `default` | Only `start`, as the fallback for private chats and other groups. |
| `chat`, with the management group ID | Only `start` for ordinary members of that group. |
| `chat_administrators`, with the same group ID | The full administrator list below. |
| `chat_member`, with the same group and a user ID | Optional for non-admin members authorized through `ADMIN_IDS`; menu visibility does not grant permission. |

Default `setMyCommands` request:

```json
{
  "scope": { "type": "default" },
  "language_code": "",
  "commands": [{ "command": "start", "description": "Start verification or send a message" }]
}
```

For administrators, use the following scope and replace `commands` with command/description objects from this list. Replace the group placeholder locally. Never commit actual Tokens or request logs.

```json
{ "type": "chat_administrators", "chat_id": "<SUPERGROUP_ID>" }
```

Administrator command list (without `/`):

```text
menu - Open the administrator button menu
info - Show the topic user's information and status
block - Block the topic user or a supplied UID with an optional reason
unblock - Unblock the topic user or a supplied UID
blocklist - Show the blacklist and next-page command
trust - Permanently bypass verification and keyword filtering
untrust - Revoke trust and require fresh verification
reset - Reset verification and permanent trust
close - Close the current user conversation
open - Reopen the current user conversation
cleanup - Remove stale topic mappings while keeping trust and blocks
keywords - Show global keyword filter settings
setkeywords - Replace the list using commas or newlines
clearkeywords - Confirm clearing the list and disabling filtering
ban - Compatible alias for block
unban - Compatible alias for unblock
```

- Check the language-neutral list (`language_code: ""`) and previously configured language lists such as `zh` and `en`. Read back with `getMyCommands` using the same scope and language.
- Old `all_private_chats`, `all_group_chats`, `all_chat_administrators` or member-specific lists can override defaults. Remove obsolete overrides with `deleteMyCommands` as appropriate.
- Hidden commands are not authorization: users can still type them, but the Worker checks the configured group and administrator identity.
- Clients may cache an old menu; leave and reopen the chat. Do not put the full management list back into BotFather's default list or it will appear globally again.

## Deployment

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather), disable Group Privacy, and create a supergroup with Topics enabled. Add the bot as administrator with Manage Topics permission.
2. Deploy manually through the Cloudflare Worker editor using [worker.js](<worker.js>). Keep the dashboard KV binding named `TOPIC_MAP`. Git pushes run checks only; they do not publish this Worker.
3. Create a Managed Turnstile widget in Cloudflare Dashboard. Allow the exact hostname used to access the Worker, without a scheme or path.
4. Configure these variables and redeploy:

| Setting | Required | Value |
| --- | --- | --- |
| `TOPIC_MAP` | Yes | KV binding |
| `BOT_TOKEN` | Yes | Secret: Telegram bot token |
| `SUPERGROUP_ID` | Yes | Group ID beginning with `-100` |
| `WEBHOOK_SECRET` | Yes | Secret: random 1–256 characters from `A-Z`, `a-z`, `0-9`, `_`, `-` |
| `PUBLIC_URL` | Yes | HTTPS root URL of this Worker, e.g. `https://bot.example.com`; no subpath, query, credentials or fragment |
| `TURNSTILE_SITE_KEY` | Yes | Public widget Site Key |
| `TURNSTILE_SECRET_KEY` | Yes | Secret: widget Secret Key |
| `FILTER_KEYWORDS` | No | Default literal substrings, comma/newline-separated; used only before a list is saved through the Bot |
| `ADMIN_IDS` | No | Comma/whitespace-separated extra authorized Telegram UIDs |
| `API_BASE` | No | Trusted HTTPS Telegram API proxy; defaults to Telegram |

Never commit real credentials. Incomplete Turnstile settings fail closed; there is no local-quiz fallback. `/` receives Telegram updates and `/verify` serves verification.

Register the webhook from a trusted terminal, replacing placeholders:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  --data-urlencode "url=<PUBLIC_URL>/" \
  --data-urlencode "secret_token=<WEBHOOK_SECRET>" \
  --data-urlencode 'allowed_updates=["message","callback_query"]'
```

Require `ok: true`. Do not share terminal history or screenshots containing credentials. Re-register after rotating the secret. Wrong/missing request headers return 401; an unconfigured webhook secret returns 503.

## Migration from v5.3

Existing `banned:UID` entries, topic mappings and permanent `verified:UID = trusted` records remain compatible. Legacy quiz verification (`verified:UID = 1`) is not accepted: non-trusted users must verify on their next ordinary message. Old quiz buttons no longer work.

First verify an isolated Worker/KV/test bot/group. Then add all new settings to production, and **register the new webhook secret while the old code is still running**: upstream ignores the additional header and continues working. Confirm delivery, then manually paste the verified code into the Cloudflare editor and deploy. Do not drop pending Telegram updates. Missing/unsigned webhooks will be rejected by the new version.

The repository's [wrangler.toml](<wrangler.toml>) includes a placeholder KV example, not the real namespace ID. Editor-based deployment keeps the existing dashboard binding. If using Wrangler separately, supply the actual ID in a Git-ignored local config and use `keep_vars = true`; never run a real deployment from the placeholder config. Test deployments require separate KV/Bot/group resources. If deployment fails, roll back the code version without clearing KV or removing the webhook secret; upstream accepts the same signed requests.

## Tests and operational checks

Node.js 22+, with pinned official development tools:

```bash
npm ci
npm run check
npm test
npm run build
```

Tests include Node mocks and actual workerd/Miniflare execution with real local KV and the production compatibility date `2024-11-30`. Telegram/Siteverify traffic is intercepted; no real messages are sent. The build uses Wrangler dry-run, never uploading production code. [Worker checks](<.github/workflows/check.yml>) runs these checks on pushes and PRs without deployment credentials. After deployment, test the first-message gate, automatic webpage submission plus the newest signed Telegram confirmation, caption filtering, trust exemption, and `/block` → `/blocklist` → `/unblock`. Test `/menu` and `/info@your_bot`, keyword set/view/confirmed-clear, and command scopes: private chats and ordinary group members should see only `start`, while management-group administrators see the full list. Use `/reset UID` to exercise re-verification. If Telegram's embedded browser cannot solve the widget, use a system browser. Match `PUBLIC_URL` and the Turnstile hostname allowlist.

Limits:

- KV is eventually consistent across locations. Same-instance verification operations are serialized, but rate limits, deduplication and block propagation are not globally atomic. Use Durable Objects if strict guarantees are needed.
- Frequent writes to the KV pending queue may encounter platform limits. Resend on missing/failed delivery.
- Verification links are short-lived sensitive bearer links. Do not share them. Telegram confirmation binds completion to the account, but does not prevent a person from outsourcing the CAPTCHA.
- Delayed media groups recheck verification, blocks and keywords before sending. Filtering checks individual text/captions; it is not whole-album content moderation.
- Real availability and cost depend on Telegram, Cloudflare, quotas and deployment settings. Mock tests do not replace a live smoke test.

References: [Telegram command scopes](https://core.telegram.org/api/bots/commands), [setMyCommands](https://core.telegram.org/bots/api#setmycommands), [Turnstile widget](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/), [server-side Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/), [Telegram setWebhook](https://core.telegram.org/bots/api#setwebhook).

## License

Upstream MIT License: [LICENSE](<LICENSE>).
