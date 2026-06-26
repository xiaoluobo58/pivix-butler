// ==UserScript==
// @name         Pixiv 收藏转不公开
// @namespace    https://www.pixiv.net/
// @version      1.1.2
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
    let batchDelay = GM_getValue('batchDelay', 400);
    let scanPages = GM_getValue('scanPages', 0); // 0 = 全部扫完再转换，N = 每次扫N页后转换

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
        let delay = 15000;
        while (true) {
            const r = await fetch(input, init);
            if (r.status !== 429) return r;
            let remaining = Math.round(delay / 1000);
            btn.textContent = `429 限速中，${remaining}s 后重试…`;
            const tid = setInterval(() => {
                btn.textContent = `429 限速中，${Math.max(0, --remaining)}s 后重试…`;
            }, 1000);
            await new Promise(res => setTimeout(res, delay));
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

    async function run(btn) {
        const token = getToken();
        const userId = getUserId();
        if (!token || !userId) {
            alert('无法获取登录信息，请确认已登录 Pixiv');
            return;
        }

        btn.disabled = true;
        let done = 0;

        try {
            if (r18Only) {
                let offset = 0, total = Infinity;
                while (offset < total) {
                    // 每轮扫描 scanPages 页（0 = 全部）
                    const r18Works = [];
                    const maxPages = scanPages || Infinity;
                    let pagesScanned = 0;
                    while (offset < total && pagesScanned < maxPages) {
                        const data = await fetchPublicBookmarks(userId, offset, btn);
                        total = data.total;
                        r18Works.push(...(data.works ?? []).filter(w => w.bookmarkData && w.id && w.xRestrict > 0));
                        offset += 100;
                        pagesScanned++;
                        btn.textContent = `扫描中… ${Math.min(offset, total)}/${total}`;
                        if ((data.works ?? []).length < 100) { offset = total; break; }
                        if (pagesScanned < maxPages) await new Promise(r => setTimeout(r, batchDelay));
                    }
                    // 转换本轮 R18 作品
                    for (let i = 0; i < r18Works.length; i += 5) {
                        await Promise.all(r18Works.slice(i, i + 5).map(w => setPrivate(w.id, token, btn)));
                        done += Math.min(5, r18Works.length - i);
                        btn.textContent = `转换中… ${done}`;
                    }
                }
            } else {
                // 全部模式：始终从 offset=0 取，列表随转换自然缩短
                while (true) {
                    const data = await fetchPublicBookmarks(userId, 0, btn);
                    const works = (data.works ?? []).filter(w => w.bookmarkData && w.id);
                    if (!works.length) break;
                    for (let i = 0; i < works.length; i += 5) {
                        await Promise.all(works.slice(i, i + 5).map(w => setPrivate(w.id, token, btn)));
                        done += Math.min(5, works.length - i);
                        btn.textContent = `转换中… ${done}`;
                    }
                    await new Promise(r => setTimeout(r, batchDelay));
                }
            }
            btn.textContent = `✓ 完成，共 ${done} 个`;
        } catch (e) {
            btn.textContent = `✗ 出错：${e.message}`;
            btn.disabled = false;
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
    btn.onclick = () => run(btn);
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
                `⚙️ 转换速率：${batchDelay}ms/批`,
                () => {
                    const v = prompt('每批次间隔（毫秒），默认400', batchDelay);
                    if (v === null) return;
                    const n = parseInt(v);
                    if (!isNaN(n) && n >= 0) { batchDelay = n; GM_setValue('batchDelay', n); registerMenu(); toast(`转换间隔已设为 ${n}ms`); }
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
