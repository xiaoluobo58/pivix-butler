// ==UserScript==
// @name         Pixiv 收藏转不公开
// @namespace    https://www.pixiv.net/
// @version      1.5.0
// @description  一键将收藏夹所有公开收藏转为不公开（支持仅转换R18内容）
// @author       Misaka Milobo (By Claude Code)
// @updateURL    https://raw.githubusercontent.com/xiaoluobo58/pivix-butler/main/pixiv-bookmark-to-private.user.js
// @downloadURL  https://raw.githubusercontent.com/xiaoluobo58/pivix-butler/main/pixiv-bookmark-to-private.user.js
// @match        https://www.pixiv.net/users/*/bookmarks/artworks*
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
    'use strict';

    let r18Only = GM_getValue('r18Only', false);
    let convMode = GM_getValue('convMode', 'batch'); // 'batch'=批量接口(推荐) | 'slow'=慢速逐个(保底)
    // 慢速模式：每个写入请求之间的基础间隔（ms）。兼容旧键 batchDelay。
    let reqInterval = GM_getValue('reqInterval', GM_getValue('batchDelay', 800));
    let batchInterval = GM_getValue('batchInterval', 2500); // 批量模式：每批之间的间隔（ms）
    let scanPages = GM_getValue('scanPages', 0); // 0 = 全部扫完再转换，N = 每次扫N页后转换
    const BATCH_SIZE = 48; // 批量模式每批最多提交的收藏数（与官方页尺寸一致）

    let running = false; // run() 是否进行中
    let paused = false;  // 是否处于暂停（点击按钮切换）

    const sleep = ms => new Promise(res => setTimeout(res, ms));
    const jitter = ms => Math.round(ms * (0.8 + Math.random() * 0.4)); // ±20% 抖动

    // 暂停时停在迭代边界，直到再次点击继续
    function waitWhilePaused(btn) {
        return new Promise(resolve => {
            (function check() {
                if (!paused) return resolve();
                btn.textContent = '▶ 已暂停，点击继续';
                setTimeout(check, 200);
            })();
        });
    }

    // 自适应调速器：写入完全串行，命中 429 后整体永久降速，持续成功后缓慢回落。
    const pace = {
        base: reqInterval,
        current: reqInterval,
        max: 15000,
        bump() { this.current = Math.min(Math.round(this.current * 1.5), this.max); },
        ok() { if (this.current > this.base) this.current = Math.max(this.base, Math.round(this.current * 0.95)); },
        wait() {
            const ms = Math.round(this.current * (0.8 + Math.random() * 0.4)); // ±20% 抖动
            return new Promise(res => setTimeout(res, ms));
        },
    };

    function getToken() {
        // 初始化检测日志
        window.__tokenDetectionLog = window.__tokenDetectionLog || [];
        const log = (layer, result, value = null) => {
            window.__tokenDetectionLog.push({ layer, result, value: value ? '***' : null, timestamp: Date.now() });
        };

        const validate = t => typeof t === 'string' && /^[a-f0-9]{32,}$/.test(t);

        // ★ 新版 Pixiv (Next.js)：token 在 __NEXT_DATA__ 的 serverSerializedPreloadedState
        //   （二次 JSON 编码的字符串）里，路径为 state.api.token —— 当前线上主策略
        try {
            const nd = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent ?? '{}');
            const sps = nd?.props?.pageProps?.serverSerializedPreloadedState;
            if (typeof sps === 'string' && sps.includes('token')) {
                const state = JSON.parse(sps);
                const direct = state?.api?.token;
                if (validate(direct)) {
                    log('next-preloaded-state', 'success', direct);
                    return direct;
                }
                // api.token 不在时兜底遍历整个 state
                const walk = o => {
                    if (!o || typeof o !== 'object') return null;
                    if (typeof o.token === 'string' && validate(o.token)) return o.token;
                    for (const v of Object.values(o)) { const r = walk(v); if (r) return r; }
                    return null;
                };
                const t = walk(state);
                if (t) {
                    log('next-preloaded-state', 'success', t);
                    return t;
                }
            }
            log('next-preloaded-state', 'not-found');
        } catch (e) {
            log('next-preloaded-state', 'error');
        }

        // 0. meta 标签策略
        try {
            const meta = document.querySelector('meta[name="csrf-token"]')?.content ||
                         document.querySelector('meta[property="csrf-token"]')?.content;
            if (meta && validate(meta)) {
                log('meta-tag', 'success', meta);
                return meta;
            }
            log('meta-tag', 'not-found');
        } catch (e) {
            log('meta-tag', 'error');
        }

        // 1. localStorage 策略
        try {
            const lsKeys = ['pixiv_token', 'token', 'csrf_token', 'csrfToken', 'tt'];
            for (const key of lsKeys) {
                const val = localStorage.getItem(key);
                if (val && validate(val)) {
                    log('localStorage', 'success', val);
                    return val;
                }
            }
            log('localStorage', 'not-found');
        } catch (e) {
            log('localStorage', 'error');
        }

        // 2. sessionStorage 策略
        try {
            const ssKeys = ['pixiv_token', 'token', 'csrf_token', 'csrfToken', 'tt'];
            for (const key of ssKeys) {
                const val = sessionStorage.getItem(key);
                if (val && validate(val)) {
                    log('sessionStorage', 'success', val);
                    return val;
                }
            }
            log('sessionStorage', 'not-found');
        } catch (e) {
            log('sessionStorage', 'error');
        }

        // 3. window globals (增强版，支持更多路径)
        try {
            const paths = [
                () => window.__pixiv_bootstrapper?.context?.token,
                () => window.pixiv?.context?.token,
                () => window.pixiv?.token,
                () => window.__NEXT_DATA__?.props?.pageProps?.token,
                () => window.pixivConfig?.token,
                () => window._token,
            ];
            for (const getter of paths) {
                try {
                    const val = getter();
                    if (val && validate(val)) {
                        log('window-globals', 'success', val);
                        return val;
                    }
                } catch {}
            }
            log('window-globals', 'not-found');
        } catch (e) {
            log('window-globals', 'error');
        }

        // 4. __NEXT_DATA__ 递归遍历 (Next.js Pixiv)，能解析内嵌的 JSON 字符串
        try {
            const nd = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent ?? '{}');
            const walk = o => {
                if (!o) return null;
                if (typeof o === 'string') {
                    // 二次 JSON 编码的字符串（如 serverSerializedPreloadedState）
                    if ((o[0] === '{' || o[0] === '[') && o.includes('token')) {
                        try { return walk(JSON.parse(o)); } catch {}
                    }
                    return null;
                }
                if (typeof o !== 'object') return null;
                if (typeof o.token === 'string' && validate(o.token)) return o.token;
                for (const v of Object.values(o)) { const r = walk(v); if (r) return r; }
                return null;
            };
            const t = walk(nd);
            if (t) {
                log('__NEXT_DATA__', 'success', t);
                return t;
            }
            log('__NEXT_DATA__', 'not-found');
        } catch (e) {
            log('__NEXT_DATA__', 'error');
        }

        // 5. inline scripts 扫描（增强版，支持多种 token 模式）
        try {
            for (const s of document.querySelectorAll('script:not([src])')) {
                // 尝试多种匹配模式
                const patterns = [
                    /"token"\s*:\s*"([a-f0-9]{32,})"/,           // "token":"xxx"
                    /\\"token\\"\s*:\s*\\"([a-f0-9]{32,})\\"/,   // 转义形式 \"token\":\"xxx\"（JSON 字符串内嵌 JSON）
                    /['"]token['"]\s*:\s*['"]([a-f0-9]{32,})['"]/,  // 'token':'xxx' 或 "token":'xxx'
                    /token["\s:=]+["']([a-f0-9]{32,})["']/,     // token="xxx" 或 token:'xxx'
                    /"api"\s*:\s*\{[^}]*"token"\s*:\s*"([a-f0-9]{32,})"/,  // "api":{"token":"xxx"}
                ];

                for (const pattern of patterns) {
                    const m = s.textContent.match(pattern);
                    if (m && validate(m[1])) {
                        log('inline-scripts', 'success', m[1]);
                        return m[1];
                    }
                }
            }
            log('inline-scripts', 'not-found');
        } catch (e) {
            log('inline-scripts', 'error');
        }

        // 6. cookies 多字段检查 (增强版)
        try {
            const cookieFields = ['tt', 'csrf_token', 'CSRF_TOKEN', 'pixiv_token', '_token'];
            for (const field of cookieFields) {
                const regex = new RegExp(`(?:^|;)\\s*${field}=([^;]+)`);
                const match = document.cookie.match(regex);
                if (match) {
                    const val = decodeURIComponent(match[1]);
                    if (validate(val)) {
                        log('cookies', 'success', val);
                        return val;
                    }
                }
            }
            log('cookies', 'not-found');
        } catch (e) {
            log('cookies', 'error');
        }

        log('all-strategies', 'failed');
        return null;
    }

    function getUserId() {
        // 1. URL 解析（主要策略）
        const fromUrl = location.pathname.match(/\/users\/(\d+)/)?.[1];
        if (fromUrl) return fromUrl;

        // 2. window globals 降级
        try {
            const fromGlobal = window.pixiv?.user?.id ||
                             window.__pixiv_bootstrapper?.context?.user?.id ||
                             window.__NEXT_DATA__?.props?.pageProps?.user?.userId;
            if (fromGlobal) return String(fromGlobal);
        } catch {}

        // 3. __NEXT_DATA__ 递归查找
        try {
            const nd = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent ?? '{}');
            const walk = o => {
                if (!o || typeof o !== 'object') return null;
                if (o.userId && /^\d+$/.test(String(o.userId))) return String(o.userId);
                if (o.user?.id && /^\d+$/.test(String(o.user.id))) return String(o.user.id);
                for (const v of Object.values(o)) { const r = walk(v); if (r) return r; }
                return null;
            };
            const id = walk(nd);
            if (id) return id;
        } catch {}

        return null;
    }

    // 等待页面关键元素加载完成
    async function waitForPageReady(maxWaitMs = 5000) {
        const startTime = Date.now();
        while (Date.now() - startTime < maxWaitMs) {
            // 检查关键元素是否存在
            const hasNextData = document.getElementById('__NEXT_DATA__');
            const hasScripts = document.querySelectorAll('script').length > 5;
            const hasBody = document.body && document.body.children.length > 0;

            if (hasNextData || (hasScripts && hasBody)) {
                await sleep(100); // 额外等待确保 JS 执行完成
                return true;
            }
            await sleep(100);
        }
        return false;
    }

    // 带重试的 token 获取
    async function getTokenWithRetry(maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const token = getToken();
            if (token) {
                console.log(`[Pixiv Butler] Token 获取成功 (尝试 ${attempt}/${maxRetries})`);
                return token;
            }

            if (attempt < maxRetries) {
                console.warn(`[Pixiv Butler] Token 获取失败，${500 * attempt}ms 后重试... (${attempt}/${maxRetries})`);
                await sleep(500 * attempt);

                // 尝试刷新页面状态
                if (attempt === 2 && !document.getElementById('__NEXT_DATA__')) {
                    console.log('[Pixiv Butler] 等待页面加载完成...');
                    await waitForPageReady(3000);
                }
            }
        }
        return null;
    }

    async function fetchWithRetry(input, init, btn) {
        let delay = 5000;
        while (true) {
            const r = await fetch(input, init);
            if (r.status !== 429) return r;
            // 命中 429：整体永久降速，并优先按服务器 Retry-After 等待。
            pace.bump();
            const ra = parseInt(r.headers.get('retry-after'));
            const waitMs = (!isNaN(ra) && ra > 0) ? ra * 1000 : delay;
            let remaining = Math.round(waitMs / 1000);
            btn.textContent = `429 限速中，${remaining}s 后重试…`;
            const tid = setInterval(() => {
                btn.textContent = `429 限速中，${Math.max(0, --remaining)}s 后重试…`;
            }, 1000);
            await new Promise(res => setTimeout(res, waitMs));
            clearInterval(tid);
            delay = Math.min(Math.round(delay * 1.5), 60000);
        }
    }

    async function fetchPublicBookmarks(userId, offset = 0, btn) {
        const r = await fetchWithRetry(
            `/ajax/user/${userId}/illusts/bookmarks?tag=&offset=${offset}&limit=100&rest=show&lang=zh`,
            { credentials: 'same-origin' },
            btn
        );
        const json = await r.json();
        if (json.error) throw new Error(json.message);
        return json.body;
    }

    async function setPrivate(illustId, token, btn) {
        const r = await fetchWithRetry('/ajax/illusts/bookmarks/add', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
            body: JSON.stringify({ illust_id: String(illustId), restrict: 1, comment: '', tags: [] }),
        }, btn);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
    }

    // 批量接口：一次提交多个「收藏 ID」（bookmarkData.id）转为不公开。
    async function setPrivateBatch(bookmarkIds, token, btn) {
        const r = await fetchWithRetry('/ajax/illusts/bookmarks/edit_restrict', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'accept': 'application/json', 'x-csrf-token': token },
            body: JSON.stringify({ bookmarkIds: bookmarkIds.map(String), bookmarkRestrict: 'private' }),
        }, btn);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
    }

    // 把一组 works 转为不公开。批量=按 BATCH_SIZE 分块走 edit_restrict（收藏 ID）；
    // 慢速=逐个走 add（作品 ID）+ pace 节流。onProgress(n) 累加进度。
    async function convertWorks(works, token, btn, onProgress) {
        if (convMode === 'batch') {
            for (let i = 0; i < works.length; i += BATCH_SIZE) {
                await waitWhilePaused(btn);
                const chunk = works.slice(i, i + BATCH_SIZE);
                await setPrivateBatch(chunk.map(w => w.bookmarkData.id), token, btn);
                onProgress(chunk.length);
                if (i + BATCH_SIZE < works.length) await sleep(jitter(batchInterval)); // 批次间隔
            }
        } else {
            for (const w of works) {
                await waitWhilePaused(btn);
                await pace.wait();
                await setPrivate(w.id, token, btn);
                pace.ok();
                onProgress(1);
            }
        }
    }

    async function run(btn) {
        console.log('[Pixiv Butler] 开始执行转换任务...');

        // 等待页面准备就绪
        const pageReady = await waitForPageReady();
        if (!pageReady) {
            console.warn('[Pixiv Butler] 页面加载超时，继续尝试获取 token...');
        }

        // 使用带重试的 token 获取
        const token = await getTokenWithRetry();
        const userId = getUserId();

        // 详细的控制台诊断信息
        console.group('[Pixiv Butler] 诊断信息');
        console.log('Token 状态:', token ? '✓ 已获取' : '✗ 获取失败');
        console.log('用户 ID:', userId || '未找到');
        console.log('检测日志:', window.__tokenDetectionLog || []);
        console.log('当前 URL:', location.href);
        console.log('页面元素状态:', {
            __NEXT_DATA__: !!document.getElementById('__NEXT_DATA__'),
            scripts: document.querySelectorAll('script').length,
            cookies: document.cookie ? '存在' : '无',
        });
        console.groupEnd();

        if (!token || !userId) {
            alert('无法获取登录信息，请确认已登录 Pixiv');
            return;
        }

        console.log('[Pixiv Butler] 初始化成功，开始转换...');

        running = true;
        paused = false;
        let done = 0;
        pace.current = pace.base; // 慢速模式从用户配置的节奏起步
        const onProgress = (n) => { done += n; btn.textContent = `转换中… ${done}　⏸点击暂停`; };

        try {
            if (r18Only) {
                let offset = 0, total = Infinity;
                while (offset < total) {
                    // 每轮扫描 scanPages 页（0 = 全部），收集 R18 作品
                    const collected = [];
                    const maxPages = scanPages || Infinity;
                    let pagesScanned = 0;
                    let reachedEnd = false;
                    while (offset < total && pagesScanned < maxPages) {
                        await waitWhilePaused(btn);
                        const data = await fetchPublicBookmarks(userId, offset, btn);
                        total = data.total;
                        collected.push(...(data.works ?? []).filter(w => w.bookmarkData?.id && w.id && w.xRestrict > 0));
                        offset += 100;
                        pagesScanned++;
                        btn.textContent = `扫描中… ${Math.min(offset, total)}/${total}　⏸点击暂停`;
                        if ((data.works ?? []).length < 100) { reachedEnd = true; break; }
                        if (pagesScanned < maxPages) await pace.wait();
                    }
                    await convertWorks(collected, token, btn, onProgress);
                    // 已扫到末尾则结束。否则：转换会使这些作品从公开列表消失，
                    // 后续未扫描作品整体前移，故回退 offset 以避免跳过。
                    if (reachedEnd) break;
                    offset = Math.max(0, offset - collected.length);
                }
            } else {
                // 全部模式：始终从 offset=0 取，列表随转换自然缩短
                while (true) {
                    await waitWhilePaused(btn);
                    const data = await fetchPublicBookmarks(userId, 0, btn);
                    const works = (data.works ?? []).filter(w => w.bookmarkData?.id && w.id);
                    if (!works.length) break;
                    await convertWorks(works, token, btn, onProgress);
                }
            }
            btn.textContent = `✓ 完成，共 ${done} 个`;
            console.log(`[Pixiv Butler] 转换完成，共处理 ${done} 个作品`);
        } catch (e) {
            btn.textContent = `✗ 出错：${e.message}`;
            console.error('[Pixiv Butler] 执行出错:', e);
        } finally {
            running = false;
            paused = false;
        }
    }

    function toast(msg) {
        const t = Object.assign(document.createElement('div'), { textContent: msg });
        Object.assign(t.style, {
            position: 'fixed', bottom: '70px', right: '24px', zIndex: '10000',
            background: '#333', color: '#fff', padding: '8px 14px',
            borderRadius: '4px', fontSize: '13px', pointerEvents: 'none',
        });
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 2000);
    }

    const btn = document.createElement('button');
    function updateBtn() {
        btn.textContent = r18Only ? '🔞 仅R18转不公开' : '🔒 全部转不公开';
    }
    updateBtn();
    Object.assign(btn.style, {
        position: 'fixed', bottom: '24px', right: '24px', zIndex: '9999',
        padding: '10px 18px', background: '#0096fa', color: '#fff',
        border: 'none', borderRadius: '4px', cursor: 'pointer',
        fontSize: '14px', boxShadow: '0 2px 8px rgba(0,0,0,.3)',
    });
    btn.onclick = () => {
        if (!running) { run(btn); return; }   // 空闲 → 开始
        paused = !paused;                      // 运行中 → 暂停/继续
        if (paused) btn.textContent = '▶ 已暂停，点击继续';
        // 继续时由循环自身刷新进度文案
    };
    document.body.appendChild(btn);

    let menuIds = [];
    function registerMenu() {
        menuIds.forEach(id => GM_unregisterMenuCommand(id));
        menuIds = [
            GM_registerMenuCommand(
                `${r18Only ? '✅' : '☐'} 仅转R18内容`,
                () => { r18Only = !r18Only; GM_setValue('r18Only', r18Only); updateBtn(); registerMenu(); toast(`仅R18模式：${r18Only ? '已开启 🔞' : '已关闭 🔒'}`); }
            ),
            GM_registerMenuCommand(
                convMode === 'batch' ? '🚀 模式：批量接口(推荐)' : '🐢 模式：慢速(保底)',
                () => { convMode = convMode === 'batch' ? 'slow' : 'batch'; GM_setValue('convMode', convMode); registerMenu(); toast(`已切换为：${convMode === 'batch' ? '批量接口 🚀' : '慢速模式 🐢'}`); }
            ),
            convMode === 'batch'
                ? GM_registerMenuCommand(
                    `⚙️ 批次间隔：${batchInterval}ms/批`,
                    () => {
                        const v = prompt('每批之间的间隔（毫秒），默认2500；过小可能429', batchInterval);
                        if (v === null) return;
                        const n = parseInt(v);
                        if (!isNaN(n) && n >= 0) { batchInterval = n; GM_setValue('batchInterval', n); registerMenu(); toast(`批次间隔已设为 ${n}ms`); }
                    }
                )
                : GM_registerMenuCommand(
                    `⚙️ 写入间隔：${reqInterval}ms/个`,
                    () => {
                        const v = prompt('每个写入请求的间隔（毫秒），默认800', reqInterval);
                        if (v === null) return;
                        const n = parseInt(v);
                        if (!isNaN(n) && n >= 0) { reqInterval = n; pace.base = n; GM_setValue('reqInterval', n); registerMenu(); toast(`写入间隔已设为 ${n}ms`); }
                    }
                ),
            GM_registerMenuCommand(
                `📄 扫描模式：${scanPages === 0 ? '全部扫完再转换' : `每次${scanPages}页`}`,
                () => {
                    const v = prompt('每次扫描页数（0 = 全部扫完再转换）', scanPages);
                    if (v === null) return;
                    const n = parseInt(v);
                    if (!isNaN(n) && n >= 0) { scanPages = n; GM_setValue('scanPages', n); registerMenu(); toast(`扫描模式：${n === 0 ? '全部' : `每次${n}页`}`); }
                }
            ),
        ];
    }
    registerMenu();

    // 诊断工具：暴露到全局供用户手动调试
    window.pixivBookmarkDebug = {
        checkToken() {
            console.group('🔍 Token 检测诊断');
            const token = getToken();
            console.log('Token 状态:', token ? '✓ 成功获取' : '✗ 未找到');
            if (token) {
                console.log('Token (前8位):', token.substring(0, 8) + '...');
                console.log('Token 长度:', token.length);
                console.log('格式验证:', /^[a-f0-9]{32,}$/.test(token) ? '✓ 通过' : '✗ 不匹配');
            }
            console.log('\n检测日志 (按执行顺序):');
            (window.__tokenDetectionLog || []).forEach((entry, i) => {
                const icon = entry.result === 'success' ? '✓' : entry.result === 'error' ? '✗' : '○';
                console.log(`  ${icon} [${i + 1}] ${entry.layer}: ${entry.result}`);
            });
            console.groupEnd();
            return token;
        },

        getAllCookies() {
            console.group('🍪 Cookies 信息');
            const cookies = document.cookie.split(';').map(c => c.trim());
            console.log('Cookie 总数:', cookies.length);
            console.log('所有 Cookie 名称:');
            cookies.forEach(c => {
                const [name] = c.split('=');
                console.log('  •', name);
            });
            console.log('\n关键 Cookie 检查:');
            ['tt', 'csrf_token', 'CSRF_TOKEN', 'pixiv_token', '_token'].forEach(name => {
                const regex = new RegExp(`(?:^|;)\\s*${name}=([^;]+)`);
                const match = document.cookie.match(regex);
                console.log(`  ${match ? '✓' : '✗'} ${name}:`, match ? '存在' : '不存在');
            });
            console.groupEnd();
        },

        checkStorage() {
            console.group('💾 Storage 信息');
            console.log('localStorage 可用:', typeof localStorage !== 'undefined');
            console.log('sessionStorage 可用:', typeof sessionStorage !== 'undefined');

            if (typeof localStorage !== 'undefined') {
                console.log('\nlocalStorage 键值:');
                const lsKeys = ['pixiv_token', 'token', 'csrf_token', 'csrfToken', 'tt'];
                lsKeys.forEach(key => {
                    const val = localStorage.getItem(key);
                    console.log(`  ${val ? '✓' : '○'} ${key}:`, val ? '存在' : '不存在');
                });
            }

            if (typeof sessionStorage !== 'undefined') {
                console.log('\nsessionStorage 键值:');
                const ssKeys = ['pixiv_token', 'token', 'csrf_token', 'csrfToken', 'tt'];
                ssKeys.forEach(key => {
                    const val = sessionStorage.getItem(key);
                    console.log(`  ${val ? '✓' : '○'} ${key}:`, val ? '存在' : '不存在');
                });
            }
            console.groupEnd();
        },

        checkGlobals() {
            console.group('🌐 全局变量检查');
            let hasPreloadedState = false;
            try {
                const nd = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent ?? '{}');
                hasPreloadedState = typeof nd?.props?.pageProps?.serverSerializedPreloadedState === 'string';
            } catch {}
            const checks = {
                '__NEXT_DATA__ serverSerializedPreloadedState (新版主策略)': hasPreloadedState,
                'window.__pixiv_bootstrapper': window.__pixiv_bootstrapper,
                'window.pixiv': window.pixiv,
                'window.__NEXT_DATA__': !!document.getElementById('__NEXT_DATA__'),
                'window.pixivConfig': window.pixivConfig,
                'window._token': window._token,
            };
            Object.entries(checks).forEach(([path, exists]) => {
                console.log(`  ${exists ? '✓' : '○'} ${path}:`, exists ? '存在' : '不存在');
            });
            console.groupEnd();
        },

        runFullDiagnostic() {
            console.clear();
            console.log('═══════════════════════════════════════════════════');
            console.log('🔧 Pixiv Bookmark Butler - 完整诊断报告');
            console.log('═══════════════════════════════════════════════════\n');

            this.checkToken();
            console.log('');
            this.checkGlobals();
            console.log('');
            this.checkStorage();
            console.log('');
            this.getAllCookies();

            console.log('\n═══════════════════════════════════════════════════');
            console.log('💡 使用提示:');
            console.log('  • window.pixivBookmarkDebug.checkToken() - 快速检查 Token');
            console.log('  • window.pixivBookmarkDebug.runFullDiagnostic() - 完整诊断');
            console.log('═══════════════════════════════════════════════════');
        },
    };

    console.log('[Pixiv Butler] 脚本已加载。运行 window.pixivBookmarkDebug.runFullDiagnostic() 进行诊断。');
})();
