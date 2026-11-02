# Bypass Paywalls Clean：Safari 版

这个目录把仓库根目录里的 Chrome 版发布包（`bypass-paywalls-chrome-clean-master.zip`）构建成 Safari Web Extension，原始发布文件不做任何改动。

> **当前状态**：构建脚本和兼容层已在模拟的 Safari 环境中通过测试，CI 也能用 Xcode 打包出 macOS/iOS 应用；但**还没有在真实的 Safari 里实际验证过**，第一次安装后请按文末的「验证清单」检查一遍。

## 系统要求

- macOS 上的 Safari 16.4 或更新版本（需要 declarativeNetRequest 修改请求头的能力），建议使用 Safari 18.4 以上
- 生成 `.app` 需要 Xcode；只想临时试用、且 Safari 较新时，可以不用 Xcode（见方式 A）
- 构建脚本需要 Node.js 18+ 和 `unzip`（macOS 自带）

## 1. 构建扩展目录

```bash
node safari/build.mjs
```

产物在 `build/safari/extension/`。加 `--zip` 参数会额外生成 `build/safari/bypass-paywalls-clean-safari-<版本>.zip`。

## 2. 安装

### 方式 A：临时加载（新版 Safari，无需 Xcode）

较新的 Safari（26 及以后）可以直接加载扩展目录：

1. Safari → 设置 → 高级 → 勾选「显示网页开发者功能」
2. 设置里出现「开发者」标签页 → 允许未签名的扩展 → 点「Add Temporary Extension…」（添加临时扩展）
3. 选择 `build/safari/extension` 文件夹

临时扩展在 Safari 退出后会被移除，适合先试用。如果你的 Safari 没有这个按钮，请用方式 B 或 C。

### 方式 B：用 Xcode 在本机构建（推荐长期使用）

```bash
safari/xcode/convert.sh
```

```bash
open build/safari/xcode/*/*.xcodeproj
```

转换时 Xcode 16 会提示 `persistent` 是「不支持的键」，可以忽略：iOS 只能运行非常驻的后台页，所以 manifest 里特意显式写了 `"persistent": false`，这本来也是 MV3 的默认值。

在 Xcode 里选择「(macOS)」scheme，目标选 My Mac，点 Run。如果没有付费开发者账号，签名选「Sign to Run Locally」，然后在 Safari 的开发者设置里打开「允许未签名的扩展」。这个开关每次重启 Safari 都要重新打开，用付费账号签名后就不需要了。

最后到 Safari → 设置 → 扩展，勾选 Bypass Paywalls Clean。

### 方式 C：下载 CI 打包好的 macOS 应用

GitHub Actions 的「Safari extension」工作流会上传以下产物（在仓库的 Actions 页面打开某次运行，在页面底部的 Artifacts 里下载，保留 90 天）：

- `safari-macos-app`：ad-hoc 签名的 `Bypass Paywalls Clean.app`
- `safari-ios-ipa-unsigned`：未签名的 iOS/iPadOS 安装包（`.ipa`），用法见下方「iOS / iPadOS」
- `safari-xcode-project`：生成好的 Xcode 工程（macOS + iOS）
- `safari-extension`：扩展目录的 zip

下载并解压 `safari-macos-app` 后，执行：

```bash
xattr -dr com.apple.quarantine "Bypass Paywalls Clean.app"
```

把应用移到「应用程序」文件夹并打开一次，再在 Safari 里打开「允许未签名的扩展」，然后到「设置 → 扩展」里启用它。

### iOS / iPadOS

需要 iOS/iPadOS 16.4 或更新版本。iOS 只能安装签过名的 App，所以下面两种方式都要用你自己的 Apple ID 或开发者证书签名。免费 Apple ID 的签名 7 天后过期，每台设备最多同时装约 3 个这样签名的 App；这个 App 带一个扩展，很可能占其中 2 个。

**用 CI 生成的 ipa（不需要 Mac）**

1. 从 GitHub Actions 下载 `safari-ios-ipa-unsigned`，解压得到 `Bypass-Paywalls-Clean-unsigned.ipa`（未签名）
2. 用 [Sideloadly](https://sideloadly.io/)（Windows/macOS）或 AltStore / SideStore 安装：选这个 ipa，登录你的 Apple ID，工具会签名并装到设备上。**不要选「移除 App 扩展」**：扩展就是 Safari 插件本身；AltStore 问是否保留扩展时选保留
3. iOS 16 及以上需先打开 设置 → 隐私与安全性 → 开发者模式
4. 7 天后签名过期，重新用工具安装一遍（Sideloadly 和 AltStore 都支持续签）

如果你有付费开发者账号，也可以用自己的证书和描述文件给 ipa 重签名（App 和扩展的 bundle ID 各需要一个描述文件）。

**用 Xcode**

用 Xcode 打开 `safari-xcode-project`（或方式 B 生成的工程），选择「(iOS)」scheme，选你的设备和 Apple ID 账号，点 Run。

装好后先打开一次 App，再到 设置 → App → Safari → 扩展 里启用 Bypass Paywalls Clean，并把「所有网站」设为允许。

本地生成未签名 ipa（需要 Mac + Xcode）：

```bash
safari/xcode/build-app.sh build/safari/xcode ios build/safari/dd
```

```bash
safari/xcode/make-ipa.sh build/safari/dd build/safari/Bypass-Paywalls-Clean-unsigned.ipa
```

## 3. 授权网站访问（必须）

Safari 不会自动授予扩展访问网站的权限。启用扩展后，在工具栏点扩展图标，选择「在每个网站上始终允许」，或者到 设置 → 扩展 → Bypass Paywalls Clean → 编辑网站 里把「其他网站」设为允许。

没有授权的网站上，修改请求头（Googlebot UA、Referer 等）和清除 Cookie 都不会生效。

## 和 Chrome 版的区别（构建时自动完成）

| 问题 | Safari 版的处理 |
| --- | --- |
| Safari 没有 `management.getSelf()`，首次启动时会在这里报错，导致一条规则都装不上 | 由 `safari-compat.js` 里的 `bpcSafari.getSelf()` 代替 |
| Safari 没有 offscreen 文档（Chrome 版用它解析抓取到的文章 HTML） | 后台改为非常驻页面（有 `DOMParser`），由 `bpcSafari.offscreenParse()` 在后台页解析 |
| Safari 18.4 以前不认识 `initiatorDomains` / `excludedInitiatorDomains` | 自动改成 `domains` / `excludedDomains` |
| WebKit 的正则不支持 `\|`、`{n,m}`、`\d`、`\w` 等写法；而规则是整批提交的，一条不合法整批都会被拒 | 把这些正则改写成一条或多条等价写法，每条单独成为一条规则；如果 Safari 仍拒绝整批，就对半拆分重试，只跳过被拒的那几条 |
| Safari 不支持修改响应头（`responseHeaders`） | 跳过这类规则（见下方「已知限制」） |
| Chrome 版的 DOMPurify 是空实现 | 换成 Firefox 版发布包里的真实 DOMPurify |

以当前版本 4.4.8.4 为例：启用全部站点时，Chrome 版生成 770 条规则；Safari 版实际应用 1081 条（其中 220 条正则规则被改写拆分），跳过 28 条。

## 已知限制

- **28 个站点无法屏蔽内联脚本**：Chrome 版通过修改响应头注入 CSP 来屏蔽这些站点的内联脚本，Safari 不支持这种做法。这些站点的其他规则照常生效，但效果可能不如 Chrome。涉及的站点：cleveland.com、lehighvalleylive.com、mlive.com、nj.com、pennlive.com、silive.com、syracuse.com、anandabazar.com、freitag.de、dwell.com、elpais.com、lastampa.it、inews.co.uk、topagrar.com、nd.nl、ogj.com、revistaoeste.com、rugbypass.com、straitstimes.com、telegram.hr、bizjournals.com、epoch.org.il、independent.co.uk、the-independent.com、theintercept.com、timesofindia.indiatimes.com、vn.at、ynet.co.il
- **不会自动更新扩展本身**：上游发布新版后，需要更新仓库里的发布包并重新构建。弹窗里的「有新版本」提示链接的是 Chrome 版下载页。如果在选项里开启了在线更新站点规则，站点规则仍会从 gitflic 更新。
- Safari 18 以前，扩展无法读取或删除 HttpOnly Cookie。
- 无痕浏览模式下，Safari 只支持 spanning 模式（Chrome 版用的是 split），需要在 Safari 扩展设置里单独允许无痕浏览。
- 修改 `Cookie` 等请求头、`world: MAIN` 脚本注入等行为，只能在真实 Safari 中确认。万一 Safari 拒绝某类规则，兼容层只会跳过被拒的规则，不会影响其他规则。

## 验证清单（第一次安装后）

1. Safari 开发 菜单 → Web Extension Background Content → Bypass Paywalls Clean，打开后台页的 Web 检查器
2. 控制台里应该能看到一行 `BPC Safari: 770 rules requested, 1081 applied (...)`（4.4.8.4 启用全部站点时的数字，随版本和启用的站点变化）。如果有规则被 Safari 拒绝，这行会显示 `rejected by Safari` 及数量
3. 在控制台执行 `bpcSafari.report.lastAddCall.droppedRules`，可以查看具体跳过了哪些规则、原因是什么
4. 打开一个已授权的支持站点，确认文章能正常显示

## 测试

```bash
node --test --test-concurrency=1 safari/test/*.test.mjs
```

测试会在 Node 中加载真实的扩展代码，用模拟的浏览器 API 跑一遍安装流程，覆盖以下内容：

- 验证原版 Chrome 代码在模拟 Safari 环境里确实一条规则都装不上；
- 构建产物在 Safari 16.4、17、18.4、26 下，所有规则都满足 Safari 的限制，并且和 Chrome 版逐条对应；
- 改写前后的正则匹配完全相同的 URL（用随机样本和 JS 正则引擎核对）；
- 切换站点后不留下残余的改写规则；
- 模拟 Safari 拒绝某类规则时，其余规则照常生效。

`safari/test/webkit-rules.mjs` 是根据 Apple 文档、MDN 兼容性数据和 WebKit 内容拦截器正则子集整理出的**近似**模型，故意定得偏严。真实 Safari 运行时会用自己的 `isRegexSupported()` 再判断一次。

## 同步上游新版本

**注意**：Safari 相关文件合入 `main` 之后，不要再用 `git push --mirror` 从 gitflic 同步，否则 GitHub 上的这些提交会被覆盖掉。改用下面的方式：

```bash
git remote add upstream https://gitflic.ru/project/magnolia1234/bpc_uploads.git
```

```bash
git fetch upstream main
```

```bash
git merge upstream/main
```

合并后重新运行 `node safari/build.mjs` 和测试。如果构建报「patch expected … but found …」，说明上游代码结构变了，需要相应更新 `safari/build.mjs` 里的补丁。

## 文件说明

- `build.mjs`：构建脚本（解压 Chrome 版 → 打补丁 → 生成 Safari manifest）
- `src/safari-compat.js`：兼容层，作为第一个后台脚本加载
- `xcode/convert.sh`、`xcode/build-app.sh`、`xcode/make-ipa.sh`：生成 Xcode 工程、构建应用、打包未签名 ipa（CI 也调用这些脚本）
- `test/`：测试（`harness.mjs` 模拟浏览器 API，`webkit-rules.mjs` 是 Safari 规则模型，`sampler.mjs` 做正则等价性采样）
