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
const TIMEOUT = 120000;

// ── 写回最新 Secrets 到文件的辅助函数 ───────────────────────
function updateSavedAccountSecret(email, newSecret) {
    accountsMap.set(email, newSecret);
    const updatedList = [];
    for (const [accEmail, accSecret] of accountsMap.entries()) {
        updatedList.push(`${accEmail},${accSecret}`);
    }
    const finalStr = updatedList.join('|');
    fs.writeFileSync(path.join(process.cwd(), 'updated_accounts.txt'), finalStr, 'utf-8');
    console.log(`💾 已将 ${email} 的最新 Cookie 写入本地更新队列`);
}

// ── Cookie 解析工具函数 ──────────────────────────────────────
function parseCookies(cookieStr) {
    const cleanStr = cookieStr.replace(/^cookie:/i, '').trim();
    return cleanStr.split(';').map(pair => {
        const eqIdx = pair.indexOf('=');
        if (eqIdx === -1) return null;
        const name = pair.substring(0, eqIdx).trim();
        const value = pair.substring(eqIdx + 1).trim();
        if (!name) return null;
        return {
            name,
            value,
            domain: '.pella.app',
            path: '/',
            secure: true,
            sameSite: 'Lax',
        };
    }).filter(Boolean);
}

// ── 工具函数：获取服务器剩余时间 ────────────────────────────
async function fetchExpiryTime(page, token) {
    try {
        // 优先从 API 查询精确时间
        if (token) {
            const serversRes = await page.evaluate(async (t) => {
                try {
                    const res = await fetch('https://api.pella.app/user/servers', {
                        headers: { 'Authorization': `Bearer ${t}` }
                    });
                    return await res.json();
                } catch { return null; }
            }, token);

            if (serversRes && serversRes.servers && serversRes.servers.length > 0) {
                const server = serversRes.servers[0];
                if (server.expires_at) {
                    const diffMs = new Date(server.expires_at) - new Date();
                    if (diffMs > 0) {
                        const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
                        const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                        const days = Math.floor(totalHours / 24);
                        const hours = totalHours % 24;
                        return `${days}D ${hours}H ${mins}M`;
                    }
                }
            }
        }

        // 备选方案：从网页 DOM 文本匹配 "expires in"
        await page.goto('https://www.pella.app/home', { waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(2000);
        const pageText = await page.evaluate(() => document.body.innerText || '');
        const match = pageText.match(/expires in\s+([0-9a-z\s]+)/i);
        if (match) {
            return match[1].trim();
        }
    } catch (e) {
        console.log(`⚠️ 获取剩余时间失败: ${e.message}`);
    }
    return '未知';
}

// ── 合并发送 Telegram 汇总通知 ──────────────────────────────
function sendSummaryTG(results) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) {
            console.log('⚠️ TG_BOT 未配置，跳过推送');
            return resolve();
        }
        const lines = [
            `🎮 Pella 自动续期汇总通知`,
            `🕐 运行时间: ${nowStr()}`,
            `──────────────────────────`,
        ];

        results.forEach((item, index) => {
            lines.push(`👤 账号 ${index + 1}: ${item.email}`);
            lines.push(`📊 结果: ${item.status}`);
            if (item.expiry) {
                lines.push(`⏳ 剩余时间: ${item.expiry}`);
            }
            if (item.extra) {
                lines.push(`ℹ️ 详情: ${item.extra}`);
            }
            if (index < results.length - 1) {
                lines.push(`──────────────────────────`);
            }
        });

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

// ── 广告拦截脚本 ─────────────────────────────────────────────
const AD_BLOCK_SCRIPT = `
(function() {
    'use strict';
    const blockedScriptDomains = ['madurird.com', 'crn77.com', 'fqjiujafk.com'];
    new MutationObserver(mutations => {
        mutations.forEach(m => {
            m.addedNodes.forEach(node => {
                if (node.tagName === 'SCRIPT' && node.src) {
                    if (blockedScriptDomains.some(d => node.src.includes(d))) {
                        node.remove();
                        console.log('[AdBlock] 已拦截广告脚本:', node.src);
                    }
                }
            });
        });
    }).observe(document.documentElement, { childList: true, subtree: true });

    function init() {
        window.open = () => null;
        document.addEventListener('click', e => {
            const a = e.target.closest('a');
            if (!a) return;
            const href = a.href || '';
            if (
                href.includes('crn77.com') ||
                href.includes('madurird.com') ||
                href.includes('tinyurl.com') ||
                href.includes('popads') ||
                href.includes('avnsgames.com') ||
                href.includes('fqjiujafk.com')
            ) {
                e.stopPropagation();
                e.preventDefault();
                console.log('[AdBlock] 拦截广告链接:', href);
            }
        }, true);

        function removeAds() {
            document.querySelector('#continue')?.removeAttribute('onclick');
            document.querySelector('#submit-button')?.removeAttribute('onclick');
            document.querySelector('#getnewlink')?.removeAttribute('onclick');
            document.querySelectorAll('[onclick*="crn77"],[onclick*="madurird"]').forEach(el => el.removeAttribute('onclick'));
            document.querySelectorAll([
                'a[href*="crn77.com"]', 'a[href*="madurird.com"]', 'a[href*="tinyurl.com"]',
                'a[href*="avnsgames.com"]', 'a[href*="popads"]', 'script[src*="madurird.com"]',
                'script[src*="fqjiujafk.com"]'
            ].join(',')).forEach(el => el.remove());

            document.querySelectorAll([
                'iframe[id*="netpub"]', 'div[id*="netpub_ins"]', 'div[id*="netpub_banner"]',
                'div[class*="eldhywa"]', 'iframe[height="0"]', 'iframe[style*="display: none"]'
            ].join(',')).forEach(el => el.remove());
        }
        removeAds();
        new MutationObserver(removeAds).observe(document.documentElement, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
`;

// ── CF Turnstile token 监听脚本 ─────────────────────────────
const CF_TOKEN_LISTENER_JS = `
(function() {
    if (window.__cf_token_listener_injected__) return;
    window.__cf_token_listener_injected__ = true;
    window.__cf_turnstile_token__ = '';
    window.addEventListener('message', function(e) {
        if (!e.origin || !e.origin.includes('cloudflare.com')) return;
        var d = e.data;
        if (!d || d.event !== 'complete' || !d.token) return;
        console.log('[TokenCapture] token length:', d.token.length);
        window.__cf_turnstile_token__ = d.token;
        var inputs = document.querySelectorAll('input[name="cf-turnstile-response"]');
        for (var i = 0; i < inputs.length; i++) {
            try {
                var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                nativeSet.call(inputs[i], d.token);
                inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
                inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
            } catch(err) { inputs[i].value = d.token; }
        }
    });
    console.log('[TokenCapture] listener injected');
})();
`;

function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).replace(/\//g, '-');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function xdotoolClick(x, y) {
    x = Math.round(x);
    y = Math.round(y);
    try {
        const wids = execSync('xdotool search --onlyvisible --class chrome', { timeout: 3000 })
            .toString().trim().split('\n').filter(Boolean);
        if (wids.length > 0) {
            execSync(`xdotool windowactivate ${wids[wids.length - 1]}`, { timeout: 2000, stdio: 'ignore' });
            execSync('sleep 0.2', { stdio: 'ignore' });
        }
        execSync(`xdotool mousemove ${x} ${y}`, { timeout: 2000 });
        execSync('sleep 0.15', { stdio: 'ignore' });
        execSync('xdotool click 1', { timeout: 2000 });
        console.log(`📐 xdotool 点击成功: (${x}, ${y})`);
        return true;
    } catch (e) {
        console.log(`⚠️ xdotool 点击失败：${e.message}`);
        return false;
    }
}

async function getWindowOffset(page) {
    try {
        const wids = execSync('xdotool search --onlyvisible --class chrome', { timeout: 3000 })
            .toString().trim().split('\n').filter(Boolean);
        if (wids.length > 0) {
            const geo = execSync(`xdotool getwindowgeometry --shell ${wids[wids.length - 1]}`, { timeout: 3000 }).toString();
            const geoDict = {};
            geo.trim().split('\n').forEach(line => {
                const [k, v] = line.split('=');
                if (k && v) geoDict[k.trim()] = parseInt(v.trim());
            });
            const winX = geoDict['X'] || 0;
            const winY = geoDict['Y'] || 0;
            const info = await page.evaluate('(function(){ return { outer: window.outerHeight, inner: window.innerHeight }; })()');
            let toolbar = info.outer - info.inner;
            if (toolbar < 30 || toolbar > 200) toolbar = 87;
            return { winX, winY, toolbar };
        }
    } catch (e) {}
    const info = await page.evaluate('(function(){ return { screenX: window.screenX||0, screenY: window.screenY||0, outer: window.outerHeight, inner: window.innerHeight }; })()');
    let toolbar = info.outer - info.inner;
    if (toolbar < 30 || toolbar > 200) toolbar = 87;
    return { winX: info.screenX, winY: info.screenY, toolbar };
}

async function getTurnstileCoords(page) {
    return await page.evaluate(`
        (function(){
            var container = document.querySelector('.cf-turnstile');
            if (container) {
                var rect = container.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    return { click_x: Math.round(rect.x + 368), click_y: Math.round(rect.y + rect.height / 2) };
                }
            }
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
                var src = iframes[i].src || '';
                if (src.includes('cloudflare') || src.includes('turnstile')) {
                    var rect = iframes[i].getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        return { click_x: Math.round(rect.x + 30), click_y: Math.round(rect.y + rect.height / 2) };
                    }
                }
            }
            return null;
        })()
    `);
}

async function checkCFToken(page) {
    try {
        const inputOk = await page.evaluate(`
            (function(){
                var input = document.querySelector('input[name="cf-turnstile-response"]');
                return input && input.value && input.value.length > 20;
            })()
        `);
        if (inputOk) return true;
    } catch (e) {}
    try {
        const token = await page.evaluate('window.__cf_turnstile_token__ || ""');
        if (token && token.length > 20) return true;
    } catch (e) {}
    return false;
}

async function solveTurnstile(page) {
    await page.evaluate(`
        (function() {
            var turnstileInput = document.querySelector('input[name="cf-turnstile-response"]');
            if (!turnstileInput) return;
            var el = turnstileInput;
            for (var i = 0; i < 20; i++) {
                el = el.parentElement;
                if (!el) break;
                var style = window.getComputedStyle(el);
                if (style.overflow === 'hidden') el.style.overflow = 'visible';
                el.style.minWidth = 'max-content';
            }
        })()
    `);

    await page.evaluate(CF_TOKEN_LISTENER_JS);
    console.log('📡 开始监控 Cloudflare Turnstile Token...');

    if (await checkCFToken(page)) {
        console.log('✅ 验证已自动通过');
        return true;
    }

    await page.evaluate(`
        var c = document.querySelector('.cf-turnstile');
        if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' });
    `);
    await sleep(1500);

    const coords = await getTurnstileCoords(page);
    if (!coords) {
        console.log('❌ 验证坐标获取失败');
        await page.screenshot({ path: 'turnstile_no_coords.png' });
        return false;
    }

    const { winX, winY, toolbar } = await getWindowOffset(page);
    const absX = coords.click_x + winX;
    const absY = coords.click_y + winY + toolbar;
    console.log('📐 坐标计算完成');
    xdotoolClick(absX, absY);

    for (let i = 0; i < 60; i++) {
        await sleep(500);
        if (await checkCFToken(page)) {
            const token = await page.evaluate('window.__cf_turnstile_token__ || ""');
            console.log(`✅ Cloudflare Turnstile 验证通过！token：${token.substring(0, 50)}...`);
            return true;
        }
    }

    console.log('❌ 人机验证超时');
    await page.screenshot({ path: 'turnstile_fail.png' });
    return false;
}

async function handleFitnesstipz(page) {
    console.log(`  📄 fitnesstipz 中转页: ${page.url()}`);
    try {
        await page.waitForSelector('p.getmylink', { timeout: 10000 });
        await page.click('p.getmylink');
        console.log('  ✅ 已点击 Continue... 触发倒计时');
    } catch (e) {
        console.log(`  ⚠️ getmylink 未找到：${e.message}`);
    }

    console.log('  ⏳ 等待倒计时结束...');
    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const timerVisible = await page.evaluate(`
            (function(){
                var el = document.querySelector('#newtimer');
                if (!el) return false;
                var style = window.getComputedStyle(el);
                return style.display !== 'none' && style.visibility !== 'hidden';
            })()
        `);
        if (!timerVisible) {
            console.log('  ✅ 倒计时结束');
            break;
        }
    }

    await sleep(1000);
    try {
        await page.click('span.wp2continuelink');
        console.log('  ✅ 已点击 wp2continuelink');
        await sleep(1500);
    } catch (e) {
        console.log(`  ⚠️ wp2continuelink 未找到：${e.message}`);
    }

    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await sleep(1000);

    try {
        await page.waitForSelector('#getnewlink', { timeout: 10000 });
        await page.click('#getnewlink');
        console.log('  ✅ 已点击 Get Link');
    } catch (e) {
        console.log(`  ❌ getnewlink 未找到：${e.message}`);
        await page.screenshot({ path: 'fitnesstipz_fail.png' });
        return false;
    }
    return true;
}

// ── 主测试：批量顺序处理并合并通知 ─────────────────────────
test('Pella 多账号自动续期（合并通知版）', async () => {
    if (accounts.length === 0) {
        throw new Error('❌ 未找到任何账号配置，请检查 PELLA_ACCOUNTS');
    }

    const summaryResults = []; // 存储所有账号运行结果

    for (const [email, secretVal] of accounts) {
        console.log(`\n===========================================`);
        console.log(`🚀 开始处理账号: ${email}`);
        console.log(`===========================================\n`);

        let proxyConfig = undefined;
        if (process.env.GOST_PROXY) {
            try {
                await new Promise((resolve, reject) => {
                    const req = http.request(
                        { host: '127.0.0.1', port: 8080, path: '/', method: 'GET', timeout: 3000 },
                        () => resolve()
                    );
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

        console.log('🔧 启动浏览器...');
        const browser = await chromium.launch({
            headless: false,
            proxy: proxyConfig,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        const context = await browser.newContext();
        await context.addInitScript(AD_BLOCK_SCRIPT);

        const isCookieLogin = secretVal.startsWith('cookie:') || secretVal.includes('__session');
        
        if (isCookieLogin) {
            console.log('🍪 检测到 Cookie 配置，注入 Cookie 实现免密登录...');
            const cookies = parseCookies(secretVal);
            await context.addCookies(cookies);
        }

        const page = await context.newPage();
        page.setDefaultTimeout(TIMEOUT);

        let currentToken = null;

        try {
            console.log('🌐 验证出口 IP...');
            try {
                const res = await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded' });
                const body = await res.text();
                const ip = JSON.parse(body).ip || body;
                console.log(`✅ 出口 IP 确认：${ip.replace(/(\d+\.\d+\.\d+\.)\d+/, '$1xx')}`);
            } catch {
                console.log('⚠️ IP 验证超时，跳过');
            }

            if (isCookieLogin) {
                console.log('🔑 打开 Pella 首页 (Cookie 免密模式)...');
                await page.goto('https://www.pella.app/home', { waitUntil: 'domcontentloaded' });
                await sleep(3000);

                let hasSession = false;
                for (let i = 0; i < 10; i++) {
                    hasSession = await page.evaluate('!!(window.Clerk && window.Clerk.session)');
                    if (hasSession) break;
                    await sleep(500);
                }

                if (!hasSession) {
                    throw new Error('Cookie 注入后未能生成有效 Session，请更新 Cookie！');
                }
                console.log(`✅ Cookie 免密登录成功！当前页面：${page.url()}`);
            } else {
                console.log('🔑 打开 Pella 登录页 (账号密码模式)...');
                await page.goto('https://www.pella.app/login', { waitUntil: 'domcontentloaded' });

                console.log('✏️ 填写邮箱...');
                await page.waitForSelector('#identifier-field', { timeout: 15000 });
                await page.fill('#identifier-field', email);

                console.log('📤 点击 Continue...');
                await page.click('span.cl-internal-2iusy0');
                await sleep(2000);

                console.log('✏️ 填写密码...');
                await page.waitForSelector('input[name="password"]', { timeout: 15000 });
                await page.fill('input[name="password"]', secretVal);

                console.log('📤 提交登录...');
                await page.click('span.cl-internal-2iusy0');

                console.log('⏳ 等待登录跳转...');
                await page.waitForURL(/pella\.app\/(home|dashboard)/, { timeout: 30000 });
                console.log(`✅ 登录成功！当前：${page.url()}`);
            }

            console.log('⏳ 等待 Clerk session...');
            for (let i = 0; i < 20; i++) {
                const ready = await page.evaluate('!!(window.Clerk && window.Clerk.session)');
                if (ready) break;
                await sleep(500);
            }

            // 抓取并存回最新 Cookie
            try {
                const latestCookies = await context.cookies(['https://www.pella.app', 'https://clerk.pella.app']);
                const cookieStr = latestCookies.map(c => `${c.name}=${c.value}`).join('; ');
                if (cookieStr.includes('__client') && cookieStr.includes('__session')) {
                    updateSavedAccountSecret(email, `cookie:${cookieStr}`);
                }
            } catch (err) {
                console.log(`⚠️ 抓取最新 Cookie 失败: ${err.message}`);
            }

            console.log('🔑 获取 JWT token...');
            currentToken = await page.evaluate('window.Clerk && window.Clerk.session ? window.Clerk.session.getToken() : null');
            if (!currentToken) throw new Error('无法获取 Clerk token');

            console.log('🔍 获取服务器续期链接...');
            const serversRes = await page.evaluate(async (t) => {
                const res = await fetch('https://api.pella.app/user/servers', {
                    headers: { 'Authorization': `Bearer ${t}` }
                });
                return await res.json();
            }, currentToken);

            const servers = serversRes.servers || [];
            if (servers.length === 0) throw new Error('未找到服务器');

            let renewLink = null;
            for (const server of servers) {
                const unclaimed = (server.renew_links || []).filter(l => l.claimed === false);
                if (unclaimed.length > 0) {
                    renewLink = unclaimed[0].link;
                    console.log(`✅ 找到续期链接: ${renewLink} (服务器 ${server.ip})`);
                    break;
                }
            }

            if (!renewLink) {
                const expiryTime = await fetchExpiryTime(page, currentToken);
                summaryResults.push({
                    email,
                    status: '⚠️ 无可用续期链接，今日已续期或暂不需要续期',
                    expiry: expiryTime
                });
                console.log('⚠️ 无可用续期链接');
                await browser.close();
                continue;
            }

            console.log(`🌐 访问广告链接: ${renewLink}`);
            await page.goto(renewLink, { waitUntil: 'domcontentloaded' });
            await sleep(3000);

            const hasTurnstile = await page.evaluate('!!document.querySelector("input[name=\'cf-turnstile-response\']")');
            if (hasTurnstile) {
                console.log('🛡️ 检测到 CF Turnstile，开始处理...');
                const cfOk = await solveTurnstile(page);
                if (!cfOk) throw new Error('CF Turnstile 验证失败');
            }

            console.log('📤 点击 Continue...');
            try {
                await page.waitForSelector('#continue', { timeout: 10000 });
                await page.click('#continue');
                await sleep(3000);
            } catch (e) {
                console.log(`⚠️ #continue 未找到：${e.message}`);
            }

            let loopCount = 0;
            while (page.url().includes('fitnesstipz.com') && loopCount < 5) {
                loopCount++;
                console.log(`🔄 处理第 ${loopCount} 个中转页...`);
                const ok = await handleFitnesstipz(page);
                if (!ok) throw new Error('中转页处理失败');
                await sleep(3000);
            }

            if (page.url().includes('tpi.li')) {
                console.log('⏳ 等待 tpi.li 倒计时...');
                for (let i = 0; i < 60; i++) {
                    await sleep(1000);
                    const timerText = await page.evaluate(`
                        (function(){
                            var el = document.querySelector('#timer');
                            return el ? el.textContent.trim() : '0';
                        })()
                    `);
                    if ((parseInt(timerText) || 0) <= 0) break;
                }

                console.log('🔍 获取 renew 链接...');
                const renewHref = await page.evaluate(`
                    (function(){
                        var a = document.querySelector('a.btn.btn-success.btn-lg.get-link');
                        return a ? a.href : null;
                    })()
                `);

                if (!renewHref || !renewHref.includes('/renew/')) {
                    await page.screenshot({ path: `no_renew_href_${email}.png` });
                    throw new Error('未找到有效 renew 链接: ' + renewHref);
                }

                console.log(`✅ 找到 renew 链接: ${renewHref}`);
                await page.click('a.btn.btn-success.btn-lg.get-link');
                await sleep(3000);
            }

            console.log('⏳ 等待续期完成...');
            try {
                await page.waitForURL(/pella\.app\/renew\//, { timeout: 15000 });
            } catch {
                console.log(`⚠️ 未检测到 renew 跳转，当前: ${page.url()}`);
            }

            const finalUrl = page.url();
            console.log(`📄 最终地址: ${finalUrl}`);
            await page.screenshot({ path: `final_result_${email}.png` });

            // 续期后刷新获取最新的剩余时间
            const latestExpiryTime = await fetchExpiryTime(page, currentToken);

            if (finalUrl.includes('/renew/')) {
                console.log('🎉 续期成功！');
                summaryResults.push({
                    email,
                    status: '✅ 续期成功！',
                    expiry: latestExpiryTime
                });
            } else {
                summaryResults.push({
                    email,
                    status: '⚠️ 续期结果未知',
                    expiry: latestExpiryTime,
                    extra: `🔗 ${finalUrl}`
                });
            }

        } catch (e) {
            await page.screenshot({ path: `error_${email}.png` }).catch(() => {});
            summaryResults.push({
                email,
                status: `❌ 脚本异常: ${e.message}`,
                expiry: '获取失败'
            });
        } finally {
            await browser.close();
        }
    }

    // ── 所有账号完成后，统一发送 1 条 Telegram 汇总通知 ───────
    await sendSummaryTG(summaryResults);
});
