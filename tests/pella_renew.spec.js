// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const http = require('http');
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

function updateSavedAccountSecret(email, newSecret) {
    accountsMap.set(email, newSecret);
    const updatedList = [];
    for (const [accEmail, accSecret] of accountsMap.entries()) {
        updatedList.push(`${accEmail},${accSecret}`);
    }
    fs.writeFileSync(path.join(process.cwd(), 'updated_accounts.txt'), updatedList.join('|'), 'utf-8');
    console.log(`💾 已将 ${email} 的最新 Cookie 写入本地更新队列`);
}

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

function calcRemaining(expiry) {
    if (!expiry) return 'N/A';
    try {
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

function sendSummaryTG(results) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) {
            console.log('⚠️ TG_BOT 未配置，跳过推送');
            return resolve();
        }
        const lines = [
            `📋 Pella 自动续期 + 智能重启报告`,
            `🕐 ${nowStr()}`,
            `──────────────────────────`,
        ];
        results.forEach((item, index) => {
            lines.push(`👤 ${item.email}`);
            if (item.error) {
                lines.push(`❌ ${item.error}`);
            } else {
                lines.push(`📊 续期: ${item.renewStatus}`);
                lines.push(`🔄 重启: ${item.restartStatus}`);
                if (item.expiry) lines.push(`⏳ 剩余: ${item.expiry}`);
                if (item.detail) lines.push(`ℹ️ ${item.detail}`);
            }
            if (index < results.length - 1) lines.push(`──────────────────────────`);
        });
        lines.push(``, `Pella Auto Renewal`);

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

// ── 检测是否需要重启 ────────────────────────────────────────
async function needRestart(page, token, serverId, apiStatus) {
    // 1. 先根据 API 状态判断
    const status = (apiStatus || '').toLowerCase();
    if (status && status !== 'running') {
        console.log(`⚠️ API 状态为 "${apiStatus}"，需要重启`);
        return true;
    }

    // 2. 打开 overview 页面检查 CONSOLE 内容
    try {
        const overviewUrl = `https://www.pella.app/server/${serverId}/overview`;
        console.log(`🔍 检查 CONSOLE: ${overviewUrl}`);
        await page.goto(overviewUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(3500);

        const consoleText = await page.evaluate(() => {
            // 尝试多种方式获取控制台内容
            const selectors = [
                '[class*="console"]',
                '[class*="Console"]',
                'pre',
                '.console-output',
                '#console',
                '[data-testid="console"]'
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && el.innerText && el.innerText.trim().length > 5) {
                    return el.innerText.trim();
                }
            }
            // 兜底：找包含 "CONSOLE" 标题附近的内容
            const all = document.querySelectorAll('div, pre, section');
            for (const el of all) {
                if ((el.innerText || '').includes('CONSOLE') || (el.innerText || '').includes('Web server is running')) {
                    return el.innerText.trim();
                }
            }
            return document.body.innerText || '';
        }).catch(() => '');

        const text = (consoleText || '').toLowerCase();
        console.log(`CONSOLE 内容片段: ${text.substring(0, 120).replace(/\n/g, ' ')}...`);

        // 判断是否异常
        const isEmpty = text.trim().length < 20;
        const onlyStarting = (
            text.includes('starting') ||
            text.includes('启动') ||
            text.includes('正在启动') ||
            text.includes('pending')
        ) && !text.includes('running') && !text.includes('listening') && !text.includes('web server is running');

        if (isEmpty) {
            console.log('⚠️ CONSOLE 为空，需要重启');
            return true;
        }
        if (onlyStarting) {
            console.log('⚠️ CONSOLE 只有启动信息，需要重启');
            return true;
        }

        console.log('✅ CONSOLE 正常，无需重启');
        return false;
    } catch (e) {
        console.log(`检查 CONSOLE 失败: ${e.message}，为安全起见执行重启`);
        return true;
    }
}

// ── 执行重启 ────────────────────────────────────────────────
async function doRestart(page, token, serverId) {
    try {
        const result = await page.evaluate(async ({ t, sid }) => {
            const res = await fetch('https://api.pella.app/server/redeploy', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${t}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': 'https://www.pella.app',
                    'Referer': 'https://www.pella.app/'
                },
                body: `id=${encodeURIComponent(sid)}`
            });
            const text = await res.text();
            return { status: res.status, text };
        }, { t: token, sid: serverId });

        console.log(`重启响应: HTTP ${result.status} ${result.text || '(空)'}`);
        if (result.status === 200 || !result.text || result.text.trim() === '') {
            console.log('✅ 重启指令已发送');
            return true;
        }
        return false;
    } catch (e) {
        console.log(`重启异常: ${e.message}`);
        return false;
    }
}

// ── 主测试 ──────────────────────────────────────────────────
test('Pella 多账号自动续期 + 智能重启', async () => {
    test.setTimeout(240000);

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
            await context.addCookies(parseCookies(secretVal));
        }

        const page = await context.newPage();
        page.setDefaultTimeout(TIMEOUT);
        let token = null;

        try {
            // 登录
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
                throw new Error('当前仅支持 Cookie 登录');
            }

            // 等待 session
            for (let i = 0; i < 20; i++) {
                if (await page.evaluate('!!(window.Clerk && window.Clerk.session)')) break;
                await sleep(500);
            }

            // 更新 Cookie
            try {
                const latestCookies = await context.cookies(['https://www.pella.app', 'https://clerk.pella.app']);
                const cookieStr = latestCookies.map(c => `${c.name}=${c.value}`).join('; ');
                if (cookieStr.includes('__client') && cookieStr.includes('__session')) {
                    updateSavedAccountSecret(email, `cookie:${cookieStr}`);
                }
            } catch (err) {
                console.log(`⚠️ 抓取最新 Cookie 失败: ${err.message}`);
            }

            // 获取 Token
            console.log('🔑 获取 JWT token...');
            token = await page.evaluate('window.Clerk && window.Clerk.session ? window.Clerk.session.getToken() : null');
            if (!token) throw new Error('无法获取 Clerk token');

            // 获取服务器
            console.log('🔍 获取服务器信息...');
            const serversRes = await page.evaluate(async (t) => {
                const res = await fetch('https://api.pella.app/user/servers', {
                    headers: { 'Authorization': `Bearer ${t}` }
                });
                return await res.json();
            }, token);
            const servers = serversRes.servers || [];
            if (servers.length === 0) throw new Error('未找到服务器');
            console.log(`🖥️ 共 ${servers.length} 台服务器`);

            const renewResults = [];
            let totalRestartSuccess = 0;
            let totalRestartSkip = 0;

            for (const server of servers) {
                const serverId = server.id || server._id;
                console.log(`\n处理服务器 ${serverId} (API状态: ${server.status || '未知'})`);

                // ===== 续期 =====
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
                    renewLinks = server.renew_links || [];
                }

                const availableLinks = renewLinks.filter(l => l.claimed === false);
                const linksToTry = availableLinks.length > 0 ? availableLinks : renewLinks;
                console.log(`可用未认领链接: ${availableLinks.length}`);

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
                            return { status: res.status, data };
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

                let renewMsg = '';
                if (successCount > 0) {
                    renewMsg = `续期成功(${successCount})`;
                    renewResults.push({ serverId, status: 'success', message: renewMsg });
                } else if (claimedCount > 0 && failMessages.length === 0) {
                    renewMsg = '广告冷却中';
                    renewResults.push({ serverId, status: 'claimed', message: renewMsg });
                } else if (failMessages.length > 0) {
                    renewMsg = failMessages.join('; ');
                    renewResults.push({ serverId, status: 'fail', message: renewMsg });
                } else {
                    renewMsg = '无可用链接';
                    renewResults.push({ serverId, status: 'no_links', message: renewMsg });
                }

                // ===== 智能重启判断 =====
                const shouldRestart = await needRestart(page, token, serverId, server.status);
                let restartMsg = '无需重启';

                if (shouldRestart) {
                    console.log('🔄 满足重启条件，执行重启...');
                    const ok = await doRestart(page, token, serverId);
                    if (ok) {
                        totalRestartSuccess++;
                        restartMsg = '已重启';
                    } else {
                        restartMsg = '重启失败';
                    }
                } else {
                    totalRestartSkip++;
                    console.log('⏭️ 进程正常，跳过重启');
                }

                renewResults[renewResults.length - 1].message += ` | ${restartMsg}`;
            }

            // 最终剩余时间
            await sleep(1000);
            const finalServersRes = await page.evaluate(async (t) => {
                const res = await fetch('https://api.pella.app/user/servers', {
                    headers: { 'Authorization': `Bearer ${t}` }
                });
                return await res.json();
            }, token);
            const finalServers = finalServersRes.servers || servers;

            const successResults = renewResults.filter(r => r.status === 'success');
            const claimedResults = renewResults.filter(r => r.status === 'claimed');
            const failResults = renewResults.filter(r => r.status === 'fail');

            let renewStatusText = '';
            if (successResults.length > 0) {
                renewStatusText = `✅ 续期成功 (${successResults.length} 台)`;
            } else if (claimedResults.length > 0 && failResults.length === 0) {
                renewStatusText = `ℹ️ 广告冷却中`;
            } else if (failResults.length > 0) {
                renewStatusText = `❌ 续期失败`;
            } else {
                renewStatusText = `⚠️ 无可用续期链接`;
            }

            let restartStatusText = '';
            if (totalRestartSuccess > 0) {
                restartStatusText = `✅ 重启 ${totalRestartSuccess} 台`;
            } else if (totalRestartSkip > 0) {
                restartStatusText = `⏭️ 全部正常，无需重启`;
            } else {
                restartStatusText = `❌ 重启失败`;
            }

            const remaining = calcRemaining(finalServers[0]?.expiry);

            summaryResults.push({
                email,
                renewStatus: renewStatusText,
                restartStatus: restartStatusText,
                expiry: remaining,
                detail: renewResults.map(r => `${r.serverId.slice(-6)}: ${r.message}`).join(' | ')
            });

            console.log(`\n✅ 账号 ${email} 处理完成`);
            console.log(`   续期: ${renewStatusText}`);
            console.log(`   重启: ${restartStatusText}`);
            console.log(`   剩余: ${remaining}`);

        } catch (e) {
            console.log(`❌ 账号 ${email} 异常: ${e.message}`);
            summaryResults.push({
                email,
                error: e.message,
                renewStatus: '脚本异常',
                restartStatus: '脚本异常',
                expiry: 'N/A'
            });
        } finally {
            await browser.close();
        }
    }

    await sendSummaryTG(summaryResults);
});
