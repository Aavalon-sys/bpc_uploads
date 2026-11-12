// Loads the Safari build of the extension in WebKit's real web-extension
// engine (the WKWebExtension API, the one Safari itself is built on) and
// reports what the extension actually does there.
//
// This is a test tool for macOS 15.4 or later; it is not part of the extension.
//
//   bpc-webkit-host --extension <dir> --out <result.json>
//                   [--load-delay <seconds>] [--grant all|none] [--settle <seconds>]
//                   [--url <url>]...
//
// --load-delay  Seconds between creating the extension controller and loading
//               the extension. WebKit treats an extension loaded within 5
//               seconds of start-up as "browser launch" (no install event)
//               and a later load as "the user just enabled it".
// --grant       all: every website is allowed (like "Always Allow on Every
//               Website"); none: no website access is granted.
//
// Build: see safari/engine/run.sh

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

// Optional private property, only used when this WebKit has it.
@interface WKWebExtensionContext (BPCHostOptional)
@property (nonatomic, nullable, readonly) WKWebView *_backgroundWebView;
@end

static NSDate *gStart;

static void logLine(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);
static void logLine(NSString *format, ...)
{
    va_list args;
    va_start(args, format);
    NSString *line = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    fprintf(stderr, "[host %6.1fs] %s\n", -[gStart timeIntervalSinceNow], line.UTF8String);
}

static void spin(NSTimeInterval seconds)
{
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (until.timeIntervalSinceNow > 0)
        [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
}

static BOOL spinUntil(BOOL (^condition)(void), NSTimeInterval timeout)
{
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:timeout];
    while (!condition()) {
        if (until.timeIntervalSinceNow <= 0)
            return NO;
        [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    return YES;
}

static id jsonSafe(id value)
{
    if (!value)
        return [NSNull null];
    if ([value isKindOfClass:NSString.class] || [value isKindOfClass:NSNumber.class] || [value isKindOfClass:NSNull.class])
        return value;
    if ([value isKindOfClass:NSArray.class]) {
        NSMutableArray *out = [NSMutableArray array];
        for (id item in (NSArray *)value)
            [out addObject:jsonSafe(item)];
        return out;
    }
    if ([value isKindOfClass:NSDictionary.class]) {
        NSMutableDictionary *out = [NSMutableDictionary dictionary];
        [(NSDictionary *)value enumerateKeysAndObjectsUsingBlock:^(id key, id item, BOOL *stop) {
            out[[key description]] = jsonSafe(item);
        }];
        return out;
    }
    return [value description];
}

static NSString *compact(id value)
{
    @try {
        NSData *data = [NSJSONSerialization dataWithJSONObject:jsonSafe(value) options:NSJSONWritingFragmentsAllowed | NSJSONWritingSortedKeys error:nil];
        return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"(not serialisable)";
    } @catch (NSException *exception) {
        return [NSString stringWithFormat:@"(%@)", exception.reason];
    }
}

// Runs an async function body in a web view and waits for its result.
// Returns the result, or @{ @"error": message }.
static id callJS(WKWebView *webView, NSString *body, WKContentWorld *world, NSTimeInterval timeout)
{
    if (!webView)
        return @{ @"error": @"no web view" };

    __block BOOL done = NO;
    __block id output = nil;
    [webView callAsyncJavaScript:body arguments:nil inFrame:nil inContentWorld:world completionHandler:^(id result, NSError *error) {
        output = error ? @{ @"error": error.userInfo[@"WKJavaScriptExceptionMessage"] ?: error.localizedDescription ?: @"unknown error" } : jsonSafe(result);
        done = YES;
    }];
    if (!spinUntil(^BOOL { return done; }, timeout))
        return @{ @"error": @"timed out" };
    return output;
}

// The body must return a JSON string; this parses it.
static id callJSON(WKWebView *webView, NSString *body, WKContentWorld *world, NSTimeInterval timeout)
{
    id result = callJS(webView, body, world, timeout);
    if (![result isKindOfClass:NSString.class])
        return result;
    id parsed = [NSJSONSerialization JSONObjectWithData:[(NSString *)result dataUsingEncoding:NSUTF8StringEncoding] options:NSJSONReadingFragmentsAllowed error:nil];
    return parsed ?: result;
}

@class BPCWindow;
@class BPCHost;

@interface BPCTab : NSObject <WKWebExtensionTab, WKNavigationDelegate>
@property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, weak) BPCWindow *window;
@property (nonatomic, weak) BPCHost *host;
@property (nonatomic) BOOL finished;
@property (nonatomic, copy) NSString *lastError;
@property (nonatomic) BOOL hostsExtensionPage;
- (void)loadURL:(NSURL *)url;
@end

@interface BPCWindow : NSObject <WKWebExtensionWindow>
@property (nonatomic, strong) NSMutableArray<BPCTab *> *tabs;
@property (nonatomic, strong) BPCTab *activeTab;
@end

@interface BPCHost : NSObject <WKWebExtensionControllerDelegate>
@property (nonatomic, strong) WKWebExtensionController *controller;
@property (nonatomic, strong) WKWebExtensionContext *context;
@property (nonatomic, strong) WKWebsiteDataStore *dataStore;
@property (nonatomic, strong) BPCWindow *window;
@property (nonatomic, strong) NSWindow *nativeWindow;
@property (nonatomic, strong) NSMutableArray<NSDictionary *> *events;
- (BPCTab *)openTabActive:(BOOL)active;
- (WKWebView *)makeWebViewForExtensionPage:(BOOL)extensionPage;
- (void)note:(NSString *)type detail:(id)detail;
@end

@implementation BPCWindow

- (instancetype)init
{
    if ((self = [super init]))
        _tabs = [NSMutableArray array];
    return self;
}

- (NSArray<id<WKWebExtensionTab>> *)tabsForWebExtensionContext:(WKWebExtensionContext *)context { return [_tabs copy]; }
- (id<WKWebExtensionTab>)activeTabForWebExtensionContext:(WKWebExtensionContext *)context { return _activeTab; }
- (WKWebExtensionWindowType)windowTypeForWebExtensionContext:(WKWebExtensionContext *)context { return WKWebExtensionWindowTypeNormal; }
- (WKWebExtensionWindowState)windowStateForWebExtensionContext:(WKWebExtensionContext *)context { return WKWebExtensionWindowStateNormal; }
- (BOOL)isPrivateForWebExtensionContext:(WKWebExtensionContext *)context { return NO; }
- (CGRect)screenFrameForWebExtensionContext:(WKWebExtensionContext *)context { return CGRectMake(0, 0, 1920, 1080); }
- (CGRect)frameForWebExtensionContext:(WKWebExtensionContext *)context { return CGRectMake(50, 50, 1200, 800); }
- (void)focusForWebExtensionContext:(WKWebExtensionContext *)context completionHandler:(void (^)(NSError *))completionHandler { completionHandler(nil); }

@end

@implementation BPCTab

- (id<WKWebExtensionWindow>)windowForWebExtensionContext:(WKWebExtensionContext *)context { return _window; }

- (NSUInteger)indexInWindowForWebExtensionContext:(WKWebExtensionContext *)context
{
    BPCWindow *window = _window;
    return window ? [window.tabs indexOfObject:self] : NSNotFound;
}

- (WKWebView *)webViewForWebExtensionContext:(WKWebExtensionContext *)context { return _webView; }
- (NSString *)titleForWebExtensionContext:(WKWebExtensionContext *)context { return _webView.title; }
- (NSURL *)urlForWebExtensionContext:(WKWebExtensionContext *)context { return _webView.URL; }
- (BOOL)isLoadingCompleteForWebExtensionContext:(WKWebExtensionContext *)context { return !_webView.isLoading; }
- (BOOL)isSelectedForWebExtensionContext:(WKWebExtensionContext *)context { return _window.activeTab == self; }
- (CGSize)sizeForWebExtensionContext:(WKWebExtensionContext *)context { return CGSizeMake(1200, 800); }

- (void)loadURL:(NSURL *)url
{
    BPCHost *host = _host;
    BOOL wantsExtensionPage = ![url.scheme hasPrefix:@"http"] && ![url.scheme isEqualToString:@"about"];
    if (!_webView || wantsExtensionPage != _hostsExtensionPage) {
        // Extension pages need the extension's own web view configuration.
        [_webView removeFromSuperview];
        _webView = [host makeWebViewForExtensionPage:wantsExtensionPage];
        _webView.navigationDelegate = self;
        _hostsExtensionPage = wantsExtensionPage;
        if (_window.activeTab == self)
            [host.nativeWindow.contentView addSubview:_webView];
    }
    _finished = NO;
    _lastError = nil;
    [_webView loadRequest:[NSURLRequest requestWithURL:url]];
}

- (void)loadURL:(NSURL *)url forWebExtensionContext:(WKWebExtensionContext *)context completionHandler:(void (^)(NSError *))completionHandler
{
    [_host note:@"tabs.update(url)" detail:url.absoluteString];
    [self loadURL:url];
    completionHandler(nil);
}

- (void)reloadFromOrigin:(BOOL)fromOrigin forWebExtensionContext:(WKWebExtensionContext *)context completionHandler:(void (^)(NSError *))completionHandler
{
    [_host note:@"tabs.reload" detail:_webView.URL.absoluteString];
    _finished = NO;
    if (fromOrigin)
        [_webView reloadFromOrigin];
    else
        [_webView reload];
    completionHandler(nil);
}

- (void)activateForWebExtensionContext:(WKWebExtensionContext *)context completionHandler:(void (^)(NSError *))completionHandler
{
    BPCWindow *window = _window;
    BPCTab *previous = window.activeTab;
    window.activeTab = self;
    [_host.controller didActivateTab:self previousActiveTab:previous];
    completionHandler(nil);
}

- (void)closeForWebExtensionContext:(WKWebExtensionContext *)context completionHandler:(void (^)(NSError *))completionHandler
{
    BPCWindow *window = _window;
    [_host note:@"tabs.remove" detail:_webView.URL.absoluteString];
    [window.tabs removeObject:self];
    [_host.controller didCloseTab:self windowIsClosing:NO];
    completionHandler(nil);
}

- (void)changed:(WKWebExtensionTabChangedProperties)properties
{
    [_host.controller didChangeTabProperties:properties forTab:self];
}

- (void)webView:(WKWebView *)webView didStartProvisionalNavigation:(WKNavigation *)navigation
{
    [self changed:WKWebExtensionTabChangedPropertiesLoading];
}

- (void)webView:(WKWebView *)webView didReceiveServerRedirectForProvisionalNavigation:(WKNavigation *)navigation
{
    [self changed:WKWebExtensionTabChangedPropertiesLoading];
}

- (void)webView:(WKWebView *)webView didCommitNavigation:(WKNavigation *)navigation
{
    [self changed:WKWebExtensionTabChangedPropertiesURL | WKWebExtensionTabChangedPropertiesTitle];
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation
{
    _finished = YES;
    [self changed:WKWebExtensionTabChangedPropertiesLoading | WKWebExtensionTabChangedPropertiesTitle];
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error
{
    _finished = YES;
    _lastError = error.localizedDescription;
    [self changed:WKWebExtensionTabChangedPropertiesLoading];
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error
{
    _finished = YES;
    _lastError = error.localizedDescription;
    [self changed:WKWebExtensionTabChangedPropertiesLoading];
}

// The test sites are served by a local server with a self-signed certificate.
- (void)webView:(WKWebView *)webView didReceiveAuthenticationChallenge:(NSURLAuthenticationChallenge *)challenge completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *))completionHandler
{
    if ([challenge.protectionSpace.authenticationMethod isEqualToString:NSURLAuthenticationMethodServerTrust]) {
        completionHandler(NSURLSessionAuthChallengeUseCredential, [NSURLCredential credentialForTrust:challenge.protectionSpace.serverTrust]);
        return;
    }
    completionHandler(NSURLSessionAuthChallengePerformDefaultHandling, nil);
}

@end

@implementation BPCHost

- (void)note:(NSString *)type detail:(id)detail
{
    [_events addObject:@{ @"t": @(round(-[gStart timeIntervalSinceNow] * 10) / 10), @"type": type, @"detail": jsonSafe(detail) }];
    logLine(@"%@ %@", type, detail ?: @"");
}

- (WKWebView *)makeWebViewForExtensionPage:(BOOL)extensionPage
{
    WKWebViewConfiguration *configuration = extensionPage ? _context.webViewConfiguration : [[WKWebViewConfiguration alloc] init];
    if (!configuration)
        configuration = [[WKWebViewConfiguration alloc] init];
    configuration.webExtensionController = _controller;
    if (!extensionPage)
        configuration.websiteDataStore = _dataStore;
    return [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 1200, 800) configuration:configuration];
}

- (BPCTab *)openTabActive:(BOOL)active
{
    BPCTab *tab = [[BPCTab alloc] init];
    tab.host = self;
    tab.window = _window;
    tab.webView = [self makeWebViewForExtensionPage:NO];
    tab.webView.navigationDelegate = tab;
    tab.finished = YES;
    [_window.tabs addObject:tab];
    [_controller didOpenTab:tab];
    if (active || !_window.activeTab) {
        BPCTab *previous = _window.activeTab;
        _window.activeTab = tab;
        [_nativeWindow.contentView addSubview:tab.webView];
        [_controller didActivateTab:tab previousActiveTab:previous];
    }
    return tab;
}

- (NSArray<id<WKWebExtensionWindow>> *)webExtensionController:(WKWebExtensionController *)controller openWindowsForExtensionContext:(WKWebExtensionContext *)extensionContext
{
    return @[ _window ];
}

- (id<WKWebExtensionWindow>)webExtensionController:(WKWebExtensionController *)controller focusedWindowForExtensionContext:(WKWebExtensionContext *)extensionContext
{
    return _window;
}

- (void)webExtensionController:(WKWebExtensionController *)controller openNewTabUsingConfiguration:(WKWebExtensionTabConfiguration *)configuration forExtensionContext:(WKWebExtensionContext *)extensionContext completionHandler:(void (^)(id<WKWebExtensionTab>, NSError *))completionHandler
{
    [self note:@"tabs.create" detail:configuration.url.absoluteString];
    // Opened in the background so that the tab under test stays the active one.
    BPCTab *tab = [self openTabActive:NO];
    if (configuration.url)
        [tab loadURL:configuration.url];
    completionHandler(tab, nil);
}

- (void)webExtensionController:(WKWebExtensionController *)controller openOptionsPageForExtensionContext:(WKWebExtensionContext *)extensionContext completionHandler:(void (^)(NSError *))completionHandler
{
    [self note:@"runtime.openOptionsPage" detail:extensionContext.optionsPageURL.absoluteString];
    BPCTab *tab = [self openTabActive:NO];
    if (extensionContext.optionsPageURL)
        [tab loadURL:extensionContext.optionsPageURL];
    completionHandler(nil);
}

- (void)webExtensionController:(WKWebExtensionController *)controller promptForPermissions:(NSSet<WKWebExtensionPermission> *)permissions inTab:(id<WKWebExtensionTab>)tab forExtensionContext:(WKWebExtensionContext *)extensionContext completionHandler:(void (^)(NSSet<WKWebExtensionPermission> *, NSDate *))completionHandler
{
    [self note:@"prompt: permissions" detail:permissions.allObjects];
    completionHandler(permissions, nil);
}

- (void)webExtensionController:(WKWebExtensionController *)controller promptForPermissionToAccessURLs:(NSSet<NSURL *> *)urls inTab:(id<WKWebExtensionTab>)tab forExtensionContext:(WKWebExtensionContext *)extensionContext completionHandler:(void (^)(NSSet<NSURL *> *, NSDate *))completionHandler
{
    NSMutableArray *list = [NSMutableArray array];
    for (NSURL *url in urls)
        [list addObject:url.absoluteString];
    [self note:@"prompt: access to URLs" detail:list];
    // Mirrors a user who never answers the per-site prompt: nothing is granted here.
    completionHandler([NSSet set], nil);
}

- (void)webExtensionController:(WKWebExtensionController *)controller promptForPermissionMatchPatterns:(NSSet<WKWebExtensionMatchPattern *> *)matchPatterns inTab:(id<WKWebExtensionTab>)tab forExtensionContext:(WKWebExtensionContext *)extensionContext completionHandler:(void (^)(NSSet<WKWebExtensionMatchPattern *> *, NSDate *))completionHandler
{
    NSMutableArray *list = [NSMutableArray array];
    for (WKWebExtensionMatchPattern *pattern in matchPatterns)
        [list addObject:pattern.string];
    [self note:@"prompt: match patterns" detail:list.count > 5 ? @(list.count) : list];
    completionHandler([NSSet set], nil);
}

@end

static NSArray<NSString *> *errorStrings(NSArray<NSError *> *errors)
{
    NSMutableArray *out = [NSMutableArray array];
    for (NSError *error in errors)
        [out addObject:[NSString stringWithFormat:@"[%@ %ld] %@", error.domain, (long)error.code, error.localizedDescription]];
    return out;
}

// State of the extension's background page.
static NSString * const kBackgroundProbe = @""
    "const out = {};"
    "const api = (typeof browser === 'object' && browser) || chrome;"
    "try {"
    "  const manifest = api.runtime.getManifest();"
    "  out.manifestKeys = Object.keys(manifest).sort();"
    "  out.manifestVersion = manifest.version;"
    "  out.hasChrome = typeof chrome === 'object'; out.hasBrowser = typeof browser === 'object';"
    "  out.backgroundLoaded = typeof isSiteEnabled === 'function';"
    "  out.compat = typeof bpcSafari === 'object' ? { safariVersion: bpcSafari.report.safariVersion, legacyDomainKeys: bpcSafari.report.legacyDomainKeys, calls: bpcSafari.report.calls, errors: bpcSafari.report.errors || null, lastAddCall: bpcSafari.report.lastAddCall ? { rulesIn: bpcSafari.report.lastAddCall.rulesIn, rulesOut: bpcSafari.report.lastAddCall.rulesOut, batchRejected: bpcSafari.report.lastAddCall.batchRejected, dropped: bpcSafari.report.lastAddCall.droppedRules.length } : null } : null;"
    "  out.enabledSites = typeof enabledSites !== 'undefined' ? enabledSites.length : null;"
    "  out.selfHosted = typeof self_hosted !== 'undefined' ? self_hosted : null;"
    "  out.extChromium = typeof ext_chromium !== 'undefined' ? ext_chromium : null;"
    "  out.userAgent = navigator.userAgent;"
    "  const stored = await api.storage.local.get(null);"
    "  out.storageKeys = Object.keys(stored).sort();"
    "  out.storedSites = stored.sites ? Object.keys(stored.sites).length : null;"
    "  const rules = await api.declarativeNetRequest.getSessionRules();"
    "  out.sessionRules = rules.length;"
    "  const byType = {}; for (const r of rules) byType[r.action.type] = (byType[r.action.type] || 0) + 1;"
    "  out.sessionRulesByType = byType;"
    "  const perms = await api.permissions.getAll();"
    "  out.permissions = perms.permissions; out.origins = perms.origins.length; out.originsSample = perms.origins.slice(0, 3);"
    "  const tabs = await api.tabs.query({});"
    "  out.tabs = tabs.map(t => ({ id: t.id, url: t.url, status: t.status, active: t.active }));"
    "  if (!globalThis.__bpcHostEvents) {"
    "    globalThis.__bpcHostEvents = [];"
    "    api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => { if (globalThis.__bpcHostEvents.length < 80) globalThis.__bpcHostEvents.push({ tabId, changeInfo, url: tab && tab.url, status: tab && tab.status }); });"
    "    out.tabEvents = 'listener installed';"
    "  } else out.tabEvents = globalThis.__bpcHostEvents;"
    "} catch (e) { out.error = String(e && e.message || e); }"
    "return JSON.stringify(out);";

// What the page looks like from the page's own world.
static NSString * const kPageProbe = @""
    "const out = { url: location.href, title: document.title, userAgent: navigator.userAgent, cookie: document.cookie, ran: {}, probes: {} };"
    "for (const a of document.documentElement.attributes) if (a.name.startsWith('data-ran-')) out.ran[a.name.slice(9)] = a.value;"
    "for (const e of document.querySelectorAll('[data-probe]')) out.probes[e.getAttribute('data-probe')] = { display: getComputedStyle(e).display, text: e.textContent.trim().slice(0, 60) };"
    "out.bodyLength = document.body ? document.body.innerText.length : -1;"
    "return JSON.stringify(out);";

// Whether the extension's content scripts are present in its content world.
static NSString * const kContentWorldProbe = @""
    "const out = {};"
    "out.hasChrome = typeof chrome === 'object'; out.hasBrowser = typeof browser === 'object';"
    "out.contentScript = typeof ext_chromium !== 'undefined';"
    "out.extChromium = typeof ext_chromium !== 'undefined' ? ext_chromium : null;"
    "out.csLocal = typeof func_post !== 'undefined';"
    "out.matchDomain = typeof matchDomain === 'function';"
    "out.dompurify = typeof DOMPurify !== 'undefined';"
    "return JSON.stringify(out);";

int main(int argc, const char *argv[])
{
    @autoreleasepool {
        gStart = [NSDate date];

        NSString *extensionPath = nil;
        NSString *outPath = nil;
        NSString *grant = @"all";
        NSTimeInterval loadDelay = 6;
        NSTimeInterval settle = 5;
        NSMutableArray<NSString *> *urls = [NSMutableArray array];
        for (int i = 1; i < argc; i++) {
            NSString *arg = @(argv[i]);
            NSString *value = i + 1 < argc ? @(argv[i + 1]) : nil;
            if ([arg isEqualToString:@"--extension"]) { extensionPath = value; i++; }
            else if ([arg isEqualToString:@"--out"]) { outPath = value; i++; }
            else if ([arg isEqualToString:@"--grant"]) { grant = value; i++; }
            else if ([arg isEqualToString:@"--load-delay"]) { loadDelay = value.doubleValue; i++; }
            else if ([arg isEqualToString:@"--settle"]) { settle = value.doubleValue; i++; }
            else if ([arg isEqualToString:@"--url"]) { [urls addObject:value]; i++; }
            else { fprintf(stderr, "unknown argument %s\n", argv[i]); return 2; }
        }
        if (!extensionPath || !outPath) {
            fprintf(stderr, "usage: bpc-webkit-host --extension <dir> --out <file> [--load-delay s] [--grant all|none] [--settle s] [--url u]...\n");
            return 2;
        }

        NSMutableDictionary *result = [NSMutableDictionary dictionary];
        NSOperatingSystemVersion os = NSProcessInfo.processInfo.operatingSystemVersion;
        result[@"os"] = [NSString stringWithFormat:@"macOS %ld.%ld.%ld", (long)os.majorVersion, (long)os.minorVersion, (long)os.patchVersion];
        result[@"webkit"] = [NSBundle bundleForClass:WKWebView.class].infoDictionary[@"CFBundleVersion"] ?: @"?";
        result[@"options"] = @{ @"grant": grant, @"loadDelay": @(loadDelay), @"settle": @(settle) };

        void (^finish)(void) = ^{
            NSData *data = [NSJSONSerialization dataWithJSONObject:jsonSafe(result) options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys error:nil];
            [data writeToFile:outPath atomically:YES];
            logLine(@"result written to %@", outPath);
        };

        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

        // 1. Parse the extension.
        __block WKWebExtension *extension = nil;
        __block NSError *parseError = nil;
        __block BOOL parsed = NO;
        [WKWebExtension extensionWithResourceBaseURL:[NSURL fileURLWithPath:extensionPath isDirectory:YES] completionHandler:^(WKWebExtension *ext, NSError *error) {
            extension = ext;
            parseError = error;
            parsed = YES;
        }];
        if (!spinUntil(^BOOL { return parsed; }, 30) || !extension) {
            result[@"fatal"] = [NSString stringWithFormat:@"could not parse the extension: %@", parseError.localizedDescription ?: @"timed out"];
            finish();
            return 1;
        }
        result[@"extension"] = @{
            @"name": extension.displayName ?: @"",
            @"version": extension.version ?: @"",
            @"manifestVersion": @(extension.manifestVersion),
            @"hasBackgroundContent": @(extension.hasBackgroundContent),
            @"hasPersistentBackgroundContent": @(extension.hasPersistentBackgroundContent),
            @"requestedPermissions": extension.requestedPermissions.allObjects,
            @"requestedMatchPatterns": @(extension.requestedPermissionMatchPatterns.count),
            @"errors": errorStrings(extension.errors),
        };
        logLine(@"parsed %@ %@ (%lu manifest errors)", extension.displayName, extension.version, (unsigned long)extension.errors.count);

        // 2. Controller, context and a window with one tab.
        BPCHost *host = [[BPCHost alloc] init];
        host.events = [NSMutableArray array];
        host.dataStore = [WKWebsiteDataStore nonPersistentDataStore];

        WKWebExtensionControllerConfiguration *configuration = [WKWebExtensionControllerConfiguration nonPersistentConfiguration];
        configuration.defaultWebsiteDataStore = host.dataStore;
        host.controller = [[WKWebExtensionController alloc] initWithConfiguration:configuration];
        host.controller.delegate = host;
        NSDate *controllerCreated = [NSDate date];

        host.context = [WKWebExtensionContext contextForExtension:extension];
        host.context.inspectable = YES;
        for (WKWebExtensionPermission permission in extension.requestedPermissions)
            [host.context setPermissionStatus:WKWebExtensionContextPermissionStatusGrantedExplicitly forPermission:permission];
        if ([grant isEqualToString:@"all"]) {
            for (WKWebExtensionMatchPattern *pattern in extension.requestedPermissionMatchPatterns)
                [host.context setPermissionStatus:WKWebExtensionContextPermissionStatusGrantedExplicitly forMatchPattern:pattern];
            [host.context setPermissionStatus:WKWebExtensionContextPermissionStatusGrantedExplicitly forMatchPattern:[WKWebExtensionMatchPattern allHostsAndSchemesMatchPattern]];
        }

        host.nativeWindow = [[NSWindow alloc] initWithContentRect:NSMakeRect(50, 50, 1200, 800) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        [host.nativeWindow orderFrontRegardless];

        host.window = [[BPCWindow alloc] init];
        [host.controller didOpenWindow:host.window];
        BPCTab *tab = [host openTabActive:YES];
        [host.controller didFocusWindow:host.window];

        // 3. Load the extension, immediately (browser launch) or later (just enabled).
        NSTimeInterval wait = loadDelay - [[NSDate date] timeIntervalSinceDate:controllerCreated];
        if (wait > 0)
            spin(wait);
        NSError *loadError = nil;
        BOOL loaded = [host.controller loadExtensionContext:host.context error:&loadError];
        [host note:@"extension loaded" detail:loaded ? host.context.baseURL.absoluteString : loadError.localizedDescription];
        if (!loaded) {
            result[@"fatal"] = [NSString stringWithFormat:@"could not load the extension: %@", loadError.localizedDescription];
            finish();
            return 1;
        }

        // 4. Let the background page start (install event, default options, rules).
        spin(10);

        WKWebView * (^backgroundView)(void) = ^WKWebView * {
            if (![host.context respondsToSelector:@selector(_backgroundWebView)])
                return nil;
            WKWebView *view = host.context._backgroundWebView;
            if (view)
                return view;
            // The non-persistent background page was unloaded: wake it up.
            __block BOOL woke = NO;
            [host.context loadBackgroundContentWithCompletionHandler:^(NSError *error) {
                if (error)
                    logLine(@"background content failed to load: %@", error.localizedDescription);
                woke = YES;
            }];
            spinUntil(^BOOL { return woke; }, 20);
            spin(1);
            return host.context._backgroundWebView;
        };

        result[@"backgroundProbeAvailable"] = @([host.context respondsToSelector:@selector(_backgroundWebView)]);
        result[@"backgroundAfterStart"] = callJSON(backgroundView(), kBackgroundProbe, WKContentWorld.pageWorld, 30);
        logLine(@"background after start: %@", compact(result[@"backgroundAfterStart"]));

        // 5. Visit the test pages.
        WKContentWorld *contentWorld = [WKContentWorld worldWithName:[@"WebExtension-" stringByAppendingString:host.context.uniqueIdentifier]];
        NSMutableArray *pages = [NSMutableArray array];
        for (NSString *urlString in urls) {
            NSMutableDictionary *page = [NSMutableDictionary dictionary];
            page[@"requested"] = urlString;
            [host note:@"navigate" detail:urlString];
            [tab loadURL:[NSURL URLWithString:urlString]];
            BOOL finished = spinUntil(^BOOL { return tab.finished; }, 30);
            page[@"finished"] = @(finished);
            if (tab.lastError)
                page[@"navigationError"] = tab.lastError;
            spin(settle);
            page[@"hasAccess"] = @([host.context hasAccessToURL:[NSURL URLWithString:urlString] inTab:tab]);
            page[@"page"] = callJSON(tab.webView, kPageProbe, WKContentWorld.pageWorld, 15);
            page[@"contentWorld"] = callJSON(tab.webView, kContentWorldProbe, contentWorld, 15);
            [pages addObject:page];
            logLine(@"page %@", compact(page));
        }
        result[@"pages"] = pages;

        // 6. The extension's own diagnostics page, for the last test page.
        if (urls.count) {
            BPCTab *diagnostics = [host openTabActive:NO];
            NSURLComponents *components = [NSURLComponents componentsWithURL:[NSURL URLWithString:@"safari-diagnostics.html" relativeToURL:host.context.baseURL] resolvingAgainstBaseURL:YES];
            NSString *tabIDScript = [NSString stringWithFormat:@"const api = (typeof browser === 'object' && browser) || chrome; const tabs = await api.tabs.query({}); const t = tabs.find(t => t.url === %@); return t ? t.id : -1;", compact(tab.webView.URL.absoluteString ?: @"")];
            id tabID = callJS(backgroundView(), tabIDScript, WKContentWorld.pageWorld, 15);
            result[@"diagnosticsTabId"] = tabID;
            if ([tabID isKindOfClass:NSNumber.class] && [tabID integerValue] >= 0) {
                components.queryItems = @[
                    [NSURLQueryItem queryItemWithName:@"tab" value:[tabID stringValue]],
                    [NSURLQueryItem queryItemWithName:@"url" value:tab.webView.URL.absoluteString],
                ];
            }
            [diagnostics loadURL:components.URL];
            spinUntil(^BOOL { return diagnostics.finished; }, 20);
            spin(4);
            result[@"diagnosticsPage"] = callJSON(diagnostics.webView, @"return JSON.stringify({ verdict: [...document.querySelectorAll('#verdict li')].map(li => li.className + ': ' + li.textContent), report: document.getElementById('report').value.split('\\n') });", WKContentWorld.pageWorld, 15);
        }

        // 7. Final state.
        result[@"backgroundAtEnd"] = callJSON(backgroundView(), kBackgroundProbe, WKContentWorld.pageWorld, 30);
        result[@"contextErrors"] = errorStrings(host.context.errors);
        result[@"events"] = host.events;
        logLine(@"context errors: %@", result[@"contextErrors"]);
        finish();
    }
    return 0;
}
