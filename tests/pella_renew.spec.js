// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── 账号配置 ────────────────────────────────────────────────
const rawAccountsStr = process.env.PELLA_ACCOUNTS || '';
const accountsMap = new Map();
rawAccountsStr.split('|').filter(Boolean).forEach(acc => {
    const idx = acc.indexOf(',');
    if (idx !== -1) {
        const email = acc.substring(0, idx).trim();
        const secret = acc.substring(idx + 1).trim();
        accountsMap.set(email, secret);
    }
});
const accounts = Array.from(accountsMap.entries());
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');
const TIMEOUT = 60000;

// ── 写回最新 Secrets ────────────────────────────────────────
function updateSavedAccountSecret(email, newSecret) {
    accountsMap.set(email, newSecret);
    const updatedList = [];
    for (const [accEmail, accSecret] of accountsMap.entries()) {
        updatedList.push(`${accEmail},${accSecret}`);
    }
    fs.writeFileSync(path.join(process.cwd(), 'updated_accounts.txt'), updatedList.join('|'), 'utf-8');
    console.log(`💾 已将 ${email} 的最新 Cookie 写入本地更新队列`);
}

// ── Cookie 解析 ─────────────────────────────────────────────
function parseCookies(cookieStr) {
    const cleanStr = cookieStr.replace(/^cookie:/i, '').trim();
    return cleanStr.split(';').map(pair => {
        const eqIdx = pair.indexOf('=');
        if (eqIdx === -1) return null;
        const name = pair.substring(0, eqIdx).trim();
        const value = pair.substring(eqIdx + 1).trim();
        if (!name) return null;
        return { name, value, domain: '.pella.app', path: '/', secure: true, sameSite: 'Lax' };
    }).filter(Boolean);
}

function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).replace(/\//g, '-');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 计算剩余时间（和 worker 一致） ───────────────────────────
function calcRemaining(expiry) {
    if (!expiry) return 'N/A';
    try {
        // 支持 "HH:MM:SS DD/MM/YYYY" 或 ISO 等格式
        let expiryDate;
        const match = String(expiry).match(/(\d{2}):(\d{2}):(\d{2})\s+(\d{2})\/(\d{2})\/(\d{4})/);
        if (match) {
            const [, hour, minute, second, day, month, year] = match;
            expiryDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
        } else {
            expiryDate = new Date(expiry);
        }
        const diff = expiryDate.getTime() - Date.now();
        if (diff <= 0) return '已过期';
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        if (days > 0) return `${days}天${hours}时${minutes}分`;
        if (hours > 0) return `${hours}时${minutes}分`;
        return `${minutes}分`;
    } catch {
        return String(expiry);
    }
}

// ── Telegram 通知（参考 worker 格式） ───────────────────────
function sendSummaryTG(results) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) {
            console.log('⚠️ TG_BOT 未配置，跳过推送');
            return resolve();
        }
        const lines = [
            `📋 Pella 自动续期报告`,
            `🕐 ${nowStr()}`,
            `──────────────────────────`,
        ];
        results.forEach((item, index) => {
            lines.push(`👤 ${item.email}`);
            if (item.error) {
                lines.push(`❌ ${item.error}`);
            } else {
                lines.push(`📊 ${item.status}`);
                if (item.expiry) lines.push(`⏳ 剩余: ${item.expiry}`);
                if (item.detail) lines.push(`ℹ️ ${item.detail}`);
            }
            if (index < results.length - 1) lines.push(`──────────────────────────`);
        });
        lines.push(``);
        lines.push(`Pella Auto Renewal`);

        const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: lines.join('\n') });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            console.log(res.statusCode === 200 ? '📨 TG 汇总推送成功' : `⚠️ TG 推送失败：HTTP ${res.statusCode}`);
            resolve();
        });
        req.on('error', e => { console.log(`⚠️ TG 推送异常：${e.message}`); resolve(); });
        req.setTimeout(15000, () => { console.log('⚠️ TG 推送超时'); req.destroy(); resolve(); });
        req.write(body);
        req.end();
    });
}

// ── 主测试 ──────────────────────────────────────────────────
test('Pella 多账号自动续期（纯 API 版）', async () => {
    test.setTimeout(180000); // 3 分钟足够

    if (accounts.length === 0) {
        throw new Error('❌ 未找到任何账号配置，请检查 PELLA_ACCOUNTS');
    }

    const summaryResults = [];

    for (const [email, secretVal] of accounts) {
        console.log(`\n===========================================`);
        console.log(`🚀 开始处理账号: ${email}`);
        console.log(`===========================================\n`);

        let proxyConfig = undefined;
        if (process.env.GOST_PROXY) {
            try {
                await new Promise((resolve, reject) => {
                    const req = http.request({ host: '127.0.0.1', port: 8080, path: '/', method: 'GET', timeout: 3000 }, () => resolve());
                    req.on('error', reject);
                    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                    req.end();
                });
                proxyConfig = { server: 'http://127.0.0.1:8080' };
                console.log('🛡️ 本地代理连通，使用 GOST 转发');
            } catch {
                console.log('⚠️ 本地代理不可达，降级为直连');
            }
        }

        console.log('🔧 启动浏览器（仅用于登录拿 Token）...');
        const browser = await chromium.launch({
            headless: false,
            proxy: proxyConfig,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        const context = await browser.newContext();
        const isCookieLogin = secretVal.startsWith('cookie:') || secretVal.includes('__session');

        if (isCookieLogin) {
            console.log('🍪 检测到 Cookie 配置，注入 Cookie 实现免密登录...');
            const cookies = parseCookies(secretVal);
            await context.addCookies(cookies);
        }

        const page = await context.newPage();
        page.setDefaultTimeout(TIMEOUT);
        let token = null;
        let servers = [];

        try {
            // 登录拿 Token
            if (isCookieLogin) {
                console.log('🔑 打开 Pella 首页 (Cookie 免密模式)...');
                await page.goto('https://www.pella.app/home', { waitUntil: 'domcontentloaded' });
                await sleep(3000);
                let hasSession = false;
                for (let i = 0; i < 15; i++) {
                    hasSession = await page.evaluate('!!(window.Clerk && window.Clerk.session)');
                    if (hasSession) break;
                    await sleep(500);
                }
                if (!hasSession) throw new Error('Cookie 注入后未能生成有效 Session，请更新 Cookie！');
                console.log(`✅ Cookie 免密登录成功`);
            } else {
                console.log('🔑 打开 Pella 登录页 (账号密码模式)...');
                await page.goto('https://www.pella.app/login', { waitUntil: 'domcontentloaded' });
                await page.waitForSelector('#identifier-field', { timeout: 15000 });
                await page.fill('#identifier-field', email);
                await page.click('span.cl-internal-2iusy0');
                await sleep(2000);
                await page.waitForSelector('input[name="password"]', { timeout: 15000 });
                await page.fill('input[name="password"]', secretVal);
                await page.click('span.cl-internal-2iusy0');
                await page.waitForURL(/pella\.app\/(home|dashboard)/, { timeout: 30000 });
                console.log(`✅ 登录成功`);
            }

            // 等待 Clerk session
            for (let i = 0; i < 20; i++) {
                const ready = await page.evaluate('!!(window.Clerk && window.Clerk.session)');
                if (ready) break;
                await sleep(500);
            }

            // 更新最新 Cookie
            try {
                const latestCookies = await context.cookies(['https://www.pella.app', 'https://clerk.pella.app']);
                const cookieStr = latestCookies.map(c => `${c.name}=${c.value}`).join('; ');
                if (cookieStr.includes('__client') && cookieStr.includes('__session')) {
                    updateSavedAccountSecret(email, `cookie:${cookieStr}`);
                }
            } catch (err) {
                console.log(`⚠️ 抓取最新 Cookie 失败: ${err.message}`);
            }

            // 获取 JWT
            console.log('🔑 获取 JWT token...');
            token = await page.evaluate('window.Clerk && window.Clerk.session ? window.Clerk.session.getToken() : null');
            if (!token) throw new Error('无法获取 Clerk token');

            // 获取服务器列表
            console.log('🔍 获取服务器信息...');
            const serversRes = await page.evaluate(async (t) => {
                const res = await fetch('https://api.pella.app/user/servers', {
                    headers: { 'Authorization': `Bearer ${t}` }
                });
                return await res.json();
            }, token);
            servers = serversRes.servers || [];
            if (servers.length === 0) throw new Error('未找到服务器');

            console.log(`🖥️ 共 ${servers.length} 台服务器`);

            // ========== 纯 API 续期（核心） ==========
            const renewResults = [];
            for (const server of servers) {
                const serverId = server.id || server._id;
                console.log(`\n处理服务器 ${serverId}`);

                // 1. 刷新广告链接
                console.log(`调用 renew/update 刷新广告链接...`);
                try {
                    await page.evaluate(async ({ t, sid }) => {
                        await fetch(`https://api.pella.app/server/renew/update?id=${sid}`, {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${t}`,
                                'Content-Type': 'application/json',
                                'Origin': 'https://www.pella.app',
                                'Referer': 'https://www.pella.app/'
                            },
                            body: '{}'
                        });
                    }, { t: token, sid: serverId });
                } catch (e) {
                    console.log(`renew/update 失败: ${e.message}`);
                }
                await sleep(800);

                // 2. 获取最新 renew_links
                let renewLinks = [];
                try {
                    const detail = await page.evaluate(async ({ t, sid }) => {
                        const res = await fetch(`https://api.pella.app/server/detailed?id=${sid}`, {
                            headers: {
                                'Authorization': `Bearer ${t}`,
                                'Origin': 'https://www.pella.app',
                                'Referer': 'https://www.pella.app/'
                            }
                        });
                        return await res.json();
                    }, { t: token, sid: serverId });
                    renewLinks = detail.renew_links || [];
                    console.log(`获取到 ${renewLinks.length} 个续期链接`);
                } catch (e) {
                    console.log(`获取详情失败: ${e.message}`);
                    renewLinks = server.renew_links || [];
                }

                const availableLinks = renewLinks.filter(l => l.claimed === false);
                const linksToTry = availableLinks.length > 0 ? availableLinks : renewLinks;
                console.log(`可用未认领链接: ${availableLinks.length}`);

                if (linksToTry.length === 0) {
                    renewResults.push({ serverId, status: 'no_links', message: '无续期链接' });
                    continue;
                }

                let successCount = 0;
                let claimedCount = 0;
                const failMessages = [];

                for (let i = 0; i < linksToTry.length; i++) {
                    const linkObj = linksToTry[i];
                    const linkUrl = typeof linkObj === 'string' ? linkObj : (linkObj.link || '');
                    const linkId = linkUrl.split('/renew/')[1];
                    if (!linkId) continue;

                    console.log(`尝试链接 ${i + 1}/${linksToTry.length}: ${linkId}`);

                    try {
                        const result = await page.evaluate(async ({ t, lid }) => {
                            const res = await fetch(`https://api.pella.app/server/renew?id=${lid}`, {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${t}`,
                                    'Content-Type': 'application/json',
                                    'Origin': 'https://www.pella.app',
                                    'Referer': `https://pella.app/renew/${lid}`
                                },
                                body: '{}'
                            });
                            const text = await res.text();
                            let data;
                            try { data = JSON.parse(text); } catch { data = {}; }
                            return { status: res.status, data, text };
                        }, { t: token, lid: linkId });

                        console.log(`API 响应: ${result.status} ${JSON.stringify(result.data)}`);

                        if (result.data.success) {
                            successCount++;
                            console.log(`✅ 续期成功`);
                        } else if (result.data.error === 'Already claimed' || (result.data.message && result.data.message.includes('Already claimed'))) {
                            claimedCount++;
                            console.log(`ℹ️ 已认领过`);
                        } else {
                            failMessages.push(result.data.error || result.data.message || '未知错误');
                        }
                    } catch (e) {
                        failMessages.push(e.message);
                    }
                    await sleep(500);
                }

                if (successCount > 0) {
                    renewResults.push({ serverId, status: 'success', message: `续期成功(${successCount}/${linksToTry.length})` });
                } else if (claimedCount === linksToTry.length) {
                    renewResults.push({ serverId, status: 'claimed', message: '广告冷却中' });
                } else if (failMessages.length > 0) {
                    renewResults.push({ serverId, status: 'fail', message: failMessages.join('; ') });
                } else {
                    renewResults.push({ serverId, status: 'no_links', message: '无可用链接' });
                }
            }

            // 重新获取最新服务器状态（拿最新 expiry）
            await sleep(1000);
            const finalServersRes = await page.evaluate(async (t) => {
                const res = await fetch('https://api.pella.app/user/servers', {
                    headers: { 'Authorization': `Bearer ${t}` }
                });
                return await res.json();
            }, token);
            const finalServers = finalServersRes.servers || servers;

            // 汇总
            const successResults = renewResults.filter(r => r.status === 'success');
            const claimedResults = renewResults.filter(r => r.status === 'claimed');
            const failResults = renewResults.filter(r => r.status === 'fail');

            let statusText = '';
            if (successResults.length > 0) {
                statusText = `✅ 续期成功 (${successResults.length} 台)`;
            } else if (claimedResults.length > 0 && failResults.length === 0) {
                statusText = `ℹ️ 广告冷却中`;
            } else if (failResults.length > 0) {
                statusText = `❌ 续期失败`;
            } else {
                statusText = `⚠️ 无可用续期链接`;
            }

            // 取第一台服务器的剩余时间
            const firstServer = finalServers[0] || {};
            const remaining = calcRemaining(firstServer.expiry);

            summaryResults.push({
                email,
                status: statusText,
                expiry: remaining,
                detail: renewResults.map(r => `${r.serverId}: ${r.message}`).join(' | ')
            });

            console.log(`\n✅ 账号 ${email} 处理完成 → ${statusText}，剩余: ${remaining}`);

        } catch (e) {
            console.log(`❌ 账号 ${email} 异常: ${e.message}`);
            summaryResults.push({
                email,
                error: e.message,
                status: '脚本异常',
                expiry: 'N/A'
            });
        } finally {
            await browser.close();
        }
    }

    await sendSummaryTG(summaryResults);
});
