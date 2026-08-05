// ── 智能判断是否需要重启（从首页重新进入服务） ───────────────
async function needRestart(page, serverId, apiStatus) {
    const status = (apiStatus || '').toLowerCase();
    
    if (status && status !== 'running' && status !== 'online') {
        console.log(`⚠️ API 状态为 "${apiStatus}"，需要重启`);
        return true;
    }

    try {
        // 1. 先回到首页
        console.log('🏠 先进入首页 https://www.pella.app/home');
        await page.goto('https://www.pella.app/home', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(3000);

        // 2. 再进入具体服务
        const targetUrl = `https://www.pella.app/server/${serverId}`;
        console.log(`🔍 重新进入服务: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        
        await sleep(5000);
        console.log('⏳ 额外等待 5 秒，确保 CONSOLE 加载完成...');
        await sleep(5000);

        const pageInfo = await page.evaluate(() => {
            const bodyText = (document.body.innerText || '').toLowerCase();
            
            const hasPending = bodyText.includes('pending');
            const hasStartBtn = Array.from(document.querySelectorAll('button')).some(btn => 
                (btn.innerText || '').trim().toUpperCase() === 'START'
            );

            // 提取 CONSOLE 内容
            let consoleText = '';
            const selectors = [
                'pre.relative.h-full.overflow-auto',
                'pre.bg-black',
                'pre.relative.h-full',
                'pre'
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) {
                    const t = (el.innerText || el.textContent || '').trim();
                    if (t.length > 10) {
                        consoleText = t;
                        break;
                    }
                }
            }

            return { hasPending, hasStartBtn, consoleText };
        });

        const text = (pageInfo.consoleText || '').toLowerCase();
        const preview = text.substring(0, 220).replace(/\n/g, ' ');
        console.log(`CONSOLE 预览: ${preview || '(空)'}...`);
        console.log(`页面检测 → PENDING: ${pageInfo.hasPending}, START按钮: ${pageInfo.hasStartBtn}`);

        // 健康关键词（非 start 的正常运行日志）
        const healthyKeywords = [
            'is running',
            'php is running',
            'web is running',
            'bot is running',
            'app is running',
            'argo_domain',
            'empowerment',
            'private key',
            'public key',
            'komari',
            'get ipv4',
            'websocket',
            'download',
            'failed to connect',
            'retrying',
            'max retries reached'
        ];

        const hasNonStartLog = healthyKeywords.some(k => text.includes(k));

        // 有非 start 的正常日志 → 不重启
        if (hasNonStartLog) {
            console.log('✅ CONSOLE 存在非 start 的正常日志，无需重启');
            return false;
        }

        // 页面显示 PENDING 或 START 按钮 → 重启
        if (pageInfo.hasPending || pageInfo.hasStartBtn) {
            console.log('⚠️ 页面显示 PENDING 或 START 按钮，需要重启');
            return true;
        }

        // CONSOLE 为空
        if (!text || text.length < 15) {
            console.log('⚠️ CONSOLE 为空，需要重启');
            return true;
        }

        // 只有 start 相关
        if (text.includes('start') && !hasNonStartLog) {
            console.log('⚠️ CONSOLE 只有 start 相关内容，需要重启');
            return true;
        }

        console.log('ℹ️ 默认不重启');
        return false;

    } catch (e) {
        console.log(`检查失败: ${e.message}，默认不重启`);
        return false;
    }
}
