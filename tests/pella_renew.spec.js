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

// ── 精准从 UI 提取 EXPIRY 倒计时字符串 (大幅增强版) ────────
async function fetchExpiryTimeFromUI(page, serverId) {
    try {
        // 优先使用 /overview 路径（手动截图确认这是完整面板）
        const targetUrl = serverId
            ? `https://www.pella.app/server/${serverId}/overview`
            : 'https://www.pella.app/home';

        console.log(`🔍 打开页面读取 EXPIRY 时间: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {
            console.log('⚠️ networkidle 超时，继续尝试...');
        });
        await sleep(6000);

        // 滚动到底部，触发懒加载
        await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
            window.scrollTo(0, 0);
        });
        await sleep(2000);

        // 主动等待 expires 文字出现（最多再等 20 秒）
        try {
            await page.waitForFunction(() => {
                const t = (document.body.innerText || '').toLowerCase();
                return t.includes('expires') || t.includes('expiry') || /\d+\s*[dh]\s*\d+\s*[hm]/.test(t);
            }, { timeout: 20000 });
            console.log('✅ 检测到 expires 相关文本');
        } catch (e) {
            console.log('⚠️ 等待 expires 文本超时，继续尝试提取...');
        }

        await sleep(2000);

        const result = await page.evaluate(() => {
            const bodyText = (document.body.innerText || '').replace(/\s+/g, ' ').trim();

            // 主匹配（与手动截图完全一致）
            let match = bodyText.match(/Your server expires in\s*([0-9]+\s*[Dd]\s*[0-9]+\s*[Hh]\s*[0-9]+\s*[Mm])/i);
            if (match) return { expiry: match[1].replace(/\s+/g, ' ').trim(), snippet: bodyText.substring(0, 800) };

            // 备用宽松匹配
            match = bodyText.match(/expires?\s+in\s*([0-9]+\s*[Dd]\s*[0-9]+\s*[Hh]\s*[0-9]+\s*[Mm])/i);
            if (match) return { expiry: match[1].replace(/\s+/g, ' ').trim(), snippet: bodyText.substring(0, 800) };

            match = bodyText.match(/([0-9]+\s*[Dd]\s*[0-9]+\s*[Hh]\s*[0-9]+\s*[Mm])/);
            if (match) return { expiry: match[1].replace(/\s+/g, ' ').trim(), snippet: bodyText.substring(0, 800) };

            // 遍历所有元素，找包含 expires 的节点
            const all = document.querySelectorAll('div, p, span, section');
            for (const el of all) {
                const txt = (el.innerText || '').trim();
                if (txt.toLowerCase().includes('expires in') && txt.length < 120) {
                    const m = txt.match(/([0-9]+\s*[Dd]\s*[0-9]+\s*[Hh]\s*[0-9]+\s*[Mm])/i);
                    if (m) return { expiry: m[1].replace(/\s+/g, ' ').trim(), snippet: txt };
                }
            }

            return { expiry: null, snippet: bodyText.substring(0, 800) };
        });

        if (result.expiry) {
            console.log(`⏳ 成功获取剩余时间: ${result.expiry}`);
            return result.expiry;
        } else {
            console.log(`⚠️ 未匹配到 EXPIRY 文本，页面片段：${result.snippet}`);
            await page.screenshot({ path: `expiry_fail_${Date.now()}.png` }).catch(() => {});
            return '未获取到时间';
        }
    } catch (e) {
        console.log(`⚠️ 读取 EXPIRY 文本异常: ${e.message}`);
        return '读取失败';
    }
}

// ── 发送 Telegram 汇总通知 ──────────────────────────────────
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
    console.log(` 📄 fitnesstipz 中转页: ${page.url()}`);
    try {
        await page.waitForSelector('p.getmylink', { timeout: 10000 });
        await page.click('p.getmylink');
        console.log(' ✅ 已点击 Continue... 触发倒计时');
    } catch (e) {
        console.log(` ⚠️ getmylink 未找到：${e.message}`);
    }
    console.log(' ⏳ 等待倒计时结束...');
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
            console.log(' ✅ 倒计时结束');
            break;
        }
    }
    await sleep(1000);
    try {
        await page.click('span.wp2continuelink');
        console.log(' ✅ 已点击 wp2continuelink');
        await sleep(1500);
    } catch (e) {
        console.log(` ⚠️ wp2continuelink 未找到：${e.message}`);
    }
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await sleep(1000);
    try {
        await page.waitForSelector('#getnewlink', { timeout: 10000 });
        await page.click('#getnewlink');
        console.log(' ✅ 已点击 Get Link');
    } catch (e) {
        console.log(` ❌ getnewlink 未找到：${e.message}`);
        await page.screenshot({ path: 'fitnesstipz_fail.png' });
        return false;
    }
    return true;
}

// ── 主测试 ──────────────────────────────────────────────────
test('Pella 多账号自动续期（支持内部Claiming + 外部广告 + 强力EXPIRY）', async () => {
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
        let serverId = null;
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
            // 抓取并写回最新 Cookie
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
            const token = await page.evaluate('window.Clerk && window.Clerk.session ? window.Clerk.session.getToken() : null');
            if (!token) throw new Error('无法获取 Clerk token');
            console.log('🔍 获取服务器信息...');
            const serversRes = await page.evaluate(async (t) => {
                const res = await fetch('https://api.pella.app/user/servers', {
                    headers: { 'Authorization': `Bearer ${t}` }
                });
                return await res.json();
            }, token);
            const servers = serversRes.servers || [];
            if (servers.length === 0) throw new Error('未找到服务器');
            serverId = servers[0].id || servers[0]._id || null;
            console.log(`🖥️ 服务器 ID: ${serverId}`);

            // 1. 从 API 获取未认领链接
            const apiLinks = [];
            for (const server of servers) {
                const unclaimed = (server.renew_links || []).filter(l => l.claimed === false);
                for (const item of unclaimed) {
                    if (item.link) apiLinks.push(item.link);
                }
            }
            // 2. 从 UI 抓取 Claim 按钮
            const targetServerUrl = serverId ? `https://www.pella.app/server/${serverId}/overview` : 'https://www.pella.app/home';
            await page.goto(targetServerUrl, { waitUntil: 'domcontentloaded' });
            await sleep(4000);
            const uiLinks = await page.evaluate(() => {
                const found = [];
                document.querySelectorAll('a').forEach(a => {
                    const txt = a.innerText || '';
                    if ((txt.includes('Claim') || txt.includes('16 Hours')) && a.href && a.href.includes('/renew/')) {
                        found.push(a.href);
                    }
                });
                return found;
            });
            const allUnclaimedLinks = Array.from(new Set([...uiLinks, ...apiLinks]));
            if (allUnclaimedLinks.length === 0) {
                const expiryTime = await fetchExpiryTimeFromUI(page, serverId);
                summaryResults.push({
                    email,
                    status: '⚠️ 无可用续期链接，今日已续期',
                    expiry: expiryTime
                });
                console.log('⚠️ 无可用续期链接');
                await browser.close();
                continue;
            }
            console.log(`📋 检测到 ${allUnclaimedLinks.length} 个未认领的续期链接，开始循环处理...`);
            let successCount = 0;

            for (let i = 0; i < allUnclaimedLinks.length; i++) {
                const renewLink = allUnclaimedLinks[i];
                console.log(`\n🌐 [${i + 1}/${allUnclaimedLinks.length}] 处理链接: ${renewLink}`);

                await page.goto(renewLink, { waitUntil: 'domcontentloaded' });
                await sleep(4000);

                // 检查当前页面状态
                const initialText = await page.evaluate(() => (document.body.innerText || '').substring(0, 300));
                console.log(`📄 当前页面文本片段: ${initialText.replace(/\n/g, ' ')}`);

                let claimSuccess = false;

                // ========== 模式1：内部 Claiming... 流程 ==========
                if (initialText.includes('Claiming') || page.url().includes('/renew/')) {
                    console.log('🔄 检测到内部 Claiming... 流程，开始耐心等待完成（最多90秒）...');
                    await page.screenshot({ path: `claiming_start_${email.replace(/[^a-z0-9]/gi, '_')}_${i}.png` }).catch(() => {});

                    for (let t = 0; t < 90; t++) {
                        await sleep(1000);
                        const curUrl = page.url();
                        const text = await page.evaluate(() => (document.body.innerText || '').substring(0, 400));

                        // 成功标志：不再显示 Claiming，或跳转到 server/home，或出现 expires / Claimed
                        const noLongerClaiming = !text.includes('Claiming');
                        const backToServer = curUrl.includes('/server/') || curUrl.includes('/home') || curUrl.includes('/overview');
                        const hasSuccessHint = text.toLowerCase().includes('expires') || text.includes('Claimed') || text.includes('success');

                        if ((noLongerClaiming && (backToServer || hasSuccessHint)) || (backToServer && hasSuccessHint)) {
                            console.log(`🎉 内部 Claiming 流程成功完成！用时约 ${t + 1} 秒，当前URL: ${curUrl}`);
                            claimSuccess = true;
                            successCount++;
                            break;
                        }

                        // 每 8 秒尝试点击可能的按钮
                        if (t > 0 && t % 8 === 0) {
                            await page.evaluate(() => {
                                document.querySelectorAll('button, a, [role="button"], .btn').forEach(el => {
                                    const t = (el.innerText || el.textContent || '').toLowerCase();
                                    if (t.includes('continue') || t.includes('claim') || t.includes('get') || t.includes('confirm')) {
                                        try { el.click(); } catch (e) {}
                                    }
                                });
                            }).catch(() => {});
                        }
                    }

                    if (!claimSuccess) {
                        console.log('⚠️ 内部 Claiming 流程超时（90秒）');
                        await page.screenshot({ path: `claiming_timeout_${email.replace(/[^a-z0-9]/gi, '_')}_${i}.png` }).catch(() => {});
                    }
                }
                // ========== 模式2：外部广告短链流程（兼容旧逻辑） ==========
                else {
                    console.log('⏳ 未检测到 Claiming，尝试外部广告跳转流程...');
                    let adDomainVisited = false;

                    for (let waitSec = 0; waitSec < 25; waitSec++) {
                        const curUrl = page.url();
                        if (
                            curUrl.includes('tpi.li') ||
                            curUrl.includes('fitnesstipz.com') ||
                            curUrl.includes('madurird.com') ||
                            curUrl.includes('crn77.com') ||
                            (!curUrl.includes('pella.app') && !curUrl.includes('about:blank'))
                        ) {
                            console.log(`✅ 已跳转至外部短链/广告页: ${curUrl}`);
                            adDomainVisited = true;
                            break;
                        }
                        await page.evaluate(() => {
                            const candidates = [...document.querySelectorAll('a, button, [role="button"], .btn')];
                            for (const el of candidates) {
                                const txt = (el.innerText || '').toLowerCase();
                                const href = el.href || '';
                                if (txt.includes('claim') || txt.includes('continue') || txt.includes('get link') ||
                                    href.includes('tpi.li') || href.includes('fitnesstipz')) {
                                    try { el.click(); } catch (e) {}
                                }
                            }
                        }).catch(() => {});
                        await sleep(1000);
                    }

                    if (adDomainVisited) {
                        // 处理 CF / fitnesstipz / tpi.li（原有逻辑）
                        const hasTurnstile = await page.evaluate('!!document.querySelector("input[name=\'cf-turnstile-response\']")');
                        if (hasTurnstile) {
                            console.log('🛡️ 检测到 CF Turnstile...');
                            const cfOk = await solveTurnstile(page);
                            if (!cfOk) {
                                console.log(`❌ CF 验证失败`);
                                continue;
                            }
                        }

                        if (page.url().includes('tpi.li') || page.url().includes('fitnesstipz')) {
                            try {
                                await page.waitForSelector('#continue', { timeout: 8000 });
                                await page.click('#continue');
                                await sleep(3000);
                            } catch (e) {}
                        }

                        let loopCount = 0;
                        while (page.url().includes('fitnesstipz.com') && loopCount < 5) {
                            loopCount++;
                            const ok = await handleFitnesstipz(page);
                            if (!ok) break;
                            await sleep(3000);
                        }

                        if (page.url().includes('tpi.li')) {
                            for (let k = 0; k < 60; k++) {
                                await sleep(1000);
                                const timerText = await page.evaluate(`(() => {
                                    const el = document.querySelector('#timer');
                                    return el ? el.textContent.trim() : '0';
                                })()`);
                                if ((parseInt(timerText) || 0) <= 0) break;
                            }
                            try {
                                await page.click('a.btn.btn-success.btn-lg.get-link');
                                await sleep(3000);
                            } catch (e) {}
                        }

                        // 等待返回 pella
                        for (let waitSec = 0; waitSec < 20; waitSec++) {
                            await sleep(1000);
                            const curUrl = page.url();
                            if (curUrl.includes('pella.app') && !curUrl.includes('tpi.li') && !curUrl.includes('fitnesstipz')) {
                                console.log(`🎉 外部广告流程续期成功！`);
                                claimSuccess = true;
                                successCount++;
                                break;
                            }
                        }
                    } else {
                        console.log('⚠️ 既没有 Claiming 也没有跳转外部广告，标记失败');
                        await page.screenshot({ path: `no_claim_no_ad_${email.replace(/[^a-z0-9]/gi, '_')}_${i}.png` }).catch(() => {});
                    }
                }

                if (!claimSuccess) {
                    console.log(`❌ 第 ${i + 1} 个链接最终未成功认领`);
                }
            }

            // 最终读取 EXPIRY
            const latestExpiryTime = await fetchExpiryTimeFromUI(page, serverId);
            await page.screenshot({ path: `final_result_${email.replace(/[^a-z0-9]/gi, '_')}.png` });
            summaryResults.push({
                email,
                status: `✅ 续期完成 (成功 ${successCount}/${allUnclaimedLinks.length} 个链接)`,
                expiry: latestExpiryTime
            });
        } catch (e) {
            await page.screenshot({ path: `error_${email.replace(/[^a-z0-9]/gi, '_')}.png` }).catch(() => {});
            const latestExpiryTime = await fetchExpiryTimeFromUI(page, serverId).catch(() => '读取失败');
            summaryResults.push({
                email,
                status: `❌ 脚本异常: ${e.message}`,
                expiry: latestExpiryTime
            });
        } finally {
            await browser.close();
        }
    }
    await sendSummaryTG(summaryResults);
});
