function getCurrentPoolType() {
    const pool = (document.body && document.body.dataset && document.body.dataset.poolType) || "normal";
    return pool === "welfare" ? "welfare" : "normal";
}

/**
 * GPT Team 管理系统 - 通用 JavaScript
 */

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function extractErrorText(payload) {
    if (payload === null || payload === undefined) return '';
    if (typeof payload === 'string') return payload;

    if (Array.isArray(payload)) {
        return payload
            .map(item => {
                if (!item) return '';
                if (typeof item === 'string') return item;
                if (item.msg !== undefined) return String(item.msg);
                if (item.detail !== undefined) return extractErrorText(item.detail);
                if (item.error !== undefined) return extractErrorText(item.error);
                try {
                    return JSON.stringify(item);
                } catch (_) {
                    return String(item);
                }
            })
            .filter(Boolean)
            .join('；');
    }

    if (typeof payload === 'object') {
        if (payload.detail !== undefined) return extractErrorText(payload.detail);
        if (payload.error !== undefined) return extractErrorText(payload.error);
        if (payload.message !== undefined) return extractErrorText(payload.message);
        if (payload.msg !== undefined) return extractErrorText(payload.msg);
        if (payload.reason !== undefined) return extractErrorText(payload.reason);
        try {
            return JSON.stringify(payload);
        } catch (_) {
            return String(payload);
        }
    }

    return String(payload);
}

function normalizeRawErrorMessage(rawMessage) {
    let message = extractErrorText(rawMessage).trim();
    if (!message) return '';

    for (let i = 0; i < 2; i++) {
        const trimmed = message.trim();
        if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) break;

        try {
            const parsed = JSON.parse(trimmed);
            const extracted = extractErrorText(parsed).trim();
            if (!extracted || extracted === trimmed) break;
            message = extracted;
        } catch (_) {
            break;
        }
    }

    return message.replace(/\s+/g, ' ').trim();
}

function isTechnicalLogMessage(message) {
    const normalized = String(message || '').trim();
    if (!normalized) return false;

    const lower = normalized.toLowerCase();
    if (normalized.length > 220) return true;

    const technicalKeywords = [
        'traceback',
        'exception',
        'stack',
        'sqlalchemy',
        'asyncsession',
        'httpx',
        'aiohttp',
        'error_code',
        'status_code',
        'file "',
        'line ',
        'detail:',
        'db_session',
        'token refresh failed',
        'validate',
        'jsondecodeerror'
    ];

    return technicalKeywords.some(keyword => lower.includes(keyword));
}

function getFriendlyAdminErrorMessage(rawMessage, statusCode = 0, scene = 'common') {
    const message = normalizeRawErrorMessage(rawMessage);
    const lower = message.toLowerCase();
    const includesAny = (...keywords) => keywords.some(keyword => lower.includes(String(keyword).toLowerCase()));

    if (scene === 'oauth') {
        if (includesAny('state') && includesAny('mismatch', '不匹配', 'invalid')) {
            return '授权回调校验失败，请重新生成授权链接后再试';
        }
        if (includesAny('code_verifier', 'code verifier', 'pkce')) {
            return '授权参数校验失败，请重新生成授权链接后再试';
        }
    }

    if (scene === 'import') {
        if (includesAny('json') && includesAny('invalid', '格式', '解析')) {
            return '导入文件格式不正确，请检查后重试';
        }
        if (
            includesAny('access_token', 'access token', 'refresh_token', 'refresh token', 'id_token', 'id token', 'session_token', 'session token') &&
            includesAny('invalid', '失效', '过期', '不能为空', 'missing')
        ) {
            return '导入的 Token 信息无效，请检查后重试';
        }
        if (includesAny('邮箱不匹配', 'email mismatch', 'token 邮箱不匹配')) {
            return 'Token 与填写邮箱不一致，请核对后重试';
        }
    }

    if (scene === 'member') {
        if (includesAny('owner', '所有者') && includesAny('不可删除', 'cannot', 'forbidden')) {
            return '所有者账号不支持删除';
        }
    }

    if (includesAny('未登录', 'api key 无效', 'unauthorized', 'authentication', 'login required')) {
        return '登录状态已失效，请重新登录后重试';
    }

    if (includesAny('forbidden', 'permission denied', '权限不足', '无权限')) {
        return '您没有该操作权限，请联系管理员';
    }

    if (includesAny('查询太频繁', 'too many requests', 'rate limit') || statusCode === 429) {
        const waitMatch = message.match(/(\d+)\s*秒/);
        if (waitMatch) {
            return `操作过于频繁，请 ${waitMatch[1]} 秒后再试`;
        }
        return '操作过于频繁，请稍后再试';
    }

    if (
        includesAny('token', 'access token', 'refresh token', 'id token', 'session token') &&
        includesAny('invalid', 'expired', 'invalidated', '失效', '过期')
    ) {
        return scene === 'oauth' ? 'Token 无效或已过期，请重新授权后再试' : 'Token 无效或已过期，请刷新后重试';
    }

    if (
        includesAny('value is not a valid email', 'invalid email', 'email address is not valid', '邮箱格式') ||
        (includesAny('field required', 'missing') && includesAny('email'))
    ) {
        return '邮箱格式不正确，请检查后重试';
    }

    if (includesAny('team id', 'team 不存在', '目标 team', 'team not found')) {
        return '目标 Team 不存在或已失效，请刷新后重试';
    }

    if (includesAny('member not found', '成员不存在', '用户不存在')) {
        return '成员不存在或已被移除，请刷新后重试';
    }

    if (includesAny('json') && includesAny('parse', '解析', '格式')) {
        return '数据格式异常，请检查后重试';
    }

    if (includesAny('proxy', 'connection', 'timeout', 'timed out', 'network', '连接', 'dns', 'ssl', 'socket')) {
        return '网络连接异常，请稍后重试';
    }

    if (statusCode === 401 || statusCode === 403) {
        return '登录状态已失效，请重新登录后重试';
    }

    if (statusCode >= 500) {
        return '系统繁忙，请稍后重试';
    }

    if (!message) {
        return statusCode >= 500 ? '系统繁忙，请稍后重试' : '操作失败，请稍后重试';
    }

    if (isTechnicalLogMessage(message)) {
        return statusCode >= 500 ? '系统繁忙，请稍后重试' : '操作失败，请稍后重试';
    }

    return message;
}

function cleanupLegacyThemeSettingsSection() {
    // 保留系统配色分区；新的系统中心页面仍然需要该面板。
}


function applySystemTheme(themeName) {
    const body = document.body;
    if (!body) return;

    const normalized = String(themeName || '').toLowerCase() === 'warm' ? 'warm' : 'ocean';
    body.dataset.uiTheme = normalized;
    body.classList.remove('theme-ocean', 'theme-warm');
    body.classList.add(`theme-${normalized}`);
    document.documentElement.classList.remove('theme-ocean', 'theme-warm');
    document.documentElement.classList.add(`theme-${normalized}`);
}

function getCurrentSystemTheme() {
    const bodyTheme = document.body?.dataset?.uiTheme;
    if (bodyTheme === 'warm' || bodyTheme === 'ocean') return bodyTheme;
    try {
        const saved = localStorage.getItem('ui_theme');
        if (saved === 'warm' || saved === 'ocean') return saved;
    } catch (e) {}
    if (window.__EARLY_UI_THEME === 'warm' || window.__EARLY_UI_THEME === 'ocean') return window.__EARLY_UI_THEME;
    if (window.SYSTEM_UI_THEME === 'warm' || window.SYSTEM_UI_THEME === 'ocean') return window.SYSTEM_UI_THEME;
    return 'ocean';
}

async function saveSystemTheme(theme) {
    const response = await fetch('/admin/settings/ui-theme', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ theme })
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
        throw new Error(extractErrorText(data.error ?? data.detail ?? data.message ?? data.reason) || '保存失败');
    }

    return data.theme || theme;
}

function updateThemeToggleButton(theme) {
    const openBtn = document.getElementById('openThemeSwitcherBtn');
    if (!openBtn) return;
    // 图标化导航：暖调显示太阳、冷调显示月亮，点击切到对侧
    const isWarm = theme === 'warm';
    openBtn.dataset.currentTheme = isWarm ? 'warm' : 'ocean';
    openBtn.setAttribute('aria-label', isWarm ? '切换为冷调' : '切换为暖调');
    openBtn.title = isWarm ? '切换为冷调' : '切换为暖调';
}

function applyUiStyle(styleName) {
    const body = document.body;
    if (!body) return;
    const normalized = String(styleName || '').toLowerCase() === 'classic' ? 'classic' : 'cartoon';
    body.dataset.uiStyle = normalized;
    body.classList.remove('style-classic', 'style-cartoon');
    body.classList.add(`style-${normalized}`);
    document.documentElement.classList.remove('style-classic', 'style-cartoon');
    document.documentElement.classList.add(`style-${normalized}`);
}

function getCurrentUiStyle() {
    const bodyStyle = document.body?.dataset?.uiStyle;
    if (bodyStyle === 'classic' || bodyStyle === 'cartoon') return bodyStyle;
    try {
        const saved = localStorage.getItem('ui_style');
        if (saved === 'classic' || saved === 'cartoon') return saved;
    } catch (e) {}
    if (window.__EARLY_UI_STYLE === 'classic' || window.__EARLY_UI_STYLE === 'cartoon') return window.__EARLY_UI_STYLE;
    return 'cartoon';
}

async function saveUiStyle(style) {
    const response = await fetch('/admin/settings/ui-style', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ style })
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
        throw new Error(extractErrorText(data.error ?? data.detail ?? data.message ?? data.reason) || '保存失败');
    }
    return data.style || style;
}

async function initThemeSwitcher() {
    const isAdmin = !!document.body?.classList.contains('admin-theme');
    const isAuthPage = !!document.body?.classList.contains('auth-page');
    applySystemTheme(getCurrentSystemTheme());
    applyUiStyle(getCurrentUiStyle());

    if (!isAdmin || isAuthPage) return;

    try {
        const [themeRes, styleRes] = await Promise.all([
            fetch('/admin/settings/ui-theme'),
            fetch('/admin/settings/ui-style'),
        ]);
        const themeData = await themeRes.json();
        if (themeRes.ok && themeData.success) {
            applySystemTheme(themeData.theme);
        }
        const styleData = await styleRes.json();
        if (styleRes.ok && styleData.success) {
            applyUiStyle(styleData.style);
            try { localStorage.setItem('ui_style', styleData.style); } catch (e) {}
        }
    } catch (error) {
        console.error('load ui theme/style failed:', error);
    }

    updateThemeToggleButton(getCurrentSystemTheme());

    const openBtn = document.getElementById('openThemeSwitcherBtn');
    if (!openBtn) return;

    openBtn.addEventListener('click', async () => {
        const current = getCurrentSystemTheme();
        const nextTheme = current === 'warm' ? 'ocean' : 'warm';
        try {
            const savedTheme = await saveSystemTheme(nextTheme);
            applySystemTheme(savedTheme);
            try { localStorage.setItem('ui_theme', savedTheme); } catch (e) {}
            updateThemeToggleButton(savedTheme);
            showToast(`已切换为${savedTheme === 'warm' ? '暖调' : '冷调'}主题`, 'success');
        } catch (error) {
            showToast(getFriendlyAdminErrorMessage(error.message || '保存失败', 0, 'settings'), 'error');
        }
    });
}


// ============================================================
// 管理员个人资料：navbar 头像下拉 + 资料弹窗（昵称 + 头像）
// ============================================================
const ADMIN_PROFILE_API = '/admin/settings/profile';
const ADMIN_AVATAR_MAX_BYTES = 1_400_000;

const adminProfileState = {
    nickname: '',
    avatar: '',
    pendingAvatar: null,
};

function adminProfileInitial(nickname) {
    const trimmed = (nickname || '').trim();
    if (!trimmed) return '管';
    const ch = Array.from(trimmed)[0] || '管';
    // 中文不需要 toUpperCase，避免英文字母 lower 也被吞
    return /[a-zA-Z]/.test(ch) ? ch.toUpperCase() : ch;
}

function applyAdminProfileToUI(profile) {
    adminProfileState.nickname = profile.nickname || '';
    adminProfileState.avatar = profile.avatar || '';

    const navImg = document.getElementById('navbarAvatarImg');
    const navFallback = document.getElementById('navbarAvatarFallback');
    if (navImg && navFallback) {
        if (adminProfileState.avatar) {
            navImg.src = adminProfileState.avatar;
            navImg.hidden = false;
            navFallback.hidden = true;
        } else {
            navImg.hidden = true;
            navImg.removeAttribute('src');
            navFallback.hidden = false;
            navFallback.textContent = adminProfileInitial(adminProfileState.nickname);
        }
    }
    const navName = document.getElementById('navbarAvatarName');
    if (navName) navName.textContent = adminProfileState.nickname || '管理员';
}

function setupNavbarAvatarMenu() {
    const wrap = document.getElementById('navbarAvatarWrap');
    const btn = document.getElementById('navbarAvatarBtn');
    const menu = document.getElementById('navbarAvatarMenu');
    if (!wrap || !btn || !menu) return;

    const closeMenu = () => {
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
    };
    const openMenu = () => {
        menu.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
    };
    const toggleMenu = (e) => {
        e.stopPropagation();
        if (menu.hidden) openMenu(); else closeMenu();
    };

    btn.addEventListener('click', toggleMenu);

    document.addEventListener('click', (e) => {
        if (menu.hidden) return;
        if (wrap.contains(e.target)) return;
        closeMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !menu.hidden) closeMenu();
    });

    // 菜单项点击后自动关菜单
    menu.querySelectorAll('.navbar-avatar-menu-item').forEach((item) => {
        item.addEventListener('click', () => closeMenu());
    });
}

async function fetchAdminProfile() {
    try {
        const resp = await fetch(ADMIN_PROFILE_API, { credentials: 'same-origin' });
        const data = await resp.json();
        if (resp.ok && data.success) {
            applyAdminProfileToUI({ nickname: data.nickname || '', avatar: data.avatar || '' });
        }
    } catch (error) {
        console.warn('加载个人资料失败', error);
    }
}

function setProfileModalPreview(dataUrl, nickname) {
    const img = document.getElementById('profileAvatarPreview');
    const fallback = document.getElementById('profileAvatarFallback');
    if (!img || !fallback) return;
    if (dataUrl) {
        img.src = dataUrl;
        img.hidden = false;
        fallback.hidden = true;
    } else {
        img.hidden = true;
        img.removeAttribute('src');
        fallback.hidden = false;
        fallback.textContent = adminProfileInitial(nickname);
    }
}

function openProfileModal() {
    if (typeof showModal !== 'function') return;
    const nicknameInput = document.getElementById('profileNickname');
    if (nicknameInput) nicknameInput.value = adminProfileState.nickname || '';
    adminProfileState.pendingAvatar = null;
    setProfileModalPreview(adminProfileState.avatar, adminProfileState.nickname);
    showModal('profileModal');
}

async function resizeImageToAvatarDataUrl(file, size = 256, quality = 0.86) {
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = reject;
            i.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        // 从中心做正方形裁切
        const min = Math.min(img.naturalWidth, img.naturalHeight);
        const sx = (img.naturalWidth - min) / 2;
        const sy = (img.naturalHeight - min) / 2;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
        // 优先尝试 jpeg 压缩，超阈值时降级
        let dataUrl = canvas.toDataURL('image/jpeg', quality);
        if (dataUrl.length > ADMIN_AVATAR_MAX_BYTES) {
            dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        }
        if (dataUrl.length > ADMIN_AVATAR_MAX_BYTES) {
            // 降到 192x192
            canvas.width = 192;
            canvas.height = 192;
            const ctx2 = canvas.getContext('2d');
            ctx2.fillStyle = '#ffffff';
            ctx2.fillRect(0, 0, 192, 192);
            ctx2.drawImage(img, sx, sy, min, min, 0, 0, 192, 192);
            dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        }
        return dataUrl;
    } finally {
        URL.revokeObjectURL(url);
    }
}

function setupProfileModal() {
    const pickBtn = document.getElementById('profileAvatarPickBtn');
    const clearBtn = document.getElementById('profileAvatarClearBtn');
    const fileInput = document.getElementById('profileAvatarInput');
    const saveBtn = document.getElementById('profileSaveBtn');
    const nicknameInput = document.getElementById('profileNickname');
    if (!pickBtn || !clearBtn || !fileInput || !saveBtn || !nicknameInput) return;

    pickBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            showToast('请选择图片文件', 'warning');
            fileInput.value = '';
            return;
        }
        try {
            const dataUrl = await resizeImageToAvatarDataUrl(file);
            adminProfileState.pendingAvatar = dataUrl;
            setProfileModalPreview(dataUrl, nicknameInput.value);
        } catch (error) {
            console.error('压缩头像失败', error);
            showToast('图片处理失败，请换一张试试', 'error');
        } finally {
            fileInput.value = '';
        }
    });

    clearBtn.addEventListener('click', () => {
        adminProfileState.pendingAvatar = '';
        setProfileModalPreview('', nicknameInput.value);
    });

    nicknameInput.addEventListener('input', () => {
        // 实时刷新 fallback 字母
        const previewImg = document.getElementById('profileAvatarPreview');
        if (previewImg && previewImg.hidden) {
            const fallback = document.getElementById('profileAvatarFallback');
            if (fallback) fallback.textContent = adminProfileInitial(nicknameInput.value);
        }
    });

    saveBtn.addEventListener('click', async () => {
        const nickname = (nicknameInput.value || '').trim().slice(0, 32);
        const avatar = adminProfileState.pendingAvatar !== null
            ? adminProfileState.pendingAvatar
            : adminProfileState.avatar;
        saveBtn.disabled = true;
        try {
            const resp = await fetch(ADMIN_PROFILE_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ nickname, avatar }),
            });
            const data = await resp.json();
            if (!resp.ok || !data.success) {
                throw new Error(data.error || '保存失败');
            }
            applyAdminProfileToUI({ nickname: data.nickname || '', avatar: data.avatar || '' });
            showToast('个人资料已保存', 'success');
            if (typeof hideModal === 'function') hideModal('profileModal');
        } catch (error) {
            showToast(error.message || '保存失败', 'error');
        } finally {
            saveBtn.disabled = false;
        }
    });
}

function initAdminProfile() {
    const isAdmin = !!document.body?.classList.contains('admin-theme');
    if (!isAdmin) return;
    setupNavbarAvatarMenu();
    setupProfileModal();
    // 用模板已经渲染的初始值刷新一次状态（避免再发一次请求时的闪烁）
    const navName = document.getElementById('navbarAvatarName');
    const initialNickname = navName ? (navName.textContent || '').trim() : '';
    const navImg = document.getElementById('navbarAvatarImg');
    adminProfileState.nickname = initialNickname === '管理员' ? '' : initialNickname;
    adminProfileState.avatar = navImg && !navImg.hidden ? (navImg.getAttribute('src') || '') : '';
    fetchAdminProfile();
}

// 暴露给 base.html inline onclick
window.openProfileModal = openProfileModal;


// Toast 提示函数
let toastTimer = null;

function hasVisibleModal() {
    return !!document.querySelector('.modal-overlay.show');
}

function syncToastMountTarget() {
    const toast = document.getElementById('toast');
    if (!toast) return;

    if (toast.parentElement !== document.body) {
        document.body.appendChild(toast);
    }

    toast.classList.toggle('toast-over-modal', hasVisibleModal());
}

function showToast(message, type = 'info', options = {}) {
    const toast = document.getElementById('toast');
    if (!toast) return;

    syncToastMountTarget();

    const iconMap = {
        success: 'check-circle',
        error: 'alert-circle',
        warning: 'alert-triangle',
        info: 'info'
    };
    const titleMap = {
        success: '操作成功',
        error: '操作失败',
        warning: '请注意',
        info: '提示'
    };
    const durationMap = {
        success: 4200,
        error: 5200,
        warning: 4200,
        info: 3000
    };

    const toastType = ['success', 'error', 'warning', 'info'].includes(type) ? type : 'info';
    const icon = iconMap[toastType];
    const title = escapeHtml(String(options.title || titleMap[toastType] || ''));
    const detail = escapeHtml(String(message || ''));
    const duration = Number.isFinite(options.duration) ? Number(options.duration) : (durationMap[toastType] || 3000);

    toast.innerHTML = `
        <div class="toast-icon-wrap">
            <i data-lucide="${icon}"></i>
        </div>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            <div class="toast-message">${detail}</div>
        </div>
    `;
    toast.className = `toast ${toastType} show`;
    toast.classList.toggle('toast-over-modal', hasVisibleModal());

    if (window.lucide) {
        lucide.createIcons();
    }

    if (toastTimer) {
        clearTimeout(toastTimer);
    }

    toastTimer = setTimeout(() => {
        toast.classList.remove('show');
        toastTimer = null;
        syncToastMountTarget();
    }, Math.max(duration, 1200));
}

function mountGlobalOverlayNodes() {
    const nodes = document.querySelectorAll('.modal-overlay, #toast');
    nodes.forEach((node) => {
        if (node && node.parentElement !== document.body) {
            document.body.appendChild(node);
        }
    });

    syncToastMountTarget();
}

// 日期格式化函数
// 后台统一按北京时间渲染（运营时区），避免浏览器时区不同导致同一时刻显示不一致
const BEIJING_TIME_ZONE = 'Asia/Shanghai';

function toBeijingDateTime(date) {
    // sv-SE 的格式恰好是 YYYY-MM-DD HH:mm
    return new Intl.DateTimeFormat('sv-SE', {
        timeZone: BEIJING_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).format(date);
}

function formatDateTime(dateString) {
    if (!dateString) return '-';

    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '-';

    return toBeijingDateTime(date);
}

// 登出函数
async function logout() {
    if (!confirm('确定要登出吗?')) {
        return;
    }

    try {
        const response = await fetch('/auth/logout', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (response.ok && data.success) {
            window.location.href = '/login';
        } else {
            showToast('登出失败', 'error');
        }
    } catch (error) {
        showToast('网络错误', 'error');
    }
}

// API 调用封装
async function apiCall(url, options = {}) {
    try {
        const response = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        });

        const data = await response.json();

        if (!response.ok) {
            const rawError = data?.error ?? data?.detail ?? data?.message ?? data?.reason ?? '请求失败';
            throw new Error(extractErrorText(rawError) || '请求失败');
        }

        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// 确认对话框
function confirmAction(message) {
    return confirm(message);
}


function setSingleImportMode(mode = 'quick') {
    const quickSection = document.getElementById('oauthQuickSection');
    const manualSection = document.getElementById('manualTokenSection');
    if (!quickSection || !manualSection) return;

    const isManual = mode === 'manual';
    quickSection.style.display = isManual ? 'none' : 'block';
    manualSection.style.display = isManual ? 'block' : 'none';

    // display:none 不会让带 required 的控件退出 HTML 表单校验。
    // 切换模式时禁用非当前模式的输入，避免隐藏的 AT 字段阻止提交。
    [quickSection, manualSection].forEach((section) => {
        const inactive = section !== (isManual ? manualSection : quickSection);
        section.querySelectorAll('input, textarea, select').forEach((field) => {
            field.disabled = inactive;
        });
    });
}

function syncResponsiveSidebarMount() {
    const sidebar = document.getElementById('adminSidebar');
    const overlay = document.getElementById('sidebarOverlay');
    const mainContainer = document.querySelector('.main-container');
    const mainContent = document.querySelector('.main-content');
    if (!sidebar || !overlay || !mainContainer || !mainContent) return;

    const isMobileLayout = window.matchMedia('(max-width: 768px)').matches;

    if (isMobileLayout) {
        if (sidebar.parentElement !== document.body) {
            overlay.insertAdjacentElement('afterend', sidebar);
        }
        return;
    }

    if (sidebar.parentElement !== mainContainer) {
        mainContainer.insertBefore(sidebar, mainContent);
    }
}

function prepareFloatingDropdown(menu) {
    if (!menu || !menu.classList.contains('dropdown-menu-floating')) return;

    const wrapper = menu._dropdownWrapper || menu.closest('.dropdown-wrapper');
    if (!wrapper) return;

    menu._dropdownWrapper = wrapper;
    if (menu.parentElement !== document.body) {
        document.body.appendChild(menu);
    }
}

function mountFloatingDropdownsToBody() {
    document.querySelectorAll('.dropdown-menu-floating').forEach((menu) => {
        prepareFloatingDropdown(menu);
    });
}

function positionFloatingDropdown(menu, triggerEl = null) {
    if (!menu || !menu.classList.contains('dropdown-menu-floating')) return;

    prepareFloatingDropdown(menu);

    if (triggerEl) {
        menu._dropdownTrigger = triggerEl;
    }

    const anchor = triggerEl
        || menu._dropdownTrigger
        || menu._dropdownWrapper?.querySelector('.dropdown-toggle')
        || menu._dropdownWrapper;
    if (!anchor) return;

    const anchorRect = anchor.getBoundingClientRect();
    const viewportPadding = 16;
    const menuWidth = Math.min(260, window.innerWidth - viewportPadding * 2);

    let left = anchorRect.left;
    if (left + menuWidth + viewportPadding > window.innerWidth) {
        left = Math.max(viewportPadding, anchorRect.right - menuWidth);
    }
    left = Math.max(viewportPadding, left);

    menu.style.position = 'fixed';
    menu.style.top = `${anchorRect.bottom + 8}px`;
    menu.style.left = `${left}px`;
    menu.style.right = 'auto';
    menu.style.width = `${menuWidth}px`;
    menu.style.maxWidth = 'calc(100vw - 2rem)';
    menu.style.zIndex = '9999';
}

function closeFloatingDropdowns() {
    document.querySelectorAll('.dropdown-menu.show').forEach((menu) => {
        menu.classList.remove('show');
    });
}

// 页面加载完成后执行
document.addEventListener('DOMContentLoaded', function () {
    mountFloatingDropdownsToBody();

    // 检查认证状态
    checkAuthStatus();

    cleanupLegacyThemeSettingsSection();
    initThemeSwitcher();
    initAdminProfile();
    mountGlobalOverlayNodes();
    syncResponsiveSidebarMount();
    window.addEventListener('resize', syncResponsiveSidebarMount);

    // OAuth 一键导入按钮绑定（避免仅依赖内联 onclick）
    const btnOneClickToken = document.getElementById('btnOneClickToken');
    if (btnOneClickToken) {
        btnOneClickToken.addEventListener('click', () => {
            generateOAuthAuthorizeLink();
        });
    }

    const btnParseOAuthCallback = document.getElementById('btnParseOAuthCallback');
    if (btnParseOAuthCallback) {
        btnParseOAuthCallback.addEventListener('click', () => {
            parseOAuthCallbackAndFill();
        });
    }

    const switchToManualFill = document.getElementById('switchToManualFill');
    if (switchToManualFill) {
        switchToManualFill.addEventListener('click', () => setSingleImportMode('manual'));
    }

    const switchToQuickToken = document.getElementById('switchToQuickToken');
    if (switchToQuickToken) {
        switchToQuickToken.addEventListener('click', () => setSingleImportMode('quick'));
    }

    const chooseJsonFileBtn = document.getElementById('chooseJsonFileBtn');
    const jsonImportFile = document.getElementById('jsonImportFile');
    if (chooseJsonFileBtn && jsonImportFile) {
        chooseJsonFileBtn.addEventListener('click', () => jsonImportFile.click());
        jsonImportFile.addEventListener('change', async () => {
            const fileNameNode = document.getElementById('jsonImportFileName');
            if (fileNameNode) {
                fileNameNode.textContent = jsonImportFile.files && jsonImportFile.files[0]
                    ? `已选择：${jsonImportFile.files[0].name}`
                    : '支持单对象、对象数组，或 {"teams": [...]} 格式';
            }
            if (jsonImportFile.files && jsonImportFile.files.length > 0) {
                await handleJsonFileImport();
            }
        });
    }

    setSingleImportMode('quick');
});

// 检查认证状态
async function checkAuthStatus() {
    // 如果在登录页面,跳过检查
    if (window.location.pathname === '/login') {
        return;
    }

    try {
        const response = await fetch('/auth/status');
        const data = await response.json();

        if (!data.authenticated && window.location.pathname.startsWith('/admin')) {
            // 未登录且在管理员页面,跳转到登录页
            window.location.href = '/login';
        }
    } catch (error) {
        console.error('检查认证状态失败:', error);
    }
}

// === 模态框控制逻辑 ===

function showModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('show');
        document.body.style.overflow = 'hidden'; // 防止背景滚动
        document.body.classList.add('modal-open');

        const sidebar = document.getElementById('adminSidebar');
        const overlay = document.getElementById('sidebarOverlay');
        if (sidebar) sidebar.classList.remove('open');
        if (overlay) overlay.classList.remove('show');

        if (modalId === 'importTeamModal') {
            setSingleImportMode('quick');
        }

        syncToastMountTarget();
    }
}

function resetBatchImportForm() {
    const form = document.getElementById('batchImportForm');
    if (!form) return;

    form.reset();

    const fileInput = document.getElementById('jsonImportFile');
    if (fileInput) {
        fileInput.value = '';
    }

    const fileNameNode = document.getElementById('jsonImportFileName');
    if (fileNameNode) {
        fileNameNode.textContent = '支持单对象、对象数组，或 {"teams": [...]} 格式';
    }
}

function hideModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('show');

        const openModal = document.querySelector('.modal-overlay.show');
        if (!openModal) {
            document.body.style.overflow = '';
            document.body.classList.remove('modal-open');
        }

        if (modalId === 'importTeamModal') {
            resetBatchImportForm();
        }

        syncToastMountTarget();
    }
}

function switchModalTab(modalId, tabId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    // 切换按钮状态
    const tabs = modal.querySelectorAll('.modal-tab-btn');
    tabs.forEach(tab => {
        if (tab.getAttribute('onclick').includes(`'${tabId}'`)) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });

    // 切换面板显示
    const panels = modal.querySelectorAll('.import-panel, .card-body');
    panels.forEach(panel => {
        if (panel.id === tabId) {
            panel.style.display = 'block';
        } else {
            panel.style.display = 'none';
        }
    });
}

/**
 * 切换质保时长输入框的显示
 */
function toggleWarrantyDays(checkbox, targetId) {
    const target = document.getElementById(targetId);
    if (target) {
        target.style.display = checkbox.checked ? 'block' : 'none';
    }
}

// === Team 导入逻辑 ===



async function copyTextSilently(text) {
    if (!text) return false;
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (err) {
        console.error('silent copy failed:', err);
    }

    try {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        textArea.style.top = '0';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(textArea);
        return ok;
    } catch (err) {
        console.error('silent fallback copy failed:', err);
        return false;
    }
}

function unwrapApiPayload(result) {
    if (!result || !result.success) return null;
    const body = result.data || {};
    if (body && typeof body === 'object' && body.data && typeof body.data === 'object') {
        return body.data;
    }
    return body;
}

let oauthDraft = {
    codeVerifier: '',
    state: '',
    clientId: ''
};

let oauthParsedCache = null;
let oauthParsedCacheKey = '';

async function generateOAuthAuthorizeLink() {
    const form = document.getElementById('singleImportForm');
    if (!form) return;

    const formClientId = form.clientId ? form.clientId.value.trim() : '';
    const defaultClientId = 'app_EMoamEEZ73f0CkXaXp7hrann';
    const clientId = formClientId || defaultClientId;

    showToast('正在生成并复制授权链接...', 'info');

    try {
        const result = await apiCall('/admin/oauth/openai/authorize', {
            method: 'POST',
            body: JSON.stringify({
                client_id: clientId,
                redirect_uri: 'http://localhost:1455/auth/callback'
            })
        });

        if (!result.success) {
            showToast(getFriendlyAdminErrorMessage(result.error || '生成授权链接失败', 0, 'oauth'), 'error');
            return;
        }

        const data = unwrapApiPayload(result) || {};
        oauthDraft.codeVerifier = data.code_verifier || '';
        oauthDraft.state = data.state || '';
        oauthDraft.clientId = data.client_id || clientId;
        oauthParsedCache = null;
        oauthParsedCacheKey = '';

        document.getElementById('oauthAuthorizeUrlOutput').value = data.authorize_url || '';
        if (form.clientId) form.clientId.value = oauthDraft.clientId;

        const authUrl = (data.authorize_url || '').trim();
        if (!authUrl) {
            showToast('授权链接生成失败，请重试', 'error');
            return;
        }

        const copied = await copyTextSilently(authUrl);
        if (copied) {
            showToast('链接已复制，去浏览器登录后粘贴回调', 'success');
        } else {
            showToast('授权链接已生成，请手动复制', 'warning');
        }
    } catch (error) {
        showToast(getFriendlyAdminErrorMessage(error.message || '生成授权链接失败', 0, 'oauth'), 'error');
    }
}

async function parseOAuthCallbackData(forceRefresh = false) {
    const callbackText = document.getElementById('oauthCallbackInput').value.trim();
    const form = document.getElementById('singleImportForm');

    if (!callbackText) {
        throw new Error('请先粘贴回调 URL');
    }

    if (!forceRefresh && oauthParsedCache && oauthParsedCacheKey === callbackText) {
        return oauthParsedCache;
    }

    const result = await apiCall('/admin/oauth/openai/parse-callback', {
        method: 'POST',
        body: JSON.stringify({
            callback_text: callbackText,
            code_verifier: oauthDraft.codeVerifier || null,
            expected_state: oauthDraft.state || null,
            client_id: ((form.clientId ? form.clientId.value.trim() : '') || oauthDraft.clientId || 'app_EMoamEEZ73f0CkXaXp7hrann'),
            redirect_uri: 'http://localhost:1455/auth/callback'
        })
    });

    if (!result.success) {
        throw new Error(getFriendlyAdminErrorMessage(result.error || '解析回调失败', 0, 'oauth'));
    }

    const parsed = unwrapApiPayload(result) || {};
    oauthParsedCache = parsed;
    oauthParsedCacheKey = callbackText;
    return parsed;
}

function decodeJwtPayload(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;

    try {
        const base64Url = parts[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
        const jsonText = decodeURIComponent(escape(window.atob(padded)));
        return JSON.parse(jsonText);
    } catch (error) {
        return null;
    }
}

function toIsoStringWithOffset8(dateObj) {
    if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) return '';
    const shifted = new Date(dateObj.getTime() + 8 * 60 * 60 * 1000);
    const iso = shifted.toISOString().replace('Z', '+08:00');
    return iso.slice(0, 19) + '+08:00';
}

function normalizeOAuthAccountId(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return '';

    const placeholders = new Set(['default', 'personal', 'none', 'null', 'me', 'self']);
    if (placeholders.has(normalized.toLowerCase())) {
        return '';
    }

    return normalized;
}

function buildOAuthJsonTemplate(parsedData) {
    const accessToken = parsedData.access_token || '';
    const refreshToken = parsedData.refresh_token || '';
    const raw = parsedData.raw || {};
    const idToken = raw.id_token || parsedData.id_token || '';
    const clientId = raw.client_id || parsedData.client_id || '';

    const accessPayload = decodeJwtPayload(accessToken) || {};
    const idPayload = decodeJwtPayload(idToken) || {};
    const accessAuth = accessPayload['https://api.openai.com/auth'] || {};
    const accessProfile = accessPayload['https://api.openai.com/profile'] || {};
    const idAuth = idPayload['https://api.openai.com/auth'] || {};

    const accountId = normalizeOAuthAccountId(
        raw.account_id || parsedData.account_id || accessAuth.chatgpt_account_id || idAuth.chatgpt_account_id || ''
    );
    const email = raw.email || parsedData.email || accessProfile.email || idPayload.email || '';
    const exp = accessPayload.exp ? new Date(accessPayload.exp * 1000) : null;
    const expired = raw.expired || parsedData.expired || (exp ? toIsoStringWithOffset8(exp) : '');

    return {
        access_token: accessToken,
        account_id: accountId,
        client_id: clientId,
        email,
        expired,
        id_token: idToken,
        last_refresh: raw.last_refresh || parsedData.last_refresh || toIsoStringWithOffset8(new Date()),
        refresh_token: refreshToken,
        type: raw.type || parsedData.type || 'codex'
    };
}

async function parseOAuthCallbackAndFill() {
    const form = document.getElementById('singleImportForm');

    try {
        const data = await parseOAuthCallbackData(true);
        const normalized = buildOAuthJsonTemplate(data);
        if (form.accessToken) form.accessToken.value = normalized.access_token || '';
        if (form.idToken) form.idToken.value = normalized.id_token || '';
        if (form.refreshToken) form.refreshToken.value = normalized.refresh_token || '';
        if (form.clientId) form.clientId.value = data.client_id || normalized.client_id || '';
        if (form.email) form.email.value = normalized.email || '';
        if (form.accountId) form.accountId.value = normalized.account_id || '';

        showToast('已自动填充 Token 信息，请确认后导入', 'success');
    } catch (error) {
        showToast(getFriendlyAdminErrorMessage(error.message || '解析回调失败', 0, 'oauth'), 'error');
    }
}


async function handleSingleImport(event) {
    event.preventDefault();
    const form = event.target;
    const accessToken = form.accessToken.value.trim();
    const idToken = form.idToken ? form.idToken.value.trim() : null;
    const refreshToken = form.refreshToken ? form.refreshToken.value.trim() : null;
    const sessionToken = form.sessionToken ? form.sessionToken.value.trim() : null;
    const clientId = form.clientId ? form.clientId.value.trim() : null;
    const email = form.email.value.trim();
    const accountId = form.accountId.value.trim();
    const activeSection = document.getElementById('manualTokenSection')?.style.display !== 'none'
        ? document.getElementById('manualTokenSection')
        : document.getElementById('oauthQuickSection');
    const submitButton = activeSection?.querySelector('button[type="submit"]')
        || form.querySelector('button[type="submit"]');

    submitButton.disabled = true;
    submitButton.textContent = '导入中...';

    try {
        const result = await apiCall('/admin/teams/import', {
            method: 'POST',
            body: JSON.stringify({
                import_type: 'single',
                access_token: accessToken,
                id_token: idToken || null,
                refresh_token: refreshToken || null,
                session_token: sessionToken || null,
                client_id: clientId || null,
                email: email || null,
                account_id: accountId || null,
                pool_type: getCurrentPoolType()
            })
        });

        if (result.success) {
            showToast('Team 导入成功！', 'success');
            form.reset();
            setTimeout(() => location.reload(), 1500);
        } else {
            showToast(getFriendlyAdminErrorMessage(result.error || '导入失败', 0, 'import'), 'error');
        }
    } catch (error) {
        showToast(getFriendlyAdminErrorMessage(error.message || '网络错误', 0, 'import'), 'error');
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = '导入';
    }
}

async function handleBatchImport(event) {
    event.preventDefault();
    const form = event.target;
    const batchContent = (form.batchContent && form.batchContent.value ? form.batchContent.value.trim() : "");
    const submitButton = form.querySelector('button[type="submit"]');

    if (!batchContent) {
        showToast('请输入批量导入内容', 'error');
        return;
    }

    // UI 元素
    const progressContainer = document.getElementById('batchProgressContainer');
    const progressBar = document.getElementById('batchProgressBar');
    const progressStage = document.getElementById('batchProgressStage');
    const progressPercent = document.getElementById('batchProgressPercent');
    const successCountEl = document.getElementById('batchSuccessCount');
    const failedCountEl = document.getElementById('batchFailedCount');
    const resultsContainer = document.getElementById('batchResultsContainer');
    const resultsDiv = document.getElementById('batchResults');
    const finalSummaryEl = document.getElementById('batchFinalSummary');

    // 重置 UI
    progressContainer.style.display = 'block';
    resultsContainer.style.display = 'none';
    progressBar.style.width = '0%';
    progressStage.textContent = '准备导入...';
    progressPercent.textContent = '0%';
    successCountEl.textContent = '0';
    failedCountEl.textContent = '0';
    resultsDiv.innerHTML = '<table class="data-table"><thead><tr><th>邮箱</th><th>状态</th><th>消息</th></tr></thead><tbody id="batchResultsBody"></tbody></table>';
    const resultsBody = document.getElementById('batchResultsBody');

    submitButton.disabled = true;
    submitButton.textContent = '导入中...';
    let shouldResetBatchForm = false;

    try {
        const response = await fetch('/admin/teams/import', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                import_type: 'batch',
                content: batchContent,
                pool_type: getCurrentPoolType()
            })
        });

        if (!response.ok) {
            const rawBody = await response.text();
            let rawError = '请求失败';
            if (rawBody) {
                try {
                    const errData = JSON.parse(rawBody);
                    rawError = errData?.error ?? errData?.detail ?? errData?.message ?? errData?.reason ?? rawBody;
                } catch (_) {
                    rawError = rawBody;
                }
            }
            throw new Error(getFriendlyAdminErrorMessage(rawError, response.status, 'import'));
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const processStreamLine = (line) => {
            if (!line || !line.trim()) return;
            try {
                const trimmed = line.trim();
                if (!trimmed.startsWith('{')) return;
                const data = JSON.parse(trimmed);

                if (data.type === 'start') {
                    progressStage.textContent = `开始导入 (共 ${data.total} 条)...`;
                    // 给用户即时反馈，避免看起来一直卡在 0%
                    progressBar.style.width = '5%';
                    progressPercent.textContent = '5%';
                } else if (data.type === 'progress') {
                    const percent = Math.round((data.current / data.total) * 100);
                    progressBar.style.width = `${percent}%`;
                    progressPercent.textContent = `${percent}%`;
                    progressStage.textContent = `正在导入 ${data.current}/${data.total}...`;
                    successCountEl.textContent = data.success_count;
                    failedCountEl.textContent = data.failed_count;

                    if (data.last_result) {
                        resultsContainer.style.display = 'block';
                        const res = data.last_result;
                        const statusClass = res.success ? 'text-success' : 'text-danger';
                        const statusText = res.success ? '成功' : '失败';
                        const row = document.createElement('tr');
                        row.innerHTML = `
                            <td>${escapeHtml(res.email)}</td>
                            <td class="${statusClass}">${escapeHtml(statusText)}</td>
                            <td>${escapeHtml(res.success ? (res.message || '导入成功') : res.error)}</td>
                        `;
                        resultsBody.insertBefore(row, resultsBody.firstChild);
                    }
                } else if (data.type === 'finish') {
                    progressStage.textContent = '导入完成';
                    progressBar.style.width = '100%';
                    progressPercent.textContent = '100%';
                    finalSummaryEl.textContent = `总数: ${data.total} | 成功: ${data.success_count} | 失败: ${data.failed_count}`;

                    if (data.failed_count === 0) {
                        shouldResetBatchForm = true;
                        showToast('全部导入成功！', 'success');
                    } else {
                        showToast(`导入完成，成功 ${data.success_count} 条，失败 ${data.failed_count} 条`, 'warning');
                    }

                    if (data.success_count > 0) {
                        setTimeout(() => location.reload(), 3000);
                    }
                } else if (data.type === 'error') {
                    showToast(getFriendlyAdminErrorMessage(data.error || '导入失败', 0, 'import'), 'error');
                }
            } catch (e) {
                console.error('解析流数据失败:', e, line);
            }
        };

        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                // 处理最后一段可能没有 \n 结尾的残余数据
                if (buffer && buffer.trim()) {
                    processStreamLine(buffer);
                }
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                processStreamLine(line);
            }
        }
    } catch (error) {
        showToast(getFriendlyAdminErrorMessage(error.message || '网络错误', 0, 'import'), 'error');
    } finally {
        if (shouldResetBatchForm) {
            resetBatchImportForm();
        }
        submitButton.disabled = false;
        submitButton.textContent = '批量导入';
    }
}

async function handleJsonFileImport() {
    const fileInput = document.getElementById('jsonImportFile');
    const form = document.getElementById('batchImportForm');
    const submitButton = form ? form.querySelector('button[type="submit"]') : null;

    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
        showToast('请先选择 JSON 文件', 'error');
        return;
    }

    const file = fileInput.files[0];
    let content = '';
    try {
        content = await file.text();
        JSON.parse(content);
    } catch (error) {
        showToast('JSON 文件格式无效', 'error');
        return;
    }

    if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = 'JSON 导入中...';
    }

    // UI 元素
    const progressContainer = document.getElementById('batchProgressContainer');
    const progressBar = document.getElementById('batchProgressBar');
    const progressStage = document.getElementById('batchProgressStage');
    const progressPercent = document.getElementById('batchProgressPercent');
    const successCountEl = document.getElementById('batchSuccessCount');
    const failedCountEl = document.getElementById('batchFailedCount');
    const resultsContainer = document.getElementById('batchResultsContainer');
    const resultsDiv = document.getElementById('batchResults');
    const finalSummaryEl = document.getElementById('batchFinalSummary');

    // 重置 UI
    progressContainer.style.display = 'block';
    resultsContainer.style.display = 'none';
    progressBar.style.width = '0%';
    progressStage.textContent = '准备 JSON 导入...';
    progressPercent.textContent = '0%';
    successCountEl.textContent = '0';
    failedCountEl.textContent = '0';
    resultsDiv.innerHTML = '<table class="data-table"><thead><tr><th>邮箱</th><th>状态</th><th>消息</th></tr></thead><tbody id="batchResultsBody"></tbody></table>';
    const resultsBody = document.getElementById('batchResultsBody');

    try {
        const response = await fetch('/admin/teams/import', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                import_type: 'json',
                content,
                pool_type: getCurrentPoolType()
            })
        });

        if (!response.ok) {
            const rawBody = await response.text();
            let rawError = '请求失败';
            if (rawBody) {
                try {
                    const errData = JSON.parse(rawBody);
                    rawError = errData?.error ?? errData?.detail ?? errData?.message ?? errData?.reason ?? rawBody;
                } catch (_) {
                    rawError = rawBody;
                }
            }
            throw new Error(getFriendlyAdminErrorMessage(rawError, response.status, 'import'));
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const processStreamLine = (line) => {
            if (!line || !line.trim()) return;
            try {
                const trimmed = line.trim();
                if (!trimmed.startsWith('{')) return;
                const data = JSON.parse(trimmed);

                if (data.type === 'start') {
                    progressStage.textContent = `开始导入 (共 ${data.total} 条)...`;
                    // 让用户看到实时变化，避免看起来一直 0%
                    progressBar.style.width = '5%';
                    progressPercent.textContent = '5%';
                } else if (data.type === 'progress') {
                    const percent = Math.round((data.current / data.total) * 100);
                    progressBar.style.width = `${percent}%`;
                    progressPercent.textContent = `${percent}%`;
                    progressStage.textContent = `正在导入 ${data.current}/${data.total}...`;
                    successCountEl.textContent = data.success_count;
                    failedCountEl.textContent = data.failed_count;

                    if (data.last_result) {
                        resultsContainer.style.display = 'block';
                        const res = data.last_result;
                        const statusClass = res.success ? 'text-success' : 'text-danger';
                        const statusText = res.success ? '成功' : '失败';
                        const row = document.createElement('tr');
                        row.innerHTML = `
                            <td>${escapeHtml(res.email)}</td>
                            <td class="${statusClass}">${escapeHtml(statusText)}</td>
                            <td>${escapeHtml(res.success ? (res.message || '导入成功') : res.error)}</td>
                        `;
                        resultsBody.insertBefore(row, resultsBody.firstChild);
                    }
                } else if (data.type === 'finish') {
                    progressStage.textContent = '导入完成';
                    progressBar.style.width = '100%';
                    progressPercent.textContent = '100%';
                    finalSummaryEl.textContent = `总数: ${data.total} | 成功: ${data.success_count} | 失败: ${data.failed_count}`;

                    if (data.failed_count === 0) {
                        showToast('全部导入成功！', 'success');
                    } else {
                        showToast(`导入完成，成功 ${data.success_count} 条，失败 ${data.failed_count} 条`, 'warning');
                    }

                    if (data.success_count > 0) {
                        setTimeout(() => location.reload(), 3000);
                    }
                } else if (data.type === 'error') {
                    showToast(getFriendlyAdminErrorMessage(data.error || '导入失败', 0, 'import'), 'error');
                }
            } catch (e) {
                console.error('解析流数据失败:', e, line);
            }
        };

        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                if (buffer && buffer.trim()) {
                    processStreamLine(buffer);
                }
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                processStreamLine(line);
            }
        }
    } catch (error) {
        showToast(getFriendlyAdminErrorMessage(error.message || '网络错误', 0, 'import'), 'error');
    } finally {
        if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent = '批量导入';
        }
    }
}

// === 兑换码生成逻辑 ===

function ensureGenerateCodeResultNodes() {
    const singleGenerateEl = document.getElementById('singleGenerate');
    let singleResultEl = document.getElementById('singleResult');
    let generatedCodeEl = document.getElementById('generatedCode');

    if (singleGenerateEl && !singleResultEl) {
        singleResultEl = document.createElement('div');
        singleResultEl.id = 'singleResult';
        singleResultEl.className = 'result-box';
        singleResultEl.style.display = 'none';
        singleResultEl.innerHTML = `
            <h4>生成成功</h4>
            <div class="code-display">
                <code id="generatedCode"></code>
                <button onclick="copyCode()" class="btn btn-sm btn-secondary">复制</button>
            </div>
        `;
        singleGenerateEl.appendChild(singleResultEl);
        generatedCodeEl = singleResultEl.querySelector('#generatedCode');
    } else if (singleResultEl && !generatedCodeEl) {
        generatedCodeEl = document.createElement('code');
        generatedCodeEl.id = 'generatedCode';

        let codeDisplayEl = singleResultEl.querySelector('.code-display');
        if (!codeDisplayEl) {
            codeDisplayEl = document.createElement('div');
            codeDisplayEl.className = 'code-display';
            singleResultEl.appendChild(codeDisplayEl);
        }
        codeDisplayEl.prepend(generatedCodeEl);
    }

    const batchGenerateEl = document.getElementById('batchGenerate');
    let batchResultEl = document.getElementById('batchResult');
    let batchTotalEl = document.getElementById('batchTotal');
    let batchCodesEl = document.getElementById('batchCodes');

    if (batchGenerateEl && !batchResultEl) {
        batchResultEl = document.createElement('div');
        batchResultEl.id = 'batchResult';
        batchResultEl.className = 'result-box';
        batchResultEl.style.display = 'none';
        batchResultEl.innerHTML = `
            <h4>批量生成成功</h4>
            <p>成功生成 <strong id="batchTotal">0</strong> 个兑换码</p>
            <textarea id="batchCodes" readonly rows="5" class="form-control" style="margin: 10px 0;"></textarea>
            <button onclick="copyBatchCodes()" class="btn btn-sm btn-secondary">复制全部</button>
            <button onclick="downloadCodes()" class="btn btn-sm btn-secondary">下载</button>
        `;
        batchGenerateEl.appendChild(batchResultEl);
        batchTotalEl = batchResultEl.querySelector('#batchTotal');
        batchCodesEl = batchResultEl.querySelector('#batchCodes');
    } else if (batchResultEl) {
        if (!batchTotalEl) {
            batchTotalEl = document.createElement('strong');
            batchTotalEl.id = 'batchTotal';
            batchTotalEl.textContent = '0';
            batchResultEl.prepend(batchTotalEl);
        }
        if (!batchCodesEl) {
            batchCodesEl = document.createElement('textarea');
            batchCodesEl.id = 'batchCodes';
            batchCodesEl.readOnly = true;
            batchCodesEl.rows = 5;
            batchCodesEl.className = 'form-control';
            batchCodesEl.style.margin = '10px 0';
            batchResultEl.appendChild(batchCodesEl);
        }
    }

    return {
        generatedCodeEl,
        singleResultEl,
        batchTotalEl,
        batchCodesEl,
        batchResultEl,
    };
}

async function generateSingle(event) {
    event.preventDefault();
    const form = event.target;
    const customCode = form.customCode.value.trim();
    const expiresDays = form.expiresDays.value;
    const hasWarranty = form.hasWarranty.checked;
    const warrantyDays = form.warrantyDays ? form.warrantyDays.value : 30;

    const data = {
        type: 'single',
        has_warranty: hasWarranty,
        warranty_days: parseInt(warrantyDays || 30)
    };
    if (customCode) data.code = customCode;
    if (expiresDays) data.expires_days = parseInt(expiresDays);

    const result = await apiCall('/admin/codes/generate', {
        method: 'POST',
        body: JSON.stringify(data)
    });

    if (result.success) {
        const { generatedCodeEl, singleResultEl } = ensureGenerateCodeResultNodes();
        if (generatedCodeEl && singleResultEl) {
            generatedCodeEl.textContent = result.data.code;
            singleResultEl.style.display = 'block';
        } else {
            console.warn('生成兑换码结果区域缺失，已回退为 toast 展示', {
                hasGeneratedCode: !!generatedCodeEl,
                hasSingleResult: !!singleResultEl,
            });
            hideModal('generateCodeModal');
            showToast(`兑换码生成成功：${result.data.code}`, 'success');
        }
        form.reset();
        if (generatedCodeEl && singleResultEl) {
            showToast('兑换码生成成功', 'success');
        }
        // 如果在列表中，延迟刷新
        if (window.location.pathname === '/admin/codes') {
            setTimeout(() => location.reload(), 2000);
        }
    } else {
        showToast(getFriendlyAdminErrorMessage(result.error || '生成失败', 0, 'common'), 'error');
    }
}

async function generateBatch(event) {
    event.preventDefault();
    const form = event.target;
    const count = parseInt(form.count.value);
    const expiresDays = form.expiresDays.value;
    const hasWarranty = form.hasWarranty.checked;
    const warrantyDays = form.warrantyDays ? form.warrantyDays.value : 30;

    if (count < 1 || count > 1000) {
        showToast('生成数量必须在1-1000之间', 'error');
        return;
    }

    const data = {
        type: 'batch',
        count: count,
        has_warranty: hasWarranty,
        warranty_days: parseInt(warrantyDays || 30)
    };
    if (expiresDays) data.expires_days = parseInt(expiresDays);

    const result = await apiCall('/admin/codes/generate', {
        method: 'POST',
        body: JSON.stringify(data)
    });

    if (result.success) {
        const { batchTotalEl, batchCodesEl, batchResultEl } = ensureGenerateCodeResultNodes();
        if (batchTotalEl && batchCodesEl && batchResultEl) {
            batchTotalEl.textContent = result.data.total;
            batchCodesEl.value = result.data.codes.join('\n');
            batchResultEl.style.display = 'block';
        } else {
            console.warn('批量生成结果区域缺失，已回退为 toast 展示', {
                hasBatchTotal: !!batchTotalEl,
                hasBatchCodes: !!batchCodesEl,
                hasBatchResult: !!batchResultEl,
            });
            hideModal('generateCodeModal');
            showToast(`成功生成 ${result.data.total} 个兑换码`, 'success');
        }
        form.reset();
        if (batchTotalEl && batchCodesEl && batchResultEl) {
            showToast(`成功生成 ${result.data.total} 个兑换码`, 'success');
        }
        if (window.location.pathname === '/admin/codes') {
            setTimeout(() => location.reload(), 3000);
        }
    } else {
        showToast(getFriendlyAdminErrorMessage(result.error || '生成失败', 0, 'common'), 'error');
    }
}

// 统一复制到剪贴板函数
async function copyToClipboard(text) {
    if (!text) return;

    try {
        // 尝试使用 Modern Clipboard API
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            showToast('已复制到剪贴板', 'success');
            return true;
        }
    } catch (err) {
        console.error('Modern copy failed:', err);
    }

    // Fallback: 使用 textarea 方式
    try {
        const textArea = document.createElement("textarea");
        textArea.value = text;

        // 确保 textarea 不可见且不影响布局
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        textArea.style.top = "0";
        textArea.style.opacity = "0";
        document.body.appendChild(textArea);

        textArea.focus();
        textArea.select();

        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);

        if (successful) {
            showToast('已复制到剪贴板', 'success');
            return true;
        }
    } catch (err) {
        console.error('Fallback copy failed:', err);
    }

    showToast('复制失败', 'error');
    return false;
}

// === 辅助函数 ===

function copyCode(code) {
    // 如果没有传入 code，尝试从生成结果中获取
    if (!code) {
        const generatedCodeEl = document.getElementById('generatedCode');
        code = generatedCodeEl ? generatedCodeEl.textContent : '';
    }

    if (code) {
        copyToClipboard(code);
    } else {
        showToast('无内容可复制', 'error');
    }
}

function copyBatchCodes() {
    const codes = document.getElementById('batchCodes').value;
    copyToClipboard(codes);
}

function copyWelfareCode() {
    const el = document.getElementById('welfareCommonCodeValue');
    const code = el ? String(el.value || '').trim() : '';
    if (!code || code === '-') {
        showToast('暂无可复制的通用兑换码', 'warning');
        return;
    }
    copyToClipboard(code);
}

function downloadCodes() {
    const codes = document.getElementById('batchCodes').value;
    const blob = new Blob([codes], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `redemption_codes_${new Date().getTime()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('下载成功', 'success');
}
// === 成员管理逻辑 ===

async function viewMembers(teamId, teamEmail = '') {
    window.currentTeamId = teamId;
    const modal = document.getElementById('manageMembersModal');
    if (!modal) return;

    // 设置基本信息
    document.getElementById('modalTeamEmail').textContent = teamEmail;

    // 打开模态框
    showModal('manageMembersModal');

    // 加载成员列表
    await loadModalMemberList(teamId);
}

function seatTypeBadge(seatType) {
    if (seatType === 'prolite') {
        return '<span class="seat-chip seat-chip-prolite" title="Premium seats (prolite)：高级席位">高级</span>';
    }
    if (seatType === 'default') {
        return '<span class="seat-chip seat-chip-default" title="Standard seats (default)：普通席位">普通</span>';
    }
    return '<span class="text-muted">-</span>';
}

// 「定时踢人」总开关状态，由成员列表接口随列表下发。
// 未知时按"已启用"处理，避免接口异常时误报。
let timedKickGloballyEnabled = true;

function setTimedKickSwitchState(enabled) {
    timedKickGloballyEnabled = enabled !== false;

    const warning = document.getElementById('timedKickSwitchWarning');
    if (warning) {
        warning.hidden = timedKickGloballyEnabled;
    }
}

function kickTimeCell(member) {
    if (!member.kick_at) {
        return '<span class="text-muted">不限时</span>';
    }
    const label = formatDateTime(member.kick_at);

    // 总开关关着时，任何已配置的到期时间都不会被执行；此时显示"待踢出"
    // 会让人以为后台马上会处理，必须换成明确的"未启用"。
    if (!timedKickGloballyEnabled) {
        return `<span class="seat-detail">${label}</span> `
            + '<span class="seat-chip seat-chip-disabled" title="已配置踢出时间，但「定时踢人」总开关未启用，后台不会执行踢出。请到「系统设置 → 定时踢人」启用并保存。">未启用</span>';
    }

    const kickAt = new Date(member.kick_at);
    if (!isNaN(kickAt.getTime()) && kickAt.getTime() <= Date.now()) {
        return `<span class="seat-detail">${label}</span> `
            + '<span class="seat-chip seat-chip-pending" title="已到点，等待宽限结束后由后台踢出">待踢出</span>';
    }
    return `<span class="seat-detail">${label}</span>`;
}

function timedKickCheckbox(member, teamId) {
    if (member.role === 'account-owner') {
        return '<span class="text-muted" title="车主不可配置">-</span>';
    }
    return `<input type="checkbox" class="timed-kick-checkbox" data-status="${member.status}"
        value="${escapeHtml(member.email)}"
        onchange="updateTimedKickSelectedCount()">`;
}

function collectTimedKickSelection() {
    return Array.from(document.querySelectorAll('.timed-kick-checkbox:checked'))
        .map(box => box.value);
}

function updateTimedKickSelectedCount() {
    const boxes = Array.from(document.querySelectorAll('.timed-kick-checkbox'));

    // 勾选的行整体高亮，长表格里也能看清选中范围
    boxes.forEach(box => {
        const row = box.closest('tr');
        if (row) row.classList.toggle('member-row-selected', box.checked);
    });

    const checked = boxes.filter(box => box.checked).length;
    const counter = document.getElementById('timedKickSelectedCount');
    if (counter) counter.textContent = String(checked);

    const badge = document.getElementById('timedKickCountBadge');
    if (badge) badge.classList.toggle('is-active', checked > 0);
}

// 选完时间给一行预览，并即时拦掉已过去的时刻
function updateTimedKickPreview() {
    const preview = document.getElementById('timedKickPreview');
    const input = document.getElementById('timedKickAt');
    if (!preview) return;

    const value = input ? input.value : '';
    if (!value) {
        preview.className = 'kick-time-preview';
        preview.textContent = '勾选子号后选择踢出时刻（北京时间，精确到分）';
        return;
    }

    // 输入框里的值本身就是"北京时间的墙钟时间"，直接和当前北京时间做字典序比较，
    // 这样不依赖浏览器所在时区
    const pickedWall = value.replace('T', ' ').slice(0, 16);
    const nowWall = toBeijingDateTime(new Date());

    if (pickedWall <= nowWall) {
        preview.className = 'kick-time-preview is-invalid';
        preview.textContent = `所选时刻 ${pickedWall} 已经过去，请重新选择`;
        return;
    }

    preview.className = 'kick-time-preview is-ready';
    preview.textContent =
        `将于 ${pickedWall}（北京时间）踢出；到点后宽限若干分钟再由后台执行，只移除成员、保留兑换码`;
}

function toggleTimedKickAll(status, checked) {
    document.querySelectorAll(`.timed-kick-checkbox[data-status="${status}"]`)
        .forEach(box => { box.checked = checked; });
    updateTimedKickSelectedCount();
}

// ===== 定时踢人：自绘日历（原生 datetime-local 的面板无法套用后台的卡通风格）=====

const kickCalState = {
    viewYear: 0,
    viewMonth: 0,
    selected: null
};

function pad2(value) {
    return String(value).padStart(2, '0');
}

// 北京时间「墙钟时间」的各个字段，不经过 Date 的时区转换
function beijingNowParts() {
    const m = toBeijingDateTime(new Date()).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
    return {
        year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
        hour: Number(m[4]), minute: Number(m[5])
    };
}

function kickValueFromParts(parts) {
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
        + `T${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

function parseKickValue(value) {
    if (!value) return null;
    const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (!m) return null;
    return {
        year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
        hour: Number(m[4]), minute: Number(m[5])
    };
}

// 用 UTC 运算做"北京时间墙钟"的日期加减，避免浏览器时区干扰
function kickPartsAddDays(parts, days) {
    const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    d.setUTCDate(d.getUTCDate() + days);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function kickPartsAddHours(parts, hours) {
    const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
    d.setUTCHours(d.getUTCHours() + hours);
    return {
        year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
        hour: d.getUTCHours(), minute: d.getUTCMinutes()
    };
}

function kickDaysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// 周一作为一周第一天
function kickFirstWeekdayOffset(year, month) {
    const weekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0=周日
    return (weekday + 6) % 7;
}

function defaultKickParts() {
    return kickPartsAddHours({ ...beijingNowParts(), minute: 0 }, 4);
}

function defaultTimedKickAtValue() {
    return kickValueFromParts(defaultKickParts());
}

function renderKickCalendar() {
    const title = document.getElementById('kickCalTitle');
    const daysBox = document.getElementById('kickCalDays');
    if (!title || !daysBox) return;

    title.textContent = `${kickCalState.viewYear} 年 ${kickCalState.viewMonth} 月`;

    const now = beijingNowParts();
    const selected = kickCalState.selected;
    const offset = kickFirstWeekdayOffset(kickCalState.viewYear, kickCalState.viewMonth);
    const total = kickDaysInMonth(kickCalState.viewYear, kickCalState.viewMonth);

    let html = '';
    for (let i = 0; i < offset; i += 1) {
        html += '<span class="kick-cal-day is-empty"></span>';
    }
    for (let day = 1; day <= total; day += 1) {
        const classes = ['kick-cal-day'];
        if (selected
            && selected.year === kickCalState.viewYear
            && selected.month === kickCalState.viewMonth
            && selected.day === day) {
            classes.push('is-selected');
        }
        if (now.year === kickCalState.viewYear
            && now.month === kickCalState.viewMonth
            && now.day === day) {
            classes.push('is-today');
        }
        html += `<button type="button" class="${classes.join(' ')}" onclick="pickKickDay(${day})">${day}</button>`;
    }
    daysBox.innerHTML = html;

    const hourSelect = document.getElementById('kickCalHour');
    const minuteSelect = document.getElementById('kickCalMinute');
    if (hourSelect && hourSelect.options.length === 0) {
        for (let hour = 0; hour < 24; hour += 1) {
            hourSelect.add(new Option(pad2(hour), String(hour)));
        }
    }
    if (minuteSelect && minuteSelect.options.length === 0) {
        for (let minute = 0; minute < 60; minute += 1) {
            minuteSelect.add(new Option(pad2(minute), String(minute)));
        }
    }
    if (selected) {
        if (hourSelect) hourSelect.value = String(selected.hour);
        if (minuteSelect) minuteSelect.value = String(selected.minute);
    }
}

function readKickCalendarTime() {
    if (!kickCalState.selected) return;
    const hourSelect = document.getElementById('kickCalHour');
    const minuteSelect = document.getElementById('kickCalMinute');
    if (hourSelect) kickCalState.selected.hour = Number(hourSelect.value) || 0;
    if (minuteSelect) kickCalState.selected.minute = Number(minuteSelect.value) || 0;
}

function toggleKickCalendar() {
    const calendar = document.getElementById('kickCalendar');
    if (!calendar) return;
    if (calendar.hidden) {
        openKickCalendar();
    } else {
        closeKickCalendar();
    }
}

function openKickCalendar() {
    const picker = document.getElementById('kickTimePicker');
    const calendar = document.getElementById('kickCalendar');
    const trigger = document.getElementById('kickTimeTrigger');
    if (!picker || !calendar) return;

    const hidden = document.getElementById('timedKickAt');
    const selected = parseKickValue(hidden ? hidden.value : '') || defaultKickParts();
    kickCalState.selected = selected;
    kickCalState.viewYear = selected.year;
    kickCalState.viewMonth = selected.month;

    renderKickCalendar();
    calendar.hidden = false;
    positionKickCalendar();
    picker.classList.add('is-open');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
}

// 日历是 fixed 定位、挂在 body 下，所以要自己算位置：
// 默认贴在触发按钮下方，放不下就翻到上方，并保证不超出视口
function positionKickCalendar() {
    const trigger = document.getElementById('kickTimeTrigger');
    const calendar = document.getElementById('kickCalendar');
    if (!trigger || !calendar || calendar.hidden) return;

    const anchor = trigger.getBoundingClientRect();
    const margin = 10;
    const viewportPadding = 12;

    calendar.style.visibility = 'hidden';
    const size = calendar.getBoundingClientRect();

    let top = anchor.bottom + margin;
    if (top + size.height > window.innerHeight - viewportPadding) {
        const above = anchor.top - margin - size.height;
        top = above >= viewportPadding
            ? above
            : Math.max(viewportPadding, window.innerHeight - viewportPadding - size.height);
    }

    let left = anchor.left;
    if (left + size.width > window.innerWidth - viewportPadding) {
        left = Math.max(viewportPadding, window.innerWidth - viewportPadding - size.width);
    }

    calendar.style.top = `${Math.round(top)}px`;
    calendar.style.left = `${Math.round(left)}px`;
    calendar.style.visibility = '';
}

function closeKickCalendar() {
    const picker = document.getElementById('kickTimePicker');
    const calendar = document.getElementById('kickCalendar');
    const trigger = document.getElementById('kickTimeTrigger');
    if (calendar) calendar.hidden = true;
    if (picker) picker.classList.remove('is-open');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

function shiftKickMonth(delta) {
    let month = kickCalState.viewMonth + delta;
    let year = kickCalState.viewYear;
    if (month < 1) { month = 12; year -= 1; }
    if (month > 12) { month = 1; year += 1; }
    kickCalState.viewYear = year;
    kickCalState.viewMonth = month;
    renderKickCalendar();
}

function pickKickDay(day) {
    const base = kickCalState.selected || defaultKickParts();
    readKickCalendarTime();
    kickCalState.selected = {
        ...base,
        year: kickCalState.viewYear,
        month: kickCalState.viewMonth,
        day
    };
    renderKickCalendar();
}

function quickKickTime(kind) {
    const now = beijingNowParts();
    const target = kind === 'tomorrow'
        ? { ...kickPartsAddDays(now, 1), hour: 12, minute: 0 }
        : { ...now, hour: 23, minute: 59 };

    kickCalState.selected = target;
    kickCalState.viewYear = target.year;
    kickCalState.viewMonth = target.month;
    renderKickCalendar();
}

// 把选中的时刻写回隐藏字段与展示文本
function setTimedKickValue(value) {
    const hidden = document.getElementById('timedKickAt');
    const display = document.getElementById('timedKickAtDisplay');
    const parts = parseKickValue(value);

    if (hidden) hidden.value = parts ? value : '';
    if (display) {
        display.textContent = parts
            ? `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}`
            : '选择踢出时间';
        display.classList.toggle('is-placeholder', !parts);
    }
    updateTimedKickPreview();
}

function confirmKickCalendar() {
    readKickCalendarTime();
    if (kickCalState.selected) {
        setTimedKickValue(kickValueFromParts(kickCalState.selected));
    }
    closeKickCalendar();
}

// 点击外部 / Esc 关闭
document.addEventListener('click', (event) => {
    const calendar = document.getElementById('kickCalendar');
    const picker = document.getElementById('kickTimePicker');
    if (!calendar || calendar.hidden) return;

    // 点日期会重渲染整个日期网格，event.target 随即被移出 DOM，
    // 这时 calendar.contains(event.target) 会是 false 而误判成"点了外部"。
    // composedPath() 在派发时就固定了祖先链，用它判断才可靠。
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (path.includes(calendar) || (picker && path.includes(picker))) return;

    closeKickCalendar();
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeKickCalendar();
});

// 弹窗内容滚动或窗口尺寸变化时，日历跟着触发按钮走
window.addEventListener('resize', positionKickCalendar);
document.addEventListener('scroll', positionKickCalendar, true);

function resetTimedKickControls() {
    document.querySelectorAll('.timed-kick-checkbox').forEach(box => { box.checked = false; });
    const allJoined = document.getElementById('timedKickSelectAllJoined');
    const allInvited = document.getElementById('timedKickSelectAllInvited');
    if (allJoined) allJoined.checked = false;
    if (allInvited) allInvited.checked = false;
    closeKickCalendar();
    setTimedKickValue(defaultTimedKickAtValue());
    updateTimedKickSelectedCount();
}

async function applyTimedKick(cancel) {
    const teamId = window.currentTeamId;
    const emails = collectTimedKickSelection();

    if (!teamId) {
        showToast('无法获取 Team ID', 'error');
        return;
    }
    if (!emails.length) {
        showToast('请先勾选要配置的子号', 'error');
        return;
    }

    let kickAt = null;
    if (!cancel) {
        const atInput = document.getElementById('timedKickAt');
        kickAt = atInput ? atInput.value : '';
        if (!kickAt) {
            showToast('请选择踢出时间（北京时间）', 'error');
            return;
        }
    }

    const submitBtn = document.getElementById('timedKickApplyBtn');
    const originalText = submitBtn ? submitBtn.innerHTML : '';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '处理中...';
    }

    try {
        const result = await apiCall(`/admin/teams/${teamId}/members/kick-time`, {
            method: 'POST',
            body: JSON.stringify({ emails, kick_at: kickAt })
        });

        if (result.success) {
            const data = result.data || {};
            if (data.warning) {
                // 时间写库成功但不会被执行：必须让管理员看见，不能只报"成功"
                showToast(data.warning, 'error');
            } else {
                showToast(data.message || (cancel ? '已取消定时踢人' : '踢出时间已设置'), 'success');
            }
            setTimedKickSwitchState(data.timed_kick_enabled);
            await loadModalMemberList(teamId);
        } else {
            showToast(getFriendlyAdminErrorMessage(result.error || '配置失败', 0, 'member'), 'error');
        }
    } catch (error) {
        showToast('网络错误', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalText;
        }
    }
}

async function loadModalMemberList(teamId) {
    const joinedTableBody = document.getElementById('modalJoinedMembersTableBody');
    const invitedTableBody = document.getElementById('modalInvitedMembersTableBody');

    if (joinedTableBody) joinedTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 2rem;">加载中...</td></tr>';
    if (invitedTableBody) invitedTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 2rem;">加载中...</td></tr>';

    try {
        const result = await apiCall(`/admin/teams/${teamId}/members/list`);
        if (result.success) {
            setTimedKickSwitchState(result.data.timed_kick_enabled);
            const allMembers = result.data.members || [];
            const joinedMembers = allMembers.filter(m => m.status === 'joined');
            const invitedMembers = allMembers.filter(m => m.status === 'invited');

            // 渲染已加入成员
            if (joinedTableBody) {
                if (joinedMembers.length === 0) {
                    joinedTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 1.5rem; color: var(--text-muted);">暂无已加入成员</td></tr>';
                } else {
                    joinedTableBody.innerHTML = joinedMembers.map(m => `
                        <tr>
                            <td>${timedKickCheckbox(m, teamId)}</td>
                            <td>${escapeHtml(m.email)}</td>
                            <td>
                                <span class="role-badge role-${m.role === 'account-owner' ? 'account-owner' : 'member'}">
                                    ${m.role === 'account-owner' ? '所有者' : '成员'}
                                </span>
                            </td>
                            <td>${seatTypeBadge(m.seat_type)}</td>
                            <td>${kickTimeCell(m)}</td>
                            <td>${formatDateTime(m.added_at)}</td>
                            <td style="text-align: right;">
                                ${m.role !== 'account-owner' ? `
                                    <button onclick='deleteMember(${JSON.stringify(teamId)}, ${JSON.stringify(m.user_id)}, ${JSON.stringify(m.email)}, true)' class="btn btn-sm btn-danger">
                                        <i data-lucide="trash-2"></i> 删除
                                    </button>
                                ` : '<span class="text-muted">不可删除</span>'}
                            </td>
                        </tr>
                    `).join('');
                }
            }

            // 渲染待加入成员
            if (invitedTableBody) {
                if (invitedMembers.length === 0) {
                    invitedTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 1.5rem; color: var(--text-muted);">暂无待加入成员</td></tr>';
                } else {
                    invitedTableBody.innerHTML = invitedMembers.map(m => `
                        <tr>
                            <td>${timedKickCheckbox(m, teamId)}</td>
                            <td>${escapeHtml(m.email)}</td>
                            <td>
                                <span class="role-badge role-member">成员</span>
                            </td>
                            <td>${seatTypeBadge(m.seat_type)}</td>
                            <td>${kickTimeCell(m)}</td>
                            <td>${formatDateTime(m.added_at)}</td>
                            <td style="text-align: right;">
                                <button onclick='revokeInvite(${JSON.stringify(teamId)}, ${JSON.stringify(m.email)}, true)' class="btn btn-sm btn-warning">
                                    <i data-lucide="undo"></i> 撤回
                                </button>
                            </td>
                        </tr>
                    `).join('');
                }
            }

            resetTimedKickControls();
            if (window.lucide) lucide.createIcons();
        } else {
            const friendlyError = getFriendlyAdminErrorMessage(result.error || '加载失败', 0, 'member');
            const errorMsg = `<tr><td colspan="7" style="text-align: center; color: var(--danger);">${escapeHtml(friendlyError)}</td></tr>`;
            if (joinedTableBody) joinedTableBody.innerHTML = errorMsg;
            if (invitedTableBody) invitedTableBody.innerHTML = errorMsg;
        }
    } catch (error) {
        const errorMsg = '<tr><td colspan="4" style="text-align: center; color: var(--danger);">加载失败</td></tr>';
        if (joinedTableBody) joinedTableBody.innerHTML = errorMsg;
        if (invitedTableBody) invitedTableBody.innerHTML = errorMsg;
    }
}

async function revokeInvite(teamId, email, inModal = false) {
    if (!confirm(`确定要撤回对 "${email}" 的邀请吗？`)) {
        return;
    }

    try {
        showToast('正在撤回...', 'info');
        const result = await apiCall(`/admin/teams/${teamId}/invites/revoke`, {
            method: 'POST',
            body: JSON.stringify({ email: email })
        });

        if (result.success) {
            showToast('撤回成功', 'success');
            if (inModal) {
                await loadModalMemberList(teamId);
            } else {
                setTimeout(() => location.reload(), 1000);
            }
        } else {
            showToast(getFriendlyAdminErrorMessage(result.error || '撤回失败', 0, 'member'), 'error');
        }
    } catch (error) {
        showToast(getFriendlyAdminErrorMessage(error.message || '网络错误', 0, 'member'), 'error');
    }
}

function parseMemberEmails(rawValue) {
    return String(rawValue || '')
        .split(/[\n,，]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

async function handleAddMember(event) {
    event.preventDefault();
    const form = event.target;
    const rawEmails = form.memberEmails ? form.memberEmails.value : '';
    const emails = parseMemberEmails(rawEmails);
    const seatTypeField = document.getElementById('memberSeatType');
    const seatType = (seatTypeField && seatTypeField.value) || 'default';
    const submitButton = document.getElementById('addMemberSubmitBtn');
    const teamId = window.currentTeamId;

    if (!teamId) {
        showToast('无法获取 Team ID', 'error');
        return;
    }

    if (!emails.length) {
        showToast('请至少输入一个邮箱', 'error');
        return;
    }

    submitButton.disabled = true;
    const originalText = submitButton.innerHTML;
    submitButton.textContent = '发送中...';

    try {
        const result = await apiCall(`/admin/teams/${teamId}/members/add`, {
            method: 'POST',
            body: JSON.stringify({ emails, seat_type: seatType })
        });

        if (!result.success) {
            showToast(getFriendlyAdminErrorMessage(result.error || '添加失败', 0, 'member'), 'error');
            return;
        }

        const data = result.data || {};
        const summary = data.summary || {};
        const invitedCount = Number(summary.invited || 0);
        const failedCount = Number(summary.failed || 0) + Number(summary.invalid || 0) + Number(summary.duplicate || 0) + Number(summary.already_exists || 0) + Number(summary.no_seat || 0) + Number(summary.not_processed || 0);
        const message = data.message || `成功 ${invitedCount} 个，失败 ${failedCount} 个`;

        if (invitedCount > 0 && failedCount > 0) {
            showToast(message, 'warning');
        } else if (invitedCount > 0) {
            showToast(message, 'success');
            form.reset();
        } else {
            showToast(getFriendlyAdminErrorMessage(message || '添加失败', 0, 'member'), 'error');
        }

        if (invitedCount > 0 && document.getElementById('manageMembersModal').classList.contains('show')) {
            await loadModalMemberList(teamId);
            if (failedCount === 0) {
                setTimeout(() => {
                    window.location.reload();
                }, 800);
            }
        }
    } catch (error) {
        showToast(getFriendlyAdminErrorMessage(error.message || '网络错误', 0, 'member'), 'error');
    } finally {
        submitButton.disabled = false;
        submitButton.innerHTML = originalText;
    }
}

async function deleteMember(teamId, userId, email, inModal = false) {
    if (!confirm(`确定要删除成员 "${email}" 吗?\n\n此操作不可恢复!`)) {
        return;
    }

    try {
        showToast('正在删除...', 'info');
        const result = await apiCall(`/admin/teams/${teamId}/members/${userId}/delete`, {
            method: 'POST',
            body: JSON.stringify({ email })
        });

        if (result.success) {
            showToast('删除成功', 'success');
            if (inModal) {
                await loadModalMemberList(teamId);
            } else {
                setTimeout(() => location.reload(), 1000);
            }
        } else {
            showToast(getFriendlyAdminErrorMessage(result.error || '删除失败', 0, 'member'), 'error');
        }
    } catch (error) {
        showToast(getFriendlyAdminErrorMessage(error.message || '网络错误', 0, 'member'), 'error');
    }
}


// 确保内联 onclick 在任何加载模式下都可调用
if (typeof window !== 'undefined') {
    window.generateOAuthAuthorizeLink = generateOAuthAuthorizeLink;
    window.parseOAuthCallbackAndFill = parseOAuthCallbackAndFill;
    window.handleJsonFileImport = handleJsonFileImport;
    window.copyWelfareCode = copyWelfareCode;
    window.updateWelfareCodeTeamHint = updateWelfareCodeTeamHint;
}


function updateWelfareCodeTeamHint() {
    const select = document.getElementById('welfareCodeTeamSelect');
    const hint = document.getElementById('welfareCodeTeamHint');
    if (!select || !hint) return;

    const option = select.options[select.selectedIndex];
    if (!option || !option.value) {
        hint.textContent = '请选择要作为号池的福利 Team。';
        return;
    }

    const teamName = option.dataset.teamName || option.textContent || '';
    const teamEmail = option.dataset.teamEmail || '';
    const remaining = option.dataset.remaining || '0';
    hint.textContent = `将为 ${teamName}${teamEmail ? `（${teamEmail}）` : ''} 生成兑换码，当前剩余可用次数 ${remaining}。`;
}

async function generateWelfareCode() {
    const pageBtn = document.getElementById('generateWelfareCodeBtn');
    const confirmBtn = document.getElementById('confirmGenerateWelfareCodeBtn');
    const teamSelect = document.getElementById('welfareCodeTeamSelect');
    const selectedTeamId = teamSelect ? Number(teamSelect.value || 0) : 0;

    if (!selectedTeamId) {
        showToast('请先选择一个福利 Team', 'error');
        return;
    }

    try {
        if (pageBtn) pageBtn.disabled = true;
        if (confirmBtn) confirmBtn.disabled = true;

        const result = await apiCall('/admin/welfare/code/generate', {
            method: 'POST',
            body: JSON.stringify({ team_id: selectedTeamId })
        });
        if (!result.success) throw new Error(result.error || '生成失败');

        const payload = result.data || {};
        const newCode = payload.code || '';
        const used = typeof payload.used === 'number' ? payload.used : 0;
        const limit = typeof payload.limit === 'number' ? payload.limit : 0;
        const remaining = typeof payload.remaining === 'number' ? payload.remaining : Math.max(limit - used, 0);
        const teamName = payload.team_name || '';
        const teamEmail = payload.team_email || '';

        const codeValueEl = document.getElementById('welfareCommonCodeValue');
        if (codeValueEl) codeValueEl.value = newCode;

        const codeTextEl = document.getElementById('welfareCommonCodeText');
        if (codeTextEl) {
            codeTextEl.textContent = newCode || '-';
            codeTextEl.title = newCode || '';
        }

        const usageTextEl = document.getElementById('welfareCodeUsageText');
        if (usageTextEl) {
            usageTextEl.textContent = `剩余次数 ${remaining} / ${limit}`;
        }

        const sourceTextEl = document.getElementById('welfareCodeSourceTeamText');
        if (sourceTextEl) {
            sourceTextEl.textContent = `来源 Team：${teamName || ('#' + selectedTeamId)}${teamEmail ? `（${teamEmail}）` : ''}`;
        }

        const copyBtn = document.getElementById('copyWelfareCodeBtn');
        if (copyBtn) copyBtn.disabled = !newCode;

        hideModal('welfareCodeTeamModal');
        await copyToClipboard(newCode || '');
        showToast(`通用兑换码已更新并复制，剩余次数 ${remaining}/${limit}`, 'success');
    } catch (error) {
        showToast(getFriendlyAdminErrorMessage(error.message || '生成通用兑换码失败', 0, 'common'), 'error');
    } finally {
        if (pageBtn) pageBtn.disabled = false;
        if (confirmBtn) confirmBtn.disabled = false;
    }
}
