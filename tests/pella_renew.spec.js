// ── 智能判断是否需要重启（保守策略） ───────────────────────
async function needRestart(page, token, serverId, apiStatus) {
    const status = (apiStatus || '').toLowerCase();
    
    // 1. API 状态明确不正常 → 重启
    if (status && status !== 'running' && status !== 'online') {
        console.log(`⚠️ API 状态为 "${apiStatus}"，需要重启`);
        return true;
    }

    try {
        const overviewUrl = `https://www.pella.app/server/${serverId}/overview`;
        console.log(`🔍 检查 CONSOLE: ${overviewUrl}`);
        await page.goto(overviewUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await sleep(8000); // 多等动态日志

        // 尝试提取
        const consoleText = await page.evaluate(() => {
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
                    if (t.length > 15) return t;
                }
            }
            return '';
        }).catch(() => '');

        const text = (consoleText || '').toLowerCase();
        const preview = text.substring(0, 200).replace(/\n/g, ' ');
        console.log(`CONSOLE 预览: ${preview || '(空)'}...`);

        // 健康特征
        const healthySignals = [
            'is running', 'php is running', 'web is running', 'bot is running',
            'argo_domain', 'empowerment', 'private key', 'komari',
            'get ipv4', 'websocket', 'download'
        ];

        const hasHealthy = healthySignals.some(sig => text.includes(sig));

        if (hasHealthy) {
            console.log('✅ 检测到正常运行日志，无需重启');
            return false;
        }

        // 只有在明确只有 starting，且内容很短时才重启
        if (text.includes('starting') && text.length < 100 && !hasHealthy) {
            console.log('⚠️ 明确只有 starting，需要重启');
            return true;
        }

        // 内容完全为空时，也倾向于不重启（自动化环境经常抓不到动态日志）
        if (!text || text.length < 20) {
            console.log('ℹ️ CONSOLE 提取为空（可能是动态加载），默认不重启');
            // 可选：保存截图方便排查
            try {
                await page.screenshot({ path: `console_empty_${serverId.slice(-6)}_${Date.now()}.png`, fullPage: false });
            } catch (e) {}
            return false;
        }

        console.log('ℹ️ 未匹配到明确需要重启的特征，跳过重启');
        return false;

    } catch (e) {
        console.log(`检查 CONSOLE 失败: ${e.message}，默认不重启`);
        return false;
    }
}
