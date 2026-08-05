// ── 智能判断是否需要重启（精准抓取 CONSOLE） ────────────────
async function needRestart(page, token, serverId, apiStatus) {
    const status = (apiStatus || '').toLowerCase();
    if (status && status !== 'running' && status !== 'online') {
        console.log(`⚠️ API 状态为 "${apiStatus}"，需要重启`);
        return true;
    }

    try {
        const overviewUrl = `https://www.pella.app/server/${serverId}/overview`;
        console.log(`🔍 检查 CONSOLE: ${overviewUrl}`);
        await page.goto(overviewUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(5000); // 多等一会让日志加载

        // 精准提取 CONSOLE 日志内容
        const consoleText = await page.evaluate(() => {
            // 1. 优先找带 Copy 按钮附近的日志区域
            const copyButtons = Array.from(document.querySelectorAll('button, div, span')).filter(el => 
                (el.innerText || '').trim().toLowerCase() === 'copy'
            );
            
            for (const btn of copyButtons) {
                // 向上找父级，找包含大量日志文字的容器
                let parent = btn.parentElement;
                for (let i = 0; i < 5 && parent; i++) {
                    const t = (parent.innerText || '').trim();
                    if (t.length > 80 && (
                        t.includes('is running') || 
                        t.includes('Komari') || 
                        t.includes('ARGO_DOMAIN') ||
                        t.includes('Download') ||
                        t.includes('Empowerment') ||
                        t.includes('WebSocket') ||
                        t.includes('starting')
                    )) {
                        return t;
                    }
                    parent = parent.parentElement;
                }
            }

            // 2. 找所有 pre 或黑色背景的日志容器
            const candidates = document.querySelectorAll('pre, [class*="console"], [class*="log"], [class*="terminal"]');
            for (const el of candidates) {
                const t = (el.innerText || '').trim();
                if (t.length > 50) return t;
            }

            // 3. 遍历所有元素，找最像日志的内容（排除导航）
            let best = '';
            const all = document.querySelectorAll('div, pre, section, code');
            for (const el of all) {
                const t = (el.innerText || '').trim();
                if (t.length < 60) continue;
                
                // 强力排除导航菜单
                if (t.includes('Overview') && t.includes('Manage') && t.includes('Files')) continue;
                if (t.includes('pending start restart')) continue;
                if (t.includes('join our discord')) continue;
                if (t.includes('TIRED OF RENEWALS')) continue;

                const score = (
                    (t.includes('is running') ? 10 : 0) +
                    (t.includes('ARGO_DOMAIN') ? 10 : 0) +
                    (t.includes('Komari') ? 10 : 0) +
                    (t.includes('Empowerment') ? 8 : 0) +
                    (t.includes('Download') ? 5 : 0) +
                    (t.includes('WebSocket') ? 5 : 0) +
                    (t.includes('starting') ? 3 : 0) +
                    (t.includes('Private Key') ? 5 : 0)
                );

                if (score > 0 && t.length > best.length) {
                    best = t;
                }
            }
            return best;
        }).catch(() => '');

        const text = (consoleText || '').toLowerCase();
        const preview = text.substring(0, 200).replace(/\n/g, ' ');
        console.log(`CONSOLE 预览: ${preview || '(完全为空)'}...`);

        // ========== 健康特征 ==========
        const healthySignals = [
            'is running',           // outlook
            'php is running',
            'web is running',
            'bot is running',
            'app is running',
            'argo_domain',
            'empowerment success',
            'private key',
            'public key',
            'komari',               // gmail
            'get ipv4 success',
            'websocket',
            'failed to connect to websocket',
            'download'
        ];

        const hasHealthy = healthySignals.some(sig => text.includes(sig));

        if (hasHealthy) {
            console.log('✅ 检测到正常运行日志，无需重启');
            return false;
        }

        // ========== 需要重启 ==========
        if (text.trim().length < 50) {
            console.log('⚠️ CONSOLE 内容为空或过短，需要重启');
            return true;
        }

        if ((text.includes('starting') || text.includes('正在启动')) && !hasHealthy) {
            console.log('⚠️ CONSOLE 只有 starting，需要重启');
            return true;
        }

        console.log('ℹ️ 未匹配到明确健康特征，默认不重启');
        return false;

    } catch (e) {
        console.log(`检查 CONSOLE 失败: ${e.message}，默认不重启`);
        return false;
    }
}
