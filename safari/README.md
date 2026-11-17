# Bypass Paywalls Clean：Safari 版

这个目录把仓库根目录里的 Chrome 版发布包（`bypass-paywalls-chrome-clean-master.zip`）构建成 Safari Web Extension，原始发布文件不做任何改动。

> **当前状态**：扩展已在 **真正的 Safari 应用**（CI 的 macOS 机器上的 Safari 27）和 **WebKit 的扩展引擎**里端到端跑通：伪装 Googlebot 的请求头、屏蔽付费墙脚本、注入内容脚本都按预期生效，后台页空闲被卸载后再打开文章也照常生效，详见文末「测试」。没有自动测试到的只有两处：打包成 App 之后的安装流程，以及 iPhone / iPad 上的 Safari（引擎相同，但没有可用的自动化手段）。所以装好后仍建议按「验证清单」看一遍。
>
> 2026-11 之前打包的版本在 Safari 里**完全不起作用**，原因见「早期版本为什么不起作用」。请更新到最新的构建。

## 系统要求

- macOS 上的 Safari 16.4 或更新版本（需要 declarativeNetRequest 修改请求头的能力），建议使用 Safari 18.4 以上
- iPhone / iPad：iOS / iPadOS 16.4 或更新版本
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

iOS 只能安装签过名的 App，所以下面两种方式都要用你自己的 Apple ID 或开发者证书签名。免费 Apple ID 的签名 7 天后过期，每台设备最多同时装约 3 个这样签名的 App；这个 App 带一个扩展，很可能占其中 2 个。

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

### 更新到新的构建

- **macOS**：先完全退出 Safari，**删掉旧的 `Bypass Paywalls Clean.app`**（包括「下载」文件夹里以前解压出来的副本，并清空废纸篓），再放入新的 App 并打开一次，然后重新打开 Safari。电脑上同时留着新旧两份 App 时，Safari 可能继续加载旧的那份扩展。每次构建的 App 都带有递增的构建号（App 菜单「关于」窗口里版本号后面括号中的数字，诊断页里也有），可以用来区分。
- **iPhone / iPad**：用同一个 Apple ID 直接安装新的 ipa 覆盖旧的，然后打开一次 App。
- 不需要清除扩展的数据。旧版本留下的设置会在新版第一次启动时自动修正：从未初始化的站点列表会被初始化；被旧版误停用的站点（名称里带重音字母的 39 个，如 Télérama.fr、El Español）会重新启用，除非你已经把站点列表精简过。
- 更新后可以在「Safari 诊断」页确认 Safari 实际加载的是哪一份：报告里的 `safari build` 一行有构建号和对应的 Git 提交。

## 3. 授权网站访问（必须，否则完全不起作用）

Safari 默认不允许扩展访问任何网站。没有授权的网站上，Safari 不会把网页地址告诉扩展，也不允许它注入脚本，所以扩展什么都做不了。修改请求头（Googlebot UA、Referer 等）和清除 Cookie 也同样需要授权。

**第一次启用时的对话框**：扩展刚启用，Safari 就会弹出「扩展“Bypass Paywalls Clean”想要访问 gitflic.ru」（扩展启动时会到 gitflic.ru 检查更新，所以最先问到的是这个域名）。这是一次性授权全部网站的最快办法：**先勾选对话框里的复选框（英文界面是 Remember for other websites），再点「始终允许」（Always Allow）**。CI 里的 Safari 测试就是这样操作的，之后所有受支持的网站立即可用。不勾选复选框的话，只有 gitflic.ru 这一个网站被授权，新闻网站仍然不能用。

如果当时选了别的，或者没有看到这个对话框，可以随时在设置里改：

- **macOS**：Safari 设置 → 扩展 → Bypass Paywalls Clean → 「编辑网站…」→ 把「访问其他网站时」设为「允许」。也可以在新闻网站上点工具栏的扩展图标，选「在每个网站上始终允许」
- **iPhone / iPad**：设置 → App → Safari → 扩展 → Bypass Paywalls Clean → 把「其他网站」设为「允许」

改完后刷新新闻页面。只点「允许一天」的话，第二天会失效。

**无痕浏览窗口**里 Safari 默认不运行扩展：需要在同一个扩展设置页里另外打开「在无痕浏览中允许」。

## 排查问题：Safari 诊断页

在要测试的新闻网站上点开扩展图标，点弹窗底部的「Safari 诊断」，会打开一个诊断页（iPhone 上也能用）：

- **结论**：直接指出问题，例如没有网站权限、选项里没有启用站点、后台脚本没有运行、脚本没有注入到当前页面
- **详细信息**：Safari 版本、实际加载的构建（`safari build`）、已授权的网站、启用的站点数、实际装上的规则数、后台报错、当前页面的检测结果。点「复制报告」可以把全部内容发给开发者

## 早期版本为什么不起作用

2026-11 之前的构建在 macOS 和 iOS 的 Safari 里都完全不起作用，即使授权了网站访问也一样。原因是 Safari 的四个与 Chrome 不同、而且事先查不到文档的行为，都是把扩展放进真实的 WebKit 引擎里运行之后才发现的：

1. **Safari 拒绝修改 `X-Forwarded-For` 等请求头**。它只接受一份固定名单里的请求头，而且只要有一条规则不合格就拒绝整批规则。伪装 Googlebot 的规则同时设置 User-Agent、Referer 和 `X-Forwarded-For`，结果整条规则被丢掉，Googlebot 的 User-Agent 根本没发出去。
2. **规则悄悄被回滚**。默认设置下，通用的付费墙脚本规则带着一个空的「排除域名」列表。Chrome 把空列表当作「不排除」；Safari 能接收这样的规则，但随后编译整个规则集失败，于是恢复成更新前的规则（也就是没有规则），却仍然向扩展报告「成功」。
3. **Safari 启动时首次加载的扩展收不到安装事件**。扩展靠这个事件启用默认站点，于是站点列表一直是空的。在 iPhone / iPad 上先在「设置」里启用扩展、再打开 Safari，几乎必然遇到。
4. **后台脚本被当成 Latin-1 编码读取**。站点名里带重音字母的 40 个站点在后台变成乱码，选项页（按 UTF-8 读取同一个文件）认不出它们，而选项页每次打开都会自动保存，于是其中 39 个站点被停用。

四个问题都已修复，并且各有对应的自动测试（见「测试」）。

## 和 Chrome 版的区别（构建时自动完成）

| 问题 | Safari 版的处理 |
| --- | --- |
| Safari 没有 `management.getSelf()`，首次启动时会在这里报错，导致一条规则都装不上 | 由 `safari-compat.js` 里的 `bpcSafari.getSelf()` 代替 |
| Safari 没有 offscreen 文档（Chrome 版用它解析抓取到的文章 HTML） | 后台改为非常驻页面（有 `DOMParser`），由 `bpcSafari.offscreenParse()` 在后台页解析 |
| Safari 18.4 以前不认识 `initiatorDomains` / `excludedInitiatorDomains` | 自动改成 `domains` / `excludedDomains` |
| WebKit 的正则不支持 `\|`、`{n,m}`、`\d`、`\w` 等写法；而规则是整批提交的，一条不合法整批都会被拒 | 把这些正则改写成一条或多条等价写法，每条单独成为一条规则；如果 Safari 仍拒绝整批，就对半拆分重试，只跳过被拒的那几条 |
| Safari 只允许修改固定名单里的请求头，名单里没有 `X-Forwarded-For` 和个别站点用的自定义请求头 | 只去掉 Safari 不接受的那个请求头，规则的其余部分（User-Agent、Referer、Cookie）照常生效；被拒的请求头会记下来，以后不再重试 |
| 带空「排除域名」列表的规则让 Safari 编译规则集失败，并悄悄恢复旧规则 | 去掉空列表。另外每次更新规则都附带一条标记规则，更新后检查它是否真的生效；如果被回滚，就对半拆分找出 Safari 编译不了的规则并跳过 |
| Safari 启动时首次加载的扩展收不到安装事件，而每次重新启用扩展又会重复收到 | 首次设置（启用默认站点）改为每个 Safari 配置只做一次，不依赖这个事件 |
| 已发布的 Safari 把后台脚本当成 Latin-1 读取，非 ASCII 字符变成乱码 | 构建时把所有脚本里的非 ASCII 字符写成 `\uXXXX` 转义，脚本本身是纯 ASCII，按哪种编码读都一样 |
| 有十几个站点的脚本要注入到网页自己的 JavaScript 环境（`world: "MAIN"`），那里 Safari 没有 `chrome` 对象，脚本第一行就报错 | 这些脚本在找不到 `chrome` / `browser` 时改用空对象，行为与 Chrome 的网页环境一致 |
| 去掉 `X-Forwarded-For` 之后，伪装 Googlebot 的请求「自称 Googlebot、却不是从 Google 的地址发出」，有的网站对这种请求干脆不回应，页面永远打不开（washingtonpost.com 就是这样） | 打开页面时不再对这类网站伪装成 Googlebot，规则的其余部分照常生效。已知的网站预先列出；其他网站在访问时自动发现：页面 12 秒没有任何回应、或者打开的是一个「拒绝访问」的短页面时，去掉伪装再加载一次，成功了就记住这个网站 |
| 不伪装的话，这类网站只给文章的免费开头（服务器端就截断了） | Safari 只是不让在**打开页面**的请求里加 `X-Forwarded-For`，脚本自己发的请求可以同时带上它和 Googlebot 的 User-Agent。所以页面一开始加载，就由页面带着这两个请求头把同一个网址再取一次，如果取回的版本正文明显更多，就把其中的文章部分换进页面（见下方「已知限制」） |
| Safari 不支持修改响应头（`responseHeaders`） | 跳过这类规则（见下方「已知限制」） |
| 上游规则已失效的个别网站 | 构建时修正这些网站的规则（`build.mjs` 里的 `SITE_FIXES`）。目前只有 The Hill：2026 年推出的 Hill Insider 付费墙其实是盖在完整正文上的弹窗，扩展屏蔽打开弹窗的脚本、隐藏弹窗并恢复页面滚动。同样的修正也做成了 Chrome 版（`chrome/build.mjs`，CI 产物 `chrome-extension-fixed`） |
| Chrome 版的 DOMPurify 是空实现 | 换成 Firefox 版发布包里的真实 DOMPurify |
| Apple 的转换工具每次都生成版本 1.0 (1) 的 App | 用扩展的版本号和递增的构建号，新的 App 一定比旧的「新」 |

以当前版本 4.4.9.5 为例：启用全部默认站点时，Chrome 版生成 728 条规则；Safari 版实际装上 1032 条（其中 204 条正则规则被改写拆分），外加 1 条用于检查的标记规则，跳过 30 条。

## 已知限制

- **29 个站点无法屏蔽内联脚本**：Chrome 版通过修改响应头注入 CSP 来屏蔽这些站点的内联脚本，Safari 不支持这种做法。这些站点的其他规则照常生效，但效果可能不如 Chrome。涉及的站点：cleveland.com、lehighvalleylive.com、mlive.com、nj.com、pennlive.com、silive.com、syracuse.com、anandabazar.com、businessdesk.co.nz、challenges.fr、freitag.de、dwell.com、elpais.com、lastampa.it、inews.co.uk、topagrar.com、ogj.com、revistaoeste.com、rugbypass.com、straitstimes.com、telegram.hr、bizjournals.com、epoch.org.il、independent.co.uk、the-independent.com、theintercept.com、timesofindia.indiatimes.com、vn.at、ynet.co.il
- **不能伪造来源 IP，所以伪装 Googlebot 的效果比 Chrome 弱**：Chrome 版对 50 个站点同时发送 Googlebot 的 User-Agent 和带有 Google 爬虫地址的 `X-Forwarded-For`。Safari 不允许扩展设置 `X-Forwarded-For`，所以：
  - 只看 User-Agent 的网站不受影响，和 Chrome 版一样；
  - 会核对来源地址的网站把这种请求当成假爬虫，有的直接不回应。对这些网站，Safari 版在打开页面时不再伪装成 Googlebot，而是在页面加载的同时，由页面带着完整的 Googlebot 身份（脚本发出的请求可以加 `X-Forwarded-For`）把同一个网址再取一次，把取回的完整正文换进页面。目前已知的是 washingtonpost.com；其他网站由扩展在访问时自动发现（第一次会多等最多 12 秒，然后自动重新加载），「Safari 诊断」页会列出这些网站和最近一次替换的结果；
  - 这样换进去的正文是**静态内容**：文字和图片都在，但文章里依赖脚本的互动部件不会工作，正文可能比页面其余部分稍晚出现。替换靠的是比较两个版本的正文：先找双方都有的段落，找不到就按元素的名字，再不行就换掉文章外面更大的一块（那一块里的互动部件也会失效）；全都对不上时页面保持原样（只有开头），诊断页会写明原因；
  - nationalgeographic.com 那条只设置 `X-Forwarded-For` 的规则被整条跳过。
- **不能发送 App 请求头**：haaretz.com、haaretz.co.il、themarker.com 和 New York Post（nypost.djservices.io）的规则依赖手机 App 的自定义请求头，这一部分在 Safari 上不生效。
- **不会自动更新扩展本身**：上游发布新版后，需要更新仓库里的发布包并重新构建。弹窗里的「有新版本」提示链接的是 Chrome 版下载页。如果在选项里开启了在线更新站点规则，站点规则仍会从 gitflic 更新。
- Safari 18 以前，扩展无法读取或删除 HttpOnly Cookie。
- 无痕浏览模式下，Safari 只支持 spanning 模式（Chrome 版用的是 split），并且需要在 Safari 扩展设置里单独允许无痕浏览。
- Safari 每次启动后要重新装载规则，启动后最初一两秒内打开的页面可能还没有规则。

## 验证清单（第一次安装后）

1. 确认已按第 3 节授权网站访问
2. 在一个支持的新闻网站上打开「Safari 诊断」，结论里应该是「扩展的脚本已注入到当前页面」，详细信息里 `session rules` 的 `total` 应该在 1000 左右（4.4.9.5 启用全部默认站点时是 1032）
3. （macOS，可选）Safari 开发 菜单 → Web Extension Background Content → Bypass Paywalls Clean，打开后台页的 Web 检查器。控制台里应该能看到一行 `BPC Safari: 728 rules requested, 1032 applied (...)`（4.4.9.5 启用全部默认站点时的数字，随版本和启用的站点变化）；执行 `bpcSafari.report.lastAddCall.droppedRules` 可以查看具体跳过了哪些规则

## 测试

### 模拟环境里的测试（任何系统都能跑）

```bash
node --test --test-concurrency=1 safari/test/*.test.mjs
```

测试会在 Node 中加载真实的扩展代码，用模拟的浏览器 API 跑一遍安装流程，覆盖以下内容：

- 验证原版 Chrome 代码在模拟 Safari 环境里确实一条规则都装不上；
- 构建产物在 Safari 16.4、17、18.4、26 下，所有规则都满足 Safari 的限制，并且和 Chrome 版逐条对应；
- 改写前后的正则匹配完全相同的 URL（用随机样本和 JS 正则引擎核对）；
- 切换站点后不留下残余的改写规则；
- 有网站权限时，内容脚本的注入和 Chrome 版完全一致；没有权限时（Safari 给的网址为空）不会注入；
- 上面「早期版本为什么不起作用」里的四种 Safari 行为：被拒的请求头、被悄悄回滚的更新、没有安装事件、后台脚本按 Latin-1 读取；
- 网站拒绝「假 Googlebot」时的处理：无回应或被拒 → 去掉伪装重试 → 成功则记住，仍失败则恢复；用户自己中止的加载不受影响；
- 从爬虫版本取回正文并换进页面的逻辑（`crawler-upgrade.browser.test.mjs`，在真实浏览器里跑，需要本机装有 Playwright，没有时自动跳过）：几种页面结构、页面还没解析完就开始、页面不重新加载就换了文章、页面脚本撤销改动后的恢复、取不到或对不上时保持原样；
- 旧版本留下的站点列表（乱码的名称、被停用的站点）会被修正，用户自己精简过的列表保持不变；
- 注入网页环境的脚本在没有 `chrome` 对象的页面里能正常启动；
- 诊断页在「没有网站权限」「一切正常」「后台没有响应」等情况下给出正确的结论。

`safari/test/webkit-rules.mjs` 是根据 Apple 文档、MDN 兼容性数据、WebKit 源码和引擎测试的结果整理出的**近似**模型，故意定得偏严。真实 Safari 运行时会用自己的 `isRegexSupported()` 再判断一次。

### 在真实的 WebKit 引擎里测试（需要 macOS 15.4 以上）

```bash
safari/engine/run.sh
```

GitHub Actions 的「Safari engine test」工作流在每次改动后自动运行它（以及下一节的 Safari 应用测试）。这个测试用 WebKit 公开的 `WKWebExtension` 接口（Safari 的扩展功能就建在它上面）加载构建好的扩展，然后打开几个受支持网站的本地替身页面，检查真正发生了什么：

- 服务器实际收到的请求头（Googlebot 的 User-Agent、Google 的 Referer、被清空的 Cookie）；
- 应该被屏蔽的脚本确实没有被请求，对照脚本照常加载；
- 内容脚本确实注入并修改了页面（包括注入到网页自己的 JavaScript 环境的那一类）；
- 扩展自己以为装上的规则数和 WebKit 里实际存在的规则数一致；
- 没有网站权限时、在无痕窗口里，页面完全不受影响；不受支持的网站完全不受影响；
- 扩展在「Safari 运行中启用」和「随 Safari 启动加载」两种情况下结果相同；
- 后台页空闲 30 秒被 WebKit 卸载之后，下一次打开文章能把它唤醒，规则和内容脚本照常生效；
- 对「拒绝假 Googlebot」的替身网站：已知的那个在打开页面时从不收到 Googlebot 的 User-Agent；另外两个（一个不回应、一个返回拒绝页面）被扩展自动发现，去掉伪装后重新加载成功，并被记住；
- 已知的那个替身网站和真站一样，只把全文给「带着 Googlebot 身份和地址」的请求：页面加载后确实带着这两个请求头再取了一次，并显示出全部段落。

测试页面由本机的代理提供（`safari/engine/server.mjs`），不会访问真实的网站。机器上的 Safari 比系统新时（Safari 自带一份更新的 WebKit），主要场景会用那份 WebKit 再跑一遍。

### 在真正的 Safari 应用里测试（只适合 CI 机器）

```bash
safari/engine/safari-app.sh
```

引擎测试里，标签页、窗口和权限是测试程序自己模拟的。这个测试则让 Safari 应用本身通过 WebDriver（`safaridriver`，需要 Safari 18.4 以上）加载构建好的扩展，标签页、事件、权限对话框全部是 Safari 自己的：

- Safari 弹出「想要访问 gitflic.ru」的对话框时，脚本像用户一样勾选复选框并点「始终允许」；
- 然后依次打开同一批替身页面，检查服务器收到的请求头、被屏蔽的脚本、内容脚本对页面的修改，包括那几个「拒绝假 Googlebot」的替身网站，以及从爬虫版本取回全文这一步（Safari 确实发出了脚本设置的 Googlebot User-Agent 和 `X-Forwarded-For`）；
- 空闲 40 秒（让 Safari 卸载后台页）后再打开两个页面，检查结果相同。

WebDriver 只能看到网页，看不到扩展内部，所以这里检查的都是网页和服务器能看到的结果。脚本会临时修改机器的设置（信任测试证书、设置代理自动配置、退出并重启 Safari、通过辅助功能接口点击对话框），结束后恢复，**不要在自己日常使用的 Mac 上运行**。

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

- `build.mjs`：构建脚本（解压 Chrome 版 → 打补丁 → 生成 Safari manifest → 把脚本转成纯 ASCII）
- `src/safari-compat.js`：兼容层，作为第一个后台脚本加载
- `src/safari-diagnostics.html`、`src/safari-diagnostics.js`、`src/safari-popup.js`：诊断页和弹窗里的入口链接
- `xcode/convert.sh`、`xcode/set-version.mjs`、`xcode/build-app.sh`、`xcode/make-ipa.sh`：生成 Xcode 工程、写入版本号、构建应用、打包未签名 ipa（CI 也调用这些脚本）
- `test/`：模拟环境里的测试（`harness.mjs` 模拟浏览器 API，`webkit-rules.mjs` 是 Safari 规则模型，`sampler.mjs` 做正则等价性采样）
- `engine/`：真实 WebKit 引擎和 Safari 应用里的测试（`host.m` 是加载扩展的宿主程序，`server.mjs` 是本地替身网站，`run.sh` 运行引擎测试的全部场景，`safari-app.sh` 和 `safari-app.mjs` 驱动 Safari 应用，`report.mjs` 汇总并检查结果）
