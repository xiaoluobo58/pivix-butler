// ==UserScript==
// @name         Pixiv 收藏转不公开
// @namespace    https://www.pixiv.net/
// @version      1.3.0
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
        // 1. window globals (older Pixiv)
        const g = window.__pixiv_bootstrapper?.context?.token ?? window.pixiv?.context?.token;
        if (g) return g;

        // 2. __NEXT_DATA__ (Next.js Pixiv)
        try {
            const nd = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent ?? '{}');
            const walk = o => {
                if (!o || typeof o !== 'object') return null;
                if (typeof o.token === 'string' && /^[a-f0-9]{32,}$/.test(o.token)) return o.token;
                for (const v of Object.values(o)) { const r = walk(v); if (r) return r; }
                return null;
            };
            const t = walk(nd);
            if (t) return t;
        } catch {}

        // 3. inline scripts
        for (const s of document.querySelectorAll('script:not([src])')) {
            const m = s.textContent.match(/"token"\s*:\s*"([a-f0-9]{32,})"/);
            if (m) return m[1];
        }

        // 4. cookie fallback
        const c = document.cookie.match(/(?:^|;)\s*tt=([^;]+)/);
        return c ? decodeURIComponent(c[1]) : null;
    }

    function getUserId() {
        return location.pathname.match(/\/users\/(\d+)/)?.[1];
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
        const token = getToken();
        const userId = getUserId();
        if (!token || !userId) {
            alert('无法获取登录信息，请确认已登录 Pixiv');
            return;
        }

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
        } catch (e) {
            btn.textContent = `✗ 出错：${e.message}`;
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
})();
