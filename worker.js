// Cloudflare Worker：Telegram 双向机器人（基于 v5.3，Turnstile 每日验证）

// --- 配置常量 ---
const CONFIG = {
    VERIFY_ID_LENGTH: 32,
    VERIFY_EXPIRE_SECONDS: 300,         // 5分钟
    VERIFIED_EXPIRE_SECONDS: 86400,     // 验证成功后 24 小时
    MEDIA_GROUP_EXPIRE_SECONDS: 60,
    MEDIA_GROUP_DELAY_MS: 3000,         // 3秒（从2秒增加）
    PENDING_MAX_MESSAGES: 10,           // 验证期间最多暂存的消息数
    ADMIN_CACHE_TTL_SECONDS: 300,       // 管理员权限缓存 5 分钟
    NEEDS_REVERIFY_TTL_SECONDS: 600,    // 标记需重新验证的 TTL（用于并发兜底）
    RATE_LIMIT_MESSAGE: 45,
    RATE_LIMIT_VERIFY: 3,
    RATE_LIMIT_WINDOW: 60,
    MAX_TITLE_LENGTH: 128,
    MAX_NAME_LENGTH: 30,
    API_TIMEOUT_MS: 10000,
    CLEANUP_BATCH_SIZE: 10,
    MAX_CLEANUP_DISPLAY: 20,
    CLEANUP_LOCK_TTL_SECONDS: 1800,     // /cleanup 防并发锁 30 分钟
    MAX_RETRY_ATTEMPTS: 3,
    THREAD_HEALTH_TTL_MS: 60000
};

// 线程健康检查缓存，减少频繁探测请求
const threadHealthCache = new Map();
// 同一实例内的并发保护：避免同一用户短时间内重复创建话题
const topicCreateInFlight = new Map();
// 管理员权限缓存（实例内）
const adminStatusCache = new Map();

// shortcut: KV 跨节点最终一致，严格原子限流或去重需升级为 Durable Objects。
const verificationInFlight = new Map();

// --- 辅助工具函数 ---

// 结构化日志系统
const Logger = {
    /**
     * 记录信息级别日志
     * @param {string} action - 操作名称
     * @param {object} data - 附加数据
     */
    info(action, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'INFO',
            action,
            ...data
        };
        console.log(JSON.stringify(log));
    },

    /**
     * 记录警告级别日志
     * @param {string} action - 操作名称
     * @param {object} data - 附加数据
     */
    warn(action, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'WARN',
            action,
            ...data
        };
        console.warn(JSON.stringify(log));
    },

    /**
     * 记录错误级别日志
     * @param {string} action - 操作名称
     * @param {Error|string} error - 错误对象或消息
     * @param {object} data - 附加数据
     */
    error(action, error, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            action,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            ...data
        };
        console.error(JSON.stringify(log));
    },

    /**
     * 记录调试级别日志
     * @param {string} action - 操作名称
     * @param {object} data - 附加数据
     */
    debug(action, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'DEBUG',
            action,
            ...data
        };
        console.log(JSON.stringify(log));
    }
};

function secureRandomId(length = 12) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// 安全的 JSON 获取
async function safeGetJSON(env, key, defaultValue = null) {
    try {
        const data = await env.TOPIC_MAP.get(key, { type: "json" });
        if (data === null || data === undefined) {
            return defaultValue;
        }
        if (typeof data !== 'object') {
            Logger.warn('kv_invalid_type', { key, type: typeof data });
            return defaultValue;
        }
        return data;
    } catch (e) {
        Logger.error('kv_parse_failed', e, { key });
        return defaultValue;
    }
}

function normalizeTgDescription(description) {
    return (description || "").toString().toLowerCase();
}

function isTopicMissingOrDeleted(description) {
    const desc = normalizeTgDescription(description);
    return desc.includes("thread not found") ||
           desc.includes("topic not found") ||
           desc.includes("message thread not found") ||
           desc.includes("topic deleted") ||
           desc.includes("thread deleted") ||
           desc.includes("forum topic not found") ||
           desc.includes("topic closed permanently");
}

function isTestMessageInvalid(description) {
    const desc = normalizeTgDescription(description);
    return desc.includes("message text is empty") ||
           desc.includes("bad request: message text is empty");
}

async function getOrCreateUserTopicRec(from, key, env, userId) {
    const existing = await safeGetJSON(env, key, null);
    if (existing && existing.thread_id) return existing;

    const inflight = topicCreateInFlight.get(String(userId));
    if (inflight) return await inflight;

    const p = (async () => {
        // 并发下二次确认，避免已被其他请求创建却读到旧值
        const again = await safeGetJSON(env, key, null);
        if (again && again.thread_id) return again;
        return await createTopic(from, key, env, userId);
    })();

    topicCreateInFlight.set(String(userId), p);
    try {
        return await p;
    } finally {
        if (topicCreateInFlight.get(String(userId)) === p) {
            topicCreateInFlight.delete(String(userId));
        }
    }
}

function withMessageThreadId(body, threadId) {
    if (threadId === undefined || threadId === null) return body;
    return { ...body, message_thread_id: threadId };
}

async function probeForumThread(env, expectedThreadId, { userId, reason, doubleCheckOnMissingThreadId = true } = {}) {
    const attemptOnce = async () => {
        const res = await tgCall(env, "sendMessage", {
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: expectedThreadId,
            text: "🔎"
        });

        const actualThreadId = res.result?.message_thread_id;
        const probeMessageId = res.result?.message_id;

        // 尽可能清理探测消息（无论落到哪个话题/General）
        if (res.ok && probeMessageId) {
            try {
                await tgCall(env, "deleteMessage", {
                    chat_id: env.SUPERGROUP_ID,
                    message_id: probeMessageId
                });
            } catch (e) {
                // 删除失败不影响主流程
            }
        }

        if (!res.ok) {
            if (isTopicMissingOrDeleted(res.description)) {
                return { status: "missing", description: res.description };
            }
            if (isTestMessageInvalid(res.description)) {
                return { status: "probe_invalid", description: res.description };
            }
            return { status: "unknown_error", description: res.description };
        }

        // 关键：有些情况下 Telegram 会返回 ok 但不带 message_thread_id（常见于 General）
        if (actualThreadId === undefined || actualThreadId === null) {
            return { status: "missing_thread_id" };
        }

        if (Number(actualThreadId) !== Number(expectedThreadId)) {
            return { status: "redirected", actualThreadId };
        }

        return { status: "ok" };
    };

    const first = await attemptOnce();
    if (first.status !== "missing_thread_id" || !doubleCheckOnMissingThreadId) return first;

    // 二次探测：避免偶发字段缺失导致误判并触发重建
    const second = await attemptOnce();
    if (second.status === "missing_thread_id") {
        Logger.warn('thread_probe_missing_thread_id', { userId, expectedThreadId, reason });
    }
    return second;
}

async function resetUserVerificationAndRequireReverify(env, { userId, userKey, oldThreadId, pendingMsg, reason }) {
    const trusted = await env.TOPIC_MAP.get(`verified:${userId}`) === "trusted";
    if (!trusted) {
        await env.TOPIC_MAP.delete(`verified:${userId}`);
        await env.TOPIC_MAP.put(`needs_verify:${userId}`, "1", { expirationTtl: CONFIG.NEEDS_REVERIFY_TTL_SECONDS });
    }
    await env.TOPIC_MAP.delete(`retry:${userId}`);

    if (userKey) {
        await env.TOPIC_MAP.delete(userKey);
    }

    if (oldThreadId !== undefined && oldThreadId !== null) {
        await env.TOPIC_MAP.delete(`thread:${oldThreadId}`);
        await env.TOPIC_MAP.delete(`thread_ok:${oldThreadId}`);
        threadHealthCache.delete(oldThreadId);
    }

    Logger.info('verification_reset_due_to_topic_loss', {
        userId,
        oldThreadId,
        pendingMsgId: pendingMsg?.message_id,
        reason
    });

    if (trusted) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "⚠️ 对话话题已失效，请重发刚才的消息以创建新话题。" });
    } else {
        await invalidateUserChallenge(env, userId);
        await sendVerificationChallenge(userId, env, pendingMsg || null);
    }
}

function parseAdminIdAllowlist(env) {
    const raw = (env.ADMIN_IDS || "").toString().trim();
    if (!raw) return null;
    const ids = raw.split(/[,;\s]+/g).map(s => s.trim()).filter(Boolean);
    const set = new Set();
    for (const id of ids) {
        const n = Number(id);
        if (!Number.isFinite(n)) continue;
        set.add(String(n));
    }
    return set.size > 0 ? set : null;
}

async function isAdminUser(env, userId, refresh = false) {
    const allowlist = parseAdminIdAllowlist(env);
    if (allowlist && allowlist.has(String(userId))) return true;

    const cacheKey = String(userId);
    const now = Date.now();
    const cached = adminStatusCache.get(cacheKey);
    if (!refresh && cached && (now - cached.ts < CONFIG.ADMIN_CACHE_TTL_SECONDS * 1000)) {
        return cached.isAdmin;
    }

    const kvKey = `admin:${userId}`;
    const kvVal = await env.TOPIC_MAP.get(kvKey);
    if (!refresh && (kvVal === "1" || kvVal === "0")) {
        const isAdmin = kvVal === "1";
        adminStatusCache.set(cacheKey, { ts: now, isAdmin });
        return isAdmin;
    }

    try {
        const res = await tgCall(env, "getChatMember", {
            chat_id: env.SUPERGROUP_ID,
            user_id: userId
        });

        const status = res.result?.status;
        const isAdmin = res.ok && (status === "creator" || status === "administrator");
        await env.TOPIC_MAP.put(kvKey, isAdmin ? "1" : "0", { expirationTtl: CONFIG.ADMIN_CACHE_TTL_SECONDS });
        adminStatusCache.set(cacheKey, { ts: now, isAdmin });
        return isAdmin;
    } catch (e) {
        Logger.warn('admin_check_failed', { userId });
        return false;
    }
}

// 获取所有 KV keys（处理分页）
async function getAllKeys(env, prefix) {
    const allKeys = [];
    let cursor = undefined;

    do {
        const result = await env.TOPIC_MAP.list({ prefix, cursor });
        allKeys.push(...result.keys);
        cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);

    return allKeys;
}

function hasValidVerification(status) {
    const expiresAt = Number(status);
    return status === "trusted" || (Number.isSafeInteger(expiresAt) && expiresAt > Date.now());
}

function normalizeFilterText(text) {
    return String(text || "").normalize("NFKC").toLowerCase().replace(/[\u200B-\u200D\uFEFF]/g, "");
}

async function getFilterKeywords(env) {
    const stored = await env.TOPIC_MAP.get("settings:filter_keywords");
    // 空字符串是明确关闭过滤；只有从未设置时才使用后台默认名单。
    return stored === null ? String(env.FILTER_KEYWORDS || "") : stored;
}

async function matchesFilter(msg, env) {
    const text = normalizeFilterText(`${msg.text || ""}\n${msg.caption || ""}`);
    return (await getFilterKeywords(env)).split(/[,，\r\n]+/)
        .map(word => normalizeFilterText(word.trim())).filter(Boolean)
        .some(word => text.includes(word));
}

function turnstileOrigin(env) {
    if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY || !env.PUBLIC_URL) return null;
    try {
        const url = new URL(env.PUBLIC_URL);
        if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
        return url.origin;
    } catch {
        return null;
    }
}

// 速率限制检查
async function checkRateLimit(userId, env, action = 'message', limit = 20, window = 60) {
    const key = `ratelimit:${action}:${userId}`;
    const countStr = await env.TOPIC_MAP.get(key);
    const count = parseInt(countStr || "0");

    if (count >= limit) {
        return { allowed: false, remaining: 0 };
    }

    await env.TOPIC_MAP.put(key, String(count + 1), { expirationTtl: window });
    return { allowed: true, remaining: limit - count - 1 };
}

export default {
  async fetch(request, env, ctx) {
    // 环境自检
    if (!env.TOPIC_MAP) return new Response("Error: KV 'TOPIC_MAP' not bound.");
    if (!env.BOT_TOKEN) return new Response("Error: BOT_TOKEN not set.");
    if (!env.SUPERGROUP_ID) return new Response("Error: SUPERGROUP_ID not set.");

    // 【修复 #7】规范化环境变量，统一为字符串类型
    const normalizedEnv = {
        ...env,
        SUPERGROUP_ID: String(env.SUPERGROUP_ID),
        BOT_TOKEN: String(env.BOT_TOKEN)
    };

    // 验证 SUPERGROUP_ID 格式
    if (!normalizedEnv.SUPERGROUP_ID.startsWith("-100")) {
        return new Response("Error: SUPERGROUP_ID must start with -100");
    }

    const url = new URL(request.url);
    if (url.pathname === "/verify") return handleTurnstileRequest(request, normalizedEnv);
    if (url.pathname !== "/") return new Response("Not found", { status: 404 });
    if (request.method === "GET") return new Response("OK");
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    // Telegram 设置 secret_token 后会在每个更新中携带此请求头。
    if (!env.WEBHOOK_SECRET) return new Response("Webhook secret not configured", { status: 503 });
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
    }

    // 验证 Content-Type
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
        Logger.warn('invalid_content_type', { contentType });
        return new Response("OK");
    }

    let update;
    try {
      update = await request.json();

      // 验证基本结构
      if (!update || typeof update !== 'object') {
          Logger.warn('invalid_json_structure', { update: typeof update });
          return new Response("OK");
      }
    } catch (e) {
      Logger.error('json_parse_failed', e);
      return new Response("OK");
    }

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, normalizedEnv, ctx);
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) return new Response("OK");

    ctx.waitUntil(flushExpiredMediaGroups(normalizedEnv, Date.now()));

    if (msg.chat && msg.chat.type === "private") {
      try {
        await handlePrivateMessage(msg, normalizedEnv, ctx);
      } catch (e) {
        // 不向用户泄露技术细节
        const errText = `⚠️ 系统繁忙，请稍后再试。`;
        await tgCall(normalizedEnv, "sendMessage", { chat_id: msg.chat.id, text: errText });
        Logger.error('private_message_failed', e, { userId: msg.chat.id });
      }
      return new Response("OK");
    }

    // 【修复 #7】使用字符串比较
    if (msg.chat && String(msg.chat.id) === normalizedEnv.SUPERGROUP_ID) {
        if (msg.forum_topic_closed && msg.message_thread_id) {
            await updateThreadStatus(msg.message_thread_id, true, normalizedEnv);
            return new Response("OK");
        }
        if (msg.forum_topic_reopened && msg.message_thread_id) {
            await updateThreadStatus(msg.message_thread_id, false, normalizedEnv);
            return new Response("OK");
        }
        // 【修复】支持 General 话题和普通话题
        // General 话题的 message_thread_id 可能不存在，或者等于 1
        const text = (msg.text || "").trim();
        const isCommand = !!text && text.startsWith("/");
        if (msg.message_thread_id || isCommand) {
            await handleAdminReply(msg, normalizedEnv, ctx);
            return new Response("OK");
        }
    }

    return new Response("OK");
  },
};

// ---------------- 核心业务逻辑 ----------------

async function handlePrivateMessage(msg, env, ctx) {
  const userId = msg.chat.id;
  const key = `user:${userId}`;

  // 黑名单优先于 trust 和限流提示，封禁用户完全静默。
  if (await env.TOPIC_MAP.get(`banned:${userId}`)) return;

  // 速率限制检查
  const rateLimit = await checkRateLimit(userId, env, 'message', CONFIG.RATE_LIMIT_MESSAGE, CONFIG.RATE_LIMIT_WINDOW);
  if (!rateLimit.allowed) {
      await tgCall(env, "sendMessage", {
          chat_id: userId,
          text: "⚠️ 发送过于频繁，请稍后再试。"
      });
      return;
  }

  // 拦截普通用户发送的指令
  if (msg.text && msg.text.startsWith("/") && msg.text.trim() !== "/start") {
      return;
  }

  if (msg.text?.trim() === "/start") {
    const verified = await env.TOPIC_MAP.get(`verified:${userId}`);
    if (!hasValidVerification(verified)) await sendVerificationChallenge(userId, env, null);
    else await tgCall(env, "sendMessage", { chat_id: userId, text: "✅ 请直接发送您的消息。" });
    return;
  }

  await forwardToTopic(msg, userId, key, env, ctx);
}

async function forwardToTopic(msg, userId, key, env, ctx) {
    if (await env.TOPIC_MAP.get(`banned:${userId}`)) return false;
    const verified = await env.TOPIC_MAP.get(`verified:${userId}`);
    const trusted = verified === "trusted";
    if (!trusted && await matchesFilter(msg, env)) {
        Logger.info('message_keyword_filtered', { userId, messageId: msg.message_id });
        return false;
    }
    const needsVerify = await env.TOPIC_MAP.get(`needs_verify:${userId}`);
    if (!trusted && (!hasValidVerification(verified) || needsVerify)) {
        if (await sendVerificationChallenge(userId, env, msg) === "verified") {
            return forwardToTopic(msg, userId, key, env, ctx);
        }
        return false;
    }

    // 【修复 #4】使用安全的 JSON 解析
    let rec = await safeGetJSON(env, key, null);

    if (rec && rec.closed) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "🚫 当前对话已被管理员关闭。" });
        return;
    }

    // 【修复 #5】重试计数器，防止无限循环
    const retryKey = `retry:${userId}`;
    let retryCount = parseInt(await env.TOPIC_MAP.get(retryKey) || "0");

    if (retryCount > CONFIG.MAX_RETRY_ATTEMPTS) {
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: "❌ 系统繁忙，请稍后再试。"
        });
        await env.TOPIC_MAP.delete(retryKey);
        return;
    }

    if (!rec || !rec.thread_id) {
        rec = await getOrCreateUserTopicRec(msg.from, key, env, userId);
        if (!rec || !rec.thread_id) {
            throw new Error("创建话题失败");
        }
    }

    // 补建 thread->user 映射（兼容旧数据）
    if (rec && rec.thread_id) {
        const mappedUser = await env.TOPIC_MAP.get(`thread:${rec.thread_id}`);
        if (!mappedUser) {
            await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(userId));
        }
    }

    // 【修复1】验证话题是否仍然存在（带缓存，降低探测频率）
    // 当话题被删除后，KV中的thread_id仍然存在，但实际话题已不可用
    if (rec && rec.thread_id) {
        const cacheKey = rec.thread_id;
        const now = Date.now();
        const cached = threadHealthCache.get(cacheKey);
        const withinTTL = cached && (now - cached.ts < CONFIG.THREAD_HEALTH_TTL_MS);

        if (!withinTTL) {
            // 跨节点缓存：避免由于 Workers 多 PoP 导致每次都做健康探测
            const kvHealthKey = `thread_ok:${rec.thread_id}`;
            const kvHealthOk = await env.TOPIC_MAP.get(kvHealthKey);
            if (kvHealthOk === "1") {
                threadHealthCache.set(cacheKey, { ts: now, ok: true });
            } else {
            const probe = await probeForumThread(env, rec.thread_id, { userId, reason: "health_check" });

            if (probe.status === "redirected" || probe.status === "missing" || probe.status === "missing_thread_id") {
                    await resetUserVerificationAndRequireReverify(env, {
                        userId,
                        userKey: key,
                        oldThreadId: rec.thread_id,
                        pendingMsg: msg,
                        reason: `health_check:${probe.status}`
                    });
                    return;
            } else if (probe.status === "probe_invalid") {
                Logger.warn('topic_health_probe_invalid_message', {
                    userId,
                    threadId: rec.thread_id,
                    errorDescription: probe.description
                });

                // 仍然设置短 TTL，避免每条消息都探测（并误触发重建）
                threadHealthCache.set(cacheKey, { ts: now, ok: true });
                await env.TOPIC_MAP.put(kvHealthKey, "1", { expirationTtl: Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1000) });
            } else if (probe.status === "unknown_error") {
                Logger.warn('topic_test_failed_unknown', {
                    userId,
                    threadId: rec.thread_id,
                    errorDescription: probe.description
                });
            } else {
                await env.TOPIC_MAP.delete(retryKey);
                threadHealthCache.set(cacheKey, { ts: now, ok: true });
                await env.TOPIC_MAP.put(kvHealthKey, "1", { expirationTtl: Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1000) });
            }
            }
        }
    }

    // 话题探测可能等待外部 API，实际发送前重新检查管理员变更。
    if (await env.TOPIC_MAP.get(`banned:${userId}`)) return false;
    const deliveryStatus = await env.TOPIC_MAP.get(`verified:${userId}`);
    const deliveryTrusted = deliveryStatus === "trusted";
    if (!deliveryTrusted && await matchesFilter(msg, env)) return false;
    if (!deliveryTrusted && (!hasValidVerification(deliveryStatus) || await env.TOPIC_MAP.get(`needs_verify:${userId}`))) {
        if (await sendVerificationChallenge(userId, env, msg) === "verified") {
            return forwardToTopic(msg, userId, key, env, ctx);
        }
        return false;
    }

    if (msg.media_group_id) {
        await handleMediaGroup(msg, env, ctx, {
            direction: "p2t",
            targetChat: env.SUPERGROUP_ID,
            threadId: rec.thread_id
        });
        return true;
    }

    // 陌生人只能发送已检查的文本快照，避免验证期间编辑原消息绕过过滤。
    const method = deliveryTrusted ? "forwardMessage" : (msg.text !== undefined ? "sendMessage" : "copyMessage");
    const body = { chat_id: env.SUPERGROUP_ID, message_thread_id: rec.thread_id };
    if (method === "sendMessage") {
        body.text = msg.text;
        if (msg.entities) body.entities = msg.entities;
    } else {
        body.from_chat_id = userId;
        body.message_id = msg.message_id;
        if (method === "copyMessage") {
            body.caption = msg.caption || "";
            if (msg.caption_entities) body.caption_entities = msg.caption_entities;
        }
    }
    const res = await tgCall(env, method, body);

    // 检测 Telegram 静默重定向到 General 的情况
    const resThreadId = res.result?.message_thread_id;
    if (res.ok && resThreadId !== undefined && resThreadId !== null && Number(resThreadId) !== Number(rec.thread_id)) {
        Logger.warn('forward_redirected_to_general', {
            userId,
            expectedThreadId: rec.thread_id,
            actualThreadId: resThreadId
        });

        // 删除误投到 General 的消息
        if (res.result?.message_id) {
            try {
                await tgCall(env, "deleteMessage", {
                    chat_id: env.SUPERGROUP_ID,
                    message_id: res.result.message_id
                });
            } catch (e) {
                // 删除失败不影响重发
            }
        }
        await resetUserVerificationAndRequireReverify(env, {
            userId,
            userKey: key,
            oldThreadId: rec.thread_id,
            pendingMsg: msg,
            reason: "forward_redirected_to_general"
        });
        return;
    }

    // 兜底：部分情况下 Telegram 返回 ok 但不带 message_thread_id（可能已落入 General）
    if (res.ok && method !== "copyMessage" && (resThreadId === undefined || resThreadId === null)) {
        const probe = await probeForumThread(env, rec.thread_id, { userId, reason: "forward_result_missing_thread_id" });
        if (probe.status !== "ok") {
            Logger.warn('forward_suspected_redirect_or_missing', {
                userId,
                expectedThreadId: rec.thread_id,
                probeStatus: probe.status,
                probeDescription: probe.description
            });

            // 尽量删除误投消息（通常在 General）
            if (res.result?.message_id) {
                try {
                    await tgCall(env, "deleteMessage", {
                        chat_id: env.SUPERGROUP_ID,
                        message_id: res.result.message_id
                    });
                } catch (e) {
                    // 删除失败不影响重发
                }
            }
            await resetUserVerificationAndRequireReverify(env, {
                userId,
                userKey: key,
                oldThreadId: rec.thread_id,
                pendingMsg: msg,
                reason: `forward_missing_thread_id:${probe.status}`
            });
            return;
        }
    }

    // 【修复2】增强错误处理，双重保险
    // 如果上面的测试没有捕获到，这里再次检测
    if (!res.ok) {
        const desc = normalizeTgDescription(res.description);
        if (isTopicMissingOrDeleted(desc)) {
            Logger.warn('forward_failed_topic_missing', {
                userId,
                threadId: rec.thread_id,
                errorDescription: res.description
            });
            await resetUserVerificationAndRequireReverify(env, {
                userId,
                userKey: key,
                oldThreadId: rec.thread_id,
                pendingMsg: msg,
                reason: "forward_failed_topic_missing"
            });
            return;
        }

        if (desc.includes("chat not found")) throw new Error(`群组ID错误: ${env.SUPERGROUP_ID}`);
        if (desc.includes("not enough rights")) throw new Error("机器人权限不足 (需 Manage Topics)");

        if (!deliveryTrusted) throw new Error("消息转发失败");
        // 只有 trust 用户允许从原始消息降级复制。
        const copied = await tgCall(env, "copyMessage", {
            chat_id: env.SUPERGROUP_ID,
            from_chat_id: userId,
            message_id: msg.message_id,
            message_thread_id: rec.thread_id
        });
        if (!copied.ok) throw new Error("消息转发失败");
    }
    return true;
}

function parsePositiveSafeUserId(value) {
  const text = String(value || "");
  if (!/^[1-9]\d*$/.test(text)) return null;
  const userId = Number(text);
  return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
}

async function sendAdminReply(env, threadId, text, parseMode, replyMarkup) {
  return await tgCall(env, "sendMessage", withMessageThreadId({
      chat_id: env.SUPERGROUP_ID,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  }, threadId));
}

async function showKeywordSettings(env, threadId) {
  const keywords = await getFilterKeywords(env);
  const enabled = keywords.split(/[,，\r\n]+/).some(word => normalizeFilterText(word.trim()));
  const preview = keywords.length > 3000 ? `${keywords.slice(0, 3000)}\n（名单过长，显示已截断）` : keywords;
  await sendAdminReply(env, threadId, `🔎 全局关键词过滤\n${enabled ? `当前名单:\n${preview}` : "未启用（名单为空）"}\n\n/setkeywords 词1,词2：替换名单\n/clearkeywords：确认后清空\n仅过滤未 trust 用户的文字和媒体说明。\nBot 设置优先于后台 FILTER_KEYWORDS，跨地区生效可能有约一分钟延迟。`, undefined, {
      inline_keyboard: [[{ text: "🗑 清空关键词", callback_data: "admin:ask-clearkeywords:0" }]]
  });
}

async function confirmClearKeywords(env, threadId) {
  await sendAdminReply(env, threadId, "确认清空全局关键词名单并关闭过滤？不会改变任何用户的信任或封禁状态。", undefined, {
      inline_keyboard: [[{ text: "确认清空", callback_data: "admin:clearkeywords:0" }, { text: "取消", callback_data: "admin:cancel:0" }]]
  });
}

async function handleKeywordCommand(command, input, env, threadId) {
  if (command === "/setkeywords") {
      const words = [...new Set(input.split(/[,，\r\n]+/).map(word => normalizeFilterText(word.trim())).filter(Boolean))];
      if (!words.length || input.length > 2048 || words.length > 100 || words.some(word => word.length > 128 || /[\u0000-\u001f\u007f]/.test(word)) || words.join(",").length > 2048) {
          await sendAdminReply(env, threadId, "用法: /setkeywords 词1,词2\n最多100个词，每词不超过128字符，总计不超过2048字符。英文/中文逗号或换行分隔，空名单请用 /clearkeywords。");
          return;
      }
      await env.TOPIC_MAP.put("settings:filter_keywords", words.join(","));
      await sendAdminReply(env, threadId, `✅ 已保存 ${words.length} 个全局关键词（已规范化并去重）。\n${words.join(",")}\n跨地区生效可能有约一分钟延迟，无需重新部署。`);
      return;
  }
  if (input) {
      await sendAdminReply(env, threadId, `用法: ${command}（不带参数）`);
      return;
  }
  if (command === "/keywords") await showKeywordSettings(env, threadId);
  else await confirmClearKeywords(env, threadId);
}

async function getTopicUser(env, threadId) {
  if (!Number.isSafeInteger(Number(threadId)) || Number(threadId) <= 1) return null;
  const mapped = await env.TOPIC_MAP.get(`thread:${threadId}`);
  if (mapped) return parsePositiveSafeUserId(mapped);
  for (const { name } of await getAllKeys(env, "user:")) {
      const record = await safeGetJSON(env, name, null);
      if (record && Number(record.thread_id) === Number(threadId)) return parsePositiveSafeUserId(name.slice(5));
  }
  return null;
}

async function sendAdminMenu(env, threadId) {
  const userId = await getTopicUser(env, threadId);
  const button = (text, action) => ({ text, callback_data: `admin:${action}:${userId || 0}` });
  const rows = [[button("🚫 黑名单", "blocklist"), button("📖 UID 指令", "help")],
      [{ text: "🔎 全局关键词管理", callback_data: "admin:keywords:0" }]];
  if (userId) rows.push(
      [button("👤 用户信息", "info")],
      [button("🚫 封禁", "ask-block"), button("✅ 解封", "ask-unblock")],
      [button("🌟 永久信任", "ask-trust"), button("↩️ 取消信任", "ask-untrust")],
      [button("🔄 重置验证", "ask-reset")],
      [button("🔒 关闭会话", "ask-close"), button("🔓 打开会话", "ask-open")]
  );
  return sendAdminReply(env, threadId, userId
      ? `🛠 管理菜单\n当前用户 UID: ${userId}\n用户操作仅针对本话题用户；关键词管理为全局设置。更改用户状态前会再次确认。`
      : "🛠 管理菜单\n请进入用户话题发送 /menu 管理该用户，或查看 UID 指令。", undefined, { inline_keyboard: rows });
}

async function handleAdminMenuCallback(query, env, ctx) {
  const match = /^admin:(ask-)?(blocklist|help|keywords|clearkeywords|info|block|unblock|trust|untrust|reset|close|open|cancel):(0|[1-9]\d*)$/.exec(query.data || "");
  const answer = text => tgCall(env, "answerCallbackQuery", { callback_query_id: query.id, ...(text ? { text, show_alert: true } : {}) });
  if (!match || !query.from?.id || String(query.message?.chat?.id) !== env.SUPERGROUP_ID || query.message.chat.type !== "supergroup") {
      await answer("❌ 菜单无效，请在管理群重新发送 /menu。");
      return;
  }
  if (!(await isAdminUser(env, query.from.id, true))) {
      await answer("❌ 仅管理员可操作。");
      return;
  }
  const [, confirm, action, target] = match;
  const threadId = query.message.message_thread_id;
  const currentUser = await getTopicUser(env, threadId);
  if ((target !== "0" && String(currentUser) !== target) ||
      (target === "0" && !["blocklist", "help", "keywords", "clearkeywords", "cancel"].includes(action)) ||
      (["keywords", "clearkeywords"].includes(action) && target !== "0")) {
      await answer("❌ 菜单目标已失效，请在用户话题重新发送 /menu。");
      return;
  }
  await answer();
  if (action === "cancel") return;
  if (action === "keywords") {
      await showKeywordSettings(env, threadId);
      return;
  }
  if (action === "clearkeywords") {
      if (confirm) await confirmClearKeywords(env, threadId);
      else {
          await env.TOPIC_MAP.put("settings:filter_keywords", "");
          await sendAdminReply(env, threadId, "✅ 已清空全局关键词名单，过滤关闭。Bot 的空名单仍覆盖后台默认值，跨地区生效可能有约一分钟延迟。");
      }
      return;
  }
  if (action === "help") {
      await sendAdminReply(env, threadId, "📖 按 UID 管理\n/block UID [原因]\n/unblock UID\n/trust UID（免验证码和关键词过滤）\n/untrust UID\n/reset UID（清除信任及验证）\n/blocklist [游标]\n进入用户话题发送 /menu，可直接管理该用户。");
      return;
  }
  if (confirm) {
      if (["blocklist", "info"].includes(action)) return;
      const labels = { block: "封禁", unblock: "解封", trust: "永久信任（免验证码和关键词过滤）", untrust: "取消信任", reset: "重置验证（同时取消信任）", close: "关闭会话", open: "打开会话" };
      await sendAdminReply(env, threadId, `确认对 UID ${target} 执行「${labels[action]}」？`, undefined, {
          inline_keyboard: [[{ text: "确认操作", callback_data: `admin:${action}:${target}` }, { text: "取消", callback_data: `admin:cancel:${target}` }]]
      });
      return;
  }
  await handleAdminReply({ ...query.message, from: query.from, text: `/${action}` }, env, ctx);
}

async function handleBlockListCommand(env, threadId, cursor) {
  if (cursor && cursor.length > 1024) return sendAdminReply(env, threadId, "❌ 分页游标无效，请使用 /blocklist 从第一页开始。");
  let result;
  try {
      result = await env.TOPIC_MAP.list({ prefix: "banned:", limit: 50, ...(cursor ? { cursor } : {}) });
  } catch {
      return sendAdminReply(env, threadId, "⚠️ 无法读取黑名单，请检查分页游标或稍后重试。");
  }
  if (result.cursor && result.cursor.length > 1024) return sendAdminReply(env, threadId, "⚠️ 分页游标异常，请稍后重试。");
  const lines = ["🚫 封禁用户列表"];

  for (const key of result.keys || []) {
      const userId = parsePositiveSafeUserId(key.name.slice("banned:".length));
      if (!userId) continue;
      const value = await env.TOPIC_MAP.get(key.name);
      let suffix = "";
      if (value && value !== "1") {
          try {
              const metadata = JSON.parse(value);
              if (metadata.reason) {
                  suffix = ` — ${String(metadata.reason).replace(/[\r\n]+/g, " ").slice(0, 32).replace(/\p{Surrogate}$/u, "")}`;
              }
          } catch {
              // Legacy values are intentionally displayed without metadata.
          }
      }
      lines.push(`${userId}${suffix}`);
  }

  if (lines.length === 1) lines.push("（空）");
  if (!result.list_complete && result.cursor) lines.push(`下一页: /blocklist ${result.cursor}`);
  return await sendAdminReply(env, threadId, lines.join("\n"));
}

async function normalizeAdminCommand(env, command) {
  const match = /^\/[a-z0-9_]+(?:@([A-Za-z0-9_]+))?$/.exec(command);
  if (!match) return null;
  if (match[1]) {
      const identity = await tgCall(env, "getMe", {});
      if (!identity.ok || typeof identity.result?.username !== "string" ||
          identity.result.username.toLowerCase() !== match[1].toLowerCase()) return null;
  }
  return command.split("@")[0];
}

async function handleAdminReply(msg, env, ctx) {
  const threadId = msg.message_thread_id;
  const text = (msg.text || "").trim();
  const senderId = msg.from?.id;
  const parts = text.split(/\s+/);
  let command = parts[0] || "";
  const args = parts.slice(1);
  const targetCommands = new Set(["/block", "/unblock", "/ban", "/unban", "/trust", "/untrust", "/reset"]);

  // 仅允许管理员在群内操作与回信，防止任意群成员向用户私聊注入消息
  const keywordCommands = ["/keywords", "/setkeywords", "/clearkeywords"];
  if (!senderId || !(await isAdminUser(env, senderId, keywordCommands.includes(command.split("@")[0])))) return;
  if (text.startsWith("/")) {
      command = await normalizeAdminCommand(env, command);
      if (!command) return;
  }

  if (keywordCommands.includes(command)) {
      try {
          await handleKeywordCommand(command, text.slice(parts[0].length).trim(), env, threadId);
      } catch (error) {
          Logger.error('keyword_settings_failed', error);
          await sendAdminReply(env, threadId, "⚠️ 关键词配置读写失败，请稍后重试；未确认保存成功的设置不要视为已生效。");
      }
      return;
  }

  if (command === "/menu") {
      if (args.length === 0) await sendAdminMenu(env, threadId);
      return;
  }

  // 【修复】允许在任何话题执行 /cleanup 命令
  if (command === "/cleanup" && args.length === 0) {
      // /cleanup 可能处理较久，使用 waitUntil 防止 webhook 请求超时导致“卡住”
      ctx.waitUntil(handleCleanupCommand(threadId, env));
      return;
  }

  if (command === "/blocklist") {
      if (args.length > 1) return;
      await handleBlockListCommand(env, threadId, args[0]);
      return;
  }

  let explicitUserId = null;
  if (targetCommands.has(command) && args.length > 0) {
      explicitUserId = parsePositiveSafeUserId(args[0]);
      if (!explicitUserId) {
          await sendAdminReply(env, threadId, `用法: ${command} [正整数UID]`);
          return;
      }
  }

  const moderationCommand = targetCommands.has(command);
  let userId = explicitUserId;

  // Unknown slash commands must never be copied to a private user.
  if (text.startsWith("/") && !moderationCommand && !["/close", "/open", "/info"].includes(command)) return;

  // 菜单和文本命令使用相同的话题映射，避免 General 被误识别为用户会话。
  if (!userId) userId = await getTopicUser(env, threadId);

  // 如果找不到用户，说明可能是在普通话题，或者数据丢失，直接返回
  if (!userId) return;

  // --- 指令区域 ---

  if (command === "/close" && args.length === 0) {
      const key = `user:${userId}`;
      let rec = await safeGetJSON(env, key, null);
      if (rec) {
          rec.closed = true;
          await env.TOPIC_MAP.put(key, JSON.stringify(rec));
          await tgCall(env, "closeForumTopic", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId });
          await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "🚫 **对话已强制关闭**", parse_mode: "Markdown" });
      }
      return;
  }

  if (command === "/open" && args.length === 0) {
      const key = `user:${userId}`;
      let rec = await safeGetJSON(env, key, null);
      if (rec) {
          rec.closed = false;
          await env.TOPIC_MAP.put(key, JSON.stringify(rec));
          await tgCall(env, "reopenForumTopic", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId });
          await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "✅ **对话已恢复**", parse_mode: "Markdown" });
      }
      return;
  }

  if (targetCommands.has(command)) {
      const targetId = userId;
      await serializeVerification(targetId, async () => {
          if (command === "/block" || command === "/ban") {
              const reason = explicitUserId && args.length > 1
                  ? args.slice(1).join(" ").trim().slice(0, 200)
                  : "";
              const value = reason
                  ? JSON.stringify({ actor: senderId, timestamp: Date.now(), reason })
                  : "1";
              await env.TOPIC_MAP.put(`banned:${targetId}`, value);
              await env.TOPIC_MAP.delete(`verified:${targetId}`);
              await env.TOPIC_MAP.delete(`needs_verify:${targetId}`);
              await invalidateUserChallenge(env, targetId);
              await sendAdminReply(env, threadId, "🚫 **用户已封禁**", "Markdown");
          } else if (command === "/unblock" || command === "/unban") {
              await env.TOPIC_MAP.delete(`banned:${targetId}`);
              await sendAdminReply(env, threadId, "✅ **用户已解封**", "Markdown");
          } else if (command === "/trust") {
              await env.TOPIC_MAP.put(`verified:${targetId}`, "trusted");
              await env.TOPIC_MAP.delete(`needs_verify:${targetId}`);
              await invalidateUserChallenge(env, targetId);
              await sendAdminReply(env, threadId, "🌟 **已设置永久信任**", "Markdown");
          } else if (command === "/untrust") {
              await env.TOPIC_MAP.delete(`verified:${targetId}`);
              await env.TOPIC_MAP.delete(`needs_verify:${targetId}`);
              await invalidateUserChallenge(env, targetId);
              await sendAdminReply(env, threadId, "↩️ **已取消信任**", "Markdown");
          } else if (command === "/reset") {
              await env.TOPIC_MAP.delete(`verified:${targetId}`);
              await env.TOPIC_MAP.delete(`needs_verify:${targetId}`);
              await invalidateUserChallenge(env, targetId);
              await sendAdminReply(env, threadId, "🔄 **验证重置**", "Markdown");
          }
      });
      return;
  }

  if (command === "/info" && args.length === 0) {
      const userKey = `user:${userId}`;
      const userRec = await safeGetJSON(env, userKey, null);
      const verifyStatus = await env.TOPIC_MAP.get(`verified:${userId}`);
      const banStatus = await env.TOPIC_MAP.get(`banned:${userId}`);
      const verificationText = hasValidVerification(verifyStatus)
          ? (verifyStatus === "trusted" ? "🌟 永久信任" : "✅ 已验证")
          : "❌ 未验证";

      const info = `👤 <b>用户信息</b>\nUID: <code>${userId}</code>\nTopic ID: <code>${threadId}</code>\n话题标题: ${escapeHtml(userRec?.title || "未知")}\n验证状态: ${verificationText}\n封禁状态: ${banStatus ? '🚫 已封禁' : '✅ 正常'}\nLink: <a href="tg://user?id=${userId}">点击私聊</a>`;
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: info, parse_mode: "HTML" });
      return;
  }

  // 转发管理员消息给用户
  if (msg.media_group_id) {
    await handleMediaGroup(msg, env, ctx, { direction: "t2p", targetChat: userId, threadId: undefined });
    return;
  }
  if (text.startsWith("/")) return;
  await tgCall(env, "copyMessage", { chat_id: userId, from_chat_id: env.SUPERGROUP_ID, message_id: msg.message_id });
}

// ---------------- Turnstile 验证 ----------------

async function serializeVerification(userId, operation) {
    const key = String(userId);
    const previous = verificationInFlight.get(key);
    const current = (previous ? previous.catch(() => {}) : Promise.resolve()).then(operation);
    verificationInFlight.set(key, current);
    try {
        return await current;
    } finally {
        if (verificationInFlight.get(key) === current) verificationInFlight.delete(key);
    }
}

async function invalidateUserChallenge(env, userId) {
    const id = await env.TOPIC_MAP.get(`user_challenge:${userId}`);
    if (id) await env.TOPIC_MAP.delete(`chal:${id}`);
    await env.TOPIC_MAP.delete(`user_challenge:${userId}`);
}

async function getActiveChallenge(env, id) {
    if (!/^[a-z0-9]{32}$/.test(id || "")) return null;
    const state = await safeGetJSON(env, `chal:${id}`);
    if (!state || state.kind !== "turnstile" || !(state.expiresAt > Date.now())) return null;
    if (await env.TOPIC_MAP.get(`user_challenge:${state.userId}`) !== id) return null;
    if (await env.TOPIC_MAP.get(`banned:${state.userId}`)) return null;
    return state;
}

async function saveChallenge(env, id, state) {
    await env.TOPIC_MAP.put(`chal:${id}`, JSON.stringify(state), {
        expirationTtl: Math.max(60, Math.ceil((state.expiresAt - Date.now()) / 1000))
    });
}

function pendingMessage(msg) {
    if (!msg) return null;
    // 保留过滤和媒体组所需字段，不存无关的用户资料或消息实体。
    const result = {};
    for (const key of ["message_id", "chat", "from", "text", "entities", "caption", "caption_entities", "media_group_id", "photo", "video", "document", "audio", "animation"]) {
        if (msg[key] !== undefined) result[key] = msg[key];
    }
    return result;
}

async function sendVerificationChallenge(userId, env, msg) {
    return serializeVerification(userId, async () => {
        if (await env.TOPIC_MAP.get(`banned:${userId}`)) return;
        const status = await env.TOPIC_MAP.get(`verified:${userId}`);
        if (hasValidVerification(status) && (status === "trusted" || !(await env.TOPIC_MAP.get(`needs_verify:${userId}`)))) return "verified";
        const origin = turnstileOrigin(env);
        if (!origin) {
            await tgCall(env, "sendMessage", { chat_id: userId, text: "⚠️ 验证服务尚未配置，请稍后再试。" });
            return;
        }
        const existingId = await env.TOPIC_MAP.get(`user_challenge:${userId}`);
        const existing = await getActiveChallenge(env, existingId);
        if (existing && String(existing.userId) === String(userId)) {
            if (msg && !existing.pending_messages.some(item => item.message_id === msg.message_id) && existing.pending_messages.length < CONFIG.PENDING_MAX_MESSAGES) {
                existing.pending_messages.push(pendingMessage(msg));
                await saveChallenge(env, existingId, existing);
            }
            return;
        }
        await invalidateUserChallenge(env, userId);
        const limit = await checkRateLimit(userId, env, 'verify', CONFIG.RATE_LIMIT_VERIFY, 300);
        if (!limit.allowed) {
            await tgCall(env, "sendMessage", { chat_id: userId, text: "⚠️ 验证请求过于频繁，请5分钟后再试。" });
            return;
        }
        const id = secureRandomId(CONFIG.VERIFY_ID_LENGTH);
        const state = {
            kind: "turnstile", userId, expiresAt: Date.now() + CONFIG.VERIFY_EXPIRE_SECONDS * 1000,
            pending_messages: msg ? [pendingMessage(msg)] : [], turnstilePassed: false
        };
        await saveChallenge(env, id, state);
        await env.TOPIC_MAP.put(`user_challenge:${userId}`, id, { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });
        const result = await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: "🛡️ 请打开网页完成人机验证并提交，然后点击机器人发来的最新「确认验证」按钮。验证成功后24小时内免重复验证。链接5分钟有效，最多暂存前10条消息，超出或过期后请重发。请勿转发验证链接。",
            reply_markup: { inline_keyboard: [
                [{ text: "打开 Turnstile 验证", url: `${origin}/verify?id=${id}` }]
            ] }
        });
        if (!result.ok) {
            await invalidateUserChallenge(env, userId);
            throw new Error("无法发送验证码链接");
        }
        Logger.info('verification_sent', { userId });
    });
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

async function createConfirmationProof(env, id, state) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(env.WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const payload = `turnstile-confirm:${id}:${state.userId}:${state.expiresAt}`;
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
    // 96-bit HMAC 加上挑战 ID 恰好占用 Telegram callback_data 的 64 字节上限。
    return btoa(String.fromCharCode(...signature.slice(0, 12))).replace(/\+/g, "-").replace(/\//g, "_");
}

async function sendPassedChallengeConfirmation(env, id, state) {
    if (!env.WEBHOOK_SECRET) return verificationPage("确认服务尚未配置，请联系管理员。", 503);
    const proof = await createConfirmationProof(env, id, state);
    const result = await tgCall(env, "sendMessage", {
        chat_id: state.userId, text: "✅ 网页验证已通过，请点击这条消息的「确认验证」。",
        reply_markup: { inline_keyboard: [[{ text: "确认验证", callback_data: `verify:${id}:confirm:${proof}` }]] }
    });
    if (!result.ok) return verificationPage("网页验证已通过，但发送确认按钮失败，请再次提交。", 503);
    return verificationPage("网页验证已通过，Telegram 已发送新的确认消息。请点击最新消息的「确认验证」。");
}

function verificationPage(message, status = 200, form = "") {
    const nonce = secureRandomId(32);
    const autoSubmit = form ? `<script nonce="${nonce}">
function onTurnstileSolved(token) {
    const form = document.getElementById('verify-form');
    if (!token || form.dataset.submitting) return;
    form.dataset.submitting = '1';
    document.getElementById('turnstile-token').value = token;
    document.getElementById('verify-status').textContent = '正在提交验证，请稍候…';
    form.requestSubmit();
}
function onTurnstileError() {
    document.getElementById('verify-status').textContent = '验证码加载失败，请检查网络或刷新网页重试。';
}
function onTurnstileExpired() {
    document.getElementById('verify-status').textContent = '验证码已过期，请重新完成验证。';
}
</script>` : "";
    return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Telegram 人机验证</title>
${autoSubmit}<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<style>body{font-family:system-ui,sans-serif;max-width:440px;margin:48px auto;padding:20px;line-height:1.7}button{padding:12px 24px;margin-top:16px;cursor:pointer}h1{font-size:24px}</style></head>
<body><h1>Telegram 人机验证</h1><p id="verify-status" role="status" aria-live="polite">${escapeHtml(message)}</p>${form}</body></html>`, {
        status, headers: {
            "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
            // no-referrer 会使原生表单 POST 发送 Origin:null，误拒绝同源提交。
            "Referrer-Policy": "same-origin", "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
        }
    });
}

async function handleTurnstileRequest(request, env) {
    const origin = turnstileOrigin(env);
    if (!origin) return verificationPage("验证服务尚未配置，请联系管理员。", 503);
    const url = new URL(request.url);
    if (url.origin !== origin) return verificationPage("请使用机器人提供的验证域名。", 400);
    const id = url.searchParams.get("id");
    const state = await getActiveChallenge(env, id);
    if (!state) return verificationPage("验证链接已失效，请回到 Telegram 重新发送消息。", 410);
    if (request.method === "GET") {
        if (state.turnstilePassed) return verificationPage("网页验证已通过，请回到 Telegram 点击「确认验证」。");
        const form = `<form id="verify-form" method="post" action="/verify?id=${escapeHtml(id)}"><input id="turnstile-token" type="hidden" name="cf-turnstile-response"><div class="cf-turnstile" data-sitekey="${escapeHtml(env.TURNSTILE_SITE_KEY)}" data-action="telegram_private_chat" data-cdata="${escapeHtml(id)}" data-response-field="false" data-callback="onTurnstileSolved" data-error-callback="onTurnstileError" data-expired-callback="onTurnstileExpired"></div></form><noscript>请启用 JavaScript 后刷新网页，验证码通过后会自动提交。</noscript>`;
        return verificationPage("请完成人机验证，通过后自动提交。随后回到 Telegram 点击最新消息中的「确认验证」。", 200, form);
    }
    if (request.method !== "POST") return verificationPage("不支持此请求方式。", 405);
    if (request.headers.get("Origin") !== origin) return verificationPage("无效的请求来源。", 403);
    if (!(request.headers.get("Content-Type") || "").startsWith("application/x-www-form-urlencoded")) return verificationPage("无效的表单。", 415);
    // 按流限制请求体，避免未携带 Content-Length 的请求耗尽内存。
    const reader = request.body?.getReader();
    if (!reader) return verificationPage("请先完成验证码。", 400);
    const decoder = new TextDecoder();
    let body = "", size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8192) {
            await reader.cancel();
            return verificationPage("表单过大。", 413);
        }
        body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    const token = new URLSearchParams(body).get("cf-turnstile-response");
    if (!token || token.length > 2048) return verificationPage("请先完成验证码，再提交。", 400);
    return serializeVerification(state.userId, async () => {
        const current = await getActiveChallenge(env, id);
        if (!current) return verificationPage("验证链接已失效，请重新发送消息。", 410);
        if (current.turnstilePassed) return sendPassedChallengeConfirmation(env, id, current);
        let result;
        try {
            const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: request.headers.get("CF-Connecting-IP") || undefined }),
                signal: AbortSignal.timeout(CONFIG.API_TIMEOUT_MS)
            });
            if (!response.ok) return verificationPage("验证服务暂时不可用，请刷新后重试。", 503);
            result = await response.json();
        } catch (error) {
            Logger.error('turnstile_siteverify_failed', error);
            return verificationPage("验证服务暂时不可用，请刷新后重试。", 503);
        }
        if (!result || result.success !== true || result.hostname !== new URL(origin).hostname || result.action !== "telegram_private_chat" || result.cdata !== id) {
            return verificationPage("验证码无效或已过期，请刷新网页后重新验证。", 400);
        }
        // Siteverify 请求期间管理员可能封禁或重置了用户，不能用旧状态恢复验证。
        const latest = await getActiveChallenge(env, id);
        if (!latest) return verificationPage("验证链接已失效，请重新发送消息。", 410);
        latest.turnstilePassed = true;
        await saveChallenge(env, id, latest);
        return sendPassedChallengeConfirmation(env, id, latest);
    });
}

async function handleCallbackQuery(query, env, ctx) {
    if ((query.data || "").startsWith("admin:")) {
        try {
            await handleAdminMenuCallback(query, env, ctx);
        } catch (error) {
            Logger.error('admin_menu_callback_failed', error);
            await tgCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: "⚠️ 操作失败，请重新打开菜单或稍后重试。", show_alert: true });
        }
        return;
    }
    const match = /^verify:([a-z0-9]{32}):confirm(?::([A-Za-z0-9_-]{16}))?$/.exec(query.data || "");
    if (!match || !query.from?.id) return;
    const userId = query.from.id;
    try {
        await serializeVerification(userId, async () => {
            const state = await getActiveChallenge(env, match[1]);
            if (!state || String(state.userId) !== String(userId) || query.message?.chat?.type !== "private" || String(query.message.chat.id) !== String(userId)) {
                await tgCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: "❌ 验证已失效或不属于您，请重发消息", show_alert: true });
                return;
            }
            let passed = state.turnstilePassed;
            if (match[2]) {
                const expected = await createConfirmationProof(env, match[1], state);
                let difference = 0;
                for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ match[2].charCodeAt(i);
                passed = difference === 0;
            }
            if (!passed) {
                await tgCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: "请先打开网页并提交验证码，再点击最新的确认按钮。", show_alert: true });
                return;
            }
            const existing = await env.TOPIC_MAP.get(`verified:${userId}`);
            if (existing !== "trusted") {
                await env.TOPIC_MAP.put(`verified:${userId}`, String(Date.now() + CONFIG.VERIFIED_EXPIRE_SECONDS * 1000), { expirationTtl: CONFIG.VERIFIED_EXPIRE_SECONDS });
            }
            await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
            await invalidateUserChallenge(env, userId);
            await tgCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: "✅ 验证通过" });
            await tgCall(env, "editMessageText", { chat_id: userId, message_id: query.message.message_id, text: "✅ 验证成功，24小时内无需重复验证。" });
            // 释放实例内验证锁后回放，避免话题失效重新发起验证时自锁。
            ctx.waitUntil(forwardPendingMessages(state, userId, env, ctx));
        });
    } catch (error) {
        Logger.error('callback_query_error', error, { userId });
        await tgCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: "⚠️ 验证失败，请重试", show_alert: true });
    }
}

async function forwardPendingMessages(state, userId, env, ctx) {
    try {
        for (const msg of (state.pending_messages || []).slice(0, CONFIG.PENDING_MAX_MESSAGES)) {
            const key = `forwarded:${userId}:${msg.message_id}`;
            if (await env.TOPIC_MAP.get(key)) continue;
            if (await forwardToTopic(msg, userId, `user:${userId}`, env, ctx)) {
                await env.TOPIC_MAP.put(key, "1", { expirationTtl: 3600 });
            }
        }
    } catch (error) {
        Logger.error('pending_message_forward_failed', error, { userId });
        if (!(await env.TOPIC_MAP.get(`banned:${userId}`))) {
            await tgCall(env, "sendMessage", { chat_id: userId, text: "⚠️ 自动发送失败，请重新发送您的消息。" });
        }
    }
}

// ---------------- 辅助函数 ----------------

/**
 * 【修复 #8】批量清理命令处理函数（优化并发性能）
 *
 * 功能说明：
 * 1. 检查所有用户的话题记录
 * 2. 找出话题ID已不存在（被删除）的用户
 * 3. 删除这些用户的KV存储记录和验证状态
 * 4. 让他们下次发消息时重新验证并创建新话题
 *
 * 使用场景：
 * - 管理员手动删除了多个用户话题后
 * - 需要批量重置这些用户的状态
 *
 * @param {number} threadId - 当前话题ID（通常在General话题中调用）
 * @param {object} env - 环境变量对象
 */
async function handleCleanupCommand(threadId, env) {
    const lockKey = "cleanup:lock";
    const locked = await env.TOPIC_MAP.get(lockKey);
    if (locked) {
        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            text: "⏳ **已有清理任务正在运行，请稍后再试。**",
            parse_mode: "Markdown"
        }, threadId));
        return;
    }

    await env.TOPIC_MAP.put(lockKey, "1", { expirationTtl: CONFIG.CLEANUP_LOCK_TTL_SECONDS });

    // 发送处理中的消息
    await tgCall(env, "sendMessage", withMessageThreadId({
        chat_id: env.SUPERGROUP_ID,
        text: "🔄 **正在扫描需要清理的用户...**",
        parse_mode: "Markdown"
    }, threadId));

    let cleanedCount = 0;
    let errorCount = 0;
    const cleanedUsers = [];
    let scannedCount = 0;

    try {
        // 逐页扫描，避免一次性拉取全部 keys 导致超时/内存膨胀
        let cursor = undefined;
        do {
            const result = await env.TOPIC_MAP.list({ prefix: "user:", cursor });
            const names = (result.keys || []).map(k => k.name);
            scannedCount += names.length;

            // 批量并发处理（限制并发数）
            for (let i = 0; i < names.length; i += CONFIG.CLEANUP_BATCH_SIZE) {
                const batch = names.slice(i, i + CONFIG.CLEANUP_BATCH_SIZE);

                const results = await Promise.allSettled(
                    batch.map(async (name) => {
                        const rec = await safeGetJSON(env, name, null);
                    if (!rec || !rec.thread_id) return null;

                    const userId = name.slice(5);
                    const topicThreadId = rec.thread_id;

                    // 检测话题是否存在：尝试向话题发送测试消息
                    const probe = await probeForumThread(env, topicThreadId, {
                        userId,
                        reason: "cleanup_check",
                        doubleCheckOnMissingThreadId: false
                    });

                    // cleanup 要求更保守：仅在明确缺失/重定向时清理，避免误删有效记录
                    if (probe.status === "redirected" || probe.status === "missing") {
                            await env.TOPIC_MAP.delete(name);
                            if (await env.TOPIC_MAP.get(`verified:${userId}`) !== "trusted") {
                                await env.TOPIC_MAP.delete(`verified:${userId}`);
                                await invalidateUserChallenge(env, userId);
                            }
                            await env.TOPIC_MAP.delete(`thread:${topicThreadId}`);

                            return {
                                userId,
                                threadId: topicThreadId,
                                title: rec.title || "未知"
                            };
                    } else if (probe.status === "probe_invalid") {
                        Logger.warn('cleanup_probe_invalid_message', {
                            userId,
                            threadId: topicThreadId,
                            errorDescription: probe.description
                        });
                    } else if (probe.status === "unknown_error") {
                        Logger.warn('cleanup_probe_failed_unknown', {
                            userId,
                            threadId: topicThreadId,
                            errorDescription: probe.description
                        });
                    } else if (probe.status === "missing_thread_id") {
                        Logger.warn('cleanup_probe_missing_thread_id', { userId, threadId: topicThreadId });
                    }

                    return null;
                })
            );

            // 处理结果
            results.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    cleanedCount++;
                    cleanedUsers.push(result.value);
                    Logger.info('cleanup_user', {
                        userId: result.value.userId,
                        threadId: result.value.threadId
                    });
                } else if (result.status === 'rejected') {
                    errorCount++;
                    Logger.error('cleanup_batch_error', result.reason);
                }
            });

                // 防止速率限制
                if (i + CONFIG.CLEANUP_BATCH_SIZE < names.length) {
                    await new Promise(r => setTimeout(r, 600));
                }
            }

            cursor = result.list_complete ? undefined : result.cursor;

            // 在分页之间让出时间片，降低单次执行压力
            if (cursor) {
                await new Promise(r => setTimeout(r, 200));
            }
        } while (cursor);

        // 生成并发送清理报告
        let reportText = `✅ **清理完成**\n\n`;
        reportText += `📊 **统计信息**\n`;
        reportText += `- 扫描用户数: ${scannedCount}\n`;
        reportText += `- 已清理用户数: ${cleanedCount}\n`;
        reportText += `- 错误数: ${errorCount}\n\n`;

        if (cleanedCount > 0) {
            reportText += `🗑️ **已清理的用户** (话题已删除):\n`;
            for (const user of cleanedUsers.slice(0, CONFIG.MAX_CLEANUP_DISPLAY)) {
                reportText += `- UID: \`${user.userId}\` | 话题: ${user.title}\n`;
            }
            if (cleanedUsers.length > CONFIG.MAX_CLEANUP_DISPLAY) {
                reportText += `\n...(还有 ${cleanedUsers.length - CONFIG.MAX_CLEANUP_DISPLAY} 个用户)\n`;
            }
            reportText += `\n💡 这些用户下次发消息时将重新进行人机验证并创建新话题。`;
        } else {
            reportText += `✨ 没有发现需要清理的用户记录。`;
        }

        Logger.info('cleanup_completed', {
            cleanedCount,
            errorCount,
            totalUsers: scannedCount
        });

        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            text: reportText,
            parse_mode: "Markdown"
        }, threadId));

    } catch (e) {
        Logger.error('cleanup_failed', e, { threadId });
        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            text: `❌ **清理过程出错**\n\n错误信息: \`${e.message}\``,
            parse_mode: "Markdown"
        }, threadId));
    } finally {
        await env.TOPIC_MAP.delete(lockKey);
    }
}

// ---------------- 其他辅助函数 ----------------

// 为话题建立 thread->user 映射，避免管理员命令时全量 KV 反查
async function createTopic(from, key, env, userId) {
    const title = buildTopicTitle(from);
    if (!env.SUPERGROUP_ID.toString().startsWith("-100")) throw new Error("SUPERGROUP_ID必须以-100开头");
    const res = await tgCall(env, "createForumTopic", { chat_id: env.SUPERGROUP_ID, name: title });
    if (!res.ok) throw new Error(`创建话题失败: ${res.description}`);
    const rec = { thread_id: res.result.message_thread_id, title, closed: false };
    await env.TOPIC_MAP.put(key, JSON.stringify(rec));
    if (userId) {
        await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(userId));
    }
    return rec;
}

// 【修复 #2】更新话题状态 - 修复异步操作未等待
async function updateThreadStatus(threadId, isClosed, env) {
    try {
        const mappedUser = await env.TOPIC_MAP.get(`thread:${threadId}`);
        if (mappedUser) {
            const userKey = `user:${mappedUser}`;
            const rec = await safeGetJSON(env, userKey, null);
            if (rec && Number(rec.thread_id) === Number(threadId)) {
                rec.closed = isClosed;
                await env.TOPIC_MAP.put(userKey, JSON.stringify(rec));
                Logger.info('thread_status_updated', { threadId, isClosed, updatedCount: 1 });
                return;
            }

            // 映射失效：清理后降级全量扫描
            await env.TOPIC_MAP.delete(`thread:${threadId}`);
        }

        const allKeys = await getAllKeys(env, "user:");
        const updates = [];

        for (const { name } of allKeys) {
            const rec = await safeGetJSON(env, name, null);
            if (rec && Number(rec.thread_id) === Number(threadId)) {
                rec.closed = isClosed;
                updates.push(env.TOPIC_MAP.put(name, JSON.stringify(rec)));
            }
        }

        await Promise.all(updates);
        Logger.info('thread_status_updated', { threadId, isClosed, updatedCount: updates.length });
    } catch (e) {
        Logger.error('thread_status_update_failed', e, { threadId, isClosed });
        throw e;
    }
}

// 改进的话题标题构建（清理特殊字符）
function buildTopicTitle(from) {
  const firstName = (from.first_name || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);
  const lastName = (from.last_name || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);

  // 清理 username
  let username = "";
  if (from.username) {
      username = from.username
          .replace(/[^\w]/g, '')  // 只保留字母数字下划线
          .substring(0, 20);
  }

  // 移除控制字符和换行符
  const cleanName = (firstName + " " + lastName)
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const name = cleanName || "User";
  const usernameStr = username ? ` @${username}` : "";

  // Telegram 话题标题最大长度为 128 字符
  const title = (name + usernameStr).substring(0, CONFIG.MAX_TITLE_LENGTH);

  return title;
}

// 改进的 Telegram API 调用（添加超时和 HTTPS 强制）
async function tgCall(env, method, body, timeout = CONFIG.API_TIMEOUT_MS) {
  let base = env.API_BASE || "https://api.telegram.org";

  // 【修复 #20】强制 HTTPS
  if (base.startsWith("http://")) {
      Logger.warn('api_http_upgraded', { originalBase: base });
      base = base.replace("http://", "https://");
  }

  // 验证 URL 格式
  try {
      new URL(`${base}/test`);
  } catch (e) {
      Logger.error('api_base_invalid', e, { base });
      base = "https://api.telegram.org";
  }

  // 【修复 #13】添加超时控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
      const resp = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!resp.ok && resp.status >= 500) {
          Logger.warn('telegram_api_server_error', {
              method,
              status: resp.status
          });
      }

      const result = await resp.json();

      // 记录速率限制
      if (!result.ok && result.description && result.description.includes('Too Many Requests')) {
          const retryAfter = result.parameters?.retry_after || 5;
          Logger.warn('telegram_api_rate_limit', {
              method,
              retryAfter
          });
      }

      return result;
  } catch (e) {
      clearTimeout(timeoutId);

      if (e.name === 'AbortError') {
          Logger.error('telegram_api_timeout', e, { method, timeout });
          return { ok: false, description: 'Request timeout' };
      }

      Logger.error('telegram_api_failed', e, { method });
      throw e;
  }
}

async function handleMediaGroup(msg, env, ctx, { direction, targetChat, threadId }) {
    const groupId = msg.media_group_id;
    const key = `mg:${direction}:${groupId}`;
    const item = extractMedia(msg);
    if (!item) {
        await tgCall(env, "copyMessage", withMessageThreadId({
            chat_id: targetChat,
            from_chat_id: msg.chat.id,
            message_id: msg.message_id
        }, threadId));
        return;
    }
    let rec = await safeGetJSON(env, key, null);
    if (!rec) rec = { direction, targetChat, sourceUserId: msg.chat.id, threadId: (threadId === null ? undefined : threadId), items: [], last_ts: Date.now() };
    rec.items.push({ ...item, msg_id: msg.message_id });
    rec.last_ts = Date.now();
    rec.send_id = secureRandomId();
    await env.TOPIC_MAP.put(key, JSON.stringify(rec), { expirationTtl: CONFIG.MEDIA_GROUP_EXPIRE_SECONDS });
    ctx.waitUntil(delaySend(env, key, rec.send_id));
}

// 【修复 #15, #19】改进的媒体提取（支持更多类型，不修改原数组）
function extractMedia(msg) {
    // 图片
    if (msg.photo && msg.photo.length > 0) {
        const highestResolution = msg.photo[msg.photo.length - 1];  // 不使用 pop()
        return {
            type: "photo",
            id: highestResolution.file_id,
            cap: msg.caption || ""
        };
    }

    // 视频
    if (msg.video) {
        return {
            type: "video",
            id: msg.video.file_id,
            cap: msg.caption || ""
        };
    }

    // 文档
    if (msg.document) {
        return {
            type: "document",
            id: msg.document.file_id,
            cap: msg.caption || ""
        };
    }

    // 音频
    if (msg.audio) {
        return {
            type: "audio",
            id: msg.audio.file_id,
            cap: msg.caption || ""
        };
    }

    // 动图
    if (msg.animation) {
        return {
            type: "animation",
            id: msg.animation.file_id,
            cap: msg.caption || ""
        };
    }

    // 语音和视频消息不支持 media group
    return null;
}

// 【修复 #21】实现媒体组清理
async function flushExpiredMediaGroups(env, now) {
    try {
        const prefix = "mg:";
        const allKeys = await getAllKeys(env, prefix);
        let deletedCount = 0;

        for (const { name } of allKeys) {
            const rec = await safeGetJSON(env, name, null);
            if (rec && rec.last_ts && (now - rec.last_ts > 300000)) { // 超过 5 分钟
                await env.TOPIC_MAP.delete(name);
                deletedCount++;
            }
        }

        if (deletedCount > 0) {
            Logger.info('media_groups_cleaned', { deletedCount });
        }
    } catch (e) {
        Logger.error('media_group_cleanup_failed', e);
    }
}

// 【修复 #12, #28】改进媒体组延迟发送
async function delaySend(env, key, sendId) {
    await new Promise(r => setTimeout(r, CONFIG.MEDIA_GROUP_DELAY_MS));

    const rec = await safeGetJSON(env, key, null);

    if (rec && rec.send_id === sendId) {
        if (!Array.isArray(rec.items) || rec.items.length === 0) {
            await env.TOPIC_MAP.delete(key);
            return;
        }
        if (rec.direction === "p2t") {
            const userId = rec.sourceUserId;
            const status = userId ? await env.TOPIC_MAP.get(`verified:${userId}`) : null;
            if (!userId || await env.TOPIC_MAP.get(`banned:${userId}`) || !hasValidVerification(status) ||
                (status !== "trusted" && (await env.TOPIC_MAP.get(`needs_verify:${userId}`) || await matchesFilter({ caption: rec.items.map(item => item.cap || "").join("\n") }, env)))) {
                await env.TOPIC_MAP.delete(key);
                return;
            }
        }
        // 验证媒体数组
        if (!rec.items || rec.items.length === 0) {
            Logger.warn('media_group_empty', { key });
            await env.TOPIC_MAP.delete(key);
            return;
        }

        const media = rec.items.map((it, i) => {
            if (!it.type || !it.id) {
                Logger.warn('media_group_invalid_item', { key, item: it });
                return null;
            }
            // 【修复 #28】限制 caption 长度
            const caption = i === 0 ? (it.cap || "").substring(0, 1024) : "";
            return { 
                type: it.type,
                media: it.id,
                caption
            };
        }).filter(Boolean);  // 过滤掉无效项

        if (media.length > 0) {
            try {
                const single = media.length === 1 ? media[0] : null;
                const method = single ? `send${single.type[0].toUpperCase()}${single.type.slice(1)}` : "sendMediaGroup";
                const body = single
                    ? { chat_id: rec.targetChat, [single.type]: single.media, caption: single.caption }
                    : { chat_id: rec.targetChat, media };
                const result = await tgCall(env, method, withMessageThreadId(body, rec.threadId));

                if (!result.ok) {
                    Logger.error('media_group_send_failed', result.description, {
                        key,
                        mediaCount: media.length
                    });
                } else {
                    Logger.info('media_group_sent', {
                        key,
                        mediaCount: media.length,
                        targetChat: rec.targetChat
                    });
                }
            } catch (e) {
                Logger.error('media_group_send_exception', e, { key });
            }
        }

        await env.TOPIC_MAP.delete(key);
    }
}
