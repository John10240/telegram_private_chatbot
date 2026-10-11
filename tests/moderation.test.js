import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../worker.js';

function harness(t) {
    const values = new Map();
    const calls = [];
    const listCalls = [];
    const jobs = [];
    const env = {
        BOT_TOKEN: 'test-bot',
        SUPERGROUP_ID: '-100123456',
        WEBHOOK_SECRET: 'test-secret',
        ADMIN_IDS: '999',
        TOPIC_MAP: {
            async get(key, options) {
                const value = values.get(key) ?? null;
                return options?.type === 'json' && value !== null ? JSON.parse(value) : value;
            },
            async put(key, value) { values.set(key, String(value)); },
            async delete(key) { values.delete(key); },
            async list({ prefix = '', cursor, limit = 1000 } = {}) {
                listCalls.push({ prefix, cursor, limit });
                const names = [...values.keys()].filter(key => key.startsWith(prefix)).sort((a, b) => {
                    const left = Number(a.slice(prefix.length));
                    const right = Number(b.slice(prefix.length));
                    return left - right;
                });
                const start = cursor ? Number(cursor) : 0;
                const page = names.slice(start, start + limit).map(name => ({ name }));
                const next = start + page.length;
                return { keys: page, list_complete: next >= names.length, cursor: String(next) };
            }
        }
    };
    const ctx = { waitUntil(promise) { jobs.push(promise); } };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        const method = String(url).split('/').pop();
        const body = JSON.parse(options.body);
        calls.push({ method, body });
        return Response.json(h.telegramResult?.(method, body) ?? { ok: true, result: method === 'getMe'
            ? { id: 42, username: 'testbot' }
            : { message_id: 1, message_thread_id: body.message_thread_id } });
    });
    const h = {
        env, values, calls, listCalls, ctx,
        async request(text, fields = {}) {
            const update = { message: {
                message_id: 10,
                chat: { id: env.SUPERGROUP_ID, type: 'supergroup' },
                from: { id: 999 },
                text,
                ...fields
            } };
            const response = await worker.fetch(new Request('https://bot.example/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Telegram-Bot-Api-Secret-Token': 'test-secret'
                },
                body: JSON.stringify(update)
            }), env, ctx);
            for (const job of jobs.splice(0)) await job;
            return response;
        }
    };
    h.callback = async (data, fields = {}) => {
        const query = { id: 'menu-callback', data, from: { id: 999 },
            message: { message_id: 20, chat: { id: env.SUPERGROUP_ID, type: 'supergroup' } }, ...fields };
        const response = await worker.fetch(new Request('https://bot.example/', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-secret' },
            body: JSON.stringify({ callback_query: query })
        }), env, ctx);
        for (const job of jobs.splice(0)) await job;
        return response;
    };
    return h;
}

test('explicit block from General stores bounded metadata and invalidates state', async t => {
    const h = harness(t);
    h.values.set('verified:12345', 'trusted');
    h.values.set('needs_verify:12345', '1');
    h.values.set('user_challenge:12345', 'challenge-1');
    h.values.set('chal:challenge-1', JSON.stringify({ userId: 12345 }));

    await h.request('/block 12345 reason '.concat('x'.repeat(500)));

    const metadata = JSON.parse(h.values.get('banned:12345'));
    assert.equal(metadata.actor, 999);
    assert.equal(metadata.reason.length, 200);
    assert.equal(h.values.has('verified:12345'), false);
    assert.equal(h.values.has('needs_verify:12345'), false);
    assert.equal(h.values.has('user_challenge:12345'), false);
    assert.equal(h.values.has('chal:challenge-1'), false);
    assert.equal(h.listCalls.some(call => call.prefix === 'user:'), false);
});

test('trust, untrust and reset accept explicit UIDs and invalidate challenges', async t => {
    const h = harness(t);
    h.values.set('needs_verify:77', '1');
    h.values.set('user_challenge:77', 'challenge-2');
    h.values.set('chal:challenge-2', JSON.stringify({ userId: 77 }));

    await h.request('/trust 77');
    assert.equal(h.values.get('verified:77'), 'trusted');
    assert.equal(h.values.has('needs_verify:77'), false);
    assert.equal(h.values.has('chal:challenge-2'), false);

    await h.request('/untrust 77');
    assert.equal(h.values.has('verified:77'), false);
    assert.equal(h.values.has('needs_verify:77'), false);

    h.values.set('verified:77', 'trusted');
    h.values.set('needs_verify:77', '1');
    await h.request('/reset 77');
    assert.equal(h.values.has('verified:77'), false);
    assert.equal(h.values.has('needs_verify:77'), false);
    assert.equal(h.listCalls.some(call => call.prefix === 'user:'), false);
});

test('topic commands preserve no-argument aliases and unknown slash commands are not forwarded', async t => {
    const h = harness(t);
    h.values.set('user:123', JSON.stringify({ thread_id: 700, title: 'Visitor' }));
    h.values.set('thread:700', '123');

    await h.request('/ban', { message_thread_id: 700 });
    assert.equal(h.values.get('banned:123'), '1');
    await h.request('/unblock', { message_thread_id: 700 });
    assert.equal(h.values.has('banned:123'), false);

    await h.request('/unknown-command', { message_thread_id: 700 });
    assert.equal(h.calls.some(call => call.method === 'copyMessage'), false);
});

test('blocklist is paginated at 50 and stays within Telegram message limits', async t => {
    const h = harness(t);
    for (let i = 1; i <= 51; i++) h.values.set(`banned:${i}`, i === 1 ? '1' : JSON.stringify({ reason: `reason-${i}` }));

    await h.request('/blocklist');
    const first = h.calls.at(-1);
    assert.equal(first.method, 'sendMessage');
    assert.ok(first.body.text.includes('1'));
    assert.ok(first.body.text.includes('下一页: /blocklist 50'));
    assert.ok(first.body.text.length <= 4096);
    assert.equal(h.listCalls.find(call => call.prefix === 'banned:').limit, 50);

    await h.request('/blocklist 50');
    const second = h.calls.at(-1);
    assert.ok(second.body.text.includes('51'));
    assert.ok(!second.body.text.includes('reason-1'));
});

test('full pages of long reasons retain every UID and the next-page command', async t => {
    const h = harness(t);
    const firstId = 100000000000000;
    for (let i = 0; i < 51; i++) h.values.set(`banned:${firstId + i}`, JSON.stringify({ reason: '很长的封禁原因'.repeat(50) }));
    await h.request('/blocklist');
    const output = h.calls.at(-1).body.text;
    assert.ok(output.length <= 4096);
    for (let i = 0; i < 50; i++) assert.ok(output.includes(String(firstId + i)));
    assert.ok(output.includes('/blocklist 50'));
});

test('invalid cursors are handled without throwing or modifying state', async t => {
    const h = harness(t);
    await h.request('/blocklist ' + 'x'.repeat(1025));
    assert.equal(h.listCalls.filter(call => call.prefix === 'banned:').length, 0);
    const nativeList = h.env.TOPIC_MAP.list;
    h.env.TOPIC_MAP.list = async options => {
        if (options.prefix === 'banned:') throw new Error('invalid cursor');
        return nativeList(options);
    };
    assert.equal((await h.request('/blocklist bad-cursor')).status, 200);
    assert.ok(h.calls.at(-1).body.text.includes('游标'));
    assert.equal(h.values.size, 0);
});

test('invalid target IDs cannot block a topic user accidentally', async t => {
    const h = harness(t);
    h.values.set('thread:700', '123');
    for (const id of ['-1', '0', '1.5', '9007199254740992', 'bad']) {
        await h.request(`/block ${id}`, { message_thread_id: 700 });
        assert.equal(h.values.has('banned:123'), false);
    }
});

test('info rejects legacy expired status and safely escapes topic titles', async t => {
    const h = harness(t);
    h.values.set('thread:700', '123');
    h.values.set('user:123', JSON.stringify({ thread_id: 700, title: 'User <script> &_name' }));
    h.values.set('verified:123', '1');
    await h.request('/info', { message_thread_id: 700 });
    const output = h.calls.at(-1).body;
    assert.equal(output.parse_mode, 'HTML');
    assert.ok(output.text.includes('&lt;script&gt;'));
    assert.ok(output.text.includes('未验证'));
});

test('General menu offers blacklist and UID help without forwarding to users', async t => {
    const h = harness(t);
    await h.request('/menu');
    const menu = h.calls.find(call => call.body.reply_markup)?.body;
    assert.ok(menu);
    const buttons = menu.reply_markup.inline_keyboard.flat();
    assert.ok(buttons.some(button => button.callback_data === 'admin:blocklist:0'));
    assert.ok(buttons.some(button => button.callback_data === 'admin:help:0'));
    assert.ok(buttons.every(button => Buffer.byteLength(button.callback_data) <= 64));
    assert.equal(h.calls.some(call => call.method === 'copyMessage'), false);
    await h.callback('admin:help:0');
    assert.match(h.calls.at(-1).body.text, /\/block UID/);
});

test('topic menu binds the user and requires confirmation before a mutation', async t => {
    const h = harness(t);
    h.values.set('thread:700', '123');
    h.values.set('user:123', JSON.stringify({ thread_id: 700, title: 'Visitor' }));
    await h.request('/menu@testbot', { message_thread_id: 700 });
    const menu = h.calls.find(call => call.body.reply_markup)?.body;
    assert.equal(menu.message_thread_id, 700);
    assert.match(menu.text, /123/);
    assert.ok(menu.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'admin:ask-block:123'));
    const message = { message_id: 20, message_thread_id: 700, chat: { id: h.env.SUPERGROUP_ID, type: 'supergroup' } };
    await h.callback('admin:ask-block:123', { message });
    assert.equal(h.values.has('banned:123'), false);
    assert.ok(h.calls.at(-1).body.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'admin:block:123'));
    await h.callback('admin:block:123', { message });
    assert.equal(h.values.get('banned:123'), '1');
    await h.callback('admin:unblock:123', { message });
    assert.equal(h.values.has('banned:123'), false);
    await h.callback('admin:trust:123', { message });
    assert.equal(h.values.get('verified:123'), 'trusted');
    await h.callback('admin:untrust:123', { message });
    assert.equal(h.values.has('verified:123'), false);
});

test('menu callbacks reject nonadmins, private/wrong groups, rebound users and unknown actions', async t => {
    const h = harness(t);
    h.values.set('thread:700', '123');
    const message = { message_id: 20, message_thread_id: 700, chat: { id: h.env.SUPERGROUP_ID, type: 'supergroup' } };
    for (const fields of [
        { from: { id: 1000 }, message },
        { message: { ...message, chat: { id: 999, type: 'private' } } },
        { message: { ...message, chat: { id: '-100999', type: 'supergroup' } } }
    ]) await h.callback('admin:block:123', fields);
    await h.callback('admin:block:456', { message });
    await h.callback('admin:block:0');
    await h.callback('admin:cleanup:123', { message });
    assert.equal(h.values.has('banned:123'), false);
    assert.equal(h.values.has('banned:456'), false);
    assert.equal(h.calls.some(call => call.method === 'copyMessage'), false);
    assert.ok(h.calls.filter(call => call.method === 'answerCallbackQuery').length >= 5);
});

test('menu does not reuse a revoked cached administrator role', async t => {
    const h = harness(t);
    h.values.set('admin:1000', '1');
    h.values.set('thread:700', '123');
    const message = { message_id: 20, message_thread_id: 700, chat: { id: h.env.SUPERGROUP_ID, type: 'supergroup' } };
    await h.callback('admin:block:123', { from: { id: 1000 }, message });
    assert.ok(h.calls.some(call => call.method === 'getChatMember' && call.body.user_id === 1000));
    assert.equal(h.values.has('banned:123'), false);
    assert.match(h.calls.at(-1).body.text, /管理员/);
});

test('nonadmins cannot open the management menu', async t => {
    const h = harness(t);
    await h.request('/menu', { from: { id: 1000 } });
    assert.equal(h.calls.some(call => call.body.reply_markup), false);
});

test('all administrator commands accept their own bot suffix', async t => {
    for (const command of ['trust', 'untrust', 'reset', 'block', 'ban', 'unblock', 'unban', 'info', 'close', 'open', 'blocklist', 'menu', 'cleanup']) {
        await t.test(command, async t => {
            const h = harness(t);
            h.values.set('thread:700', '123');
            h.values.set('user:123', JSON.stringify({ thread_id: 700, title: 'Visitor', closed: true }));
            h.values.set('verified:123', 'trusted');
            h.values.set('banned:123', '1');
            await h.request(`/${command}@TeStBoT`, { message_thread_id: 700 });
            assert.ok(h.calls.some(call => call.method === 'getMe'));
            if (command === 'trust') assert.match(h.calls.at(-1).body.text, /永久信任/);
            else if (['untrust', 'reset'].includes(command)) assert.equal(h.values.has('verified:123'), false);
            else if (['block', 'ban'].includes(command)) assert.match(h.calls.at(-1).body.text, /封禁/);
            else if (['unblock', 'unban'].includes(command)) assert.equal(h.values.has('banned:123'), false);
            else if (command === 'close') assert.ok(h.calls.some(call => call.method === 'closeForumTopic'));
            else if (command === 'open') assert.equal(JSON.parse(h.values.get('user:123')).closed, false);
            else if (command === 'menu') assert.ok(h.calls.some(call => call.body.reply_markup));
            else if (command === 'blocklist') assert.match(h.calls.at(-1).body.text, /封禁用户列表/);
            else if (command === 'info') assert.match(h.calls.at(-1).body.text, /用户信息/);
            else assert.ok(h.calls.some(call => call.body.text?.includes('清理')));
            assert.equal(h.calls.some(call => call.method === 'copyMessage'), false);
        });
    }
});

test('addressed commands retain UID/reason arguments and reject other bots or failed identity lookup', async t => {
    const h = harness(t);
    await h.request('/block@testbot 77 spam reason @anotherbot');
    assert.equal(JSON.parse(h.values.get('banned:77')).reason, 'spam reason @anotherbot');
    await h.request('/trust@testbot 88');
    assert.equal(h.values.get('verified:88'), 'trusted');
    await h.request('/reset@otherbot 88');
    await h.request('/menu@otherbot');
    assert.equal(h.values.get('verified:88'), 'trusted');
    assert.equal(h.calls.some(call => call.body.reply_markup), false);
    h.telegramResult = method => method === 'getMe' ? { ok: false, description: 'lookup failed' } : undefined;
    await h.request('/block@testbot 99');
    assert.equal(h.values.has('banned:99'), false);
    await h.request('/block 99');
    assert.equal(h.values.get('banned:99'), '1', 'bare commands must not depend on identity lookup');
    await h.request('/unknown@testbot');
    assert.equal(h.calls.some(call => call.method === 'copyMessage'), false);
});

test('keyword commands replace, normalize and show the persistent global list', async t => {
    const h = harness(t);
    h.env.FILTER_KEYWORDS = 'dashboard-default';
    await h.request('/keywords@testbot');
    assert.match(h.calls.at(-1).body.text, /dashboard-default/);
    await h.request('/setkeywords@testbot 广告，ＳＣＡＭ\nscam, 零\u200b宽');
    assert.equal(h.values.get('settings:filter_keywords'), '广告,scam,零宽');
    await h.request('/keywords');
    assert.match(h.calls.at(-1).body.text, /广告,scam,零宽/);
    assert.ok(h.calls.at(-1).body.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'admin:ask-clearkeywords:0'));
    await h.request('/menu');
    assert.ok(h.calls.at(-1).body.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'admin:keywords:0'));
});

test('clearing keywords requires confirmation and persists an empty override over dashboard defaults', async t => {
    const h = harness(t);
    h.env.FILTER_KEYWORDS = 'dashboard-default';
    h.values.set('settings:filter_keywords', '广告');
    await h.request('/clearkeywords@testbot');
    assert.equal(h.values.get('settings:filter_keywords'), '广告');
    assert.ok(h.calls.at(-1).body.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'admin:clearkeywords:0'));
    await h.callback('admin:cancel:0');
    assert.equal(h.values.get('settings:filter_keywords'), '广告');
    await h.callback('admin:clearkeywords:0');
    assert.equal(h.values.get('settings:filter_keywords'), '');
    await h.request('/keywords');
    assert.match(h.calls.at(-1).body.text, /未启用/);
    assert.doesNotMatch(h.calls.at(-1).body.text, /dashboard-default/);
});

test('keyword policy rejects invalid input, unauthorized commands and wrong-group callbacks', async t => {
    const h = harness(t);
    h.values.set('settings:filter_keywords', 'unchanged');
    for (const input of ['', ',，\n', 'x'.repeat(129), Array.from({ length: 101 }, (_, i) => `word${i}`).join(','), 'x'.repeat(2049)]) {
        await h.request(`/setkeywords ${input}`);
        assert.equal(h.values.get('settings:filter_keywords'), 'unchanged');
    }
    await h.request('/setkeywords@otherbot changed');
    await h.request('/setkeywords changed', { from: { id: 1000 } });
    await h.request('/setkeywords changed', { chat: { id: '-100999', type: 'supergroup' } });
    await h.callback('admin:clearkeywords:0', { from: { id: 1000 } });
    await h.callback('admin:clearkeywords:0', { message: { message_id: 20, chat: { id: 999, type: 'private' } } });
    assert.equal(h.values.get('settings:filter_keywords'), 'unchanged');
    assert.equal(h.calls.some(call => call.method === 'copyMessage'), false);
});

test('keyword write failure is reported without claiming success or changing the policy', async t => {
    const h = harness(t);
    h.values.set('settings:filter_keywords', 'unchanged');
    const put = h.env.TOPIC_MAP.put.bind(h.env.TOPIC_MAP);
    t.mock.method(h.env.TOPIC_MAP, 'put', async (key, value) => {
        if (key === 'settings:filter_keywords') throw new Error('simulated KV write failure');
        return put(key, value);
    });
    t.mock.method(console, 'error', () => {});
    assert.equal((await h.request('/setkeywords changed')).status, 200);
    assert.equal(h.values.get('settings:filter_keywords'), 'unchanged');
    assert.match(h.calls.at(-1).body.text, /读写失败/);
});

test('non-admin moderation command is ignored', async t => {
    const h = harness(t);
    await h.request('/block 77', { from: { id: 1000 } });
    assert.equal(h.values.has('banned:77'), false);
});
