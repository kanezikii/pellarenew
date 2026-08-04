# 🎮 Pella 自动续期

使用 Playwright + GitHub Actions 每天自动续期 Pella 免费服务器。

## ⚙️ 配置步骤

### 1️⃣ Fork 或上传此仓库到 GitHub

### 2️⃣ 添加 Secrets

进入仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**：

| 🔑 Secret 名称 | 📝 格式 | ✅ 必填 |
|---|---|---|
| `PELLA_ACCOUNT` | `email,password` | ✅ |
| `TG_BOT` | `chat_id,bot_token` | ✅ |
| `GOST_PROXY` | `socks5://host:port` | 可选 |

### 3️⃣ 启用 Actions

进入 **Actions** 标签页，点击 **Enable GitHub Actions**。

### 4️⃣ 手动触发测试

**Actions** → **🎮 Pella 自动续期** → **Run workflow**

## 🕐 运行时间

每天 **UTC 01:00**（北京时间 09:00）自动运行。

可在 `.github/workflows/pella_renew.yml` 的 `cron` 表达式中修改。

## 📊 续期结果说明

| 状态 | 说明 |
|---|---|
| ✅ passed | 续期成功，TG 已推送通知 |
| ⚠️ 无可用链接 | 今日已续期或暂不需要续期 |
| ❌ failed | 登录失败或脚本异常，查看 debug-screenshots |
