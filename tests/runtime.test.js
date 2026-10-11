import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

const origin = 'https://bot.example';
const groupId = '-100123456';
const secret = 'runtime-test-secret';
const workerPath = fileURLToPath(new URL('../worker.js', import.meta.url));

if (process.platform === 'win32') {
    // Miniflare 的 email-store 使用 os.tmpdir()，不受 resourceTmpPath 控制。
    const temp = fileURLToPath(new URL('../.wrangler/runtime-temp/', import.meta.url));
    await mkdir(temp, { recursive: true });
    process.env.TEMP = process.env.TMP = process.env.TMPDIR = temp;
}

async function harness(t, bindings = {}) {
    const calls = [];
    const waiters = new Set();
    const h = { calls, siteResult: undefined, telegramResult: undefined };
    const tempRoot = fileURLToPath(new URL('../.wrangler/runtime-tests/', import.meta.url));
    await mkdir(tempRoot, { recursive: true });
    const tempPath = await mkdtemp(join(tempRoot, 'test-'));
    const resourcePersistencePath = join(tempPath, 'resources');
    const resourceTmpPath = join(tempPath, 'tmp');
    await mkdir(resourcePersistencePath);
    await mkdir(resourceTmpPath);
    const options = convertV4MiniflareOptions({
        modules: true,
        scriptPath: workerPath,
        compatibilityDate: '2024-11-30',
        host: '127.0.0.1',
        port: 0,
        cf: false,
        log: new Log(LogLevel.ERROR),
        kvNamespaces: ['TOPIC_MAP'],
        bindings: {
            BOT_TOKEN: 'runtime-test-bot',
            SUPERGROUP_ID: groupId,
            WEBHOOK_SECRET: secret,
            PUBLIC_URL: origin,
            TURNSTILE_SITE_KEY: 'runtime-public-site-key',
            TURNSTILE_SECRET_KEY: 'runtime-private-secret-key',
            FILTER_KEYWORDS: '广告,SCAM\n赌博',
            ADMIN_IDS: '999',
            ...bindings
        },
        // All external fetches terminate here; these tests cannot send real messages.
        outboundService: async request => {
            const url = new URL(request.url);
            assert.equal(request.method, 'POST');
            assert.match(request.headers.get('content-type'), /application\/json/);
            const body = await request.json();
            let response;
            if (url.href === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
                const id = await h.kv.get('user_challenge:123');
                response = h.siteResult === undefined
                    ? { success: true, hostname: 'bot.example', action: 'telegram_private_chat', cdata: id }
                    : h.siteResult;
            } else {
                assert.equal(url.origin, 'https://api.telegram.org', 'unexpected external network request');
                assert.match(url.pathname, /^\/botruntime-test-bot\/[A-Za-z]+$/);
                const method = url.pathname.split('/').pop();
                if (method === 'sendMediaGroup') assert.ok(body.media.length >= 2 && body.media.length <= 10);
                response = h.telegramResult?.(method, body) ?? {
                    ok: true,
                    result: method === 'copyMessage'
                        ? { message_id: 999 }
                        : { message_id: 999, message_thread_id: body.message_thread_id ?? 700, status: 'administrator' }
                };
            }
            const call = { method: url.pathname.split('/').pop(), body };
            calls.push(call);
            for (const waiter of waiters) {
                if (waiter.predicate(call)) { waiters.delete(waiter); waiter.resolve(call); }
            }
            return Response.json(response);
        }
    });
    // Workspace-local paths also keep native runtime storage inspectable on Windows.
    const mf = new Miniflare({ ...options, resourcePersistencePath, resourceTmpPath });
    t.after(async () => { await mf.dispose(); });
    h.mf = mf;
    h.kv = await mf.getKVNamespace('TOPIC_MAP');
    h.waitForCall = async predicate => {
        const existing = calls.find(predicate);
        if (existing) return existing;
        let waiter;
        let timeout;
        try {
            return await new Promise((resolve, reject) => {
                waiter = { predicate, resolve };
                waiters.add(waiter);
                timeout = setTimeout(() => reject(new Error('expected background delivery was not observed')), 5000);
            });
        } finally {
            clearTimeout(timeout);
            waiters.delete(waiter);
        }
    };
    h.request = async (update, token = secret) => {
        const headers = { 'Content-Type': 'application/json' };
        if (token !== null) headers['X-Telegram-Bot-Api-Secret-Token'] = token;
        const response = await mf.dispatchFetch(`${origin}/`, { method: 'POST', headers, body: JSON.stringify(update) });
        await response.text();
        return response;
    };
    h.message = fields => h.request({ message: {
        message_id: 42, chat: { id: 123, type: 'private' }, from: { id: 123, first_name: 'Visitor' }, text: 'clean text', ...fields
    } });
    h.admin = text => h.request({ message: {
        message_id: 100, chat: { id: Number(groupId), type: 'supergroup' }, from: { id: 999 }, text
    } });
    h.confirm = (id, userId = 123, data = `verify:${id}:confirm`) => h.request({ callback_query: {
        id: `callback-${userId}`, data, from: { id: userId, first_name: 'Visitor' },
        message: { message_id: 999, chat: { id: userId, type: 'private' } }
    } });
    h.form = (id, { source = origin, token = 'runtime-token', body, contentType = 'application/x-www-form-urlencoded' } = {}) =>
        mf.dispatchFetch(`${origin}/verify?id=${id}`, {
            method: 'POST', headers: { Origin: source, 'Content-Type': contentType, 'CF-Connecting-IP': '192.0.2.1' },
            body: body ?? new URLSearchParams({ 'cf-turnstile-response': token }).toString()
        });
    h.deliveries = () => calls.filter(call =>
        ['forwardMessage', 'copyMessage', 'sendMediaGroup', 'sendPhoto', 'sendVideo', 'sendDocument', 'sendAudio'].includes(call.method) ||
        (call.method === 'sendMessage' && String(call.body.chat_id) === groupId && call.body.text !== '🔎')
    );
    h.seedTopic = async (userId, threadId, status) => {
        await h.kv.put(`user:${userId}`, JSON.stringify({ thread_id: threadId, title: 'existing topic', closed: false }));
        await h.kv.put(`thread:${threadId}`, String(userId));
        await h.kv.put(`thread_ok:${threadId}`, '1');
        await h.kv.put(`verified:${userId}`, status);
    };
    return h;
}

test('workerd starts the production compatibility-date module and rejects unsigned webhooks', async t => {
    const h = await harness(t);
    const health = await h.mf.dispatchFetch(`${origin}/`);
    assert.equal(health.status, 200);
    assert.equal((await h.request({}, null)).status, 401);
    assert.equal((await h.request({}, 'wrong')).status, 401);
    assert.equal((await h.request({})).status, 200);
    assert.equal((await h.mf.dispatchFetch(`${origin}/unknown`)).status, 404);
    assert.equal(h.calls.length, 0);
});

test('concurrent real requests share one challenge without cross-request I/O crashes', async t => {
    const h = await harness(t);
    const responses = await Promise.all([
        h.message({ message_id: 42, text: 'first concurrent message' }),
        h.message({ message_id: 43, text: 'second concurrent message' })
    ]);
    assert.ok(responses.every(response => response.status === 200));
    const id = await h.kv.get('user_challenge:123');
    assert.match(id, /^[a-z0-9]{32}$/);
    const state = await h.kv.get(`chal:${id}`, { type: 'json' });
    assert.deepEqual(state.pending_messages.map(msg => msg.message_id).sort(), [42, 43]);
    assert.equal(h.calls.filter(call => call.body.reply_markup).length, 1);
    assert.equal(h.calls.filter(call => call.body.text?.includes('系统繁忙')).length, 0);
});

test('real KV preserves upstream trusted users, legacy bans and existing topic routes', async t => {
    const h = await harness(t);
    await h.seedTopic(123, 710, 'trusted');
    await h.message({ text: 'SCAM 广告' });
    assert.equal(h.deliveries().length, 1);
    assert.equal(h.deliveries()[0].method, 'forwardMessage');
    assert.equal(h.deliveries()[0].body.message_thread_id, 710);
    assert.equal(await h.kv.get('verified:123'), 'trusted');
    await h.kv.put('banned:123', '1');
    const before = h.calls.length;
    await h.message({ message_id: 43 });
    assert.equal(h.calls.length, before);
    assert.equal(await h.kv.get('banned:123'), '1');
    assert.equal((await h.kv.get('user:123', { type: 'json' })).thread_id, 710);
});

test('real runtime gates first messages, validates Siteverify, binds Telegram identity and replays frozen snapshots', async t => {
    const h = await harness(t);
    const before = Date.now();
    const entities = [{ type: 'bold', offset: 0, length: 5 }];
    await h.message({ text: 'clean original', entities });
    await h.message({ message_id: 43, text: undefined, photo: [{ file_id: 'test-photo' }] });
    const id = await h.kv.get('user_challenge:123');
    assert.match(id, /^[a-z0-9]{32}$/);
    assert.equal(h.deliveries().length, 0);
    const state = await h.kv.get(`chal:${id}`, { type: 'json' });
    assert.equal(state.pending_messages.length, 2);
    assert.equal(state.pending_messages[0].text, 'clean original');
    await h.confirm(id);
    assert.equal(await h.kv.get('verified:123'), null);
    const page = await h.mf.dispatchFetch(`${origin}/verify?id=${id}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('referrer-policy'), 'same-origin');
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await page.text(), /data-action="telegram_private_chat"/);
    assert.equal((await h.form(id, { source: 'https://attacker.example' })).status, 403);
    assert.equal((await h.form(id, { source: 'null' })).status, 403);
    assert.equal((await h.form(id, { source: '' })).status, 403);
    assert.equal((await h.form(id)).status, 200);
    const siteCall = h.calls.find(call => call.method === 'siteverify');
    assert.equal(siteCall.body.secret, 'runtime-private-secret-key');
    assert.equal(siteCall.body.response, 'runtime-token');
    assert.equal(await h.kv.get('verified:123'), null, 'web verification alone cannot grant Telegram access');
    await h.confirm(id, 456);
    assert.equal(await h.kv.get('verified:123'), null);
    await h.confirm(id);
    await h.waitForCall(call => call.method === 'copyMessage' && call.body.message_id === 43);
    const deliveries = h.deliveries();
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[0].method, 'sendMessage');
    assert.equal(deliveries[0].body.text, 'clean original');
    assert.deepEqual(deliveries[0].body.entities, entities);
    assert.equal(deliveries[1].body.caption, '', 'captionless queued media must override a subsequently edited caption');
    assert.equal(h.calls.some(call => call.method === 'forwardMessage'), false);
    const expiresAt = Number(await h.kv.get('verified:123'));
    assert.ok(expiresAt >= before + 86400000 && expiresAt <= Date.now() + 86400000);
    const entry = (await h.kv.list({ prefix: 'verified:123' })).keys[0];
    assert.ok(entry.expiration >= Math.floor(before / 1000) + 86400);
    assert.equal(await h.kv.get(`chal:${id}`), null);
    assert.equal((await h.mf.dispatchFetch(`${origin}/verify?id=${id}`)).status, 410);
    await h.confirm(id);
    assert.equal(h.deliveries().length, 2);
});

test('workerd validates signed confirmation even when KV supplies the old unpassed snapshot', async t => {
    const h = await harness(t);
    await h.message();
    const id = await h.kv.get('user_challenge:123');
    const stale = await h.kv.get(`chal:${id}`);
    const page = await h.form(id);
    assert.equal(page.status, 200);
    await page.text();
    const data = h.calls.flatMap(call => call.body.reply_markup?.inline_keyboard?.flat() || [])
        .filter(button => button.callback_data).at(-1).callback_data;
    assert.equal(data.length, 64);
    // 模拟 Telegram 地区读取到了网页验证前的状态，而非网页地区刚写入的状态。
    await h.kv.put(`chal:${id}`, stale);
    await h.confirm(id, 123, data);
    await h.waitForCall(call => call.method === 'sendMessage' && String(call.body.chat_id) === groupId && call.body.text === 'clean text');
    assert.ok(Number(await h.kv.get('verified:123')) > Date.now());
});

test('real request streams enforce bounded forms and reject invalid Siteverify binding', async t => {
    const h = await harness(t);
    await h.message();
    const id = await h.kv.get('user_challenge:123');
    assert.equal((await h.form(id, { contentType: 'application/json' })).status, 415);
    assert.equal((await h.form(id, { token: '' })).status, 400);
    assert.equal((await h.form(id, { token: 'x'.repeat(2049) })).status, 400);
    assert.equal((await h.form(id, { body: 'x'.repeat(8193) })).status, 413);
    assert.equal(h.calls.some(call => call.method === 'siteverify'), false);
    for (const invalid of [{ success: false }, { hostname: 'elsewhere.example' }, { action: 'other' }, { cdata: 'wrong-challenge' }]) {
        h.siteResult = { success: true, hostname: 'bot.example', action: 'telegram_private_chat', cdata: id, ...invalid };
        assert.equal((await h.form(id)).status, 400);
        assert.equal((await h.kv.get(`chal:${id}`, { type: 'json' })).turnstilePassed, false);
    }
    await h.confirm(id);
    assert.equal(await h.kv.get('verified:123'), null);
});

test('keyword filtering in workerd rejects untrusted text and captions before queueing', async t => {
    const h = await harness(t);
    await h.message({ text: '广告合作' });
    await h.message({ message_id: 43, text: 'ＳＣＡＭ' });
    await h.message({ message_id: 44, text: undefined, caption: '赌博推广', photo: [{ file_id: 'test-photo' }] });
    assert.equal(await h.kv.get('user_challenge:123'), null);
    assert.equal(h.calls.length, 0);
    await h.seedTopic(123, 730, String(Date.now() + 86400000));
    await h.message({ message_id: 45, text: 's\u200bcam' });
    assert.equal(h.deliveries().length, 0);
    await h.message({ message_id: 46, text: 'ordinary question' });
    assert.equal(h.deliveries().length, 1);
});

test('daily expiration and upstream quiz verification require a fresh real-runtime challenge', async t => {
    const h = await harness(t);
    await h.seedTopic(123, 720, String(Date.now() + 86400000));
    await h.message();
    assert.equal(h.deliveries().length, 1);
    await h.kv.put('verified:123', String(Date.now() - 1));
    await h.message({ message_id: 43 });
    assert.equal(h.deliveries().length, 1);
    const id = await h.kv.get('user_challenge:123');
    assert.ok(id);
    await h.kv.put('verified:456', '1');
    await h.message({ message_id: 44, chat: { id: 456, type: 'private' }, from: { id: 456, first_name: 'Legacy user' } });
    assert.ok(await h.kv.get('user_challenge:456'));
    assert.equal(h.deliveries().length, 1);
    const state = await h.kv.get(`chal:${id}`, { type: 'json' });
    state.expiresAt = Date.now() - 1;
    await h.kv.put(`chal:${id}`, JSON.stringify(state));
    assert.equal((await h.mf.dispatchFetch(`${origin}/verify?id=${id}`)).status, 410);
});

test('real workerd management menu executes topic-bound callbacks with confirmation prompts', async t => {
    const h = await harness(t);
    await h.seedTopic(123, 700, String(Date.now() + 86400000));
    const message = { message_id: 100, message_thread_id: 700, chat: { id: Number(groupId), type: 'supergroup' }, from: { id: 999 } };
    await h.request({ message: { ...message, text: '/menu' } });
    const menu = h.calls.find(call => call.body.reply_markup)?.body;
    assert.equal(menu.message_thread_id, 700);
    assert.ok(menu.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'admin:ask-block:123'));
    const callback = data => h.request({ callback_query: { id: 'menu-test', from: { id: 999 }, message, data } });
    await callback('admin:ask-block:123');
    assert.equal(await h.kv.get('banned:123'), null);
    await callback('admin:block:123');
    assert.equal(await h.kv.get('banned:123'), '1');
    await callback('admin:unblock:123');
    assert.equal(await h.kv.get('banned:123'), null);
    assert.equal(h.calls.some(call => call.method === 'copyMessage'), false);
});

test('workerd accepts addressed commands only for the current bot and preserves UID arguments', async t => {
    const h = await harness(t);
    h.telegramResult = method => method === 'getMe' ? { ok: true, result: { id: 42, username: 'runtime_test_bot' } } : undefined;
    await h.admin('/trust@runtime_test_bot 123');
    assert.equal(await h.kv.get('verified:123'), 'trusted');
    await h.admin('/block@other_bot 123');
    assert.equal(await h.kv.get('banned:123'), null);
    await h.admin('/block@RUNTIME_TEST_BOT 123 reason @other_bot');
    assert.equal((await h.kv.get('banned:123', { type: 'json' })).reason, 'reason @other_bot');
    await h.admin('/unblock@runtime_test_bot 123');
    assert.equal(await h.kv.get('banned:123'), null);
    assert.equal(h.calls.some(call => call.method === 'copyMessage'), false);
});

test('workerd persists Bot-managed keywords, filters messages and clears only after confirmation', async t => {
    const h = await harness(t);
    h.telegramResult = method => method === 'getMe' ? { ok: true, result: { id: 42, username: 'runtime_test_bot' } } : undefined;
    await h.seedTopic(123, 700, String(Date.now() + 86400000));
    await h.admin('/setkeywords@runtime_test_bot ＳＣＡＭ，customword,scam');
    assert.equal(await h.kv.get('settings:filter_keywords'), 'scam,customword');
    await h.message({ text: 'CUSTOMWORD' });
    await h.message({ message_id: 43, text: undefined, caption: 'scam', photo: [{ file_id: 'photo' }] });
    assert.equal(h.deliveries().filter(call => call.body.message_thread_id === 700).length, 0);
    await h.admin('/keywords@runtime_test_bot');
    assert.match(h.calls.at(-1).body.text, /scam,customword/);
    await h.admin('/clearkeywords@runtime_test_bot');
    assert.equal(await h.kv.get('settings:filter_keywords'), 'scam,customword');
    await h.request({ callback_query: { id: 'clear-policy', data: 'admin:clearkeywords:0', from: { id: 999 },
        message: { message_id: 100, chat: { id: Number(groupId), type: 'supergroup' } } } });
    assert.equal(await h.kv.get('settings:filter_keywords'), '');
    await h.message({ message_id: 44, text: 'scam customword 广告' });
    assert.equal(h.deliveries().filter(call => call.body.message_thread_id === 700).length, 1, 'empty KV list must suppress dashboard defaults too');
});

test('admin trust, untrust, block, unblock and list work against real local KV', async t => {
    const h = await harness(t);
    await h.message();
    const id = await h.kv.get('user_challenge:123');
    await h.admin('/trust 123');
    assert.equal(await h.kv.get('verified:123'), 'trusted');
    assert.equal(await h.kv.get(`chal:${id}`), null);
    await h.message({ text: 'SCAM 广告', message_id: 43 });
    assert.equal(h.deliveries().filter(call => call.method === 'forwardMessage').length, 1);
    await h.admin('/block 123 runtime-test-reason');
    assert.equal(await h.kv.get('verified:123'), null);
    assert.equal((await h.kv.get('banned:123', { type: 'json' })).reason, 'runtime-test-reason');
    const before = h.calls.length;
    await h.message({ message_id: 44 });
    assert.equal(h.calls.length, before);
    await h.admin('/blocklist');
    assert.match(h.calls.at(-1).body.text, /123.*runtime-test-reason/);
    await h.admin('/unblock 123');
    assert.equal(await h.kv.get('banned:123'), null);
    await h.admin('/trust 123');
    await h.admin('/untrust 123');
    assert.equal(await h.kv.get('verified:123'), null);
    const count = h.calls.filter(call => call.method === 'copyMessage').length;
    await h.admin('/unknown-command');
    assert.equal(h.calls.filter(call => call.method === 'copyMessage').length, count);
});
