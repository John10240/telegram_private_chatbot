import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import worker from '../worker.js';

function harness(t) {
    const values = new Map();
    const puts = [];
    const calls = [];
    const jobs = [];
    const env = {
        BOT_TOKEN: 'test-bot', SUPERGROUP_ID: '-100123456', WEBHOOK_SECRET: 'test-secret',
        TURNSTILE_SITE_KEY: 'test-site', TURNSTILE_SECRET_KEY: 'private-secret',
        PUBLIC_URL: 'https://bot.example', FILTER_KEYWORDS: '广告,SCAM\n赌博',
        TOPIC_MAP: {
            async get(key, options) {
                const value = values.get(key) ?? null;
                return options?.type === 'json' && value !== null ? JSON.parse(value) : value;
            },
            async put(key, value, options) {
                values.set(key, value);
                puts.push({ key, value, options });
                if (h.onPut) await h.onPut(key);
            },
            async delete(key) { values.delete(key); },
            async list({ prefix = '' } = {}) {
                return { keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })), list_complete: true };
            }
        }
    };
    const ctx = { waitUntil(promise) { jobs.push(promise); } };
    const h = { env, values, calls, puts, ctx, siteResult: undefined, siteFailure: null };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        const body = JSON.parse(options.body);
        const method = String(url).split('/').pop();
        calls.push({ method, body });
        if (method === 'siteverify') {
            if (h.siteFailure) throw h.siteFailure;
            if (h.siteHook) await h.siteHook();
            const id = await env.TOPIC_MAP.get('user_challenge:123');
            return Response.json(h.siteResult === undefined ? { success: true, hostname: 'bot.example', action: 'telegram_private_chat', cdata: id } : h.siteResult);
        }
        const override = h.telegramResult?.(method, body);
        if (override) return Response.json(override);
        return Response.json({ ok: true, result: { message_id: 999, message_thread_id: body.message_thread_id ?? 700, status: 'administrator' } });
    });
    h.drain = async () => {
        for (let i = 0; i < jobs.length; i++) await jobs[i];
        jobs.length = 0;
    };
    h.request = async (update, secret = 'test-secret') => {
        const headers = { 'Content-Type': 'application/json' };
        if (secret !== null) headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
        const result = await worker.fetch(new Request('https://bot.example/', { method: 'POST', headers, body: JSON.stringify(update) }), env, ctx);
        if (!h.noDrain) await h.drain();
        return result;
    };
    h.message = async (fields = {}) => h.request({ message: {
        message_id: 42, chat: { id: 123, type: 'private' }, from: { id: 123, first_name: 'Visitor' }, text: 'Hello', ...fields
    } });
    h.confirm = async (id, userId = 123, data = `verify:${id}:confirm`) => h.request({ callback_query: {
        id: 'callback', data, from: { id: userId, first_name: 'Visitor' },
        message: { message_id: 999, chat: { id: userId, type: 'private' } }
    } });
    h.web = async (id, { method = 'POST', origin = env.PUBLIC_URL, token = 'valid-token', body, contentType = 'application/x-www-form-urlencoded' } = {}) => {
        const headers = { Origin: origin, 'Content-Type': contentType };
        return worker.fetch(new Request(`${env.PUBLIC_URL}/verify?id=${id}`, {
            method, headers, ...(method === 'POST' ? { body: body ?? new URLSearchParams({ 'cf-turnstile-response': token }) } : {})
        }), env, ctx);
    };
    h.seedVerified = (status = String(Date.now() + 86400000)) => {
        values.set('verified:123', status);
        values.set('user:123', JSON.stringify({ thread_id: 700, closed: false }));
        values.set('thread:700', '123');
        values.set('thread_ok:700', '1');
    };
    h.forwarded = () => calls.filter(call =>
        ['forwardMessage', 'copyMessage', 'sendMediaGroup', 'sendPhoto', 'sendVideo', 'sendDocument', 'sendAudio'].includes(call.method) ||
        (call.method === 'sendMessage' && call.body.chat_id === env.SUPERGROUP_ID && call.body.text !== '🔎')
    );
    return h;
}

test('verification webpage submits automatically once and uses a nonce-authorized callback', async t => {
    const h = harness(t);
    await h.message();
    const page = await h.web(h.values.get('user_challenge:123'), { method: 'GET' });
    const html = await page.text();
    assert.doesNotMatch(html, /<button\b/);
    assert.match(html, /data-callback="onTurnstileSolved"/);
    assert.match(html, /data-response-field="false"/);
    const script = html.match(/<script nonce="([a-z0-9]+)">([\s\S]*?)<\/script>/);
    assert.ok(script);
    assert.ok(page.headers.get('Content-Security-Policy').includes(`'nonce-${script[1]}'`));
    assert.doesNotMatch(page.headers.get('Content-Security-Policy'), /script-src[^;]*'unsafe-inline'/);
    let submitted = 0;
    const form = { dataset: {}, requestSubmit() { submitted++; } };
    const token = { value: '' };
    const status = { textContent: '' };
    const context = { document: { getElementById: id => ({ 'verify-form': form, 'turnstile-token': token, 'verify-status': status })[id] } };
    runInNewContext(script[2], context);
    context.onTurnstileSolved('');
    assert.equal(submitted, 0);
    context.onTurnstileError();
    assert.match(status.textContent, /失败/);
    context.onTurnstileExpired();
    assert.match(status.textContent, /过期/);
    context.onTurnstileSolved('captcha-token');
    context.onTurnstileSolved('second-token');
    assert.equal(token.value, 'captcha-token');
    assert.equal(submitted, 1);
});

test('KV keyword overrides affect text and captions while trusted users stay exempt', async t => {
    const h = harness(t);
    h.seedVerified();
    h.values.set('settings:filter_keywords', 'customword');
    await h.message({ text: 'ＣＵＳＴＯＭＷＯＲＤ' });
    await h.message({ message_id: 43, text: undefined, caption: 'customword', photo: [{ file_id: 'photo' }] });
    assert.equal(h.forwarded().length, 0);
    await h.message({ message_id: 44, text: 'SCAM' });
    assert.equal(h.forwarded().length, 1, 'KV list replaces rather than appends to dashboard defaults');
    h.values.set('settings:filter_keywords', '');
    await h.message({ message_id: 45, text: 'customword SCAM' });
    assert.equal(h.forwarded().length, 2, 'persisted empty override disables filtering');
    h.values.set('settings:filter_keywords', 'customword');
    h.seedVerified('trusted');
    await h.message({ message_id: 46, text: 'customword' });
    assert.equal(h.forwarded().at(-1).method, 'forwardMessage');
});

test('pending messages replay against the new KV keyword policy', async t => {
    const h = harness(t);
    await h.message({ text: 'newly blocked word' });
    const id = h.values.get('user_challenge:123');
    await h.web(id);
    h.values.set('settings:filter_keywords', 'newly blocked');
    await h.confirm(id);
    assert.equal(h.forwarded().length, 0);
});

test('delayed media checks the updated KV policy rather than its original environment snapshot', async t => {
    const h = harness(t);
    h.seedVerified();
    h.noDrain = true;
    const callbacks = [];
    const nativeTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
        if (ms === 3000) { callbacks.push(callback); return 0; }
        return nativeTimeout(callback, ms, ...args);
    });
    await h.message({ text: undefined, caption: 'future blocked', media_group_id: 'policy-update-album', photo: [{ file_id: 'photo' }] });
    assert.equal(h.values.has('mg:p2t:policy-update-album'), true);
    h.values.set('settings:filter_keywords', 'future blocked');
    callbacks.forEach(callback => callback());
    await h.drain();
    assert.equal(h.forwarded().length, 0);
    assert.equal(h.values.has('mg:p2t:policy-update-album'), false, 'updated policy must be checked when queued media is consumed');
});

test('filter policy read errors fail closed instead of falling back to an unfiltered default', async t => {
    const h = harness(t);
    h.seedVerified();
    const get = h.env.TOPIC_MAP.get.bind(h.env.TOPIC_MAP);
    t.mock.method(h.env.TOPIC_MAP, 'get', async (key, options) => {
        if (key === 'settings:filter_keywords') throw new Error('simulated policy read failure');
        return get(key, options);
    });
    t.mock.method(console, 'error', () => {});
    await h.message();
    assert.equal(h.forwarded().length, 0);
    assert.match(h.calls.at(-1).body.text, /系统繁忙/);
});

test('webhook requires the configured Telegram secret', async t => {
    const h = harness(t);
    assert.equal((await h.request({}, null)).status, 401);
    assert.equal((await h.request({}, 'wrong')).status, 401);
    delete h.env.WEBHOOK_SECRET;
    assert.equal((await h.request({})).status, 503);
    assert.deepEqual(h.calls, []);
});

test('first message waits for Siteverify AND matching Telegram confirmation; expires after 24 hours', async t => {
    const h = harness(t);
    const before = Date.now();
    await h.message();
    const id = h.values.get('user_challenge:123');
    assert.match(id, /^[a-z0-9]{32}$/);
    assert.equal(h.forwarded().length, 0);
    const challenge = JSON.parse(h.values.get(`chal:${id}`));
    assert.equal(challenge.pending_messages[0].text, 'Hello');
    await h.confirm(id);
    assert.equal(h.values.has('verified:123'), false);
    const page = await h.web(id, { method: 'GET' });
    assert.equal(page.headers.get('Cache-Control'), 'no-store');
    assert.equal(page.headers.get('Referrer-Policy'), 'same-origin');
    assert.match(await page.text(), /data-action="telegram_private_chat"/);
    assert.equal((await h.web(id)).status, 200);
    assert.equal(h.values.has('verified:123'), false);
    await h.confirm(id, 456);
    assert.equal(h.values.has('verified:123'), false);
    await h.confirm(id);
    assert.equal(h.forwarded().length, 1);
    assert.equal(h.forwarded()[0].method, 'sendMessage');
    assert.equal(h.forwarded()[0].body.text, 'Hello');
    const expiry = Number(h.values.get('verified:123'));
    assert.ok(expiry >= before + 86400000 && expiry <= Date.now() + 86400000);
    assert.equal(h.puts.find(put => put.key === 'verified:123').options.expirationTtl, 86400);
    assert.equal(h.values.has(`chal:${id}`), false);
    await h.confirm(id);
    assert.equal(h.forwarded().length, 1);
    assert.equal((await h.web(id)).status, 410);
    await h.message({ message_id: 43 });
    assert.equal(h.forwarded().length, 2);
    h.values.set('verified:123', String(Date.now() - 1));
    await h.message({ message_id: 44 });
    assert.equal(h.forwarded().length, 2);
    assert.ok(h.values.has('user_challenge:123'));
});

test('signed confirmation succeeds immediately even when Telegram reads a stale unpassed KV snapshot', async t => {
    const h = harness(t);
    await h.message();
    const id = h.values.get('user_challenge:123');
    const key = `chal:${id}`;
    const stale = h.values.get(key);
    assert.equal((await h.web(id)).status, 200);
    const confirmation = h.calls.flatMap(call => call.body.reply_markup?.inline_keyboard?.flat() || [])
        .filter(button => button.callback_data).at(-1).callback_data;
    const get = h.env.TOPIC_MAP.get.bind(h.env.TOPIC_MAP);
    t.mock.method(h.env.TOPIC_MAP, 'get', async (name, options) => name === key
        ? (options?.type === 'json' ? JSON.parse(stale) : stale)
        : get(name, options));
    await h.confirm(id, 123, confirmation);
    assert.equal(h.forwarded().length, 1, 'website completion must not wait for regional KV propagation');
    assert.equal(confirmation.length, 64, 'Telegram callback_data must fit the 64-byte limit');
    assert.match(confirmation, /^verify:[a-z0-9]{32}:confirm:[A-Za-z0-9_-]{16}$/);
});

test('signed confirmation rejects forged, rebound, wrong-account, expired and blocked challenges', async t => {
    for (const scenario of ['forged', 'rebound', 'wrong-account', 'expired', 'blocked']) {
        await t.test(scenario, async t => {
            const h = harness(t);
            await h.message();
            let id = h.values.get('user_challenge:123');
            const initial = h.values.get(`chal:${id}`);
            await h.web(id);
            let data = h.calls.flatMap(call => call.body.reply_markup?.inline_keyboard?.flat() || [])
                .filter(button => button.callback_data).at(-1).callback_data;
            let userId = 123;
            if (scenario === 'forged') {
                // 即使 KV 已标记通过，提供的签名也必须有效。
                data = data.slice(0, -1) + (data.endsWith('A') ? 'B' : 'A');
            } else {
                h.values.set(`chal:${id}`, initial);
                if (scenario === 'rebound') {
                    const proof = data.split(':').at(-1);
                    id = id === 'a'.repeat(32) ? 'b'.repeat(32) : 'a'.repeat(32);
                    h.values.set(`chal:${id}`, initial);
                    h.values.set('user_challenge:123', id);
                    data = `verify:${id}:confirm:${proof}`;
                } else if (scenario === 'wrong-account') userId = 456;
                else if (scenario === 'expired') {
                    const expired = JSON.parse(initial);
                    expired.expiresAt = Date.now() - 1;
                    h.values.set(`chal:${id}`, JSON.stringify(expired));
                } else h.values.set('banned:123', '1');
            }
            await h.confirm(id, userId, data);
            assert.equal(h.values.has('verified:123'), false);
            assert.equal(h.forwarded().length, 0);
        });
    }
});

test('legacy 30-day verification is not accepted; trusted status is preserved', async t => {
    const h = harness(t);
    h.seedVerified('1');
    await h.message();
    assert.equal(h.forwarded().length, 0);
    assert.ok(h.values.has('user_challenge:123'));
    h.values.set('verified:123', 'trusted');
    h.values.set('needs_verify:123', '1');
    await h.message({ text: 'SCAM 广告', message_id: 43 });
    assert.equal(h.forwarded().length, 1);
    assert.equal(h.values.get('verified:123'), 'trusted');
});

test('keyword filtering covers text, normalized Unicode and media captions before and after verification', async t => {
    const h = harness(t);
    await h.message({ text: '广告合作' });
    assert.equal(h.values.has('user_challenge:123'), false);
    assert.equal(h.calls.length, 0);
    h.seedVerified();
    await h.message({ text: 'ＳＣＡＭ' });
    await h.message({ text: 's\u200bcam' });
    await h.message({ text: undefined, caption: '赌博推广', photo: [{ file_id: 'photo' }] });
    assert.equal(h.forwarded().length, 0);
    await h.message({ text: 'ordinary question' });
    assert.equal(h.forwarded().length, 1);
});

test('corrupt verification values never bypass the daily gate', async t => {
    const h = harness(t);
    for (const status of ['Infinity', 'NaN', String(Date.now() + 1000.5)]) {
        h.seedVerified(status);
        await h.message();
        assert.equal(h.forwarded().length, 0);
    }
});

test('null Siteverify response fails closed without an unhandled exception', async t => {
    const h = harness(t);
    await h.message();
    const id = h.values.get('user_challenge:123');
    h.siteResult = null;
    assert.equal((await h.web(id)).status, 400);
    await h.confirm(id);
    assert.equal(h.values.has('verified:123'), false);
});

test('blocked users are silent even if trusted or rate-limited', async t => {
    const h = harness(t);
    h.seedVerified('trusted');
    h.values.set('banned:123', '1');
    h.values.set('ratelimit:message:123', '999');
    await h.message();
    assert.equal(h.calls.length, 0);
});

test('missing Turnstile config fails closed', async t => {
    const h = harness(t);
    delete h.env.TURNSTILE_SECRET_KEY;
    await h.message();
    assert.equal(h.forwarded().length, 0);
    assert.equal(h.values.has('user_challenge:123'), false);
    assert.equal((await h.web('a'.repeat(32), { method: 'GET' })).status, 503);
});

test('Siteverify rejects failure, wrong hostname, action or challenge binding', async t => {
    const h = harness(t);
    await h.message();
    const id = h.values.get('user_challenge:123');
    const good = { success: true, hostname: 'bot.example', action: 'telegram_private_chat', cdata: id };
    for (const invalid of [{ success: false }, { hostname: 'attacker.example' }, { action: 'other' }, { cdata: 'different' }]) {
        h.siteResult = { ...good, ...invalid };
        assert.equal((await h.web(id)).status, 400);
        assert.equal(JSON.parse(h.values.get(`chal:${id}`)).turnstilePassed, false);
    }
    t.mock.method(console, 'error', () => {});
    h.siteFailure = new Error('network unavailable');
    assert.equal((await h.web(id)).status, 503);
    await h.confirm(id);
    assert.equal(h.values.has('verified:123'), false);
});

test('a successful Siteverify response cannot restore a blocked or reset challenge', async t => {
    for (const operation of ['block', 'reset']) {
        await t.test(operation, async t => {
            const h = harness(t);
            await h.message();
            const id = h.values.get('user_challenge:123');
            h.siteResult = { success: true, hostname: 'bot.example', action: 'telegram_private_chat', cdata: id };
            h.siteHook = () => {
                if (operation === 'block') h.values.set('banned:123', '1');
                else h.values.delete('user_challenge:123');
            };
            assert.equal((await h.web(id)).status, 410);
            await h.confirm(id);
            assert.equal(h.values.has('verified:123'), false);
            assert.equal(h.forwarded().length, 0);
        });
    }
});

test('expired, invalid or blocked challenge cannot be solved', async t => {
    const h = harness(t);
    assert.equal((await h.web('invalid')).status, 410);
    await h.message();
    const id = h.values.get('user_challenge:123');
    const state = JSON.parse(h.values.get(`chal:${id}`));
    state.expiresAt = Date.now() - 1;
    h.values.set(`chal:${id}`, JSON.stringify(state));
    assert.equal((await h.web(id)).status, 410);
    await h.confirm(id);
    assert.equal(h.forwarded().length, 0);
    state.expiresAt = Date.now() + 300000;
    h.values.set(`chal:${id}`, JSON.stringify(state));
    h.values.set('banned:123', '1');
    assert.equal((await h.web(id)).status, 410);
});

test('form requires same origin, bounded token and bounded body', async t => {
    const h = harness(t);
    await h.message();
    const id = h.values.get('user_challenge:123');
    assert.equal((await h.web(id, { origin: 'https://attacker.example' })).status, 403);
    assert.equal((await h.web(id, { origin: 'null' })).status, 403);
    assert.equal((await h.web(id, { origin: '' })).status, 403);
    assert.equal((await h.web(id, { contentType: 'application/json' })).status, 415);
    assert.equal((await h.web(id, { token: '' })).status, 400);
    assert.equal((await h.web(id, { token: 'x'.repeat(2049) })).status, 400);
    assert.equal((await h.web(id, { body: 'x'.repeat(8193) })).status, 413);
    assert.equal(h.calls.filter(call => call.method === 'siteverify').length, 0);
});

test('pending queue preserves first 10 unique messages without extending link lifetime', async t => {
    const h = harness(t);
    await h.message();
    const id = h.values.get('user_challenge:123');
    const expiry = JSON.parse(h.values.get(`chal:${id}`)).expiresAt;
    await h.message();
    for (let message_id = 43; message_id < 55; message_id++) await h.message({ message_id });
    const state = JSON.parse(h.values.get(`chal:${id}`));
    assert.equal(state.expiresAt, expiry);
    assert.deepEqual(state.pending_messages.map(msg => msg.message_id), [42,43,44,45,46,47,48,49,50,51]);
    assert.equal(h.calls.filter(call => call.body.reply_markup).length, 1);
});

test('pending messages are re-filtered when keyword policy changes', async t => {
    const h = harness(t);
    await h.message({ text: 'now forbidden' });
    const id = h.values.get('user_challenge:123');
    await h.web(id);
    h.env.FILTER_KEYWORDS = 'forbidden';
    await h.confirm(id);
    assert.equal(h.forwarded().length, 0);
    assert.equal(h.values.has('forwarded:123:42'), false);
});

test('delayed media groups recheck blocks, expiry and queued captions', async t => {
    for (const policy of ['block', 'expire', 'filter', 'normal']) {
        await t.test(policy, async t => {
            const h = harness(t);
            h.seedVerified();
            const nativeTimeout = globalThis.setTimeout;
            t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
                if (ms === 3000) { queueMicrotask(callback); return 0; }
                return nativeTimeout(callback, ms, ...args);
            });
            h.onPut = key => {
                if (!key.startsWith('mg:')) return;
                if (policy === 'block') h.values.set('banned:123', '1');
                if (policy === 'expire') h.values.set('verified:123', String(Date.now() - 1));
                if (policy === 'filter') {
                    const queued = JSON.parse(h.values.get(key));
                    queued.items[0].cap = 'SCAM';
                    h.values.set(key, JSON.stringify(queued));
                }
            };
            await h.message({ text: undefined, caption: 'ordinary photo', media_group_id: policy, photo: [{ file_id: 'photo' }] });
            assert.equal(h.calls.filter(call => call.method === 'sendMediaGroup').length, 0);
            assert.equal(h.calls.filter(call => call.method === 'sendPhoto').length, policy === 'normal' ? 1 : 0);
            assert.equal(h.values.has(`mg:p2t:${policy}`), false);
        });
    }
});

test('same-millisecond album messages send once and a filtered album sends its remaining item', async t => {
    for (const filtered of [false, true]) {
        await t.test(filtered ? 'one member filtered' : 'two allowed members', async t => {
            const h = harness(t);
            h.seedVerified();
            h.noDrain = true;
            const callbacks = [];
            const nativeTimeout = globalThis.setTimeout;
            const now = Date.now();
            t.mock.method(Date, 'now', () => now);
            t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
                if (ms === 3000) { callbacks.push(callback); return 0; }
                return nativeTimeout(callback, ms, ...args);
            });
            await h.message({ text: undefined, caption: 'clean', media_group_id: 'album', photo: [{ file_id: 'first' }] });
            await h.message({ text: undefined, message_id: 43, caption: filtered ? 'SCAM' : 'clean', media_group_id: 'album', photo: [{ file_id: 'second' }] });
            callbacks.forEach(callback => callback());
            await h.drain();
            const outgoing = h.forwarded();
            assert.equal(outgoing.length, 1);
            assert.equal(outgoing[0].method, filtered ? 'sendPhoto' : 'sendMediaGroup');
            if (!filtered) assert.equal(outgoing[0].body.media.length, 2);
        });
    }
});

test('pending text and even empty captions are sent from filtered snapshots', async t => {
    const h = harness(t);
    const entities = [{ type: 'bold', offset: 0, length: 5 }];
    await h.message({ text: 'clean original', entities });
    await h.message({ message_id: 43, text: undefined, photo: [{ file_id: 'photo' }] });
    const id = h.values.get('user_challenge:123');
    await h.web(id);
    await h.confirm(id);
    const outgoing = h.forwarded();
    assert.equal(outgoing.length, 2);
    assert.equal(outgoing[0].method, 'sendMessage');
    assert.equal(outgoing[0].body.text, 'clean original');
    assert.deepEqual(outgoing[0].body.entities, entities);
    assert.equal(outgoing[1].method, 'copyMessage');
    assert.equal(outgoing[1].body.caption, '');
    assert.equal(h.calls.some(call => call.method === 'forwardMessage'), false);
});

test('confirmation racing a new message does not create another challenge', async t => {
    const h = harness(t);
    await h.message();
    const id = h.values.get('user_challenge:123');
    await h.web(id);
    const nativeGet = h.env.TOPIC_MAP.get;
    let intercept = true;
    h.env.TOPIC_MAP.get = async (key, options) => {
        const value = await nativeGet(key, options);
        if (key === 'verified:123' && intercept) {
            intercept = false;
            await h.confirm(id);
        }
        return value;
    };
    await h.message({ message_id: 43, text: 'arriving during confirmation' });
    assert.equal(h.forwarded().length, 2);
    assert.equal(h.values.has('user_challenge:123'), false);
    assert.equal(h.calls.filter(call => call.body.reply_markup?.inline_keyboard?.flat().some(button => button.url)).length, 1);
});

test('lost topics and cleanup retain permanent trust', async t => {
    const h = harness(t);
    h.seedVerified('trusted');
    h.telegramResult = method => method === 'forwardMessage' ? { ok: false, description: 'message thread not found' } : null;
    await h.message();
    assert.equal(h.values.get('verified:123'), 'trusted');
    assert.equal(h.values.has('user:123'), false);
    assert.equal(h.values.has('user_challenge:123'), false);
    h.seedVerified('trusted');
    h.telegramResult = (method, body) => method === 'sendMessage' && body.text === '🔎' ? { ok: false, description: 'message thread not found' } : null;
    h.env.ADMIN_IDS = '987654';
    await h.request({ message: { message_id: 100, chat: { id: Number(h.env.SUPERGROUP_ID), type: 'supergroup' }, from: { id: 987654 }, text: '/cleanup' } });
    assert.equal(h.values.get('verified:123'), 'trusted');
    assert.equal(h.values.has('user:123'), false);
});

test('failed nontrusted snapshot sending never falls back to an unchecked original', async t => {
    const h = harness(t);
    h.seedVerified();
    h.telegramResult = (method, body) => method === 'sendMessage' && body.chat_id === h.env.SUPERGROUP_ID ? { ok: false, description: 'temporary failure' } : null;
    t.mock.method(console, 'error', () => {});
    await h.message();
    assert.equal(h.calls.some(call => ['forwardMessage', 'copyMessage'].includes(call.method)), false);
    assert.ok(h.calls.some(call => call.method === 'sendMessage' && call.body.chat_id === 123 && call.body.text.includes('稍后')));
});

test('/start is never forwarded or put in pending messages', async t => {
    const h = harness(t);
    await h.message({ text: '/start' });
    const id = h.values.get('user_challenge:123');
    assert.deepEqual(JSON.parse(h.values.get(`chal:${id}`)).pending_messages, []);
    h.seedVerified('trusted');
    await h.message({ text: '/start' });
    assert.equal(h.forwarded().length, 0);
});
