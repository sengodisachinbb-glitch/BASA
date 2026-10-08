// ============================================
// LIQUID MUSIC — Complete Application Engine
// ============================================

// 1. STATE & CONFIG
let savedPrevTracks = [];
try {
    savedPrevTracks = JSON.parse(localStorage.getItem('basa_previous_tracks') || '[]');
} catch (e) {}

let savedQueueTracks = [];
try {
    savedQueueTracks = JSON.parse(localStorage.getItem('basa_queue') || '[]');
} catch (e) {}

const state = {
    user: null,
    token: localStorage.getItem('basa_token') || localStorage.getItem('liquid_music_token'),
    currentView: 'home',
    currentPlaylistId: null,
    playlists: [],
    likedTrackIds: new Set(),
    queue: Array.isArray(savedQueueTracks) ? savedQueueTracks : [],
    queueIndex: -1,
    previousTracks: Array.isArray(savedPrevTracks) ? savedPrevTracks : [],
    isPlaying: false,
    shuffle: false,
    repeat: 'none',
    volume: parseInt(localStorage.getItem('basa_volume') || localStorage.getItem('liquid_music_volume') || '80'),
    searchTimeout: null,
    currentTrack: null,
    currentCanonicalTrackId: null,
    recentCanonicalTrackIds: [],
    queueActiveTab: 'upnext',
    recommendedQueue: [],
    isFetchingRecommendations: false,
    currentTrackStartTime: 0
};

function saveQueueState() {
    try {
        localStorage.setItem('basa_previous_tracks', JSON.stringify(state.previousTracks.slice(-50)));
        localStorage.setItem('basa_queue', JSON.stringify(state.queue.slice(0, 100)));
    } catch (e) {}
}

// Synchronized lyrics engine globals (hoisted to prevent TDZ ReferenceError)
let currentLyricsData = null;
let currentLyricsTrackId = null;
let activeLyricIndex = -1;
let lyricsOffsetSeconds = 0;
let isUserInteractingWithLyrics = false;
let userLyricsScrollTimeout = null;

// Fullscreen player mode globals
let fsPlayerMode = 'artwork'; // 'artwork' (Apple Music centered player) or 'lyrics' (split view)
let isLyricsAvailable = false;
let userWantsLyrics = false;
let fsTimeDisplayMode = localStorage.getItem('basa_fs_time_mode') || 'remaining';

// Audio element replaced by YouTube IFrame API
// window.playbackManager is defined in youtubePlayer.js

// 2. API HELPER
async function api(endpoint, options = {}) {
    const headers = {};
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;

    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`/api${endpoint}`, {
        ...options,
        headers: { ...headers, ...options.headers }
    });

    if (res.status === 204) return null;

    let data;
    try { data = await res.json(); }
    catch (e) { data = { error: 'Invalid response' }; }

    if (!res.ok) {
        if (res.status === 401) { logout(); }
        throw new Error(data.error || 'API error');
    }
    return data;
}

// 3. TOAST NOTIFICATIONS
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.style.cssText = `
        padding: 12px 24px; border-radius: 12px; font-size: 13px; color: #fff;
        background: rgba(20,20,30,0.85); backdrop-filter: blur(16px);
        border: 1px solid rgba(255,255,255,0.08); min-width: 240px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        border-left: 3px solid ${type === 'error' ? '#ff6b6b' : type === 'success' ? '#71ffba' : '#7b6eff'};
        transform: translateX(120%); transition: transform 0.4s cubic-bezier(0.2,0.8,0.2,1), opacity 0.3s;
    `;
    toast.textContent = message;
    container.appendChild(toast);

    requestAnimationFrame(() => { toast.style.transform = 'translateX(0)'; });

    setTimeout(() => {
        toast.style.transform = 'translateX(120%)';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 400);
    }, 3000);
}

// 4. ROUTER
function navigate(hash) {
    window.location.hash = hash;
}

function showView(viewId) {
    document.querySelectorAll('.view').forEach(v => {
        v.style.display = v.id === viewId ? 'block' : 'none';
        v.classList.toggle('active', v.id === viewId);
    });
    state.currentView = viewId.replace('view-', '');

    document.querySelectorAll('.sidebar-nav a').forEach(link => {
        link.classList.toggle('active', link.getAttribute('href') === `#${state.currentView}`);
    });
}

function setupRouter() {
    function handleRoute() {
        const hash = window.location.hash || '#home';

        if (hash === '#home') {
            showView('view-home');
            loadHome();
        } else if (hash === '#search') {
            showView('view-search');
        } else if (hash === '#library') {
            showView('view-library');
            loadLibrary();
        } else if (hash === '#uploads') {
            showView('view-uploads');
            loadUploads();
        } else if (hash === '#sync') {
            showView('view-sync');
        } else if (hash === '#telegram' || hash === '#lossless') {
            showView('view-telegram');
            loadTelegramVault();
        } else if (hash.startsWith('#playlist/')) {
            const id = hash.split('/')[1];
            showView('view-playlist');
            loadPlaylist(id);
        }
    }
    window.addEventListener('hashchange', handleRoute);
}

// 5. AUTH MODULE
async function initAuth() {
    if (state.token) {
        try {
            const data = await api('/auth/me');
            state.user = data.user;
            updateAuthUI();
            loadPlaylists();
        } catch (err) {
            state.token = null;
            localStorage.removeItem('liquid_music_token');
            updateAuthUI();
        }
    } else {
        updateAuthUI();
    }
}

function showAuthModal(mode = 'login') {
    const modal = document.getElementById('auth-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.style.display = 'grid';

    const title = document.getElementById('auth-modal-title');
    const signupFields = document.getElementById('signup-fields');
    const submitBtn = document.getElementById('auth-submit');
    const switchText = document.getElementById('auth-switch-text');
    const switchBtn = document.getElementById('auth-switch-btn');
    const form = document.getElementById('auth-form');

    if (form) form.dataset.mode = mode;

    if (mode === 'login') {
        if (title) title.textContent = 'Sign In';
        if (signupFields) signupFields.classList.add('hidden');
        if (submitBtn) submitBtn.textContent = 'Sign In';
        if (switchText) switchText.textContent = "Don't have an account?";
        if (switchBtn) switchBtn.textContent = 'Sign Up';
    } else {
        if (title) title.textContent = 'Create Account';
        if (signupFields) signupFields.classList.remove('hidden');
        if (submitBtn) submitBtn.textContent = 'Create Account';
        if (switchText) switchText.textContent = 'Already have an account?';
        if (switchBtn) switchBtn.textContent = 'Sign In';
    }
}

function hideAuthModal() {
    const modal = document.getElementById('auth-modal');
    if (modal) { modal.style.display = 'none'; modal.classList.add('hidden'); }
}

async function handleAuthSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const mode = form.dataset.mode || 'login';
    const email = document.getElementById('auth-email')?.value;
    const password = document.getElementById('auth-password')?.value;
    const username = document.getElementById('auth-username')?.value;
    const errorEl = document.getElementById('auth-error');

    if (errorEl) { errorEl.classList.add('hidden'); errorEl.textContent = ''; }

    const body = { email, password };
    if (mode === 'signup') body.username = username;

    try {
        const data = await api(`/auth/${mode}`, {
            method: 'POST',
            body: JSON.stringify(body)
        });
        loginUser(data.token, data.user);
        hideAuthModal();
        form.reset();
        showToast(`Welcome${data.user.username ? ', ' + data.user.username : ''}!`, 'success');
    } catch (err) {
        if (errorEl) { errorEl.textContent = err.message; errorEl.classList.remove('hidden'); }
        showToast(err.message, 'error');
    }
}

function loginUser(token, user) {
    state.token = token;
    state.user = user;
    localStorage.setItem('liquid_music_token', token);
    updateAuthUI();
    loadPlaylists();
    loadHome();
}

function logout() {
    state.token = null;
    state.user = null;
    state.playlists = [];
    state.likedTrackIds.clear();
    localStorage.removeItem('liquid_music_token');
    updateAuthUI();
    updatePlaylistSidebar();

    if (state.currentView === 'library' || state.currentView === 'uploads') {
        navigate('#home');
    }
}

function updateAuthUI() {
    const authBtn = document.getElementById('auth-btn');
    const userMenu = document.getElementById('user-menu');
    const userName = document.getElementById('user-name');
    const userAvatar = document.getElementById('user-avatar');
    const uploadNavBtn = document.getElementById('upload-nav-btn');

    if (state.user) {
        if (authBtn) authBtn.style.display = 'none';
        if (userMenu) { userMenu.style.display = 'flex'; userMenu.classList.remove('hidden'); }
        if (userName) userName.textContent = state.user.username || state.user.email;
        if (userAvatar) userAvatar.textContent = (state.user.username || 'U')[0].toUpperCase();
        if (uploadNavBtn) uploadNavBtn.style.display = 'inline-flex';
    } else {
        if (authBtn) authBtn.style.display = 'inline-flex';
        if (userMenu) { userMenu.style.display = 'none'; userMenu.classList.add('hidden'); }
        if (uploadNavBtn) uploadNavBtn.style.display = 'none';
    }
}

// 6. SEARCH
function setupSearch() {
    const searchInput = document.getElementById('search-input');
    const qualityFilter = document.getElementById('quality-filter');
    if (!searchInput) return;

    if (qualityFilter) {
        qualityFilter.addEventListener('change', () => {
            const query = searchInput.value.trim();
            if (query.length > 0) searchMusic(query);
            else if (state.currentView === 'home') loadHome();
        });
    }

    searchInput.addEventListener('input', (e) => {
        clearTimeout(state.searchTimeout);
        const query = e.target.value.trim();
        if (query.length > 0) {
            if (state.currentView !== 'search') navigate('#search');
            state.searchTimeout = setTimeout(() => searchMusic(query), 400);
        }
    });

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            clearTimeout(state.searchTimeout);
            const q = e.target.value.trim();
            if (q) { navigate('#search'); searchMusic(q); }
        }
    });
}

function filterTracksByQuality(tracks, qualityPreference) {
    if (qualityPreference === 'AUTO' || !qualityPreference) return tracks;
    
    return tracks.filter(t => {
        const effectiveQuality = t.quality || 'SOURCE_DEPENDENT'; 
        
        if (qualityPreference === 'HI_RES_LOSSLESS') {
            return effectiveQuality === 'HI_RES_LOSSLESS';
        }
        if (qualityPreference === 'LOSSLESS') {
            return effectiveQuality === 'LOSSLESS' || effectiveQuality === 'HI_RES_LOSSLESS';
        }
        if (qualityPreference === 'HIGH') {
            return effectiveQuality === 'HIGH' || effectiveQuality === 'LOSSLESS' || effectiveQuality === 'HI_RES_LOSSLESS';
        }
        return true;
    });
}

function rankAutoTracks(tracks, query) {
    // For AUTO: Put high quality local files matching query ahead of YouTube 
    const q = (query || '').toLowerCase();
    return tracks.sort((a, b) => {
        const aTitle = (a.title || '').toLowerCase();
        const bTitle = (b.title || '').toLowerCase();
        const aMatch = aTitle.includes(q) ? 1 : 0;
        const bMatch = bTitle.includes(q) ? 1 : 0;
        
        // Both match relevance similarly
        if (aMatch === bMatch) {
            const qScore = { 'HI_RES_LOSSLESS': 4, 'LOSSLESS': 3, 'HIGH': 2, 'STANDARD': 1, 'SOURCE_DEPENDENT': 0, 'UNKNOWN': 0 };
            const aQ = qScore[a.quality || 'SOURCE_DEPENDENT'] || 0;
            const bQ = qScore[b.quality || 'SOURCE_DEPENDENT'] || 0;
            return bQ - aQ;
        }
        return bMatch - aMatch;
    });
}

async function searchMusic(query) {
    const container = document.getElementById('search-results');
    const qualityFilter = document.getElementById('quality-filter');
    const selectedQuality = qualityFilter ? qualityFilter.value : 'AUTO';
    
    if (!container) return;

    container.innerHTML = '<div class="loader">Searching...</div>';
    try {
        let musicTracks = [];
        let localTracks = [];
        
        try {
            const searchData = await api(`/music/search?q=${encodeURIComponent(query)}&source=all&limit=30`);
            musicTracks = searchData.data || [];
        } catch (e) { console.error("Search Error", e); }
        
        if (state.user) {
            try {
                const localData = await api('/upload/tracks');
                const qLower = query.toLowerCase();
                localTracks = (localData.tracks || []).filter(t => 
                    (t.title && t.title.toLowerCase().includes(qLower)) || 
                    (t.artist && t.artist.toLowerCase().includes(qLower))
                ).map(t => ({...t, source: 'local'}));
            } catch (e) { console.error("Local Search Error", e); }
        }

        let allTracks = [...localTracks, ...musicTracks];
        
        if (selectedQuality === 'AUTO') {
            allTracks = rankAutoTracks(allTracks, query);
        }
        
        const filteredTracks = filterTracksByQuality(allTracks, selectedQuality);
        
        if (filteredTracks.length > 0) {
            window.currentSearchTracks = filteredTracks;
            container.innerHTML = filteredTracks.map((t, idx) => renderTrackCard(t, t.source, idx, 'search')).join('');
        } else {
            if (selectedQuality !== 'AUTO') {
                container.innerHTML = `
                    <div class="empty-state">
                        <div style="margin-bottom:10px;">No ${selectedQuality.replace('_', ' ').toLowerCase()} version available.</div>
                        <button class="button button-primary" onclick="document.getElementById('quality-filter').value='AUTO'; searchMusic('${query.replace(/'/g, "\\'")}');">Play best available</button>
                    </div>`;
            } else {
                container.innerHTML = '<div class="empty-state">No results found. Try a different search.</div>';
            }
        }
    } catch (err) {
        container.innerHTML = '<div class="empty-state">Search failed. Please try again.</div>';
    }
}

// 7. HOME VIEW — BASA V2 PERSONALIZED RECOMMENDATIONS & LANGUAGE-AWARE NEW RELEASES

let activeNewReleaseLanguage = localStorage.getItem('basa_active_release_lang') || 'Tamil';
let activeNewReleaseRequestId = 0;

/**
 * Initializes language pills with accessible keyboard and click handlers (Section 10, 33, 46).
 */
function initLanguagePills() {
    const container = document.getElementById('lang-pills-container');
    if (!container) return;

    const savedLang = localStorage.getItem('basa_active_release_lang') || 'Tamil';
    activeNewReleaseLanguage = savedLang;

    container.querySelectorAll('.lang-pill').forEach(pill => {
        const pillLang = pill.getAttribute('data-lang');
        const isActive = pillLang.toLowerCase() === savedLang.toLowerCase();
        pill.classList.toggle('active', isActive);
        pill.setAttribute('aria-pressed', isActive ? 'true' : 'false');

        // Accessible click / keyboard selection
        pill.onclick = (e) => {
            e.preventDefault();
            container.querySelectorAll('.lang-pill').forEach(p => {
                p.classList.remove('active');
                p.setAttribute('aria-pressed', 'false');
            });
            pill.classList.add('active');
            pill.setAttribute('aria-pressed', 'true');

            activeNewReleaseLanguage = pillLang;
            localStorage.setItem('basa_active_release_lang', pillLang);

            // Fetch new releases for selected language without recomputing user detected language (Section 10, 33)
            loadNewReleases(pillLang);
        };
    });
}

/**
 * Loads personalized recommendations based on authoritative DB history (authenticated) or guest session (Section 1, 2, 26, 27).
 */
async function loadPersonalizedRecommendations() {
    const recGrid = document.getElementById('recommended-grid');
    const recSubtitle = document.getElementById('recommended-subtitle');
    const tasteBadge = document.getElementById('taste-detected-badge');
    if (!recGrid) return;

    recGrid.innerHTML = '<div class="grid-skeleton">Curating your recommendations...</div>';

    try {
        let data = null;
        if (state.token) {
            // Authenticated: DB is authoritative (Section 2)
            data = await api('/music/personalized-recommendations');
        } else {
            // Guest session: inspect localStorage history
            let guestHistory = [];
            try {
                const raw = localStorage.getItem('basa_guest_history');
                if (raw) guestHistory = JSON.parse(raw);
            } catch (e) {}

            if (guestHistory && guestHistory.length > 0) {
                const res = await fetch('/api/music/personalized-recommendations/session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tracks: guestHistory })
                });
                data = await res.json();
            } else {
                data = await api('/music/personalized-recommendations');
            }
        }

        const tracks = (data && data.recommendations) || [];
        if (tracks.length > 0) {
            window.currentRecommendedTracks = tracks;
            recGrid.innerHTML = tracks.map((t, idx) => renderTrackCard(t, t.source || 'youtube', idx, 'recommended')).join('');

            // Evidence-based taste badge & subtitle (Section 9, 45)
            if (data.detectedFrom === 'HISTORY') {
                if (tasteBadge) {
                    const confPct = Math.round((data.languageConfidence || 0.75) * 100);
                    tasteBadge.textContent = `${data.topLanguage} Taste · ${confPct}%`;
                    tasteBadge.style.display = 'inline-flex';
                }
                if (recSubtitle) {
                    recSubtitle.textContent = `Personalized for your ${data.topLanguage} listening history`;
                }
            } else {
                if (tasteBadge) tasteBadge.style.display = 'none';
                if (recSubtitle) {
                    recSubtitle.textContent = 'Curated recommendations for you';
                }
            }
        } else {
            recGrid.innerHTML = '<div class="empty-state">Listen to a few more songs to personalize your recommendations.</div>';
        }
    } catch (err) {
        console.warn('[Home] Recommendations load error:', err);
        recGrid.innerHTML = '<div class="empty-state">Listen to a few more songs to personalize your recommendations.</div>';
    }
}

/**
 * Loads language-aware new releases with date/year verification and stale response cancellation (Section 16, 28, 33).
 */
async function loadNewReleases(language = activeNewReleaseLanguage) {
    const releaseGrid = document.getElementById('new-releases-grid');
    const langTitle = document.getElementById('new-releases-lang-title');
    const releaseSubtitle = document.getElementById('new-releases-subtitle');
    if (!releaseGrid) return;

    // Stale request handling: track latest request ID so rapid clicks don't overwrite with old responses (Section 33)
    const currentRequestId = ++activeNewReleaseRequestId;

    if (langTitle) langTitle.textContent = language;
    releaseGrid.innerHTML = `<div class="grid-skeleton">Verifying new releases for ${escapeHtml(language)}...</div>`;

    try {
        const data = await api(`/music/new-releases?language=${encodeURIComponent(language)}`);

        // Discard stale responses if user clicked another pill in the meantime (Section 33)
        if (currentRequestId !== activeNewReleaseRequestId) {
            return;
        }

        const releases = (data && data.releases) || [];
        if (releases.length > 0) {
            window.currentNewReleases = releases;
            releaseGrid.innerHTML = releases.map((t, idx) => renderTrackCard(t, t.source || 'jiosaavn', idx, 'newreleases')).join('');
            if (releaseSubtitle) {
                if (data.languageSource === 'AUTO_DETECTED') {
                    releaseSubtitle.textContent = `Showing verified ${data.language} releases`;
                } else {
                    releaseSubtitle.textContent = `Showing ${data.language} releases`;
                }
            }
        } else {
            // Empty state requirement (Section 48): never fake new releases
            releaseGrid.innerHTML = `<div class="empty-state">No verified new releases found for ${escapeHtml(language)} right now.</div>`;
        }
    } catch (err) {
        if (currentRequestId === activeNewReleaseRequestId) {
            console.warn('[Home] New releases load error:', err);
            releaseGrid.innerHTML = `<div class="empty-state">No verified new releases found for ${escapeHtml(language)} right now.</div>`;
        }
    }
}

async function loadTrendingCharts() {
    const chartsGrid = document.getElementById('charts-grid');
    if (!chartsGrid) return;

    chartsGrid.innerHTML = '<div class="loader">Loading trending music...</div>';
    try {
        const data = await api('/music/charts?limit=20');
        let tracks = data.data || [];
        
        const qualityFilter = document.getElementById('quality-filter');
        const selectedQuality = qualityFilter ? qualityFilter.value : 'AUTO';
        
        tracks = filterTracksByQuality(tracks, selectedQuality);
        if (tracks.length > 0) {
            window.currentChartsTracks = tracks;
            chartsGrid.innerHTML = tracks.map((t, idx) => renderTrackCard(t, t.source || 'youtube', idx, 'charts')).join('');
        } else {
            chartsGrid.innerHTML = '<div class="empty-state">No trending tracks available matching the quality filter.</div>';
        }
    } catch (err) {
        chartsGrid.innerHTML = '<div class="empty-state">Could not load charts. Try searching instead.</div>';
    }
}

async function loadLosslessMusic() {
    const losslessGrid = document.getElementById('lossless-grid');
    if (!losslessGrid) return;

    losslessGrid.innerHTML = '<div class="loader">Loading Hi-Fi &amp; Lossless music...</div>';
    try {
        const data = await api('/music/lossless?limit=12');
        const tracks = data.data || [];
        if (tracks.length > 0) {
            window.currentLosslessTracks = tracks;
            losslessGrid.innerHTML = tracks.map((t, idx) => renderTrackCard(t, t.source, idx, 'lossless')).join('');
        } else {
            losslessGrid.innerHTML = '<div class="empty-state">No lossless tracks available yet. Submit a request to ingest master audio.</div>';
        }
    } catch (e) {
        console.error('Lossless loading error', e);
        losslessGrid.innerHTML = '<div class="empty-state">Unable to load lossless collection.</div>';
    }
}

async function loadRecentlyPlayed() {
    const recentGrid = document.getElementById('recent-grid');
    if (!recentGrid) return;

    if (state.token) {
        try {
            const data = await api('/library/history?limit=10');
            let tracks = data.tracks || [];
            tracks = tracks.filter(item => item.track_data && (item.track_data.videoId || item.track_data.id) && !isShortTrack(item.track_data));
            if (tracks.length > 0) {
                window.currentRecentTracks = tracks.map(item => ({ ...item.track_data, source: item.track_source }));
                recentGrid.innerHTML = tracks.map((item, idx) => renderTrackCard(item.track_data, item.track_source, idx, 'recent')).join('');
            } else {
                recentGrid.innerHTML = '<p class="empty-state">Your recently played tracks will appear here</p>';
            }
        } catch (err) {
            recentGrid.innerHTML = '<p class="empty-state">Your recently played tracks will appear here</p>';
        }
    } else {
        recentGrid.innerHTML = '<p class="empty-state">Your recently played tracks will appear here</p>';
    }
}

/**
 * Parallel fault-isolated Home loader using Promise.allSettled() (Section 32, 50, 52).
 */
async function loadHome() {
    initLanguagePills();

    // Sections load in parallel. If any one section fails, others still render cleanly.
    await Promise.allSettled([
        loadPersonalizedRecommendations(),
        loadNewReleases(activeNewReleaseLanguage),
        loadTrendingCharts(),
        loadLosslessMusic(),
        loadRecentlyPlayed()
    ]);
}

// 8. TRACK RENDERING
function mapTrackToStandard(track, source = 'youtube') {
    let id, cover, title, artist, preview, audioUrl, fallbackUrl;
    const effectiveSource = track.source || source || 'youtube';

    if (effectiveSource === 'local') {
        id = track.id;
        cover = track.cover_url ? `/api/upload/cover/${track.id}?token=${state.token || ''}` : (track.cover || '');
        title = track.title || 'Unknown';
        artist = track.artist || 'Unknown Artist';
        preview = track.preview || `/api/upload/stream/${track.id}?token=${state.token || ''}`;
        audioUrl = preview;
    } else if (effectiveSource === 'telegram' || effectiveSource === 'lossless') {
        id = track.id;
        cover = track.cover || track.cover_url || `/api/telegram/cover/${track.id}`;
        title = track.title || 'Unknown Title';
        artist = track.artist || 'Unknown Artist';
        preview = track.preview || track.audioUrl || `/api/telegram/stream/${track.id}`;
        audioUrl = `/api/telegram/stream/${track.id}`;
    } else {
        id = track.id || track.videoId;
        cover = track.cover || 
            (typeof track.artwork === 'string' ? track.artwork : (track.artwork?.['500x500'] || track.artwork?.['480x480'] || track.artwork?.['150x150'] || track.artwork?.url)) ||
            (Array.isArray(track.image) ? (track.image[track.image.length - 1]?.link || track.image[track.image.length - 1]?.url || (typeof track.image[0] === 'string' ? track.image[0] : '')) : (typeof track.image === 'string' ? track.image : '')) ||
            track.thumbnail ||
            (Array.isArray(track.thumbnails) ? track.thumbnails[track.thumbnails.length - 1]?.url : '') ||
            '';
        if (!cover && (effectiveSource === 'youtube' || (typeof id === 'string' && id.length === 11))) {
            const ytVid = track.videoId || id;
            if (ytVid && typeof ytVid === 'string' && !ytVid.startsWith('http') && !ytVid.startsWith('/')) {
                cover = `https://i.ytimg.com/vi/${ytVid}/hqdefault.jpg`;
            }
        }
        title = track.title || 'Unknown';
        artist = track.user?.name || track.artist || 'Unknown Artist';
        preview = track.videoId || track.preview || track.id;
        audioUrl = preview;
    }

    const durationMs = track.durationMs != null ? Number(track.durationMs) : (track.duration ? Number(track.duration) * 1000 : null);
    const durationSec = track.duration != null ? Number(track.duration) : (track.durationSec != null ? Number(track.durationSec) : (durationMs != null ? Math.round(durationMs / 1000) : 0));

    return { 
        id, videoId: track.videoId || id || preview, title, artist, album: track.album?.title || track.album || '', cover, preview,
        duration: durationSec, durationMs, durationSec,
        audioUrl, fallbackUrl, source: effectiveSource,
        sourceId: track.sourceId || id,
        quality: track.quality, format: track.format, codec: track.codec,
        lossless: Boolean(track.isLossless || track.lossless),
        isLossless: Boolean(track.isLossless || track.lossless),
        isHiRes: Boolean(track.isHiRes || track.quality === 'HI_RES_LOSSLESS'),
        sampleRate: track.sampleRate || track.sample_rate, 
        bitDepth: track.bitDepth || track.bit_depth, 
        bitrate: track.bitrate,
        license: track.license, licenseUrl: track.licenseUrl || track.license_url,
        rightsStatus: track.rightsStatus || track.rights_status,
        status: track.status,
        isCached: track.isCached !== undefined ? track.isCached : (effectiveSource !== 'telegram' ? true : false),
        sourceName: track.sourceName,
        sourcePriority: track.sourcePriority,
        qualityRankBadge: track.qualityRankBadge,
        candidates: track.candidates || [],
        availableSources: track.availableSources || [],
        requiresUpgrade: track.requiresUpgrade || false,
        upgradeStatus: track.upgradeStatus || null,
        recordingVersion: track.recordingVersion || track.versionType || 'ORIGINAL',
        versionType: track.versionType || track.recordingVersion || 'ORIGINAL',
        isOfficial: Boolean(track.isOfficial),
        isOriginal: track.isOriginal !== undefined ? Boolean(track.isOriginal) : true,
        canonicalTrackId: track.canonicalTrackId || track.canonicalId || null,
        reason: track.reason || '',
        releaseTag: track.releaseTag || null,
        releaseDate: track.releaseDate || null
    };
}

function renderTrackCard(track, source = 'youtube', index = -1, contextType = '') {
    // Layer 9 Defense-in-depth: Never render a YouTube Short card
    if (typeof isDisallowedShortFormCandidate === 'function' && isDisallowedShortFormCandidate(track)) {
        return '';
    }
    const trackObj = mapTrackToStandard(track, source);
    const encoded = encodeURIComponent(JSON.stringify(trackObj));

    const coverHtml = trackObj.cover
        ? `<img src="${trackObj.cover}" alt="${trackObj.title}" loading="lazy" onerror="this.style.display='none'">`
        : `<div style="width:100%;height:100%;display:grid;place-items:center;font-size:32px;opacity:0.2">🎵</div>`;

    const clickCall = index >= 0 && contextType
        ? `playTrackFromData('${encoded}', '${contextType}', ${index})`
        : `playTrackFromData('${encoded}')`;

    // Release tag badge on cover (Section 17, 29: e.g. "NEW 2026" or "2026")
    const releaseTagHtml = trackObj.releaseTag
        ? `<div class="new-release-tag-badge">${escapeHtml(trackObj.releaseTag)}</div>`
        : '';

    // Distinguish primary original recording or version in search results (Section 39)
    let versionBadgeHtml = '';
    if (contextType === 'search') {
        if (trackObj.isOriginal || trackObj.recordingVersion === 'ORIGINAL') {
            if (index === 0) {
                versionBadgeHtml = `<div class="track-card-version-badge primary-original">★ PRIMARY RECORDING</div>`;
            } else if (trackObj.isOfficial) {
                versionBadgeHtml = `<div class="track-card-version-badge primary-original">★ OFFICIAL</div>`;
            }
        } else if (trackObj.recordingVersion && trackObj.recordingVersion !== 'ORIGINAL') {
            versionBadgeHtml = `<div class="track-card-version-badge version-alternate">${escapeHtml(trackObj.recordingVersion)}</div>`;
        }
    }

    return `
    <div class="track-card glass-subtle" onclick="${clickCall}">
        <div class="track-card-cover">
            ${releaseTagHtml}
            ${coverHtml}
            <div class="track-card-play"><div class="track-card-play-btn">▶</div></div>
            <button class="track-card-queue-btn" onclick="event.stopPropagation();addToQueueFromData('${encoded}')" title="Add to Queue" aria-label="Add to Queue">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            </button>
        </div>
        <div class="track-card-info">
            <div class="track-card-title">${escapeHtml(trackObj.title)}</div>
            <div class="track-card-artist">${escapeHtml(trackObj.artist)}</div>
            ${versionBadgeHtml}
            ${renderQualityBadge(trackObj)}
        </div>
    </div>`;
}

function renderQualityBadge(track) {
    if (!track) return '';

    const isCurrent = window.playbackManager && window.playbackManager.currentTrack && window.playbackManager.currentTrack.id === track.id;
    const currentState = isCurrent ? window.playbackManager.playerState : null;

    if (track.upgradeStatus === 'buffering' || currentState === 'PREPARING_UPGRADE' || currentState === 'UPGRADING') {
        return `<div class="quality-badge badge-resolving" title="Buffering lossless stream for seamless handoff..."><span class="badge-icon">⏳</span><span class="badge-title">Upgrading...</span></div>`;
    }

    // Check if track is actively resolving or preparing upgrade
    if (track.upgradeStatus === 'resolving' || currentState === 'RESOLVING_LOSSLESS' ||
        (isCurrent && window.playbackManager.pendingUpgradeCandidate)) {
        return `<div class="quality-badge badge-resolving" title="Resolving higher quality audio stream in background..."><span class="badge-icon">⚡</span><span class="badge-title">Resolving Hi-Res...</span></div>`;
    }

    const fmtLower = String(track.codec || track.format || '').toLowerCase();
    const isFlacOrLossless = fmtLower === 'flac' || fmtLower.includes('flac');

    // Section 11 & 26: Display lossless badge ONLY if actual source is verified
    const isVerifiedLossless = isFlacOrLossless && (
        track.verificationStatus === 'VERIFIED' ||
        track.losslessVerification === 'VERIFIED' ||
        track.playableLosslessVerified === true ||
        track.isCached === true ||
        track.cached === true
    );

    if (isVerifiedLossless) {
        const bitDepth = Number(track.bitDepth) || (track.quality === 'HI_RES_LOSSLESS' ? 24 : 16);
        const sampleRate = Number(track.sampleRate) || (track.quality === 'HI_RES_LOSSLESS' ? 96000 : 44100);
        const isHiRes = bitDepth > 16 || sampleRate > 48000 || track.quality === 'HI_RES_LOSSLESS';

        const bitStr = `${bitDepth}-bit`;
        const rateStr = `${Math.round(sampleRate / 1000)} kHz`;

        if (isHiRes) {
            return `<div class="quality-badge badge-hires" title="Hi-Res Lossless Audio (FLAC · ${bitStr} / ${rateStr})"><span class="badge-icon">◆</span><span class="badge-title">HI-RES LOSSLESS</span><span class="badge-sep">·</span><span class="badge-meta">FLAC · ${bitStr} / ${rateStr}</span></div>`;
        } else {
            return `<div class="quality-badge badge-lossless" title="Studio Lossless Quality (FLAC · ${bitStr} / ${rateStr})"><span class="badge-icon">✦</span><span class="badge-title">LOSSLESS</span><span class="badge-sep">·</span><span class="badge-meta">FLAC · ${bitStr} / ${rateStr}</span></div>`;
        }
    }

    // Section 19: Ordinary search & track cards remain clean. No provider chips (YouTube, JioSaavn, Telegram, Qobuz, etc.)
    return '';
}

function renderTrackListItem(track, index, source, options = {}) {
    const trackObj = mapTrackToStandard(track, source);
    const encoded = encodeURIComponent(JSON.stringify(trackObj));
    const isLiked = state.likedTrackIds.has(String(trackObj.id));

    let actions = `
        <button class="track-action-btn ${isLiked ? 'liked' : ''}" onclick="event.stopPropagation();toggleLike('${trackObj.id}','${trackObj.source}','${encoded}')" title="Like">${isLiked ? '♥' : '♡'}</button>
        <button class="track-action-btn" onclick="event.stopPropagation();addToQueueFromData('${encoded}')" title="Add to Queue">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
        </button>
        <button class="track-action-btn" onclick="event.stopPropagation();downloadTrackFromData('${encoded}')" title="Download Audio">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        </button>
        <button class="track-action-btn" onclick="event.stopPropagation();showAddToPlaylist(event,'${trackObj.id}','${trackObj.source}','${encoded}')" title="Add to playlist">+</button>
    `;
    if (options.isUpload) {
        actions += `<button class="track-action-btn" onclick="event.stopPropagation();deleteUpload('${trackObj.id}')" title="Delete">🗑</button>`;
    }
    if (options.playlistEntryId) {
        actions += `<button class="track-action-btn" onclick="event.stopPropagation();removeFromPlaylist('${options.playlistId}','${options.playlistEntryId}')" title="Remove">✕</button>`;
    }

    // Render source chips if multiple candidates exist
    let sourcesChipsHtml = '';
    if (trackObj.availableSources && trackObj.availableSources.length > 1) {
        const chips = trackObj.availableSources.map(s => {
            const label = s.source === 'youtube' ? 'YouTube' : (s.source === 'telegram' ? (s.isHiRes ? 'Hi-Res' : 'FLAC') : 'Local');
            const icon = s.isHiRes ? '💎' : (s.isLossless ? '✦' : '▶');
            return `<span class="source-chip" title="${escapeHtml(s.title)} (${s.quality || 'Audio'})" onclick="event.stopPropagation();openCandidateSourcesModal('${encoded}')">${icon} ${label}</span>`;
        }).join('');
        sourcesChipsHtml = `<div class="sources-chips-row" style="display:inline-flex; margin-left:8px;">${chips}</div>`;
    }

    const clickCall = options.contextType
        ? `playTrackFromData('${encoded}', '${options.contextType}', ${index})`
        : `playTrackFromData('${encoded}')`;

    return `
    <div class="track-list-item" onclick="${clickCall}">
        <span class="track-list-num">${index + 1}</span>
        <img class="track-list-cover" src="${trackObj.cover || ''}" alt="" loading="lazy" onerror="this.style.opacity='0.1'">
        <div class="track-list-info">
            <span class="track-list-title">${escapeHtml(trackObj.title)}</span>
            <div class="track-list-artist-row">
                <span class="track-list-artist">${escapeHtml(trackObj.artist)}</span>
                ${renderQualityBadge(trackObj)}
                ${sourcesChipsHtml}
            </div>
        </div>
        <span class="track-list-album">${escapeHtml(trackObj.album)}</span>
        <span class="track-list-duration">${formatDuration(track.duration || 0)}</span>
        <div class="track-list-actions">${actions}</div>
    </div>`;
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// 7.5. SHORTS FILTERING
function isShortTrack(trackData) {
    if (!trackData) return false;
    if (trackData.source !== 'youtube') return false; // Only filter YouTube shorts, preserve lossless audio
    
    const title = (trackData.title || '').toLowerCase();
    const url = (trackData.url || trackData.preview || '').toLowerCase();
    
    if (title.includes('shorts') || title.includes('#shorts') || title.includes('youtube short')) return true;
    if (url.includes('/shorts/')) return true;
    
    return false;
}

// 9. AUDIO PLAYER ENGINE & QUEUE
function playTrackFromData(encodedData, contextType = null, index = -1) {
    try {
        const trackData = JSON.parse(decodeURIComponent(encodedData));
        
        // Search results are query matches, NOT a continuous playlist/album!
        // When a user selects a search result, play it standalone and let Smart Up Next take over.
        if (contextType === 'search') {
            state.queue = [trackData];
            state.queueIndex = 0;
            saveQueueState();
            playTrack(trackData);
            return;
        }

        let contextList = null;
        if (contextType === 'charts' && window.currentChartsTracks) {
            contextList = window.currentChartsTracks.map(t => mapTrackToStandard(t, t.source || 'youtube'));
        } else if (contextType === 'lossless' && window.currentLosslessTracks) {
            contextList = window.currentLosslessTracks.map(t => mapTrackToStandard(t, t.source));
        } else if (contextType === 'library' && window.currentLibraryTracks) {
            contextList = window.currentLibraryTracks.map(t => mapTrackToStandard(t, t.source));
        } else if (contextType === 'playlist' && window.currentPlaylistTracks) {
            contextList = window.currentPlaylistTracks.map(t => mapTrackToStandard(t, t.source));
        } else if ((contextType === 'upload' || contextType === 'local') && window.currentUploadTracks) {
            contextList = window.currentUploadTracks.map(t => mapTrackToStandard(t, 'local'));
        } else if (contextType === 'recent' && window.currentRecentTracks) {
            contextList = window.currentRecentTracks.map(t => mapTrackToStandard(t, t.source || 'youtube'));
        }

        if (contextList && contextList.length > 0 && index >= 0 && index < contextList.length) {
            playFromList(contextList, index);
        } else {
            // Standalone play: preserve upcoming queue if any, starting with this track
            const upcoming = (state.queue && state.queueIndex >= 0 && state.queueIndex < state.queue.length - 1)
                ? state.queue.slice(state.queueIndex + 1).filter(t => !isSameSongFamily(trackData, t))
                : [];
            state.queue = [trackData, ...upcoming];
            state.queueIndex = 0;
            saveQueueState();
            playTrack(trackData);
        }
    } catch (e) {
        console.error('Failed to parse track data', e);
    }
}

// Client-side Song Family & Recommendation Safety Validation (Section 16, 17, 18)
function cleanBaseTitle(title, artist = '') {
    if (!title) return '';
    let str = String(title).toLowerCase();
    if (artist && str.includes(' - ')) {
        const parts = str.split(/\s+-\s+/);
        const normArt = String(artist).toLowerCase().trim();
        if (parts[0].includes(normArt)) {
            str = parts.slice(1).join(' - ');
        }
    }
    str = str.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
    // Video quality / resolution noise
    str = str.replace(/\b(?:8k\/?4k|4k\/?8k|8k|4k|1080p|720p|uhd|hd|hq)\b/gi, ' ');
    // Release and video qualifiers
    str = str.replace(/\b(?:official\s*(?:audio|video|music\s*video)|lyric\s*video|lyrics|full\s*video\s*song|full\s*video|full\s*song|audio\s*song|video\s*song|visualizer|topic|interlude|promo)\b/gi, ' ');
    // Version modifiers
    str = str.replace(/\b(?:remix|slowed(?:\s*\+\s*reverb)?|reverb|sped\s*up|speed\s*up|nightcore|fast(?:\s*version)?|bass\s*boost(?:ed)?|orchestral(?:\s*version)?|live(?:\s+at\s+[^\])]+|\s+in\s+[^\])]+)?|acoustic(?:\s*version)?|unplugged|cover|instrumental|karaoke|extended(?:\s*mix|\s*version)?|remastered|radio\s*edit)\b/gi, ' ');

    // Indian / YouTube titles often format: 'Song Title | Movie Name'
    if (str.includes('|')) {
        const seg = str.split('|')[0].trim();
        if (seg.length >= 3) str = seg;
    }

    str = str.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    return str;
}

function isSameSongFamily(trackA, trackB) {
    if (!trackA || !trackB) return false;
    const idA = trackA.canonicalTrackId || trackA.canonicalId;
    const idB = trackB.canonicalTrackId || trackB.canonicalId;
    if (idA && idB && idA === idB) return true;

    const baseA = cleanBaseTitle(trackA.title || '', trackA.artist || '');
    const baseB = cleanBaseTitle(trackB.title || '', trackB.artist || '');
    if (!baseA || !baseB || baseA.length < 2 || baseB.length < 2) return false;

    const isMatch = (baseA === baseB) || 
                    (baseA.length >= 8 && baseB.length >= 8 && (baseA.startsWith(baseB + ' ') || baseB.startsWith(baseA + ' ')));

    if (isMatch) {
        const titleA = String(trackA.title || '').toLowerCase();
        const titleB = String(trackB.title || '').toLowerCase();
        const versionWords = /\b(cover|remix|slowed|sped\s*up|fast|bass\s*boost|orchestral|live|acoustic|instrumental|karaoke|extended)\b/i;
        if (versionWords.test(titleA) || versionWords.test(titleB)) {
            return true;
        }
        const artA = String(trackA.artist || '').toLowerCase().trim();
        const artB = String(trackB.artist || '').toLowerCase().trim();
        if (!artA || !artB || artA === artB || artA.includes(artB) || artB.includes(artA)) {
            const durA = Number(trackA.duration) || 0;
            const durB = Number(trackB.duration) || 0;
            if (durA > 0 && durB > 0 && Math.abs(durA - durB) > 45) {
                return false;
            }
            return true;
        }
    }
    return false;
}

function validateRecommendationQueue(queue, currentTrack, recentHistory = []) {
    if (!Array.isArray(queue) || queue.length === 0) return [];
    const valid = [];
    const seenCanonical = new Set();
    const currCanonId = currentTrack ? (currentTrack.canonicalTrackId || currentTrack.canonicalId || currentTrack.id) : null;

    for (const item of queue) {
        if (!item) continue;
        if (typeof isDisallowedShortFormCandidate === 'function' && isDisallowedShortFormCandidate(item)) continue;
        const candId = item.canonicalTrackId || item.canonicalId || item.id;
        if (!candId) continue;

        if (currCanonId && candId === currCanonId) continue;
        if (seenCanonical.has(candId)) continue;
        if (currentTrack && isSameSongFamily(currentTrack, item)) continue;

        if (recentHistory && recentHistory.length > 0) {
            if (recentHistory[0] === candId) continue;
            const rIdx = recentHistory.indexOf(candId);
            if (rIdx !== -1 && rIdx < 15) continue;
        }

        seenCanonical.add(candId);
        valid.push(item);
    }
    return valid;
}

function isValidNextRecommendation(candidate, currentTrack, recentHistory = []) {
    if (!candidate) return false;
    if (typeof isDisallowedShortFormCandidate === 'function' && isDisallowedShortFormCandidate(candidate)) return false;
    const currCanonId = currentTrack ? (currentTrack.canonicalTrackId || currentTrack.canonicalId || currentTrack.id) : null;
    const candId = candidate.canonicalTrackId || candidate.canonicalId || candidate.id;

    if (currCanonId && candId === currCanonId) return false;
    if (currentTrack && isSameSongFamily(currentTrack, candidate)) return false;

    if (recentHistory && recentHistory.length > 0) {
        if (recentHistory[0] === candId) return false;
        const rIdx = recentHistory.indexOf(candId);
        if (rIdx !== -1 && rIdx < 15) return false;
    }
    return true;
}

function repairRecommendedQueue() {
    if (!state.recommendedQueue || state.recommendedQueue.length === 0) return;
    state.recommendedQueue = validateRecommendationQueue(
        state.recommendedQueue,
        state.currentTrack,
        state.recentCanonicalTrackIds || []
    );
}

function repairManualQueue() {
    if (!state.queue || state.queue.length <= 1) return;
    const current = state.currentTrack;
    if (!current) return;

    const currentCanonId = current.canonicalTrackId || current.canonicalId || current.id;
    const currentBaseTitle = cleanBaseTitle(current.title, current.artist);

    // Keep history up to queueIndex
    const pastAndCurrent = state.queue.slice(0, state.queueIndex + 1);
    const upcoming = state.queue.slice(state.queueIndex + 1);

    const seenFamilies = new Set();
    if (currentBaseTitle) seenFamilies.add(currentBaseTitle);

    const filteredUpcoming = [];
    for (const item of upcoming) {
        if (!item) continue;
        if (typeof isDisallowedShortFormCandidate === 'function' && isDisallowedShortFormCandidate(item)) continue;
        const itemCanonId = item.canonicalTrackId || item.canonicalId || item.id;
        
        // Exclude exact canonicalTrackId as current
        if (currentCanonId && itemCanonId === currentCanonId) continue;
        
        // Exclude same song family as current
        if (isSameSongFamily(current, item)) continue;

        // Exclude duplicate song family within upcoming queue
        const itemBaseTitle = cleanBaseTitle(item.title, item.artist);
        if (itemBaseTitle && seenFamilies.has(itemBaseTitle)) continue;
        if (itemBaseTitle) seenFamilies.add(itemBaseTitle);

        filteredUpcoming.push(item);
    }

    state.queue = [...pastAndCurrent, ...filteredUpcoming];
    saveQueueState();
}

async function fetchUpNextRecommendations(trackData) {
    if (!trackData) return;
    const trackId = trackData.canonicalTrackId || trackData.canonicalId || trackData.id || '';
    const title = trackData.title || '';
    const artist = trackData.artist || '';
    const album = trackData.album || '';

    state.isFetchingRecommendations = true;
    try {
        const queryParams = new URLSearchParams({
            trackId: String(trackId),
            canonicalTrackId: String(trackData.canonicalTrackId || trackId),
            title,
            artist,
            album,
            limit: '8',
            sessionId: state.user?.id || 'guest_session'
        });
        const res = await api(`/music/recommendations?${queryParams.toString()}`);
        if (res && res.success && Array.isArray(res.recommendations)) {
            const mapped = res.recommendations.map(r => mapTrackToStandard(r, r.source || 'youtube'));
            state.recommendedQueue = validateRecommendationQueue(mapped, state.currentTrack, state.recentCanonicalTrackIds || []);
            renderQueueDrawer();
        }
    } catch (err) {
        console.warn('[Recommendations] Failed to fetch Up Next:', err.message);
    } finally {
        state.isFetchingRecommendations = false;
    }
}

function playTrack(trackData, forceLocal = false, isBackwardNav = false) {
    if (!forceLocal && window.syncManager && window.syncManager.roomCode) {
        if (window.syncManager.role === 'HOST') {
            if (window.syncManager.ws && window.syncManager.ws.readyState === WebSocket.OPEN) {
                window.syncManager.ws.send(JSON.stringify({ type: 'TRACK_CHANGE', track: trackData }));
            }
        }
        return;
    }

    if (!trackData || (!trackData.preview && !trackData.videoId && !trackData.id)) {
        showToast('Stream URL not available', 'error');
        return;
    }

    // Record session feedback on outgoing track (skip vs complete)
    if (state.currentTrack && state.currentTrackStartTime > 0 && !isBackwardNav) {
        const elapsedSec = (Date.now() - state.currentTrackStartTime) / 1000;
        const action = elapsedSec < 25 ? 'skip' : (elapsedSec > 60 ? 'complete' : null);
        if (action) {
            api('/music/session-feedback', {
                method: 'POST',
                body: JSON.stringify({
                    trackId: String(state.currentTrack.id),
                    action,
                    durationPlayed: elapsedSec,
                    track: state.currentTrack,
                    sessionId: state.user?.id || 'guest_session'
                })
            }).catch(() => {});
        }
    }
    state.currentTrackStartTime = Date.now();

    // Save outgoing track into previousTracks (unless navigating backwards)
    if (state.currentTrack && state.currentTrack.id && String(state.currentTrack.id) !== String(trackData.id) && !isBackwardNav) {
        const lastPrev = state.previousTracks[state.previousTracks.length - 1];
        if (!lastPrev || String(lastPrev.id) !== String(state.currentTrack.id)) {
            state.previousTracks.push(state.currentTrack);
            if (state.previousTracks.length > 50) state.previousTracks.shift();
        }
    }

    state.currentTrack = trackData;
    const canonId = trackData.canonicalTrackId || trackData.canonicalId || trackData.id;
    state.currentCanonicalTrackId = canonId;
    if (canonId) {
        state.recentCanonicalTrackIds = [canonId, ...(state.recentCanonicalTrackIds || []).filter(x => x !== canonId)].slice(0, 20);
    }
    // Dynamic repair: purge current song family from both pre-generated and manual queues immediately
    repairRecommendedQueue();
    repairManualQueue();

    saveQueueState();

    // Trigger asynchronous lyrics fetch for new track
    loadLyricsForTrack(trackData);

    // Asynchronously pre-generate Up Next queue for instantaneous Next response (Section 32, 41)
    fetchUpNextRecommendations(trackData);

    window.playbackManager.loadTrack(trackData);
    state.isPlaying = true;
    updatePlayerUI(trackData);
    renderQueueDrawer();

    // Section 12: Trigger background lossless discovery if playing fast source
    if (canonId && !trackData.isLossless && !trackData.isHiRes && window.playbackManager.tryLosslessUpgrade) {
        window.playbackManager.tryLosslessUpgrade(canonId);
    }

    if (state.token) {
        api('/library/history', {
            method: 'POST',
            body: JSON.stringify({
                track_id: String(trackData.id),
                track_source: trackData.source || 'youtube',
                track_data: trackData
            })
        }).catch(() => {});
        checkIfLiked(trackData.id, trackData.source || 'youtube');
    } else {
        // Record guest listening event for guest personalized recommendations (Section 2, 27)
        try {
            let guestHistory = [];
            const raw = localStorage.getItem('basa_guest_history');
            if (raw) guestHistory = JSON.parse(raw);
            const canonicalTrackId = trackData.canonicalTrackId || trackData.canonicalId || `ct_${trackData.id}`;
            guestHistory.unshift({
                canonicalTrackId,
                title: trackData.title,
                artist: trackData.artist,
                album: trackData.album || '',
                playedAt: new Date().toISOString(),
                playedSeconds: 180,
                durationSeconds: trackData.duration || 200,
                completed: true
            });
            if (guestHistory.length > 50) guestHistory = guestHistory.slice(0, 50);
            localStorage.setItem('basa_guest_history', JSON.stringify(guestHistory));
        } catch (e) {}
    }
}

function playFromList(tracks, index = 0) {
    if (!tracks || tracks.length === 0) return;
    state.queue = tracks;
    state.queueIndex = Math.max(0, Math.min(index, tracks.length - 1));
    saveQueueState();
    playTrack(state.queue[state.queueIndex]);
}

function playNext(isUserInitiated = false) {
    // If repeat is 'one', only loop current song when it ended naturally.
    if (state.repeat === 'one' && !isUserInitiated) {
        window.playbackManager.seekTo(0);
        window.playbackManager.play();
        return;
    }

    // 1. Manual Queue Priority (Section 35): Play explicitly queued user songs first!
    repairManualQueue();
    while (state.queue && state.queueIndex < state.queue.length - 1) {
        state.queueIndex++;
        const nextTrack = state.queue[state.queueIndex];
        if (isShortTrack(nextTrack)) continue;
        if (state.currentTrack && isSameSongFamily(state.currentTrack, nextTrack)) continue;
        playTrack(nextTrack);
        return;
    }

    // 2. Context-Aware Smart Recommendation Queue (Section 18, 19, 21)
    // Run dynamic queue repair before popping recommendation
    repairRecommendedQueue();

    while (state.recommendedQueue && state.recommendedQueue.length > 0) {
        const nextTrack = state.recommendedQueue.shift();
        if (isValidNextRecommendation(nextTrack, state.currentTrack, state.recentCanonicalTrackIds || [])) {
            // Progressive refresh: replenish queue in background when running low
            if (state.recommendedQueue.length <= 2) {
                fetchUpNextRecommendations(nextTrack);
            }
            playTrack(nextTrack);
            return;
        }
    }

    // Fallback: If recommended queue ran out of valid songs, refresh
    if (state.currentTrack) {
        fetchUpNextRecommendations(state.currentTrack);
    }

    // 3. Fallback: Wrap around if repeat all, or charts
    if (state.repeat === 'all' && state.queue && state.queue.length > 0) {
        state.queueIndex = 0;
        playTrack(state.queue[0]);
        return;
    }

    if (window.currentChartsTracks && window.currentChartsTracks.length > 0) {
        const contextList = window.currentChartsTracks.map(t => mapTrackToStandard(t, t.source || 'youtube'));
        playFromList(contextList, 0);
        return;
    }

    state.isPlaying = false;
    updatePlayPauseButton();
    renderQueueDrawer();
}

function playPrev() {
    // 1. If playing > 3 seconds in, restart the song (standard music player UX)
    if (window.playbackManager && window.playbackManager.getCurrentTime() > 3) {
        window.playbackManager.seekTo(0);
        return;
    }

    // 2. If we are in an active queue list and not at the beginning:
    if (state.queueIndex > 0 && state.queue.length > 0) {
        let attempts = 0;
        while (attempts < state.queue.length) {
            if (state.queueIndex > 0) {
                state.queueIndex--;
            } else if (state.repeat === 'all') {
                state.queueIndex = state.queue.length - 1;
            } else {
                break;
            }
            const prevTrack = state.queue[state.queueIndex];
            if (!isShortTrack(prevTrack)) {
                playTrack(prevTrack, false, true);
                return;
            }
            attempts++;
        }
    }

    // 3. If at start of queue (or standalone song) and we have previous tracks in history:
    if (state.previousTracks && state.previousTracks.length > 0) {
        const prevTrack = state.previousTracks.pop();
        if (state.currentTrack) {
            if (state.queue.length === 0 || state.queue[state.queueIndex]?.id !== state.currentTrack.id) {
                state.queue = [prevTrack, state.currentTrack, ...state.queue];
            } else {
                state.queue.unshift(prevTrack);
            }
            state.queueIndex = 0;
        } else {
            state.queue.unshift(prevTrack);
            state.queueIndex = 0;
        }
        saveQueueState();
        playTrack(prevTrack, false, true);
        return;
    }

    // 4. Fallback: seek to beginning
    if (window.playbackManager) {
        window.playbackManager.seekTo(0);
    }
}

// ============================================
// QUEUE & PREVIOUS SONGS MANAGEMENT
// ============================================

function addToQueue(trackData) {
    if (!trackData) return;
    state.queue.push(trackData);
    saveQueueState();
    showToast(`Added "${trackData.title}" to Queue`, 'info');
    updateQueueBadge();
    renderQueueDrawer();
}

function addToQueueFromData(encodedData) {
    try {
        const trackData = JSON.parse(decodeURIComponent(encodedData));
        addToQueue(trackData);
    } catch (e) {
        console.error('Failed to add track to queue', e);
    }
}

function playNextInQueue(trackData) {
    if (!trackData) return;
    if (state.queue.length === 0 || state.queueIndex === -1) {
        state.queue = [trackData];
        state.queueIndex = 0;
        playTrack(trackData);
    } else {
        state.queue.splice(state.queueIndex + 1, 0, trackData);
        saveQueueState();
        showToast(`"${trackData.title}" will play next`, 'info');
        updateQueueBadge();
        renderQueueDrawer();
    }
}

function removeFromQueue(index) {
    if (index < 0 || index >= state.queue.length) return;
    if (index < state.queueIndex) {
        state.queueIndex--;
    } else if (index === state.queueIndex) {
        state.queueIndex = Math.max(0, state.queueIndex - 1);
    }
    state.queue.splice(index, 1);
    saveQueueState();
    updateQueueBadge();
    renderQueueDrawer();
    showToast('Removed from queue');
}

function clearQueue() {
    if (state.currentTrack) {
        state.queue = [state.currentTrack];
        state.queueIndex = 0;
    } else {
        state.queue = [];
        state.queueIndex = -1;
    }
    saveQueueState();
    updateQueueBadge();
    renderQueueDrawer();
    showToast('Upcoming queue cleared');
}

function clearPreviousTracks() {
    state.previousTracks = [];
    saveQueueState();
    updateQueueBadge();
    renderQueueDrawer();
    showToast('Previous tracks history cleared');
}

function replayPreviousTrack(index) {
    if (index < 0 || index >= state.previousTracks.length) return;
    const track = state.previousTracks[index];
    state.previousTracks.splice(index, 1);
    if (state.currentTrack) {
        state.queue.unshift(state.currentTrack);
        state.queueIndex = 0;
    }
    saveQueueState();
    playTrack(track, false, true);
    showToast(`Playing "${track.title}"`, 'info');
}

function playFromQueueIndex(index) {
    if (index < 0 || index >= state.queue.length) return;
    state.queueIndex = index;
    playTrack(state.queue[state.queueIndex]);
}

function updateQueueBadge() {
    const upnextCountEl = document.getElementById('queue-upnext-count');
    const historyCountEl = document.getElementById('queue-history-count');
    const queueBtn = document.getElementById('queue-btn');
    
    const upcomingCount = Math.max(0, state.queue.length - (state.queueIndex + 1)) + (state.recommendedQueue ? state.recommendedQueue.length : 0);
    if (upnextCountEl) upnextCountEl.textContent = upcomingCount;
    if (historyCountEl) historyCountEl.textContent = state.previousTracks.length;

    if (queueBtn) {
        let dot = queueBtn.querySelector('.queue-btn-dot');
        if (upcomingCount > 0) {
            if (!dot) {
                dot = document.createElement('span');
                dot.className = 'queue-btn-dot';
                queueBtn.appendChild(dot);
            }
        } else if (dot) {
            dot.remove();
        }
    }
}

function toggleQueueDrawer() {
    const drawer = document.getElementById('queue-drawer');
    const backdrop = document.getElementById('queue-drawer-backdrop');
    const queueBtn = document.getElementById('queue-btn');
    const fsQueueBtn = document.getElementById('fs-queue-btn');
    if (!drawer) return;

    const isHidden = drawer.classList.contains('hidden');
    if (isHidden) {
        drawer.classList.remove('hidden');
        if (backdrop) backdrop.classList.remove('hidden');
        if (queueBtn) queueBtn.classList.add('active');
        if (fsQueueBtn) fsQueueBtn.classList.add('active');
        renderQueueDrawer();
    } else {
        closeQueueDrawer();
    }
}

function closeQueueDrawer() {
    const drawer = document.getElementById('queue-drawer');
    const backdrop = document.getElementById('queue-drawer-backdrop');
    const queueBtn = document.getElementById('queue-btn');
    const fsQueueBtn = document.getElementById('fs-queue-btn');
    if (!drawer) return;
    drawer.classList.add('hidden');
    if (backdrop) backdrop.classList.add('hidden');
    if (queueBtn) queueBtn.classList.remove('active');
    if (fsQueueBtn) fsQueueBtn.classList.remove('active');
}

function openQueueDrawer() {
    const drawer = document.getElementById('queue-drawer');
    const backdrop = document.getElementById('queue-drawer-backdrop');
    const queueBtn = document.getElementById('queue-btn');
    const fsQueueBtn = document.getElementById('fs-queue-btn');
    if (!drawer) return;
    drawer.classList.remove('hidden');
    if (backdrop) backdrop.classList.remove('hidden');
    if (queueBtn) queueBtn.classList.add('active');
    if (fsQueueBtn) fsQueueBtn.classList.add('active');
    renderQueueDrawer();
}

function switchQueueTab(tab) {
    state.queueActiveTab = tab;
    const tabUpnext = document.getElementById('queue-tab-upnext');
    const tabHistory = document.getElementById('queue-tab-history');
    const viewUpnext = document.getElementById('queue-view-upnext');
    const viewHistory = document.getElementById('queue-view-history');

    if (tab === 'upnext') {
        if (tabUpnext) tabUpnext.classList.add('active');
        if (tabHistory) tabHistory.classList.remove('active');
        if (viewUpnext) { viewUpnext.classList.remove('hidden'); viewUpnext.classList.add('active'); }
        if (viewHistory) { viewHistory.classList.add('hidden'); viewHistory.classList.remove('active'); }
    } else {
        if (tabHistory) tabHistory.classList.add('active');
        if (tabUpnext) tabUpnext.classList.remove('active');
        if (viewHistory) { viewHistory.classList.remove('hidden'); viewHistory.classList.add('active'); }
        if (viewUpnext) { viewUpnext.classList.add('hidden'); viewUpnext.classList.remove('active'); }
    }
    renderQueueDrawer();
}

function renderQueueDrawer() {
    updateQueueBadge();

    // 1. Now Playing Section
    const nowCard = document.getElementById('queue-now-playing-card');
    const nowCover = document.getElementById('queue-now-cover');
    const nowTitle = document.getElementById('queue-now-title');
    const nowArtist = document.getElementById('queue-now-artist');
    const nowBadge = document.getElementById('queue-now-badge');
    const eqBars = document.getElementById('queue-eq-bars');

    if (state.currentTrack) {
        if (nowCover) nowCover.src = state.currentTrack.cover || '';
        if (nowTitle) nowTitle.textContent = state.currentTrack.title || 'Unknown Title';
        if (nowArtist) nowArtist.textContent = state.currentTrack.artist || 'Unknown Artist';
        if (nowBadge) nowBadge.innerHTML = renderQualityBadge(state.currentTrack);
        if (eqBars) eqBars.style.display = state.isPlaying ? 'flex' : 'none';
        if (nowCard) nowCard.style.opacity = '1';
    } else {
        if (nowCover) nowCover.src = '';
        if (nowTitle) nowTitle.textContent = 'Not Playing';
        if (nowArtist) nowArtist.textContent = 'Select a track to start';
        if (nowBadge) nowBadge.innerHTML = '';
        if (eqBars) eqBars.style.display = 'none';
        if (nowCard) nowCard.style.opacity = '0.6';
    }

    // 2. Up Next List (Manual Queue + Context-Aware Musical Recommendations)
    const upnextContainer = document.getElementById('queue-upnext-list');
    if (upnextContainer) {
        const upcomingTracks = [];
        for (let i = state.queueIndex + 1; i < state.queue.length; i++) {
            upcomingTracks.push({ track: state.queue[i], index: i });
        }

        let contentHtml = '';

        // Render manual queue tracks first (Section 35)
        if (upcomingTracks.length > 0) {
            const manualItemsHtml = upcomingTracks.map(({ track, index }) => {
                const cover = track.cover || '';
                return `
                    <div class="queue-item" onclick="playFromQueueIndex(${index})">
                        <div class="queue-item-thumb-wrap">
                            <img class="queue-item-thumb" src="${cover}" alt="" onerror="this.style.opacity='0.2'">
                            <div class="queue-item-play-overlay">▶</div>
                        </div>
                        <div class="queue-item-info">
                            <span class="queue-item-title">${escapeHtml(track.title || 'Unknown')}</span>
                            <span class="queue-item-artist">${escapeHtml(track.artist || 'Unknown Artist')}</span>
                        </div>
                        <div class="queue-item-actions">
                            <button class="queue-item-remove-btn" onclick="event.stopPropagation();removeFromQueue(${index})" title="Remove from Queue">✕</button>
                        </div>
                    </div>
                `;
            }).join('');

            contentHtml += `
                <div class="queue-section-subhead" style="color:#60a5fa;"><span>MANUAL QUEUE (${upcomingTracks.length})</span></div>
                ${manualItemsHtml}
            `;
        }

        // Render context-aware recommended queue (Section 18, 30, 40)
        if (state.recommendedQueue && state.recommendedQueue.length > 0) {
            const recItemsHtml = state.recommendedQueue.map((track, rIdx) => {
                const cover = track.cover || '';
                const reason = track.reason || 'Matches your vibe';
                const encoded = encodeURIComponent(JSON.stringify(track));
                return `
                    <div class="queue-item" onclick="playTrackFromData('${encoded}')">
                        <div class="queue-item-thumb-wrap">
                            <img class="queue-item-thumb" src="${cover}" alt="" onerror="this.style.opacity='0.2'">
                            <div class="queue-item-play-overlay">▶</div>
                        </div>
                        <div class="queue-item-info">
                            <span class="queue-item-title">${escapeHtml(track.title || 'Unknown')}</span>
                            <span class="queue-item-artist">${escapeHtml(track.artist || 'Unknown Artist')}</span>
                        </div>
                    </div>
                `;
            }).join('');

            contentHtml += `
                <div class="queue-section-subhead"><span>✨ SMART UP NEXT · MUSICAL CONTINUATION</span></div>
                ${recItemsHtml}
            `;
        }

        if (!contentHtml) {
            if (state.isFetchingRecommendations) {
                upnextContainer.innerHTML = `
                    <div class="queue-empty-state">
                        <div class="queue-empty-icon">⏳</div>
                        <p>Curating songs for your vibe...</p>
                    </div>
                `;
            } else {
                upnextContainer.innerHTML = `
                    <div class="queue-empty-state">
                        <div class="queue-empty-icon">🎵</div>
                        <p>No upcoming tracks in queue.</p>
                        <span style="font-size:11px;opacity:0.6;">Click "+ Queue" on any track or start playback for auto-curated music.</span>
                    </div>
                `;
            }
        } else {
            upnextContainer.innerHTML = contentHtml;
        }
    }

    // 3. Previous Songs (History) List
    const historyContainer = document.getElementById('queue-history-list');
    if (historyContainer) {
        if (!state.previousTracks || state.previousTracks.length === 0) {
            historyContainer.innerHTML = `
                <div class="queue-empty-state">
                    <div class="queue-empty-icon">🕒</div>
                    <p>No previous songs yet.</p>
                    <span style="font-size:11px;opacity:0.6;">Songs you finish or skip will appear here.</span>
                </div>
            `;
        } else {
            // Render in reverse order (most recently played at the top)
            const reversedHistory = state.previousTracks.slice().reverse();
            historyContainer.innerHTML = reversedHistory.map((track, revIdx) => {
                const realIdx = state.previousTracks.length - 1 - revIdx;
                const cover = track.cover || '';
                return `
                    <div class="queue-item" onclick="replayPreviousTrack(${realIdx})">
                        <div class="queue-item-thumb-wrap">
                            <img class="queue-item-thumb" src="${cover}" alt="" onerror="this.style.opacity='0.2'">
                            <div class="queue-item-play-overlay">↺</div>
                        </div>
                        <div class="queue-item-info">
                            <span class="queue-item-title">${escapeHtml(track.title || 'Unknown')}</span>
                            <span class="queue-item-artist">${escapeHtml(track.artist || 'Unknown Artist')}</span>
                        </div>
                        <div class="queue-item-actions">
                            <button class="queue-action-link" style="font-size:11px;" onclick="event.stopPropagation();replayPreviousTrack(${realIdx})">Replay</button>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }
}

function updatePlayerUI(trackData) {
    const coverEl = document.getElementById('player-cover');
    const titleEl = document.getElementById('player-title');
    const artistEl = document.getElementById('player-artist');

    // Full Screen Player Elements
    const fsCoverImg = document.getElementById('fs-cover-image');
    const fsTitleEl = document.getElementById('fs-title');
    const fsArtistEl = document.getElementById('fs-artist');

    const fallbackSrc = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'><rect width='100%25' height='100%25' fill='%231a1a1a'/><text x='50%25' y='50%25' font-size='80' fill='%23444' text-anchor='middle' dominant-baseline='middle'>🎵</text></svg>";

    if (coverEl) {
        if (trackData.cover) {
            const existingImg = coverEl.querySelector('img');
            if (existingImg && existingImg.src !== trackData.cover) {
                existingImg.classList.add('switching');
                const tempImg = new Image();
                tempImg.src = trackData.cover;
                tempImg.onload = () => {
                    existingImg.src = trackData.cover;
                    existingImg.alt = escapeHtml(trackData.title);
                    existingImg.classList.remove('switching');
                };
                tempImg.onerror = () => {
                    existingImg.src = fallbackSrc;
                    existingImg.classList.remove('switching');
                };
            } else if (!existingImg) {
                coverEl.innerHTML = `<img src="${trackData.cover}" alt="${escapeHtml(trackData.title)}" onerror="this.onerror=null; this.src='${fallbackSrc}';">`;
            }
            
            // Update FS Cover and trigger color extraction with smooth crossfade
            if (fsCoverImg) {
                fsCoverImg.crossOrigin = "Anonymous";
                if (fsCoverImg.src && fsCoverImg.src !== trackData.cover) {
                    fsCoverImg.classList.add('switching');
                }
                const tempFsImg = new Image();
                tempFsImg.crossOrigin = "Anonymous";
                tempFsImg.src = trackData.cover;
                tempFsImg.onload = () => {
                    fsCoverImg.src = trackData.cover;
                    fsCoverImg.classList.remove('switching');
                    document.documentElement.style.setProperty('--album-art', `url('${trackData.cover}')`);
                    extractColorsFromImage(fsCoverImg);
                };
                tempFsImg.onerror = () => {
                    fsCoverImg.src = fallbackSrc;
                    fsCoverImg.classList.remove('switching');
                    document.documentElement.style.setProperty('--album-art', `url('${fallbackSrc}')`);
                };
            }
        } else {
            coverEl.innerHTML = `<div style="width:100%;height:100%;display:grid;place-items:center;font-size:32px;opacity:0.2">🎵</div>`;
            if (fsCoverImg) {
                fsCoverImg.onerror = null;
                fsCoverImg.src = fallbackSrc;
                document.documentElement.style.setProperty('--album-art', `url('${fallbackSrc}')`);
            }
        }
    }

    // Smooth track text morph animation
    const miniTrackText = document.querySelector('.player-track-text');
    if (miniTrackText) {
        miniTrackText.classList.remove('track-text-transition');
        void miniTrackText.offsetWidth;
        miniTrackText.classList.add('track-text-transition');
    }
    const fsInfoArea = document.querySelector('.fs-info-area');
    if (fsInfoArea) {
        fsInfoArea.classList.remove('track-text-transition');
        void fsInfoArea.offsetWidth;
        fsInfoArea.classList.add('track-text-transition');
    }

    if (titleEl) titleEl.textContent = trackData.title;
    if (artistEl) artistEl.textContent = trackData.artist;

    if (fsTitleEl) fsTitleEl.textContent = trackData.title;
    if (fsArtistEl) fsArtistEl.textContent = trackData.artist;
    
    const fsQualityContainer = document.getElementById('fs-quality-badge-container');
    if (fsQualityContainer) {
        fsQualityContainer.innerHTML = renderQualityBadge(trackData);
    }

    const playerQualityContainer = document.getElementById('player-quality-badge-container');
    if (playerQualityContainer) {
        playerQualityContainer.innerHTML = renderQualityBadge(trackData);
    }

    const queueNowBadge = document.getElementById('queue-now-badge');
    if (queueNowBadge) {
        queueNowBadge.innerHTML = renderQualityBadge(trackData);
    }

    document.title = `${trackData.title} — ${trackData.artist} | BASA`;

    // Highlight playing track in lists
    document.querySelectorAll('.track-list-item').forEach(item => {
        item.classList.toggle('playing', String(item.dataset?.trackId) === String(trackData.id));
    });

    updatePlayerLikeButton();
    if (trackData && trackData.id) {
        checkIfLiked(trackData.id, trackData.source);
    }

    // Immediately display track duration from metadata
    const metaDuration = (Number.isFinite(trackData?.duration) && trackData.duration > 0)
        ? trackData.duration
        : ((Number.isFinite(trackData?.durationSec) && trackData.durationSec > 0)
            ? trackData.durationSec
            : ((Number.isFinite(trackData?.durationMs) && trackData.durationMs > 0)
                ? Math.round(trackData.durationMs / 1000)
                : 0));
    if (metaDuration > 0) {
        const durFormatted = formatDuration(metaDuration);
        const totalTimeEl = document.getElementById('total-time');
        const fsTotalTimeEl = document.getElementById('fs-total-time');
        if (totalTimeEl) {
            totalTimeEl.textContent = durFormatted;
            totalTimeEl.dataset.lastDur = String(Math.round(metaDuration));
        }
        if (fsTotalTimeEl) {
            fsTotalTimeEl.textContent = (fsTimeDisplayMode === 'remaining') ? `-${durFormatted}` : durFormatted;
            fsTotalTimeEl.dataset.lastDur = String(Math.round(metaDuration));
        }
    }
}

function updatePlayPauseButton() {
    const btn = document.getElementById('play-btn');
    if (btn) btn.textContent = state.isPlaying ? '⏸' : '▶';

    const fsPlayIcon = document.getElementById('fs-play-icon');
    if (fsPlayIcon) {
        if (state.isPlaying) {
            fsPlayIcon.innerHTML = `<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>`; // Pause SVG
        } else {
            fsPlayIcon.innerHTML = `<path d="M8 5v14l11-7z"/>`; // Play SVG
        }
    }
}

function setupPlayer() {
    const playBtn = document.getElementById('play-btn');
    const nextBtn = document.getElementById('next-btn');
    const prevBtn = document.getElementById('prev-btn');
    const shuffleBtn = document.getElementById('shuffle-btn');
    const repeatBtn = document.getElementById('repeat-btn');
    const progressBar = document.getElementById('progress-bar');
    const progressFill = document.getElementById('progress-fill');
    const volumeBar = document.getElementById('volume-bar');
    const volumeFill = document.getElementById('volume-fill');
    const volumeBtn = document.getElementById('volume-btn');
    const currentTimeEl = document.getElementById('current-time');
    const totalTimeEl = document.getElementById('total-time');

    if (playBtn) {
        playBtn.addEventListener('click', () => {
            if (!window.playbackManager.currentTrack) return;
            if (state.isPlaying) {
                window.playbackManager.pause();
                state.isPlaying = false;
                updatePlayPauseButton();
            } else {
                window.playbackManager.resume();
                state.isPlaying = true;
                updatePlayPauseButton();
            }
        });
    }
    if (nextBtn) nextBtn.addEventListener('click', () => playNext(true));
    if (prevBtn) prevBtn.addEventListener('click', playPrev);

    // Queue button & drawer listeners
    const queueBtn = document.getElementById('queue-btn');
    const queueCloseBtn = document.getElementById('queue-close-btn');
    const queueBackdrop = document.getElementById('queue-drawer-backdrop');
    const fsQueueBtn = document.getElementById('fs-queue-btn');
    if (queueBtn) queueBtn.addEventListener('click', toggleQueueDrawer);
    if (queueCloseBtn) queueCloseBtn.addEventListener('click', closeQueueDrawer);
    if (queueBackdrop) queueBackdrop.addEventListener('click', closeQueueDrawer);
    if (fsQueueBtn) fsQueueBtn.addEventListener('click', toggleQueueDrawer);

    if (shuffleBtn) {
        shuffleBtn.addEventListener('click', () => {
            state.shuffle = !state.shuffle;
            shuffleBtn.classList.toggle('active', state.shuffle);
            showToast(state.shuffle ? 'Shuffle on' : 'Shuffle off');
        });
    }
    if (repeatBtn) {
        repeatBtn.addEventListener('click', () => {
            if (state.repeat === 'none') { state.repeat = 'all'; repeatBtn.classList.add('active'); repeatBtn.textContent = '🔁'; showToast('Repeat all'); }
            else if (state.repeat === 'all') { state.repeat = 'one'; repeatBtn.textContent = '🔂'; showToast('Repeat one'); }
            else { state.repeat = 'none'; repeatBtn.classList.remove('active'); repeatBtn.textContent = '↻'; showToast('Repeat off'); }
        });
    }

    // Two-stage fast-start upgrade listeners (Section 12)
    window.playbackManager.onUpgradeStatusChange = (status, candidate) => {
        if (state.currentTrack) {
            state.currentTrack.upgradeStatus = status;
            updatePlayerUI(state.currentTrack);
        }
        const banner = document.getElementById('lossless-upgrade-banner');
        const textEl = document.getElementById('upgrade-banner-text');
        if (status === 'available' && candidate) {
            if (banner && textEl) {
                const bit = candidate.bitDepth || 24;
                const rate = candidate.sampleRate ? `${Math.round(candidate.sampleRate / 1000)} kHz` : '96 kHz';
                textEl.textContent = `Lossless available · Switch to FLAC (${bit}-bit / ${rate})`;
                banner.classList.remove('hidden');
            }
        } else if (status === 'completed' || status === 'idle' || status === 'failed') {
            if (banner) banner.classList.add('hidden');
        }
    };

    window.playbackManager.onPlayerStateChange = (playerState, currentTrack) => {
        if (state.currentTrack) {
            updatePlayerUI(state.currentTrack);
        }
    };

    window.playbackManager.onUpgraded = (upgradedTrack) => {
        state.currentTrack = upgradedTrack;
        updatePlayerUI(upgradedTrack);
        renderQueueDrawer();
    };

    window.playbackManager.onDurationChange = (dur) => {
        if (dur > 0) {
            const durText = formatDuration(dur);
            if (totalTimeEl) {
                totalTimeEl.textContent = durText;
                totalTimeEl.dataset.lastDur = String(Math.round(dur));
            }
            const fsTotalTimeEl = document.getElementById('fs-total-time');
            if (fsTotalTimeEl) {
                fsTotalTimeEl.textContent = durText;
                fsTotalTimeEl.dataset.lastDur = String(Math.round(dur));
            }
        }
    };

    window.playbackManager.onStateChange = (stateName) => {
        if (stateName === 'playing' || stateName === 'loadedmetadata') {
            if (stateName === 'playing') {
                state.isPlaying = true;
                updatePlayPauseButton();
                renderQueueDrawer();
            }
            const dur = window.playbackManager.getDuration();
            if (dur > 0) {
                const durText = formatDuration(dur);
                if (totalTimeEl) {
                    totalTimeEl.textContent = durText;
                    totalTimeEl.dataset.lastDur = String(Math.round(dur));
                }
                const fsTotalTimeEl = document.getElementById('fs-total-time');
                if (fsTotalTimeEl) {
                    fsTotalTimeEl.textContent = durText;
                    fsTotalTimeEl.dataset.lastDur = String(Math.round(dur));
                }
            }
        } else if (stateName === 'paused') {
            state.isPlaying = false;
            updatePlayPauseButton();
            renderQueueDrawer();
        } else if (stateName === 'ended') {
            playNext();
        }
    };
    
    window.playbackManager.onError = (err) => {
        showToast(err, 'error');
        state.isPlaying = false;
        updatePlayPauseButton();
    };

    let isUserScrubbing = false;

    // Direct hardware-timed update from HTML5 Audio timeupdate
    window.playbackManager.onTimeUpdate = (currentTime, duration) => {
        if (isUserScrubbing) return;
        const curText = formatDuration(currentTime);
        if (currentTimeEl) currentTimeEl.textContent = curText;
        const fsCurrentTimeEl = document.getElementById('fs-current-time');
        if (fsCurrentTimeEl) fsCurrentTimeEl.textContent = curText;

        if (duration > 0) {
            const pct = Math.min(100, Math.max(0, (currentTime / duration) * 100));
            if (progressBar && !progressBar.matches(':active')) progressBar.value = pct;
            if (progressFill && !progressBar.matches(':active')) progressFill.style.width = `${pct}%`;

            const fsProgressBar = document.getElementById('fs-progress-bar');
            const fsProgressFill = document.getElementById('fs-progress-fill');
            if (fsProgressBar && !fsProgressBar.matches(':active')) fsProgressBar.value = pct;
            if (fsProgressFill && !fsProgressFill.matches(':active')) fsProgressFill.style.width = `${pct}%`;

            const durFormatted = formatDuration(duration);
            if (totalTimeEl && totalTimeEl.textContent !== durFormatted) {
                totalTimeEl.textContent = durFormatted;
            }
            const fsTotalTimeEl = document.getElementById('fs-total-time');
            if (fsTotalTimeEl && fsTotalTimeEl.textContent !== durFormatted) {
                fsTotalTimeEl.textContent = durFormatted;
            }
        }
    };
    
    let smoothProgressPct = 0;
    let lastRenderedSec = -1;
    let lastRenderedDur = -1;

    function runHighFpsPlayerLoop() {
        try {
            if (state.isPlaying && window.playbackManager) {
                const currentTime = window.playbackManager.getCurrentTime();
                const duration = window.playbackManager.getDuration();
                
                // High-FPS continuous lyrics synchronization evaluation
                try {
                    syncLyricsTick(currentTime);
                } catch (e) {}

                // Update text timestamp once per whole second to eliminate DOM thrashing
                if (!isUserScrubbing) {
                    const currentSec = Math.floor(currentTime);
                    if (currentSec !== lastRenderedSec) {
                        lastRenderedSec = currentSec;
                        const curText = formatDuration(currentTime);
                        if (currentTimeEl) currentTimeEl.textContent = curText;
                        const fsCurrentTimeEl = document.getElementById('fs-current-time');
                        if (fsCurrentTimeEl) fsCurrentTimeEl.textContent = curText;

                        // Continuous remaining time calculation for fullscreen player (Apple Music style)
                        const fsTotalTimeEl = document.getElementById('fs-total-time');
                        if (fsTotalTimeEl && duration > 0) {
                            if (fsTimeDisplayMode === 'remaining') {
                                const remSec = Math.max(0, duration - currentTime);
                                fsTotalTimeEl.textContent = `-${formatDuration(remSec)}`;
                            } else {
                                fsTotalTimeEl.textContent = formatDuration(duration);
                            }
                        }
                    }

                    // High-refresh-rate smooth sub-pixel progress bar glide (lerp)
                    if (duration > 0) {
                        const targetPct = Math.min(100, Math.max(0, (currentTime / duration) * 100));
                        const diff = targetPct - smoothProgressPct;
                        if (Math.abs(diff) > 2.5 || diff < 0) {
                            // User seek / track start / jump
                            smoothProgressPct = targetPct;
                        } else {
                            // Continuous fluid glide (35% lerp per display frame yields liquid smoothness)
                            smoothProgressPct += diff * 0.35;
                        }

                        if (progressBar && !progressBar.matches(':active')) progressBar.value = smoothProgressPct;
                        if (progressFill && !progressBar?.matches(':active')) progressFill.style.width = `${smoothProgressPct}%`;

                        const fsProgressBar = document.getElementById('fs-progress-bar');
                        const fsProgressFill = document.getElementById('fs-progress-fill');
                        if (fsProgressBar && !fsProgressBar.matches(':active')) fsProgressBar.value = smoothProgressPct;
                        if (fsProgressFill && !fsProgressBar?.matches(':active')) fsProgressFill.style.width = `${smoothProgressPct}%`;

                        const durSec = Math.round(duration);
                        if (durSec !== lastRenderedDur) {
                            lastRenderedDur = durSec;
                            const durFormatted = formatDuration(duration);
                            if (totalTimeEl) totalTimeEl.textContent = durFormatted;
                            const fsTotalTimeEl = document.getElementById('fs-total-time');
                            if (fsTotalTimeEl) {
                                if (fsTimeDisplayMode === 'remaining') {
                                    const remSec = Math.max(0, duration - currentTime);
                                    fsTotalTimeEl.textContent = `-${formatDuration(remSec)}`;
                                } else {
                                    fsTotalTimeEl.textContent = durFormatted;
                                }
                            }
                        }
                    }
                }

                // Update loaded/buffering fraction
                const bufferedFrac = typeof window.playbackManager.getBufferedFraction === 'function'
                    ? window.playbackManager.getBufferedFraction()
                    : 0;
                if (bufferedFrac > 0) {
                    const bufPct = Math.min(100, Math.max(0, bufferedFrac * 100));
                    const pb = document.getElementById('progress-buffer');
                    if (pb) pb.style.width = `${bufPct}%`;
                    const fspb = document.getElementById('fs-progress-buffer');
                    if (fspb) fspb.style.width = `${bufPct}%`;
                }
            }
        } catch (err) {
            console.warn('[PlayerTick] Non-fatal tick error:', err);
        }
        requestAnimationFrame(runHighFpsPlayerLoop);
    }
    requestAnimationFrame(runHighFpsPlayerLoop);

    // Fast-seek helper for instant responsive scrubbing & clicking
    function applySeek(pct) {
        pct = Math.min(100, Math.max(0, pct));
        if (progressFill) progressFill.style.width = `${pct}%`;
        if (progressBar) progressBar.value = pct;

        const fsBar = document.getElementById('fs-progress-bar');
        const fsFill = document.getElementById('fs-progress-fill');
        if (fsBar) fsBar.value = pct;
        if (fsFill) fsFill.style.width = `${pct}%`;

        const duration = window.playbackManager.getDuration();
        if (duration > 0) {
            const seekTime = (pct / 100) * duration;
            if (currentTimeEl) currentTimeEl.textContent = formatDuration(seekTime);
            const fsTime = document.getElementById('fs-current-time');
            if (fsTime) fsTime.textContent = formatDuration(seekTime);
            window.playbackManager.seekTo(seekTime);
        }
    }

    // Direct click-to-seek on progress bar wrapper
    const progressBarWrapper = document.querySelector('.player-progress .progress-bar-wrapper');
    if (progressBarWrapper) {
        progressBarWrapper.addEventListener('click', (e) => {
            if (e.target === progressBar) return;
            const rect = progressBarWrapper.getBoundingClientRect();
            if (rect.width <= 0) return;
            const pct = ((e.clientX - rect.left) / rect.width) * 100;
            applySeek(pct);
        });
    }

    if (progressBar) {
        progressBar.addEventListener('input', (e) => {
            isUserScrubbing = true;
            const pct = parseFloat(e.target.value) || 0;
            if (progressFill) progressFill.style.width = `${pct}%`;
            const duration = window.playbackManager.getDuration();
            if (duration > 0) {
                const seekTime = (pct / 100) * duration;
                if (currentTimeEl) currentTimeEl.textContent = formatDuration(seekTime);
            }
            const fsBar = document.getElementById('fs-progress-bar');
            const fsFill = document.getElementById('fs-progress-fill');
            const fsTime = document.getElementById('fs-current-time');
            if (fsBar) fsBar.value = pct;
            if (fsFill) fsFill.style.width = `${pct}%`;
            if (fsTime && duration > 0) fsTime.textContent = formatDuration((pct / 100) * duration);
        });

        progressBar.addEventListener('change', (e) => {
            const duration = window.playbackManager.getDuration();
            const pct = parseFloat(e.target.value) || 0;
            if (duration > 0) {
                window.playbackManager.seekTo((pct / 100) * duration);
            }
            setTimeout(() => { isUserScrubbing = false; }, 150);
        });
    }

    const fsProgressBarWrapper = document.querySelector('.fs-progress-wrapper');
    const fsProgressBar = document.getElementById('fs-progress-bar');
    if (fsProgressBarWrapper) {
        fsProgressBarWrapper.addEventListener('click', (e) => {
            if (e.target === fsProgressBar) return;
            const rect = fsProgressBarWrapper.getBoundingClientRect();
            if (rect.width <= 0) return;
            const pct = ((e.clientX - rect.left) / rect.width) * 100;
            applySeek(pct);
        });
    }

    if (fsProgressBar) {
        fsProgressBar.addEventListener('input', (e) => {
            isUserScrubbing = true;
            const pct = parseFloat(e.target.value) || 0;
            const fsFill = document.getElementById('fs-progress-fill');
            if (fsFill) fsFill.style.width = `${pct}%`;
            const duration = window.playbackManager.getDuration();
            if (duration > 0) {
                const seekTime = (pct / 100) * duration;
                const fsTime = document.getElementById('fs-current-time');
                if (fsTime) fsTime.textContent = formatDuration(seekTime);
            }
            if (progressBar) progressBar.value = pct;
            if (progressFill) progressFill.style.width = `${pct}%`;
            if (currentTimeEl && duration > 0) currentTimeEl.textContent = formatDuration((pct / 100) * duration);
        });

        fsProgressBar.addEventListener('change', (e) => {
            const duration = window.playbackManager.getDuration();
            const pct = parseFloat(e.target.value) || 0;
            if (duration > 0) {
                window.playbackManager.seekTo((pct / 100) * duration);
            }
            setTimeout(() => { isUserScrubbing = false; }, 150);
        });
    }

    if (volumeBar) {
        volumeBar.value = state.volume;
        if (volumeFill) volumeFill.style.width = `${state.volume}%`;
        window.playbackManager.onReadyCallback = () => {
            window.playbackManager.setVolume(state.volume);
        };
        volumeBar.addEventListener('input', (e) => {
            state.volume = parseInt(e.target.value);
            window.playbackManager.setVolume(state.volume);
            if (volumeFill) volumeFill.style.width = `${state.volume}%`;
            localStorage.setItem('liquid_music_volume', state.volume);
        });
    }

    let isMuted = false;
    let preMuteVolume = state.volume;
    
    function setMuteState(muted) {
        isMuted = muted;
        const volBtns = [document.getElementById('volume-btn'), document.getElementById('fs-volume-btn')];
        const vBars = [document.getElementById('volume-bar'), document.getElementById('fs-volume-bar')];
        const vFills = [document.getElementById('volume-fill'), document.getElementById('fs-volume-fill')];

        if (isMuted) {
            preMuteVolume = state.volume;
            window.playbackManager.setVolume(0);
            vFills.forEach(f => f && (f.style.width = '0%'));
            vBars.forEach(b => b && (b.value = 0));
            const fsVolVal = document.getElementById('fs-volume-val');
            if (fsVolVal) fsVolVal.textContent = '0%';
        } else {
            window.playbackManager.setVolume(preMuteVolume);
            vFills.forEach(f => f && (f.style.width = `${preMuteVolume}%`));
            vBars.forEach(b => b && (b.value = preMuteVolume));
            const fsVolVal = document.getElementById('fs-volume-val');
            if (fsVolVal) fsVolVal.textContent = `${preMuteVolume}%`;
        }
        volBtns.forEach(btn => {
            if (btn) btn.innerHTML = isMuted 
                ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"></line><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon></svg>'
                : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
        });
    }

    if (volumeBtn) volumeBtn.addEventListener('click', () => setMuteState(!isMuted));
    const fsVolumeBtn = document.getElementById('fs-volume-btn');
    if (fsVolumeBtn) fsVolumeBtn.addEventListener('dblclick', () => setMuteState(!isMuted));

    function syncVolume(val) {
        state.volume = parseInt(val);
        window.playbackManager.setVolume(state.volume);
        localStorage.setItem('liquid_music_volume', state.volume);
        [document.getElementById('volume-fill'), document.getElementById('fs-volume-fill')].forEach(f => f && (f.style.width = `${state.volume}%`));
        [document.getElementById('volume-bar'), document.getElementById('fs-volume-bar')].forEach(b => b && (b.value = state.volume));
        const fsVolVal = document.getElementById('fs-volume-val');
        if (fsVolVal) fsVolVal.textContent = `${state.volume}%`;
    }
    
    if (volumeBar) {
        volumeBar.value = state.volume;
        if (volumeFill) volumeFill.style.width = `${state.volume}%`;
        window.playbackManager.onReadyCallback = () => window.playbackManager.setVolume(state.volume);
        volumeBar.addEventListener('input', (e) => syncVolume(e.target.value));
    }

    const fsVolumeBar = document.getElementById('fs-volume-bar');
    if (fsVolumeBar) {
        fsVolumeBar.value = state.volume;
        const fsVolumeFill = document.getElementById('fs-volume-fill');
        if (fsVolumeFill) fsVolumeFill.style.width = `${state.volume}%`;
        fsVolumeBar.addEventListener('input', (e) => syncVolume(e.target.value));
    }
}

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        switch (e.code) {
            case 'Space': 
                e.preventDefault(); 
                if (window.playbackManager.currentTrack && window.playbackManager.isReady) { 
                    state.isPlaying ? window.playbackManager.pause() : window.playbackManager.resume(); 
                } 
                break;
            case 'KeyQ':
                e.preventDefault();
                toggleQueueDrawer();
                break;
            case 'ArrowRight': 
                e.preventDefault(); 
                if (window.playbackManager.currentTrack) window.playbackManager.seek(window.playbackManager.getCurrentTime() + 5); 
                break;
            case 'ArrowLeft': 
                e.preventDefault(); 
                if (window.playbackManager.currentTrack) window.playbackManager.seek(Math.max(window.playbackManager.getCurrentTime() - 5, 0)); 
                break;
        }
    });
}

// 10. LIBRARY MODULE
async function loadLibrary() {
    const list = document.getElementById('liked-list');
    if (!list) return;
    if (!state.token) {
        list.innerHTML = '<div class="empty-state">Please sign in to view your liked songs</div>';
        return;
    }

    list.innerHTML = '<div class="loader">Loading liked songs...</div>';
    try {
        const data = await api('/library/liked');
        let items = data.tracks || [];
        // Handle tracks with videoId (YouTube) or id (Archive/Telegram/Local)
        items = items.filter(item => item.track_data && (item.track_data.videoId || item.track_data.id));
        if (items.length > 0) {
            window.currentLibraryTracks = items.map(item => ({ ...item.track_data, source: item.track_source }));
            list.innerHTML = items.map((item, i) =>
                renderTrackListItem(item.track_data, i, item.track_source, { contextType: 'library' })
            ).join('');
        } else {
            list.innerHTML = '<div class="empty-state">No liked songs yet. Like songs by clicking ♡</div>';
        }
    } catch (err) {
        list.innerHTML = '<div class="empty-state">Failed to load library</div>';
    }
}

async function toggleLike(trackId, source, encodedData) {
    if (!state.token) { showToast('Please sign in to like tracks', 'error'); return; }

    const trackData = JSON.parse(decodeURIComponent(encodedData));
    const isLiked = state.likedTrackIds.has(String(trackId));

    try {
        if (isLiked) {
            await api(`/library/like/${trackId}?source=${source}`, { method: 'DELETE' });
            state.likedTrackIds.delete(String(trackId));
            showToast('Removed from likes');
        } else {
            await api('/library/like', {
                method: 'POST',
                body: JSON.stringify({ track_id: String(trackId), track_source: source, track_data: trackData })
            });
            state.likedTrackIds.add(String(trackId));
            showToast('Added to likes ♥', 'success');

            // Send session feedback to boost similar musical DNA (Section 25, 38)
            api('/music/session-feedback', {
                method: 'POST',
                body: JSON.stringify({
                    trackId: String(trackId),
                    action: 'like',
                    durationPlayed: 0,
                    track: trackData,
                    sessionId: state.user?.id || 'guest_session'
                })
            }).catch(() => {});
        }

        // Update player like button
        updatePlayerLikeButton();

        // Refresh library view if active
        if (state.currentView === 'library') loadLibrary();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function updatePlayerLikeButton() {
    if (!state.currentTrack) return;
    const liked = state.likedTrackIds.has(String(state.currentTrack.id));
    
    // 1. Bottom Mini-Player Like Button
    const btn = document.getElementById('player-like-btn');
    if (btn) {
        btn.textContent = liked ? '♥' : '♡';
        btn.classList.toggle('liked', liked);
        btn.setAttribute('title', liked ? 'Remove from Favorites' : 'Add to Favorites');
    }

    // 2. Fullscreen Player Like Button
    const fsBtn = document.getElementById('fs-like-btn');
    if (fsBtn) {
        fsBtn.classList.toggle('liked', liked);
        fsBtn.setAttribute('title', liked ? 'Remove from Favorites' : 'Add to Favorites');
        const icon = fsBtn.querySelector('.fs-heart-icon');
        if (icon) {
            if (liked) {
                icon.setAttribute('fill', '#ff3b5c');
                icon.setAttribute('stroke', '#ff3b5c');
            } else {
                icon.setAttribute('fill', 'none');
                icon.setAttribute('stroke', 'currentColor');
            }
        }
    }
}

async function checkIfLiked(trackId, source) {
    if (!state.token) return;
    try {
        const data = await api(`/library/liked/check/${trackId}?source=${source || 'youtube'}`);
        if (data.liked) state.likedTrackIds.add(String(trackId));
        else state.likedTrackIds.delete(String(trackId));
        updatePlayerLikeButton();
    } catch (err) { /* ignore */ }
}

// 11. PLAYLIST MODULE
async function loadPlaylists() {
    if (!state.token) return;
    try {
        const data = await api('/playlists');
        state.playlists = data.playlists || [];
        updatePlaylistSidebar();
    } catch (err) {
        console.error('Failed to load playlists', err);
    }
}

function updatePlaylistSidebar() {
    const list = document.getElementById('playlist-list');
    if (!list) return;

    if (!state.token || state.playlists.length === 0) {
        list.innerHTML = `<li class="playlist-empty">${state.token ? 'No playlists yet' : 'Sign in to create playlists'}</li>`;
        return;
    }

    list.innerHTML = state.playlists.map(pl => `
        <li><a href="#playlist/${pl.id}" class="playlist-link">${escapeHtml(pl.name)} <span class="playlist-count">${pl.track_count || 0}</span></a></li>
    `).join('');
}

async function loadPlaylist(id) {
    state.currentPlaylistId = id;
    const tracksContainer = document.getElementById('playlist-tracks');
    const nameEl = document.getElementById('playlist-name');
    const descEl = document.getElementById('playlist-desc');
    const countEl = document.getElementById('playlist-track-count');
    const playAllBtn = document.getElementById('playlist-play-all');
    const deleteBtn = document.getElementById('playlist-delete-btn');
    const coverEl = document.getElementById('playlist-cover');

    if (!tracksContainer) return;
    tracksContainer.innerHTML = '<div class="loader">Loading playlist...</div>';

    try {
        const data = await api(`/playlists/${id}`);
        const playlist = data.playlist;
        let tracks = data.tracks || [];
        // Handle tracks with videoId (YouTube) or id (Archive/Telegram/Local) and filter out Shorts
        tracks = tracks.filter(t => t.track_data && (t.track_data.videoId || t.track_data.id) && !isShortTrack(t.track_data));

        if (nameEl) nameEl.textContent = playlist.name;
        if (descEl) descEl.textContent = playlist.description || '';
        if (countEl) countEl.textContent = `${tracks.length} track${tracks.length !== 1 ? 's' : ''}`;
        if (coverEl && playlist.cover_url) {
            coverEl.innerHTML = `<img src="${playlist.cover_url}" alt="${escapeHtml(playlist.name)}">`;
        }

        if (deleteBtn) deleteBtn.onclick = () => deletePlaylist(id);

        if (tracks.length > 0) {
            const trackObjs = tracks.map(t => ({
                ...t.track_data,
                source: t.track_source,
                playlistEntryId: t.id
            }));
            window.currentPlaylistTracks = trackObjs;

            if (playAllBtn) playAllBtn.onclick = () => playFromList(trackObjs, 0);

            tracksContainer.innerHTML = tracks.map((item, i) =>
                renderTrackListItem(item.track_data, i, item.track_source, {
                    playlistId: id,
                    playlistEntryId: item.id,
                    contextType: 'playlist'
                })
            ).join('');
        } else {
            tracksContainer.innerHTML = '<div class="empty-state">This playlist is empty. Search for songs and add them!</div>';
        }
    } catch (err) {
        tracksContainer.innerHTML = '<div class="empty-state">Failed to load playlist</div>';
    }
}

async function createPlaylistSubmit(e) {
    e.preventDefault();
    const nameInput = document.getElementById('playlist-name-input');
    const descInput = document.getElementById('playlist-desc-input');
    const name = nameInput?.value?.trim();
    const desc = descInput?.value?.trim() || '';

    if (!name) { showToast('Please enter a playlist name', 'error'); return; }

    try {
        await api('/playlists', { method: 'POST', body: JSON.stringify({ name, description: desc }) });
        showToast('Playlist created!', 'success');
        hideModal('playlist-modal');
        if (nameInput) nameInput.value = '';
        if (descInput) descInput.value = '';
        loadPlaylists();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function deletePlaylist(id) {
    if (!confirm('Delete this playlist? This cannot be undone.')) return;
    try {
        await api(`/playlists/${id}`, { method: 'DELETE' });
        showToast('Playlist deleted');
        loadPlaylists();
        navigate('#home');
    } catch (err) { showToast(err.message, 'error'); }
}

async function removeFromPlaylist(playlistId, entryId) {
    try {
        await api(`/playlists/${playlistId}/tracks/${entryId}`, { method: 'DELETE' });
        showToast('Track removed');
        if (state.currentPlaylistId === playlistId) loadPlaylist(playlistId);
    } catch (err) { showToast(err.message, 'error'); }
}

function showAddToPlaylist(event, trackId, source, encodedData) {
    event.stopPropagation();
    if (!state.token) { showToast('Please sign in to add to playlists', 'error'); return; }

    const menu = document.getElementById('context-menu');
    if (!menu) return;

    const plList = document.getElementById('context-menu-playlists');
    if (plList) {
        if (state.playlists.length === 0) {
            plList.innerHTML = '<li style="padding:10px;color:rgba(255,255,255,0.4);font-size:12px">No playlists yet</li>';
        } else {
            plList.innerHTML = state.playlists.map(pl => `
                <li onclick="addToPlaylist('${pl.id}','${trackId}','${source}','${encodedData}')">${escapeHtml(pl.name)}</li>
            `).join('');
        }
    }

    menu.classList.remove('hidden');
    menu.style.display = 'block';

    const x = Math.min(event.clientX, window.innerWidth - 220);
    const y = Math.min(event.clientY, window.innerHeight - 200);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
}

async function addToPlaylist(playlistId, trackId, source, encodedData) {
    const trackData = JSON.parse(decodeURIComponent(encodedData));
    try {
        await api(`/playlists/${playlistId}/tracks`, {
            method: 'POST',
            body: JSON.stringify({ track_id: String(trackId), track_source: source, track_data: trackData })
        });
        showToast('Added to playlist', 'success');
    } catch (err) { showToast(err.message, 'error'); }
    finally {
        const menu = document.getElementById('context-menu');
        if (menu) { menu.style.display = 'none'; menu.classList.add('hidden'); }
    }
}

// 12. UPLOAD MODULE
async function loadUploads() {
    const list = document.getElementById('upload-list');
    if (!list) return;
    if (!state.token) {
        list.innerHTML = '<div class="empty-state">Please sign in to view uploads</div>';
        return;
    }

    list.innerHTML = '<div class="loader">Loading uploads...</div>';
    try {
        const data = await api('/upload/tracks');
        const tracks = data.tracks || [];
        if (tracks.length > 0) {
            window.currentUploadTracks = tracks.map(t => ({ ...t, source: 'local' }));
            list.innerHTML = tracks.map((t, i) => renderTrackListItem(t, i, 'local', { isUpload: true, contextType: 'upload' })).join('');
        } else {
            list.innerHTML = '<div class="empty-state">No uploads yet. Drag & drop audio files above!</div>';
        }
    } catch (err) {
        list.innerHTML = '<div class="empty-state">Failed to load uploads</div>';
    }
}

function setupUpload() {
    const fileInput = document.getElementById('file-input');
    const uploadZone = document.getElementById('upload-zone');
    const uploadNavBtn = document.getElementById('upload-nav-btn');

    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) uploadFiles(e.target.files);
        });
    }
    if (uploadZone) {
        uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
        uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
        uploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadZone.classList.remove('drag-over');
            if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
        });
    }
    if (uploadNavBtn) {
        uploadNavBtn.addEventListener('click', () => {
            if (!state.token) { showToast('Please sign in to upload', 'error'); return; }
            navigate('#uploads');
        });
    }
}

async function uploadFiles(files) {
    if (!state.token) { showToast('Please sign in to upload', 'error'); return; }
    showToast(`Uploading ${files.length} file(s)...`);

    for (const file of files) {
        const formData = new FormData();
        formData.append('audio', file);
        formData.append('title', file.name.replace(/\.[^.]+$/, ''));
        try {
            const res = await api('/upload', { method: 'POST', body: formData });
            const q = res.track?.quality !== 'UNKNOWN' ? res.track?.quality : '';
            const f = res.track?.format || 'UNKNOWN';
            showToast(`Uploaded ${res.track?.title} (${f} ${q})`, 'success');
        } catch (err) {
            showToast(`Failed: ${file.name} — ${err.message}`, 'error');
        }
    }
    if (state.currentView === 'uploads') loadUploads();
}

async function deleteUpload(id) {
    if (!confirm('Delete this uploaded track?')) return;
    try {
        await api(`/upload/${id}`, { method: 'DELETE' });
        showToast('Upload deleted');
        if (state.currentView === 'uploads') loadUploads();
    } catch (err) { showToast(err.message, 'error'); }
}

// 13. MODALS & CONTEXT MENU
function setupModals() {
    // Auth modal
    const authBtn = document.getElementById('auth-btn');
    const authClose = document.getElementById('auth-modal-close');
    const authSwitch = document.getElementById('auth-switch-btn');
    const authForm = document.getElementById('auth-form');
    const logoutBtn = document.getElementById('logout-btn');
    const playerLikeBtn = document.getElementById('player-like-btn');

    if (authBtn) authBtn.addEventListener('click', () => showAuthModal('login'));
    if (authClose) authClose.addEventListener('click', hideAuthModal);
    if (authSwitch) {
        authSwitch.addEventListener('click', () => {
            const mode = authForm?.dataset.mode || 'login';
            showAuthModal(mode === 'login' ? 'signup' : 'login');
        });
    }
    if (authForm) authForm.addEventListener('submit', handleAuthSubmit);
    if (logoutBtn) logoutBtn.addEventListener('click', logout);

    // Player like button
    if (playerLikeBtn) {
        playerLikeBtn.addEventListener('click', () => {
            if (!state.currentTrack) return;
            const encoded = encodeURIComponent(JSON.stringify(state.currentTrack));
            toggleLike(state.currentTrack.id, state.currentTrack.source || 'youtube', encoded);
        });
    }

    // Playlist modal
    const createBtn = document.getElementById('create-playlist-btn');
    const playlistClose = document.getElementById('playlist-modal-close');
    const playlistForm = document.getElementById('playlist-form');

    if (createBtn) {
        createBtn.addEventListener('click', () => {
            if (!state.token) { showToast('Please sign in to create playlists', 'error'); return; }
            showModal('playlist-modal');
        });
    }
    if (playlistClose) playlistClose.addEventListener('click', () => hideModal('playlist-modal'));
    if (playlistForm) playlistForm.addEventListener('submit', createPlaylistSubmit);

    // Close modals on backdrop click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { overlay.style.display = 'none'; overlay.classList.add('hidden'); }
        });
    });
}

function showModal(id) {
    const modal = document.getElementById(id);
    if (modal) { modal.style.display = 'grid'; modal.classList.remove('hidden'); }
}

function hideModal(id) {
    const modal = document.getElementById(id);
    if (modal) { modal.style.display = 'none'; modal.classList.add('hidden'); }
}

function setupContextMenu() {
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('context-menu');
        if (menu && !menu.contains(e.target) && menu.style.display === 'block') {
            menu.style.display = 'none';
            menu.classList.add('hidden');
        }
    });
}

// 14. NAVBAR SCROLL
function setupNavbarScroll() {
    const navbar = document.getElementById('navbar');
    if (!navbar) return;
    let lastScroll = 0;
    const mainContent = document.getElementById('main-content');
    const scrollTarget = mainContent || window;

    (mainContent || document).addEventListener('scroll', () => {
        const scrollY = mainContent ? mainContent.scrollTop : window.scrollY;
        navbar.classList.toggle('scrolled', scrollY > 20);
        lastScroll = scrollY;
    });
}

// 15. GLASS EFFECTS
function setupGlassEffects() {
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    if (prefersReduced || isTouch) return;

    let mx = window.innerWidth / 2, my = window.innerHeight / 2;
    let vx = 0, vy = 0, sv = 0, lx = mx, ly = my;

    document.addEventListener('mousemove', (e) => {
        vx = e.clientX - lx; vy = e.clientY - ly;
        lx = e.clientX; ly = e.clientY;
        mx = e.clientX; my = e.clientY;
    });

    function animate() {
        const vel = Math.sqrt(vx * vx + vy * vy);
        sv = sv * 0.92 + vel * 0.08;

        document.querySelectorAll('.glass-subtle, .glass-standard, .glass-premium, .glass-floating, [data-prism]').forEach(el => {
            const r = el.getBoundingClientRect();
            if (r.bottom < 0 || r.top > window.innerHeight) return;

            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            const dx = mx - cx, dy = my - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const maxD = Math.max(r.width, r.height) * 1.2;
            const prox = Math.max(0, 1 - dist / maxD);

            const lxPct = ((mx - r.left) / r.width) * 100;
            const lyPct = ((my - r.top) / r.height) * 100;
            el.style.setProperty('--light-x', `${lxPct}%`);
            el.style.setProperty('--light-y', `${lyPct}%`);
            el.style.setProperty('--cursor-proximity', prox.toFixed(3));

            const inner = el.querySelector('.glass-inner-depth');
            if (inner) {
                el.style.setProperty('--parallax-x', `${(dx * 0.08).toFixed(1)}px`);
                el.style.setProperty('--parallax-y', `${(dy * 0.08).toFixed(1)}px`);
            }

            if (el.hasAttribute('data-prism')) {
                const angle = Math.atan2(dy, dx) * (180 / Math.PI);
                const intensity = Math.min(1, sv * prox * 0.025);
                el.style.setProperty('--prism-angle', `${angle}deg`);
                el.style.setProperty('--prism-opacity', intensity.toFixed(3));
            }
        });

        vx *= 0.92; vy *= 0.92;
        requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
}

// 16. INITIALIZATION
document.addEventListener('DOMContentLoaded', () => {
    window.ytAudioPlayer.init('yt-player');
    window.playbackManager.initYouTube(window.ytAudioPlayer);
    window.playbackManager.initSync(window.syncManager);
    initAuth();
    setupRouter();
    setupSearch();
    setupPlayer();
    setupUpload();
    setupModals();
    setupContextMenu();
    setupKeyboardShortcuts();
    setupNavbarScroll();
    setupGlassEffects();
    setupFullScreenPlayer();
    setupSync();

    // Navigate to initial hash or home
    const hash = window.location.hash || '#home';
    navigate(hash);
    // Trigger initial route
    if (hash === '#home' || hash === '') {
        showView('view-home');
        loadHome();
    }
});

// 17. FULL SCREEN PLAYER & LIQUID GLASS PHYSICS
function extractColorsFromImage(imgEl) {
    if (!imgEl || !imgEl.complete) return;
    try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 64;
        canvas.height = 64;
        ctx.drawImage(imgEl, 0, 0, 64, 64);
        const data = ctx.getImageData(0, 0, 64, 64).data;
        let r = 0, g = 0, b = 0, count = 0;
        // Sample border pixels more lightly, center more heavily or just average all
        for (let i = 0; i < data.length; i += 16) {
            r += data[i];
            g += data[i+1];
            b += data[i+2];
            count++;
        }
        r = Math.floor(r/count); g = Math.floor(g/count); b = Math.floor(b/count);
        
        // Setup a secondary color by shifting hue or just taking a specific section
        let r2 = 255 - r, g2 = 255 - g, b2 = 255 - b; // simplistic complement
        
        document.documentElement.style.setProperty('--fs-color-primary', `rgb(${r},${g},${b})`);
        document.documentElement.style.setProperty('--fs-color-secondary', `rgb(${r2},${g2},${b2})`);
    } catch(e) {
        // Tainted canvas (CORS) - ignore
    }
}

function setFsPlayerMode(mode) {
    fsPlayerMode = mode;
    const layout = document.getElementById('fs-layout-container') || document.querySelector('.fs-split-layout');
    const lyricsBtn = document.getElementById('fs-lyrics-btn');
    const lyricsPanel = document.getElementById('fs-lyrics-panel');

    if (!layout) return;

    if (mode === 'lyrics' && isLyricsAvailable) {
        layout.classList.remove('fs-mode-artwork');
        layout.classList.add('fs-mode-lyrics');
        if (lyricsPanel) lyricsPanel.classList.add('show-lyrics');
        if (lyricsBtn) {
            lyricsBtn.classList.add('active');
            lyricsBtn.setAttribute('aria-pressed', 'true');
            lyricsBtn.title = 'Hide Lyrics';
        }
        if (window.playbackManager) {
            syncLyricsTick(window.playbackManager.getCurrentTime(), true);
        }
    } else {
        // Mode 1: Centered Artwork Mode (Apple Music style)
        layout.classList.remove('fs-mode-lyrics');
        layout.classList.add('fs-mode-artwork');
        if (lyricsPanel) lyricsPanel.classList.remove('show-lyrics');
        if (lyricsBtn) {
            lyricsBtn.classList.remove('active');
            lyricsBtn.setAttribute('aria-pressed', 'false');
            lyricsBtn.title = isLyricsAvailable ? 'Show Lyrics' : 'Lyrics not available for this track';
        }
    }
}

function updateFsLyricsButtonState(available, loading = false) {
    isLyricsAvailable = available;
    const lyricsBtn = document.getElementById('fs-lyrics-btn');
    if (!lyricsBtn) return;

    if (loading) {
        lyricsBtn.classList.add('loading');
        lyricsBtn.classList.remove('disabled');
        lyricsBtn.title = 'Looking for lyrics...';
    } else if (available) {
        lyricsBtn.classList.remove('loading', 'disabled');
        lyricsBtn.title = (fsPlayerMode === 'lyrics') ? 'Hide Lyrics' : 'Show Lyrics';
    } else {
        lyricsBtn.classList.remove('loading', 'active');
        lyricsBtn.classList.add('disabled');
        lyricsBtn.title = 'Lyrics not available for this track';
    }
}

function setupFullScreenPlayer() {
    const fsPlayer = document.getElementById('fs-player');
    const trackInfoBtn = document.getElementById('player-track-info');
    const closeBtn = document.getElementById('fs-close-btn');
    const fsFsBtn = document.getElementById('fs-fullscreen-toggle-btn');
    const lyricsBtn = document.getElementById('fs-lyrics-btn');
    const lyricsPanel = document.getElementById('fs-lyrics-panel');

    // Default to artwork centered mode initially
    setFsPlayerMode('artwork');

    if (trackInfoBtn && fsPlayer) {
        trackInfoBtn.addEventListener('click', () => {
            if (!state.currentTrack) return;
            fsPlayer.classList.remove('hidden');
            fsPlayer.setAttribute('aria-hidden', 'false');
            document.body.classList.add('fullscreen-player-open');
            // Allow display change before opacity fade
            setTimeout(() => fsPlayer.classList.add('active'), 10);
            
            // Re-extract color if cover was updated before it was open
            const img = document.getElementById('fs-cover-image');
            if (img && img.src) extractColorsFromImage(img);

            // Determine mode on open
            if (isLyricsAvailable && userWantsLyrics) {
                setFsPlayerMode('lyrics');
            } else {
                setFsPlayerMode('artwork');
            }

            // Ensure lyrics are loaded
            if (state.currentTrack && (!currentLyricsData || currentLyricsTrackId !== state.currentTrack.id)) {
                loadLyricsForTrack(state.currentTrack);
            } else if (currentLyricsData && currentLyricsData.synced && fsPlayerMode === 'lyrics') {
                setTimeout(() => {
                    const ct = window.playbackManager ? window.playbackManager.getCurrentTime() : 0;
                    syncLyricsTick(ct, true);
                }, 120);
            }
        });
    }

    // Native Fullscreen toggle button (top right: ⤢)
    if (fsFsBtn && fsPlayer) {
        fsFsBtn.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                if (fsPlayer.requestFullscreen) {
                    fsPlayer.requestFullscreen();
                } else if (fsPlayer.webkitRequestFullscreen) {
                    fsPlayer.webkitRequestFullscreen();
                }
            } else {
                if (document.exitFullscreen) {
                    document.exitFullscreen();
                } else if (document.webkitExitFullscreen) {
                    document.webkitExitFullscreen();
                }
            }
        });
    }

    document.addEventListener('fullscreenchange', () => {
        const fsIcon = document.getElementById('fs-fs-icon');
        if (fsIcon) {
            if (document.fullscreenElement) {
                fsIcon.innerHTML = `
                    <polyline points="4 14 10 14 10 20"/>
                    <polyline points="20 10 14 10 14 4"/>
                    <line x1="14" y1="10" x2="21" y2="3"/>
                    <line x1="3" y1="21" x2="10" y2="14"/>
                `;
            } else {
                fsIcon.innerHTML = `
                    <polyline points="15 3 21 3 21 9"/>
                    <polyline points="9 21 3 21 3 15"/>
                    <line x1="21" y1="3" x2="14" y2="10"/>
                    <line x1="3" y1="21" x2="10" y2="14"/>
                `;
            }
        }
    });

    // Close button (top right: ✕)
    if (closeBtn && fsPlayer) {
        closeBtn.addEventListener('click', () => {
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
            }
            fsPlayer.classList.remove('active');
            fsPlayer.setAttribute('aria-hidden', 'true');
            document.body.classList.remove('fullscreen-player-open');
            setTimeout(() => fsPlayer.classList.add('hidden'), 500); // Wait for fade
        });
    }

    // Lyrics toggle button (Apple Music speech bubble)
    if (lyricsBtn) {
        lyricsBtn.addEventListener('click', () => {
            if (!isLyricsAvailable) {
                showToast('Lyrics not available for this track', 'info');
                return;
            }
            const nextMode = (fsPlayerMode === 'lyrics') ? 'artwork' : 'lyrics';
            userWantsLyrics = (nextMode === 'lyrics');
            setFsPlayerMode(nextMode);
        });
    }

    // Remaining vs Total Time Toggle Click
    const fsTotalTimeEl = document.getElementById('fs-total-time');
    if (fsTotalTimeEl) {
        fsTotalTimeEl.addEventListener('click', () => {
            fsTimeDisplayMode = (fsTimeDisplayMode === 'remaining') ? 'total' : 'remaining';
            localStorage.setItem('basa_fs_time_mode', fsTimeDisplayMode);
            const dur = window.playbackManager ? window.playbackManager.getDuration() : 0;
            const ct = window.playbackManager ? window.playbackManager.getCurrentTime() : 0;
            if (dur > 0) {
                if (fsTimeDisplayMode === 'remaining') {
                    const remSec = Math.max(0, dur - ct);
                    fsTotalTimeEl.textContent = `-${formatDuration(remSec)}`;
                } else {
                    fsTotalTimeEl.textContent = formatDuration(dur);
                }
            }
        });
    }

    // Volume Popover Interactivity
    const fsVolumeWrap = document.getElementById('fs-volume-wrap');
    const fsVolumeBtn = document.getElementById('fs-volume-btn');
    const fsVolumePopover = document.getElementById('fs-volume-popover');
    let volPopoverTimeout = null;

    if (fsVolumeWrap && fsVolumePopover) {
        fsVolumeWrap.addEventListener('mouseenter', () => {
            if (volPopoverTimeout) clearTimeout(volPopoverTimeout);
            fsVolumePopover.classList.remove('hidden');
        });
        fsVolumeWrap.addEventListener('mouseleave', () => {
            volPopoverTimeout = setTimeout(() => {
                fsVolumePopover.classList.add('hidden');
            }, 400);
        });
    }

    if (fsVolumeBtn) {
        fsVolumeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (fsVolumePopover) {
                fsVolumePopover.classList.toggle('hidden');
            }
        });
    }

    // Close volume popover on click outside
    document.addEventListener('click', (e) => {
        if (fsVolumePopover && !fsVolumePopover.contains(e.target) && !fsVolumeWrap.contains(e.target)) {
            fsVolumePopover.classList.add('hidden');
        }
    });

    // Like / Favorite button in Fullscreen player
    const fsLikeBtn = document.getElementById('fs-like-btn');
    if (fsLikeBtn) {
        fsLikeBtn.addEventListener('click', () => {
            if (!state.currentTrack) return;
            const encoded = encodeURIComponent(JSON.stringify(state.currentTrack));
            toggleLike(state.currentTrack.id, state.currentTrack.source || 'youtube', encoded);
            fsLikeBtn.classList.add('pop');
            setTimeout(() => fsLikeBtn.classList.remove('pop'), 350);
        });
    }

    // Top Right Options Menu in Fullscreen player
    const fsOptionsBtn = document.getElementById('fs-options-btn');
    const fsOptionsMenu = document.getElementById('fs-options-menu');
    const fsOptionsTrackName = document.getElementById('fs-options-track-name');

    function closeFsOptionsMenu() {
        if (fsOptionsMenu) {
            fsOptionsMenu.classList.add('hidden');
            fsOptionsMenu.setAttribute('aria-hidden', 'true');
        }
    }

    if (fsOptionsBtn && fsOptionsMenu) {
        fsOptionsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isHidden = fsOptionsMenu.classList.contains('hidden');
            if (isHidden) {
                if (fsOptionsTrackName && state.currentTrack) {
                    fsOptionsTrackName.textContent = `${state.currentTrack.title || 'Track'} • ${state.currentTrack.artist || ''}`;
                }
                const optLikeText = document.getElementById('fs-opt-like-text');
                if (optLikeText && state.currentTrack) {
                    optLikeText.textContent = state.isLiked ? 'Remove from Favorites' : 'Add to Favorites';
                }
                const optRepeatText = document.getElementById('fs-opt-repeat-text');
                if (optRepeatText) {
                    optRepeatText.textContent = `Repeat: ${state.repeat || 'Off'}`;
                }
                fsOptionsMenu.classList.remove('hidden');
                fsOptionsMenu.setAttribute('aria-hidden', 'false');
            } else {
                closeFsOptionsMenu();
            }
        });

        // Close options on click outside
        document.addEventListener('click', (e) => {
            if (!fsOptionsMenu.contains(e.target) && e.target !== fsOptionsBtn) {
                closeFsOptionsMenu();
            }
        });

        // Menu Option: Like / Favorite
        const optLike = document.getElementById('fs-opt-like');
        if (optLike) {
            optLike.addEventListener('click', () => {
                closeFsOptionsMenu();
                if (state.currentTrack) {
                    const encoded = encodeURIComponent(JSON.stringify(state.currentTrack));
                    toggleLike(state.currentTrack.id, state.currentTrack.source || 'youtube', encoded);
                }
            });
        }

        // Menu Option: Shuffle
        const optShuffle = document.getElementById('fs-opt-shuffle');
        if (optShuffle) {
            optShuffle.addEventListener('click', () => {
                closeFsOptionsMenu();
                const mainShuffle = document.getElementById('shuffle-btn');
                if (mainShuffle) mainShuffle.click();
            });
        }

        // Menu Option: Repeat
        const optRepeat = document.getElementById('fs-opt-repeat');
        if (optRepeat) {
            optRepeat.addEventListener('click', () => {
                closeFsOptionsMenu();
                const mainRepeat = document.getElementById('repeat-btn');
                if (mainRepeat) mainRepeat.click();
            });
        }

        // Option 1: Available Audio Sources & Lossless
        const optSources = document.getElementById('fs-opt-sources');
        if (optSources) {
            optSources.addEventListener('click', () => {
                closeFsOptionsMenu();
                if (state.currentTrack) {
                    const encoded = encodeURIComponent(JSON.stringify(state.currentTrack));
                    openCandidateSourcesModal(encoded);
                } else {
                    showToast('No track playing', 'info');
                }
            });
        }

        // Option 2: Audio & Resolution Settings
        const optSettings = document.getElementById('fs-opt-settings');
        if (optSettings) {
            optSettings.addEventListener('click', () => {
                closeFsOptionsMenu();
                openAudioSettingsModal();
            });
        }

        // Option 3: Request Lossless Master
        const optRequest = document.getElementById('fs-opt-request');
        if (optRequest) {
            optRequest.addEventListener('click', () => {
                closeFsOptionsMenu();
                const query = state.currentTrack ? `${state.currentTrack.title} - ${state.currentTrack.artist || ''}` : '';
                openSongRequestModal(query);
            });
        }

        // Option 4: Download Audio
        const optDownload = document.getElementById('fs-opt-download');
        if (optDownload) {
            optDownload.addEventListener('click', () => {
                closeFsOptionsMenu();
                if (state.currentTrack) {
                    downloadTrackFromData(encodeURIComponent(JSON.stringify(state.currentTrack)));
                } else {
                    showToast('No track playing to download', 'info');
                }
            });
        }

        // Option 5: Copy Track Info / Share
        const optShare = document.getElementById('fs-opt-share');
        if (optShare) {
            optShare.addEventListener('click', async () => {
                closeFsOptionsMenu();
                if (state.currentTrack) {
                    const shareText = `🎵 Listening to "${state.currentTrack.title}" by ${state.currentTrack.artist || 'Unknown'} on BASA`;
                    try {
                        await navigator.clipboard.writeText(shareText);
                        showToast('Track info copied to clipboard!', 'success');
                    } catch {
                        showToast(shareText, 'info');
                    }
                }
            });
        }
    }

    // Lyrics Timing Offset Controls
    const offsetMinus = document.getElementById('fs-lyrics-offset-minus');
    const offsetPlus = document.getElementById('fs-lyrics-offset-plus');
    const offsetReset = document.getElementById('fs-lyrics-offset-reset');
    if (offsetMinus) offsetMinus.addEventListener('click', () => setLyricsOffset(-0.5));
    if (offsetPlus) offsetPlus.addEventListener('click', () => setLyricsOffset(+0.5));
    if (offsetReset) offsetReset.addEventListener('click', () => setLyricsOffset(0));

    // Keyboard ESC to close with priority: options menu -> queue drawer -> full player
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && fsPlayer && fsPlayer.classList.contains('active')) {
            if (fsOptionsMenu && !fsOptionsMenu.classList.contains('hidden')) {
                closeFsOptionsMenu();
                return;
            }
            const queueDrawer = document.getElementById('queue-drawer');
            if (queueDrawer && !queueDrawer.classList.contains('hidden')) {
                closeQueueDrawer();
                return;
            }
            closeBtn.click();
        }
    });

    // Setup duplicate controls
    const fsPlayBtn = document.getElementById('fs-play-btn');
    const fsNextBtn = document.getElementById('fs-next-btn');
    const fsPrevBtn = document.getElementById('fs-prev-btn');
    const fsShuffleBtn = document.getElementById('fs-shuffle-btn');
    const fsRepeatBtn = document.getElementById('fs-repeat-btn');

    if (fsPlayBtn) {
        fsPlayBtn.addEventListener('click', () => {
            const mainPlay = document.getElementById('play-btn');
            if (mainPlay) mainPlay.click();
        });
    }
    if (fsNextBtn) fsNextBtn.addEventListener('click', () => playNext(true));
    if (fsPrevBtn) fsPrevBtn.addEventListener('click', playPrev);
    
    if (fsShuffleBtn) {
        fsShuffleBtn.addEventListener('click', () => {
            const mainShuffle = document.getElementById('shuffle-btn');
            if (mainShuffle) mainShuffle.click();
            fsShuffleBtn.classList.toggle('active', state.shuffle);
        });
    }
    if (fsRepeatBtn) {
        fsRepeatBtn.addEventListener('click', () => {
            const mainRepeat = document.getElementById('repeat-btn');
            if (mainRepeat) mainRepeat.click();
        });
    }

    // 3D Glass Physics and Interaction loop
    const glassContainer = document.getElementById('fs-glass-container');
    
    // Check for reduced motion
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    
    let targetX = 0, targetY = 0; // Mouse normalized coords (-1 to 1)
    let currentX = 0, currentY = 0; // Interpolated coords
    let velocity = 0;
    let targetVelocity = 0;
    
    function onMove(e) {
        if (prefersReducedMotion.matches || !fsPlayer.classList.contains('active')) return;
        
        let clientX = e.touches ? e.touches[0].clientX : e.clientX;
        let clientY = e.touches ? e.touches[0].clientY : e.clientY;
        
        const rect = fsPlayer.getBoundingClientRect();
        
        // Normalize coordinates from -1 to 1 based on screen center
        targetX = ((clientX - rect.left) / rect.width) * 2 - 1;
        targetY = ((clientY - rect.top) / rect.height) * 2 - 1;

        // Set CSS mouse vars (0% to 100%) for gradient backgrounds
        document.documentElement.style.setProperty('--fs-mouse-x', `${(clientX / rect.width) * 100}%`);
        document.documentElement.style.setProperty('--fs-mouse-y', `${(clientY / rect.height) * 100}%`);
        
        targetVelocity = 3; // Boost velocity during movement
    }
    
    fsPlayer.addEventListener('mousemove', onMove);
    fsPlayer.addEventListener('touchmove', onMove, { passive: true });

    function renderPhysics() {
        if (!prefersReducedMotion.matches && fsPlayer.classList.contains('active')) {
            // Smoothly decay velocity for edge lighting
            velocity += (targetVelocity - velocity) * 0.1;
            targetVelocity *= 0.95; // Decay target
            
            document.documentElement.style.setProperty('--fs-velocity', velocity.toFixed(3));
        }
        requestAnimationFrame(renderPhysics);
    }
    
    requestAnimationFrame(renderPhysics);
}

// 18. MULTI-DEVICE SYNC
function setupSync() {
    const btnCreate = document.getElementById('btn-create-room');
    const btnJoin = document.getElementById('btn-join-room');
    const btnLeave = document.getElementById('btn-leave-room');
    const inputDeviceName = document.getElementById('sync-device-name');
    const inputJoinCode = document.getElementById('sync-join-code');
    const displayCode = document.getElementById('sync-display-code');
    const deviceList = document.getElementById('sync-device-list');
    
    const activeRoomView = document.getElementById('sync-active-room');
    const setupView = document.getElementById('sync-setup');

    if (!window.syncManager) return;

    btnCreate.addEventListener('click', () => {
        const name = inputDeviceName.value.trim() || 'Host Device';
        window.syncManager.createRoom(name);
    });

    btnJoin.addEventListener('click', () => {
        const name = inputDeviceName.value.trim() || 'Client Device';
        const code = inputJoinCode.value.trim();
        if (code.length === 6) {
            window.syncManager.joinRoom(code, name);
        } else {
            showToast('Enter a valid 6-letter room code', 'error');
        }
    });

    btnLeave.addEventListener('click', () => {
        window.syncManager.leaveRoom();
        activeRoomView.classList.add('hidden');
        setupView.classList.remove('hidden');
    });

    window.syncManager.on('room_state_update', (data) => {
        setupView.classList.add('hidden');
        activeRoomView.classList.remove('hidden');
        displayCode.textContent = data.roomCode;
        
        deviceList.innerHTML = '';
        data.clients.forEach(client => {
            const li = document.createElement('li');
            li.className = 'track-list-item';
            li.innerHTML = `
                <div style="display:flex; justify-content:space-between; width:100%;">
                    <span>${escapeHtml(client.name)} ${client.id === window.syncManager.clientId ? '(You)' : ''}</span>
                    <span class="badge-gold">${client.role}</span>
                </div>
            `;
            deviceList.appendChild(li);
        });
    });
}

// Global window bindings for interop with PlaybackManager & YouTube Player
window.playTrack = playTrack;
window.playNext = playNext;
window.playPrev = playPrev;
window.playTrackFromData = playTrackFromData;
window.playFromList = playFromList;
window.addToQueue = addToQueue;
window.addToQueueFromData = addToQueueFromData;
window.playNextInQueue = playNextInQueue;
window.removeFromQueue = removeFromQueue;
window.clearQueue = clearQueue;
window.clearPreviousTracks = clearPreviousTracks;
window.replayPreviousTrack = replayPreviousTrack;
window.playFromQueueIndex = playFromQueueIndex;
window.toggleQueueDrawer = toggleQueueDrawer;
window.openQueueDrawer = openQueueDrawer;
window.closeQueueDrawer = closeQueueDrawer;
window.switchQueueTab = switchQueueTab;
window.renderQueueDrawer = renderQueueDrawer;
window.toggleLike = toggleLike;
window.showAddToPlaylist = showAddToPlaylist;

// Lossless Studio & Master Engine Controller Functions
window.loadTelegramVault = loadTelegramVault;
window.loadLosslessStudio = loadTelegramVault;
window.switchVaultTab = switchVaultTab;
window.loadVaultSources = loadVaultSources;
window.startSourceIndexing = startSourceIndexing;
window.pauseSourceIndexing = pauseSourceIndexing;
window.stopSourceIndexing = stopSourceIndexing;
window.deleteVaultSource = deleteVaultSource;
window.openAddSourceModal = openAddSourceModal;
window.closeAddSourceModal = closeAddSourceModal;
window.handleAddSourceSubmit = handleAddSourceSubmit;
window.loadVaultRequests = loadVaultRequests;
window.playTrackById = playTrackById;
window.processVaultQueue = processVaultQueue;
window.openSongRequestModal = openSongRequestModal;
window.closeSongRequestModal = closeSongRequestModal;
window.handleSongRequestSubmit = handleSongRequestSubmit;
window.cleanVaultCache = cleanVaultCache;

// ============================================
// 10. TELEGRAM VAULT & REQUEST SYSTEM CONTROLLER
// ============================================

async function loadTelegramVault() {
    try {
        const statusRes = await api('/telegram/status');
        if (statusRes) {
            const elSources = document.getElementById('vault-stat-sources');
            const elIndexed = document.getElementById('vault-stat-indexed');
            const elCached = document.getElementById('vault-stat-cached');
            const elStorage = document.getElementById('vault-stat-storage');
            const elLimit = document.getElementById('vault-stat-limit');

            if (elSources) elSources.textContent = statusRes.totalSources || 0;
            if (elIndexed) elIndexed.textContent = (statusRes.totalIndexedAudio || 0).toLocaleString();
            if (elCached) elCached.textContent = (statusRes.totalCachedTracks || 0).toLocaleString();
            if (elStorage) elStorage.textContent = `${(statusRes.cacheUsageGb || 0).toFixed(2)} GB`;
            if (elLimit) {
                elLimit.innerHTML = `Max ${statusRes.maxCacheGb || 25} GB · <a href="javascript:void(0)" onclick="cleanVaultCache()" style="color:var(--accent);text-decoration:underline;">Clean Cache</a>`;
            }
        }
    } catch (e) {
        console.error('[Telegram Vault] Status load error:', e);
    }

    loadVaultSources();
    loadVaultRequests();
}

function switchVaultTab(tab) {
    const viewSources = document.getElementById('vault-view-sources');
    const viewRequests = document.getElementById('vault-view-requests');
    const viewLibrary = document.getElementById('vault-view-library');
    const btnSources = document.getElementById('vault-tab-sources');
    const btnRequests = document.getElementById('vault-tab-requests');
    const btnLibrary = document.getElementById('vault-tab-library');

    [viewSources, viewRequests, viewLibrary].forEach(v => {
        if (v) { v.classList.add('hidden'); v.classList.remove('active'); }
    });
    [btnSources, btnRequests, btnLibrary].forEach(b => {
        if (b) b.classList.remove('active');
    });

    if (tab === 'sources') {
        if (viewSources) { viewSources.classList.remove('hidden'); viewSources.classList.add('active'); }
        if (btnSources) btnSources.classList.add('active');
        loadVaultSources();
    } else if (tab === 'requests') {
        if (viewRequests) { viewRequests.classList.remove('hidden'); viewRequests.classList.add('active'); }
        if (btnRequests) btnRequests.classList.add('active');
        loadVaultRequests();
    } else if (tab === 'library') {
        if (viewLibrary) { viewLibrary.classList.remove('hidden'); viewLibrary.classList.add('active'); }
        if (btnLibrary) btnLibrary.classList.add('active');
        loadLosslessLibrary();
    }
}

// ============================================
// VERIFIED LOSSLESS LIBRARY (Section 18)
// ============================================
let verifiedLosslessTracks = [];
let activeLosslessFilter = 'all';

async function loadLosslessLibrary() {
    const listEl = document.getElementById('vault-library-list');
    const countEl = document.getElementById('vault-library-count');
    if (!listEl) return;
    listEl.innerHTML = '<div class="loader">Loading verified lossless tracks...</div>';

    try {
        const res = await api('/music/lossless/cache');
        if (res && res.cachedSources) {
            // Section 18: Only verified sources belong in Verified Lossless!
            verifiedLosslessTracks = res.cachedSources.filter(s => 
                s.playableLosslessVerified === true || s.verificationStatus === 'VERIFIED' || s.is_verified === 1
            );
            if (countEl) countEl.textContent = String(verifiedLosslessTracks.length);
            renderLosslessLibraryList(verifiedLosslessTracks);
        } else {
            listEl.innerHTML = '<p class="empty-state" style="padding: 24px; text-align: center; color: var(--text-tertiary);">No verified lossless tracks cached yet.</p>';
        }
    } catch (e) {
        console.error('Error loading verified lossless library:', e);
        listEl.innerHTML = `<p class="error-state" style="padding: 24px; text-align: center; color: #ff6b6b;">Failed to load verified lossless tracks: ${escapeHtml(e.message)}</p>`;
    }
}

function setLosslessLibraryFilter(filter, el) {
    activeLosslessFilter = filter;
    document.querySelectorAll('#vault-view-library .lang-pill').forEach(p => p.classList.remove('active'));
    if (el) el.classList.add('active');
    applyLosslessLibraryFilters();
}

function filterLosslessLibrary(query) {
    applyLosslessLibraryFilters(query);
}

function applyLosslessLibraryFilters(queryText = null) {
    const searchInput = document.getElementById('lossless-library-search');
    const q = (queryText !== null ? queryText : (searchInput ? searchInput.value : '')).toLowerCase().trim();

    let filtered = verifiedLosslessTracks.filter(t => {
        // Filter by category (Section 18: All, Hi-Res, Lossless, Recently Cached, Local FLAC, Telegram FLAC)
        if (activeLosslessFilter === 'hires') {
            const bit = Number(t.bit_depth || t.bitDepth) || 0;
            const rate = Number(t.sample_rate || t.sampleRate) || 0;
            if (bit <= 16 && rate <= 48000) return false;
        } else if (activeLosslessFilter === 'lossless') {
            const bit = Number(t.bit_depth || t.bitDepth) || 0;
            const rate = Number(t.sample_rate || t.sampleRate) || 0;
            if (bit > 16 || rate > 48000) return false;
        } else if (activeLosslessFilter === 'cached') {
            if (!t.cached_at && !t.cachedAt && !t.last_played_at) return false;
        } else if (activeLosslessFilter === 'local') {
            if (t.provider !== 'local' && t.source !== 'local' && t.source_type !== 'LOCAL_FILE') return false;
        } else if (activeLosslessFilter === 'telegram') {
            if (t.provider !== 'telegram' && t.source !== 'telegram' && t.source_type !== 'TELEGRAM_FILE') return false;
        }

        // Filter by search query
        if (q) {
            const title = String(t.title || '').toLowerCase();
            const artist = String(t.artist || '').toLowerCase();
            const album = String(t.album || '').toLowerCase();
            return title.includes(q) || artist.includes(q) || album.includes(q);
        }
        return true;
    });

    renderLosslessLibraryList(filtered);
}

function renderLosslessLibraryList(tracks) {
    const listEl = document.getElementById('vault-library-list');
    if (!listEl) return;

    if (!tracks || tracks.length === 0) {
        listEl.innerHTML = '<p class="empty-state" style="padding: 24px; text-align: center; color: var(--text-tertiary);">No verified tracks match the selected filter.</p>';
        return;
    }

    listEl.innerHTML = tracks.map((track, idx) => {
        const bitDepth = track.bit_depth || track.bitDepth || 16;
        const sampleRate = track.sample_rate || track.sampleRate || 44100;
        const isHiRes = Number(bitDepth) > 16 || Number(sampleRate) > 48000;
        const rateKhz = `${Math.round(sampleRate / 1000)} kHz`;
        const sizeMb = track.file_size ? `${(track.file_size / (1024 * 1024)).toFixed(1)} MB` : '';
        const trackObj = {
            id: track.canonical_track_id || track.id,
            canonicalTrackId: track.canonical_track_id || track.id,
            title: track.title || 'Verified Lossless Track',
            artist: track.artist || 'Unknown Artist',
            album: track.album || '',
            cover: track.cover_url || track.cover || '/logo.png',
            duration: track.duration || 0,
            source: track.provider || 'lossless',
            format: 'FLAC',
            codec: 'FLAC',
            isLossless: true,
            lossless: true,
            isHiRes,
            quality: isHiRes ? 'HI_RES_LOSSLESS' : 'LOSSLESS',
            bitDepth,
            sampleRate,
            verificationStatus: 'VERIFIED',
            playableLosslessVerified: true,
            isCached: true,
            preview: `/api/music/lossless/stream/${encodeURIComponent(track.canonical_track_id || track.id)}`
        };
        const encoded = encodeURIComponent(JSON.stringify(trackObj));

        return `
            <div class="track-list-item glass-subtle" style="display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: 8px; margin-bottom: 8px;" onclick="playTrackFromData('${encoded}')">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <div style="width: 40px; height: 40px; border-radius: 6px; overflow: hidden; background: #1a1a24; flex-shrink: 0;">
                        <img src="${trackObj.cover}" alt="" style="width: 100%; height: 100%; object-fit: cover;" onerror="this.style.opacity='0.2'">
                    </div>
                    <div>
                        <div style="font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px;">
                            ${escapeHtml(trackObj.title)}
                            <span class="source-badge ${isHiRes ? 'hires' : 'lossless'}" style="font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: 700;">
                                ${isHiRes ? 'HI-RES LOSSLESS' : 'LOSSLESS'} · ${bitDepth}-bit/${rateKhz}
                            </span>
                            <span style="font-size: 10px; background: rgba(16, 185, 129, 0.2); color: #10b981; border: 1px solid rgba(16,185,129,0.4); border-radius: 4px; padding: 2px 6px; font-weight: 700;">VERIFIED</span>
                        </div>
                        <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
                            ${escapeHtml(trackObj.artist)} ${trackObj.album ? '· ' + escapeHtml(trackObj.album) : ''} · ${(track.provider || 'FLAC').toUpperCase()} ${sizeMb ? '· ' + sizeMb : ''}
                        </div>
                    </div>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <button class="button button-primary" style="font-size: 12px; padding: 6px 14px;" onclick="event.stopPropagation();playTrackFromData('${encoded}')">
                        ▶ Play
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// Manual lossless upgrade trigger & dismissal (Section 12)
function executeManualLosslessUpgrade() {
    if (!window.playbackManager || !window.playbackManager.pendingUpgradeCandidate) return;
    const cand = window.playbackManager.pendingUpgradeCandidate;
    dismissLosslessUpgradeBanner();
    showToast('Upgrading to Studio Lossless FLAC...', 'info');
    window.playbackManager.switchSource(cand.id, cand, { explicit: false });
}

function dismissLosslessUpgradeBanner() {
    const banner = document.getElementById('lossless-upgrade-banner');
    if (banner) banner.classList.add('hidden');
}

window.loadLosslessLibrary = loadLosslessLibrary;
window.setLosslessLibraryFilter = setLosslessLibraryFilter;
window.filterLosslessLibrary = filterLosslessLibrary;
window.executeManualLosslessUpgrade = executeManualLosslessUpgrade;
window.dismissLosslessUpgradeBanner = dismissLosslessUpgradeBanner;

async function loadVaultSources() {
    const listEl = document.getElementById('vault-sources-list');
    if (!listEl) return;

    try {
        const res = await api('/telegram/sources');
        const sources = res.data || [];

        if (sources.length === 0) {
            listEl.innerHTML = `
                <div class="empty-state">
                    <p>No audio feeds configured yet.</p>
                    <button class="button button-primary" style="margin-top:12px;" onclick="openAddSourceModal()">+ Add Audio Feed</button>
                </div>
            `;
            return;
        }

        listEl.innerHTML = sources.map(s => {
            const isIndexing = s.indexing_status === 'INDEXING';
            const isPaused = s.indexing_status === 'PAUSED';
            const isConnected = s.status === 'CONNECTED' || s.status === 'READY';
            const statusClass = isIndexing ? 'indexing' : (isPaused ? 'paused' : (isConnected ? 'ready' : (s.status === 'AUTHENTICATION_REQUIRED' ? 'auth' : 'idle')));
            const statusText = isIndexing ? 'INDEXING METADATA' : (isPaused ? 'INDEXING PAUSED' : (s.status || 'IDLE'));

            const pBadgeClass = s.priority === 1 ? 'p1' : (s.priority === 2 ? 'p2' : '');
            const peerIdDisplay = s.peer_id || s.peerId || s.chat_id || 'Pending Resolution';

            let actionsHtml = '';
            if (isIndexing) {
                actionsHtml = `
                    <button class="button button-secondary" style="font-size:11px; padding:4px 8px;" onclick="pauseSourceIndexing('${s.id}')">⏸ Pause</button>
                    <button class="button button-secondary" style="font-size:11px; padding:4px 8px; color:#ff6b6b;" onclick="stopSourceIndexing('${s.id}')">⏹ Stop</button>
                `;
            } else {
                actionsHtml = `
                    <button class="button button-secondary" style="font-size:11px; padding:4px 8px;" onclick="reResolveSource('${s.id}')" title="Dynamically re-resolve peer entity">🔄 Re-resolve</button>
                    <button class="button button-secondary" style="font-size:11px; padding:4px 8px;" onclick="testVaultSource('${s.id}')" title="Test entity accessibility">⚡ Test</button>
                    <button class="button button-secondary" style="font-size:11px; padding:4px 8px;" onclick="toggleVaultSource('${s.id}', ${Boolean(s.enabled)})">${s.enabled ? 'Disable' : 'Enable'}</button>
                    <button class="button button-primary" style="font-size:11px; padding:4px 10px;" onclick="startSourceIndexing('${s.id}')">▶ Index</button>
                    <button class="button button-ghost" style="font-size:11px; padding:4px 6px; color:#ff6b6b;" onclick="deleteVaultSource('${s.id}')" title="Delete Source">🗑</button>
                `;
            }

            return `
                <div class="vault-source-card ${s.enabled ? '' : 'source-disabled'}">
                    <div class="source-info">
                        <div class="source-title-row">
                            <span class="source-name">${escapeHtml(s.name)}</span>
                            <span class="priority-badge ${pBadgeClass}">Priority ${s.priority}</span>
                            <span class="status-pill ${statusClass}">${statusText}</span>
                            ${!s.enabled ? '<span class="status-pill idle">DISABLED</span>' : ''}
                        </div>
                        <div class="source-details">
                            <span>Identity: <strong>${s.username ? `@${escapeHtml(s.username)}` : '<span style="color:var(--accent);">Dynamic Resolution (Dialogs)</span>'}</strong></span>
                            <span>Peer ID: <code>${escapeHtml(peerIdDisplay)}</code></span>
                            <span>Indexed Audio: <strong>${(s.indexed_audio || s.indexedTrackCount || 0).toLocaleString()}</strong></span>
                            <span>Checkpoint Msg ID: <code>${s.last_indexed_message_id || 0}</code></span>
                            ${s.last_successful_search || s.lastSuccessfulSearch ? `<span>Last Search: <small>${escapeHtml(s.last_successful_search || s.lastSuccessfulSearch)}</small></span>` : ''}
                        </div>
                        ${s.last_error || s.lastError ? `
                            <div style="margin-top:6px; font-size:11px; color:#ff6b6b; background:rgba(255,107,107,0.1); padding:3px 8px; border-radius:4px;">
                                ⚠️ Last Notice: ${escapeHtml(s.last_error || s.lastError)} (Errors: ${s.error_count || s.errorCount || 0})
                            </div>
                        ` : ''}
                    </div>
                    <div class="source-actions">
                        ${actionsHtml}
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        listEl.innerHTML = `<div class="empty-state">Failed to load sources: ${escapeHtml(err.message)}</div>`;
    }
}

async function reResolveSource(sourceId) {
    try {
        showToast('Resolving Telegram source entity dynamically...', 'info');
        const res = await api(`/telegram/sources/${sourceId}/resolve`, { method: 'POST' });
        if (res.success) {
            showToast(res.message || 'Entity resolved successfully', 'success');
        } else {
            showToast(res.message || 'Entity resolution notice', 'info');
        }
        loadVaultSources();
    } catch (err) {
        showToast(`Resolution error: ${err.message}`, 'error');
    }
}

async function testVaultSource(sourceId) {
    try {
        showToast('Testing Telegram source connection...', 'info');
        const res = await api(`/telegram/sources/${sourceId}/test`, { method: 'POST' });
        if (res.success) {
            showToast(`Connected: ${res.title || res.message}`, 'success');
        } else {
            showToast(`Status: ${res.status} - ${res.message}`, 'info');
        }
        loadVaultSources();
    } catch (err) {
        showToast(`Test error: ${err.message}`, 'error');
    }
}

async function toggleVaultSource(sourceId, currentlyEnabled) {
    try {
        await api(`/telegram/sources/${sourceId}`, {
            method: 'PUT',
            body: { enabled: !currentlyEnabled }
        });
        showToast(`Source ${!currentlyEnabled ? 'enabled' : 'disabled'}`, 'success');
        loadVaultSources();
    } catch (err) {
        showToast(`Failed to update source: ${err.message}`, 'error');
    }
}

async function startSourceIndexing(sourceId) {
    try {
        showToast('Initiating background metadata indexing (No mass downloading)...', 'info');
        const res = await api(`/telegram/sources/${sourceId}/index`, { method: 'POST' });
        showToast(res.message || 'Indexing started', 'success');
        loadVaultSources();
    } catch (err) {
        showToast(`Could not start indexing: ${err.message}`, 'error');
    }
}

async function pauseSourceIndexing(sourceId) {
    try {
        const res = await api(`/telegram/sources/${sourceId}/pause`, { method: 'POST' });
        showToast('Indexing paused', 'info');
        loadVaultSources();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function stopSourceIndexing(sourceId) {
    try {
        const res = await api(`/telegram/sources/${sourceId}/stop`, { method: 'POST' });
        showToast('Indexing stopped', 'info');
        loadVaultSources();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function deleteVaultSource(sourceId) {
    if (!confirm('Are you sure you want to delete this audio source and remove its indexed tracks?')) return;
    try {
        await api(`/telegram/sources/${sourceId}`, { method: 'DELETE' });
        showToast('Source deleted', 'success');
        loadTelegramVault();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function openAddSourceModal() {
    const modal = document.getElementById('source-modal');
    if (modal) { modal.classList.remove('hidden'); modal.style.display = 'grid'; }
}

function closeAddSourceModal() {
    const modal = document.getElementById('source-modal');
    if (modal) { modal.classList.add('hidden'); modal.style.display = 'none'; }
}

async function handleAddSourceSubmit(event) {
    event.preventDefault();
    const name = document.getElementById('source-name-input')?.value;
    const chatId = document.getElementById('source-chat-input')?.value;
    const username = document.getElementById('source-username-input')?.value;
    const priority = parseInt(document.getElementById('source-priority-input')?.value || '1', 10);

    try {
        await api('/telegram/sources', {
            method: 'POST',
            body: JSON.stringify({ name, chat_id: chatId, username, priority })
        });
        showToast(`Source "${name}" configured!`, 'success');
        closeAddSourceModal();
        document.getElementById('source-form')?.reset();
        loadTelegramVault();
    } catch (err) {
        showToast(`Failed to add source: ${err.message}`, 'error');
    }
}

async function loadVaultRequests() {
    const container = document.getElementById('vault-requests-container');
    const countBadge = document.getElementById('vault-request-count');
    if (!container) return;

    try {
        const res = await api('/telegram/requests');
        const requests = res.data || [];

        if (countBadge) countBadge.textContent = requests.length;

        if (requests.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <p>No song requests in the queue yet.</p>
                    <button class="button button-primary" style="margin-top:12px;" onclick="openSongRequestModal()">📥 Submit First Request</button>
                </div>
            `;
            return;
        }

        container.innerHTML = requests.map(r => {
            const statusClass = (r.status || 'PENDING').toLowerCase();
            let statusLabel = r.status;
            if (r.status === 'READY') statusLabel = 'READY TO PLAY';
            if (r.status === 'FOUND') statusLabel = 'FOUND IN VAULT';
            if (r.status === 'NOT_FOUND') statusLabel = 'NOT IN ANY SOURCE';

            const sourcesMap = r.sourcesStatus || {};
            const sourcePills = Object.entries(sourcesMap).map(([srcId, st]) => {
                const isFound = st === 'SEARCHED_FOUND';
                const pillColor = isFound ? 'rgba(113,255,186,0.15)' : 'rgba(255,255,255,0.06)';
                const textColor = isFound ? '#71ffba' : 'var(--text-tertiary)';
                return `<span style="font-size:10px; padding:2px 6px; border-radius:4px; background:${pillColor}; color:${textColor};">${srcId.replace('source_', '')}: ${st}</span>`;
            }).join(' ');

            return `
                <div class="vault-request-card">
                    <div>
                        <div class="request-query-text">${escapeHtml(r.query)}</div>
                        <div class="request-listeners">
                            <span>👥 <strong>${r.waitingCount || 1}</strong> listener${(r.waitingCount > 1 ? 's' : '')} waiting</span>
                            <span style="opacity:0.4;">·</span>
                            <span>Normalized: <code>${escapeHtml(r.normalizedQuery || '')}</code></span>
                        </div>
                        <div style="display:flex; gap:6px; margin-top:6px; flex-wrap:wrap;">
                            ${sourcePills}
                        </div>
                    </div>
                    <div class="request-meta-right">
                        <span class="status-pill ${statusClass}">${statusLabel}</span>
                        ${r.resultTrackId ? `<button class="button button-secondary" style="font-size:11px; padding:4px 10px;" onclick="playTrackById('${r.resultTrackId}')">▶ Play</button>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        container.innerHTML = `<div class="empty-state">Failed to load requests: ${escapeHtml(err.message)}</div>`;
    }
}

async function playTrackById(trackId) {
    try {
        const res = await api(`/telegram/prepare/${trackId}`);
        if (res.track) {
            playTrack(res.track);
        } else {
            playTrack({ id: trackId, source: 'telegram', title: 'Lossless Track' });
        }
    } catch (e) {
        playTrack({ id: trackId, source: 'telegram', title: 'Lossless Track' });
    }
}

async function processVaultQueue() {
    try {
        showToast('Evaluating requests across sources in priority order...', 'info');
        const res = await api('/telegram/requests/process', { method: 'POST' });
        showToast(`Processed ${res.processed || 0} queue requests!`, 'success');
        loadVaultRequests();
    } catch (err) {
        showToast(`Queue processing failed: ${err.message}`, 'error');
    }
}

function openSongRequestModal(prefillQuery = '') {
    const modal = document.getElementById('request-song-modal');
    const input = document.getElementById('request-query-input');
    if (modal) {
        modal.classList.remove('hidden');
        modal.style.display = 'grid';
        if (input) {
            input.value = prefillQuery || (document.getElementById('search-input')?.value || '');
            input.focus();
        }
    }
}

function closeSongRequestModal() {
    const modal = document.getElementById('request-song-modal');
    if (modal) { modal.classList.add('hidden'); modal.style.display = 'none'; }
}

async function handleSongRequestSubmit(event) {
    event.preventDefault();
    const query = document.getElementById('request-query-input')?.value;
    if (!query) return;

    try {
        const res = await api('/telegram/request', {
            method: 'POST',
            body: JSON.stringify({ query })
        });
        showToast(res.message || 'Song request registered!', 'success');
        closeSongRequestModal();
        document.getElementById('request-song-form')?.reset();
        if (state.currentView === 'telegram') loadVaultRequests();
    } catch (err) {
        showToast(`Request submission failed: ${err.message}`, 'error');
    }
}

async function cleanVaultCache() {
    if (!confirm('Run LRU cache cleanup to enforce storage limits? Least-recently-played tracks will be evicted if limit is exceeded.')) return;
    try {
        showToast('Running cache maintenance...', 'info');
        const res = await api('/telegram/cache/clean', { method: 'POST' });
        showToast(res.message || 'Cache cleaned successfully', 'success');
        loadTelegramVault();
    } catch (err) {
        showToast(`Cache cleanup failed: ${err.message}`, 'error');
    }
}

// ============================================
// 19. AUDIO SETTINGS & CANDIDATE SOURCES MODALS
// ============================================

function openAudioSettingsModal() {
    const modal = document.getElementById('audio-settings-modal');
    if (!modal) return;
    
    const settings = window.playbackManager ? window.playbackManager.settings : {};
    const playbackModeSelect = document.getElementById('setting-playback-mode');
    const fastStartCheckbox = document.getElementById('setting-fast-start');
    const autoUpgradeCheckbox = document.getElementById('setting-auto-upgrade');
    const preferCachedCheckbox = document.getElementById('setting-prefer-cached');
    const preferredQualitySelect = document.getElementById('setting-preferred-quality');
    
    if (playbackModeSelect && settings.playbackMode) playbackModeSelect.value = settings.playbackMode;
    if (fastStartCheckbox) fastStartCheckbox.checked = settings.fastStart !== false;
    if (autoUpgradeCheckbox) autoUpgradeCheckbox.checked = settings.autoLosslessUpgrade !== false;
    if (preferCachedCheckbox) preferCachedCheckbox.checked = settings.preferCached !== false;
    if (preferredQualitySelect && settings.preferredQuality) preferredQualitySelect.value = settings.preferredQuality;
    
    // Sync live DSP engine settings to UI controls
    if (window.dspEngine) {
        const cfg = window.dspEngine.config;
        const modeEl = document.getElementById('setting-dsp-mode');
        const presetEl = document.getElementById('setting-dsp-preset');
        const bassEl = document.getElementById('setting-bass-boost');
        const trebleEl = document.getElementById('setting-treble-boost');
        const resEl = document.getElementById('setting-resample-target');
        const profEl = document.getElementById('setting-dsp-profile');
        const stereoEl = document.getElementById('setting-stereo-width');
        const crossEl = document.getElementById('setting-crossfeed');

        if (modeEl && cfg.mode) modeEl.value = cfg.mode;
        if (presetEl && cfg.preset) presetEl.value = cfg.preset;
        if (bassEl && cfg.bass) bassEl.value = cfg.bass;
        if (trebleEl && cfg.treble) trebleEl.value = cfg.treble;
        if (resEl && cfg.resampleTarget) resEl.value = cfg.resampleTarget;
        if (profEl && cfg.profile) profEl.value = cfg.profile;
        if (stereoEl && cfg.stereoWidth) stereoEl.value = cfg.stereoWidth;
        if (crossEl && cfg.crossfeed) crossEl.value = cfg.crossfeed;
    }
    
    modal.classList.remove('hidden');
    modal.style.display = 'grid';
}

function closeAudioSettingsModal() {
    const modal = document.getElementById('audio-settings-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
}

function savePlaybackSetting(key, value) {
    if (window.playbackManager) {
        window.playbackManager.updateSettings({ [key]: value });
        showToast(`Updated ${key}: ${value}`, 'info');
    }
}

function updateDspSetting(key, value) {
    if (!window.dspEngine) return;
    switch (key) {
        case 'mode':
            window.dspEngine.setMode(value);
            break;
        case 'preset':
            window.dspEngine.setPreset(value);
            break;
        case 'bass':
            window.dspEngine.setBass(value);
            break;
        case 'treble':
            window.dspEngine.setTreble(value);
            break;
        case 'resampleTarget':
            window.dspEngine.setResampleTarget(value);
            break;
        case 'profile':
            window.dspEngine.setProfile(value);
            break;
        case 'stereo':
            window.dspEngine.setStereoWidth(value);
            break;
        case 'crossfeed':
            window.dspEngine.setCrossfeed(value);
            break;
    }
    updateABButtonState();
    if (state.currentTrack) {
        updatePlayerUI(state.currentTrack);
    }
    showToast(`DSP ${key} set to ${value}`, 'info');
}

function toggleABMode() {
    if (!window.playbackManager) return;
    const newState = window.playbackManager.toggleAB();
    updateABButtonState();
    if (state.currentTrack) {
        updatePlayerUI(state.currentTrack);
    }
    showToast(newState === 'A' ? 'A/B: State A (DIRECT / DSP BYPASS)' : 'A/B: State B (DSP ENABLED)', 'info');
}

function updateABButtonState() {
    const btn = document.getElementById('ab-mode-btn');
    const playerBtn = document.getElementById('player-ab-btn');
    const modalBtn = document.getElementById('modal-ab-toggle-btn');
    const isDirect = window.dspEngine && (window.dspEngine.abState === 'A' || window.dspEngine.mode === 'DIRECT');
    const label = isDirect ? 'A: BYPASS' : 'B: DSP';
    
    if (btn) {
        btn.textContent = label;
        btn.title = isDirect ? 'A: DIRECT / DSP BYPASS' : 'B: DSP ENABLED';
        btn.classList.toggle('direct-mode', isDirect);
        btn.classList.toggle('dsp-mode', !isDirect);
    }
    if (playerBtn) {
        playerBtn.textContent = label;
        playerBtn.title = isDirect ? 'A: DIRECT / DSP BYPASS' : 'B: DSP ENABLED';
        playerBtn.classList.toggle('direct-mode', isDirect);
        playerBtn.classList.toggle('dsp-mode', !isDirect);
    }
    if (modalBtn) {
        modalBtn.textContent = isDirect ? 'A: DIRECT / DSP BYPASS' : 'B: DSP ENABLED';
    }
}

let pipelineInspectorInterval = null;

function openPipelineInspectorModal() {
    const modal = document.getElementById('pipeline-inspector-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.style.display = 'grid';
    
    updatePipelineInspectorUI();
    if (pipelineInspectorInterval) clearInterval(pipelineInspectorInterval);
    pipelineInspectorInterval = setInterval(updatePipelineInspectorUI, 300);
}

function closePipelineInspectorModal() {
    const modal = document.getElementById('pipeline-inspector-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
    if (pipelineInspectorInterval) {
        clearInterval(pipelineInspectorInterval);
        pipelineInspectorInterval = null;
    }
}

function updatePipelineInspectorUI() {
    if (!window.playbackManager) return;
    const diag = window.playbackManager.getAudioPipelineDiagnostics();
    if (!diag) return;
    const validation = window.playbackManager.validateAudioPipeline();
    updateABButtonState();

    const setTxt = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val !== null && val !== undefined && val !== '' ? String(val) : '—';
    };

    // Stage 1: Source
    const src = diag.source || {};
    const isLossless = Boolean(src.lossless || src.isLossless);
    const truthBadge = document.getElementById('pipeline-truth-badge');
    if (truthBadge) {
        if (isLossless) {
            truthBadge.className = 'source-badge lossless';
            truthBadge.textContent = 'SOURCE: LOSSLESS FLAC';
        } else if (src.provider === 'YOUTUBE' || src.provider === 'youtube') {
            truthBadge.className = 'source-badge standard';
            truthBadge.textContent = 'SOURCE: YOUTUBE OPUS/AAC';
        } else {
            truthBadge.className = 'source-badge high';
            truthBadge.textContent = (diag.dsp && diag.dsp.enabled) ? 'SOURCE: LOSSY AAC · DSP ENHANCED' : 'SOURCE: HIGH / LOSSY (AAC 320)';
        }
    }

    setTxt('diag-source-tier', isLossless ? 'LOSSLESS / STUDIO MASTER' : (src.quality ? `${src.quality} / LOSSY` : 'HIGH / LOSSY'));
    setTxt('diag-source-provider', src.provider ? src.provider.toUpperCase() : 'Unavailable');
    setTxt('diag-source-codec', src.codec ? src.codec.toUpperCase() : 'Unavailable');
    setTxt('diag-source-bitrate', src.bitrate ? `${Math.round(src.bitrate / 1000)} kbps` : 'Unavailable');
    setTxt('diag-source-rate', src.sampleRate ? `${src.sampleRate} Hz` : 'Unavailable');
    setTxt('diag-source-depth', src.bitDepth ? `${src.bitDepth}-bit` : 'UNAVAILABLE / NOT APPLICABLE');
    setTxt('diag-source-channels', src.channels ? (src.channels === 2 ? 'Stereo (2 ch)' : `${src.channels} ch`) : 'Stereo');
    setTxt('diag-source-format', src.format ? src.format.toUpperCase() : (src.codec || 'AUDIO').toUpperCase());
    setTxt('diag-source-lossless', isLossless ? 'Yes (Verified Lossless FLAC)' : 'No (Lossy Compression)');

    // Stage 2: Decoder (Section 4: Browser-managed FLAC decoding)
    const dec = diag.decoder || {};
    setTxt('diag-decoder-status', dec.pcmFormat ? `${dec.pcmFormat} Stream` : 'Float32 PCM');
    setTxt('diag-decoder-name', (isLossless && (src.codec === 'FLAC' || src.format === 'FLAC')) 
        ? 'HTMLMediaElement / Browser-managed FLAC decoding' 
        : (dec.name || 'HTMLMediaElement / Browser-managed decoding'));
    setTxt('diag-decoder-codec', dec.codec ? dec.codec.toUpperCase() : (src.codec || 'Browser Native').toUpperCase());
    setTxt('diag-decoder-pcm', dec.pcmFormat || 'Float32');
    setTxt('diag-decoder-rate', (dec.sampleRate && dec.sampleRate !== 'UNAVAILABLE') ? `${dec.sampleRate} Hz` : 'UNAVAILABLE');

    // Stage 3: Float32 DSP Engine (Section 1: Dynamic actual AudioContext rate)
    const dsp = diag.dsp || {};
    const dspStatusEl = document.getElementById('diag-dsp-status');
    if (dspStatusEl) {
        dspStatusEl.textContent = dsp.enabled ? (dsp.mode || 'ACTIVE') : 'BYPASS / DIRECT';
        dspStatusEl.style.color = dsp.enabled ? '#10b981' : '#f59e0b';
    }
    const nativeRate = dsp.nativeDspRate || diag.audioContext?.actualRate || 48000;
    const rateKhz = nativeRate ? Math.round(nativeRate / 1000) : 48;
    const isModeA = (diag.audioContext?.actualRate || nativeRate) >= 88200;
    const dspRateStr = `${rateKhz} kHz Native DSP`;
    setTxt('diag-dsp-rate', dspRateStr);
    setTxt('diag-dsp-preset', dsp.preset ? dsp.preset.replace(/_/g, ' ') : 'BASA HiFi');
    setTxt('diag-dsp-bass', dsp.bassLevel !== undefined ? (dsp.bassLevel === 0 ? 'OFF' : `${dsp.bassLevel > 0 ? '+' : ''}${dsp.bassLevel.toFixed(1)} dB`) : 'OFF');
    setTxt('diag-dsp-treble', dsp.trebleLevel !== undefined ? (dsp.trebleLevel === 0 ? 'OFF' : `${dsp.trebleLevel > 0 ? '+' : ''}${dsp.trebleLevel.toFixed(1)} dB`) : 'OFF');
    setTxt('diag-dsp-compressor', dsp.compressor?.enabled ? (dsp.compressor.preset || 'LIGHT') : 'OFF');
    setTxt('diag-dsp-limiter', dsp.limiter?.enabled !== false ? `Peak Limiter @ ${rateKhz} kHz (-1.0 dBFS Ceiling)` : 'OFF');
    setTxt('diag-dsp-stereo', dsp.stereo?.enabled ? `${Math.round((dsp.stereo.width || 1) * 100)}%` : 'NORMAL');
    setTxt('diag-dsp-crossfeed', dsp.crossfeed?.enabled ? (dsp.crossfeed.mode || 'ACTIVE') : 'OFF');
    setTxt('diag-dsp-loudness', dsp.loudness?.enabled ? `K-weighted normalization target: ${dsp.loudness.targetLufs || -14} LUFS` : 'OFF');

    // Stage 4: AudioWorklet Resampler / Oversampler
    const res = diag.resampler || {};
    const resStatusEl = document.getElementById('diag-resampler-status');
    if (resStatusEl) {
        const statusText = isModeA 
            ? 'BYPASS (Mode A True 96 kHz Direct)'
            : (res.enabled ? '96 kHz Internal Oversampling' : 'BYPASS');
        resStatusEl.textContent = statusText;
        resStatusEl.style.color = (res.enabled && !isModeA) ? '#10b981' : (statusText === 'UNAVAILABLE' ? '#ef4444' : '#f59e0b');
    }
    const inRate = res.resamplerInputRate || res.inputRate || 48000;
    const osRate = res.internalOversampleRate || res.internalRate || 96000;
    const outRate = res.resamplerOutputRate || res.outputRate || 48000;
    const ioPath = isModeA
        ? 'BYPASS (Mode A Direct 96 kHz Native)'
        : ((osRate > outRate && res.status !== 'BYPASS')
            ? `${inRate} Hz → ${osRate} Hz Internal → ${outRate} Hz`
            : (inRate !== outRate
                ? `${inRate} Hz → ${outRate} Hz`
                : 'BYPASS'));
    setTxt('diag-resampler-io', ioPath);
    setTxt('diag-resampler-algo', res.algorithm || '16-tap polyphase windowed-sinc using Lanczos window');
    setTxt('diag-resampler-quality', res.quality || 'High-Precision Float32 (16-tap Lanczos)');
    setTxt('diag-resampler-latency', res.latencyMs ? `~${res.latencyMs.toFixed(1)} ms (Sync)` : '~2.6 ms (Sync)');

    // Stage 5: AudioContext & Output Device
    const actx = diag.audioContext || {};
    const out = diag.output || {};
    const actualCtxRate = actx.actualRate || out.audioContextSampleRate || 48000;
    setTxt('diag-output-rate-title', `AUDIOCONTEXT: ${Math.round(actualCtxRate / 1000)} kHz`);
    setTxt('diag-output-requested-rate', actx.requestedRate ? `${Math.round(actx.requestedRate / 1000)} kHz` : 'System Default');
    setTxt('diag-output-ctx-rate', `${actualCtxRate} Hz`);
    
    let statusLabel = 'NATIVE';
    if (actx.status === 'REQUEST_NOT_HONORED' || actx.status === 'FALLBACK') {
        statusLabel = 'REQUEST_NOT_HONORED';
    } else if (actx.status === 'MATCH') {
        statusLabel = `MATCH (${Math.round(actualCtxRate / 1000)} kHz achieved)`;
    }
    setTxt('diag-output-status', statusLabel);
    setTxt('diag-output-hw-rate', 'UNAVAILABLE');
    setTxt('diag-output-hw-depth', 'UNAVAILABLE');
    setTxt('diag-output-channels', out.channels ? `${out.channels} (Stereo)` : '2 (Stereo)');
    setTxt('diag-output-device', out.deviceName || 'Default Audio Output');
    setTxt('diag-output-hw-rate', out.hardwareSampleRate || 'UNAVAILABLE / NOT EXPOSED BY BROWSER');
    setTxt('diag-output-hw-depth', out.hardwareBitDepth || 'UNAVAILABLE / NOT EXPOSED BY BROWSER');

    // Internal PCM data rate: sampleRate * bits * channels
    const pcmRate = dsp.internalRate || actualCtxRate;
    if (pcmRate) {
        const pcmBits = pcmRate * 32 * 2;
        setTxt('diag-output-pcm-bitrate', `${(pcmBits / 1000000).toFixed(3)} Mbps (Float32 Internal)`);
    } else {
        setTxt('diag-output-pcm-bitrate', '—');
    }

    // Telemetry meters
    const meters = diag.meters || dsp.analyzer || {};
    const rmsEl = document.getElementById('diag-meter-rms');
    const peakEl = document.getElementById('diag-meter-peak');
    const clipEl = document.getElementById('diag-clip-indicator');
    const rmsVal = meters.rms !== undefined ? meters.rms : meters.rmsDb;
    const peakVal = meters.peak !== undefined ? meters.peak : meters.peakDb;
    if (rmsEl) rmsEl.textContent = rmsVal !== undefined && rmsVal !== -100 ? `${rmsVal.toFixed(1)} dBFS` : '—';
    if (peakEl) peakEl.textContent = peakVal !== undefined && peakVal !== -100 ? `${peakVal.toFixed(1)} dBFS` : '—';
    if (clipEl) {
        if (meters.isClipping) {
            clipEl.textContent = 'CLIPPING DETECTED';
            clipEl.style.background = '#ef4444';
            clipEl.style.color = '#fff';
        } else {
            clipEl.textContent = 'NO CLIPPING';
            clipEl.style.background = 'rgba(255,255,255,0.1)';
            clipEl.style.color = '#888';
        }
    }

    // Validation Status
    const valEl = document.getElementById('pipeline-validation-status');
    if (valEl) {
        const isValid = validation.isValid !== undefined ? validation.isValid : validation.valid;
        const reason = (validation.violations && validation.violations.length > 0) 
            ? validation.violations.join('; ')
            : (validation.reason || (isValid ? 'Pipeline Consistent & Valid' : 'Pipeline Configuration Inconsistent'));
        valEl.textContent = isValid ? `✓ ${reason}` : `⚠ ${reason}`;
        valEl.style.color = isValid ? '#10b981' : '#f59e0b';
    }
}

function openCandidateSourcesModal(encodedTrackData) {
    let track;
    try {
        track = JSON.parse(decodeURIComponent(encodedTrackData));
    } catch (e) {
        console.error('Failed to parse track data for sources modal:', e);
        return;
    }

    const modal = document.getElementById('candidate-sources-modal');
    const titleEl = document.getElementById('sources-modal-title');
    const subtitleEl = document.getElementById('sources-modal-subtitle');
    const listEl = document.getElementById('sources-modal-list');
    if (!modal || !listEl) return;

    // Section 20: Dedicated source modal: AUDIO SOURCES
    if (titleEl) titleEl.textContent = 'AUDIO SOURCES';
    if (subtitleEl) subtitleEl.textContent = `${track.title || 'Track'} · ${track.artist || 'Unknown Artist'}`;

    const candidates = (track.candidates && track.candidates.length > 0) ? track.candidates : [track];

    listEl.innerHTML = candidates.map((cand, idx) => {
        const isCurrent = state.currentTrack && (state.currentTrack.id === cand.id || state.currentTrack.preview === cand.preview || state.currentTrack.sourceId === cand.sourceId);
        const candEncoded = encodeURIComponent(JSON.stringify(cand));

        const isFlac = (cand.format === 'FLAC' || cand.codec === 'FLAC');
        const isVerified = Boolean(cand.verificationStatus === 'VERIFIED' || cand.losslessVerification === 'VERIFIED' || cand.playableLosslessVerified || cand.isCached || cand.cached);

        // Section 20: Standardized format display
        let formatDisplay = '';
        if (isFlac) {
            const bit = cand.bitDepth || (cand.quality === 'HI_RES_LOSSLESS' ? 24 : 16);
            const rate = cand.sampleRate ? `${Math.round(cand.sampleRate / 1000)} kHz` : (cand.quality === 'HI_RES_LOSSLESS' ? '96 kHz' : '44.1 kHz');
            formatDisplay = `FLAC · ${bit}-bit / ${rate}`;
        } else if (cand.source === 'jiosaavn') {
            formatDisplay = 'AAC · 320 kbps';
        } else if (cand.source === 'youtube') {
            formatDisplay = 'YouTube';
        } else {
            formatDisplay = `${(cand.format || cand.codec || 'Audio').toUpperCase()}`;
        }

        let providerDisplayName = 'YouTube Audio';
        if (cand.source === 'telegram' || cand.source === 'lossless') {
            providerDisplayName = 'Telegram Lossless Vault';
        } else if (cand.source === 'jiosaavn') {
            providerDisplayName = 'JioSaavn HD Audio';
        } else if (cand.source === 'local') {
            providerDisplayName = 'Local Upload';
        } else if (cand.source === 'internet_archive' || cand.source === 'archive') {
            providerDisplayName = 'Internet Archive FLAC';
        } else if (cand.provider) {
            providerDisplayName = cand.provider;
        }

        const radioMark = isCurrent ? '●' : '○';
        const verifiedBadge = isVerified 
            ? `<span style="font-size: 10px; background: rgba(16, 185, 129, 0.2); color: #10b981; border: 1px solid rgba(16,185,129,0.4); border-radius: 4px; padding: 2px 6px; font-weight: 700; margin-left: 8px;">VERIFIED</span>`
            : '';

        return `
            <div class="track-list-item ${isCurrent ? 'playing' : ''}" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-radius: 8px; margin-bottom: 8px; background: rgba(255,255,255,0.03); cursor: pointer;" onclick="playSpecificCandidate('${candEncoded}')">
                <div style="display: flex; align-items: center; gap: 14px;">
                    <div style="font-size: 18px; color: ${isCurrent ? '#38bdf8' : 'var(--text-tertiary)'}; width: 20px; text-align: center;">${radioMark}</div>
                    <div>
                        <div style="font-weight: 600; font-size: 14px; display: flex; align-items: center;">
                            <span>${escapeHtml(formatDisplay)}</span>
                            ${verifiedBadge}
                        </div>
                        <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
                            ${escapeHtml(providerDisplayName)} · ${escapeHtml(cand.title || '')}
                            ${cand.cached ? '<span style="color: #71ffba; margin-left: 6px;">⚡ Cached Instant Start</span>' : ''}
                        </div>
                    </div>
                </div>
                <button class="button ${isCurrent ? 'button-secondary' : 'button-primary'}" style="font-size: 12px; padding: 6px 14px;" onclick="event.stopPropagation();playSpecificCandidate('${candEncoded}')">
                    ${isCurrent ? 'Active Source' : 'Select Source'}
                </button>
            </div>
        `;
    }).join('');

    modal.classList.remove('hidden');
    modal.style.display = 'grid';
}

function closeCandidateSourcesModal() {
    const modal = document.getElementById('candidate-sources-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
}

function playSpecificCandidate(encodedCandidateData) {
    try {
        const candidate = JSON.parse(decodeURIComponent(encodedCandidateData));
        closeCandidateSourcesModal();
        showToast(`Switching to ${candidate.source?.toUpperCase() || 'Source'} (${candidate.quality || 'Audio'})...`, 'info');
        
        // Mode B: Explicit Candidate Playback (preserving position, queue, lyrics, recommendations)
        state.currentTrack = {
            ...state.currentTrack,
            ...candidate
        };
        updatePlayerUI(state.currentTrack);
        saveQueueState();
        if (window.playbackManager) {
            window.playbackManager.switchSource(candidate.id, candidate, { explicit: true });
        }
    } catch (e) {
        console.error('Failed to play specific candidate:', e);
    }
}

// ==========================================
// SYNCHRONIZED LYRICS ENGINE & TIMING OFFSET
// ==========================================
// Note: currentLyricsData and related globals hoisted at top of file

function setLyricsOffset(delta) {
    if (delta === 0) {
        lyricsOffsetSeconds = 0;
    } else {
        lyricsOffsetSeconds = Math.max(-10, Math.min(10, Number((lyricsOffsetSeconds + delta).toFixed(1))));
    }
    const valEl = document.getElementById('fs-lyrics-offset-val');
    if (valEl) {
        const sign = lyricsOffsetSeconds > 0 ? '+' : '';
        valEl.textContent = `${sign}${lyricsOffsetSeconds.toFixed(1)}s`;
    }
    if (window.playbackManager) {
        syncLyricsTick(window.playbackManager.getCurrentTime(), true);
    }
}

let lyricsScrollRaf = null;
let currentLyricsScrollY = 0;
let targetLyricsScrollY = 0;
let isProgrammaticLyricsScrolling = false;

function smoothScrollLyricsTo(targetY) {
    const scrollContainer = document.querySelector('.fs-lyrics-content');
    if (!scrollContainer) return;

    targetLyricsScrollY = Math.max(0, targetY);

    if (!isProgrammaticLyricsScrolling) {
        currentLyricsScrollY = scrollContainer.scrollTop;
        isProgrammaticLyricsScrolling = true;

        const animateScroll = () => {
            if (!isProgrammaticLyricsScrolling || isUserInteractingWithLyrics) {
                isProgrammaticLyricsScrolling = false;
                lyricsScrollRaf = null;
                return;
            }

            const diff = targetLyricsScrollY - currentLyricsScrollY;
            if (Math.abs(diff) < 0.6) {
                currentLyricsScrollY = targetLyricsScrollY;
                scrollContainer.scrollTop = currentLyricsScrollY;
                isProgrammaticLyricsScrolling = false;
                lyricsScrollRaf = null;
                return;
            }

            // High-refresh-rate adaptive lerp (12% per frame yields a smooth, liquid momentum curve)
            currentLyricsScrollY += diff * 0.12;
            scrollContainer.scrollTop = currentLyricsScrollY;
            lyricsScrollRaf = requestAnimationFrame(animateScroll);
        };
        lyricsScrollRaf = requestAnimationFrame(animateScroll);
    }
}

function scrollActiveLyricIntoView(activeEl, force = false) {
    if (!activeEl) return;
    if (isUserInteractingWithLyrics && !force) return;

    const container = document.getElementById('fs-lyrics-container');
    const scrollContainer = (container && container.closest('.fs-lyrics-content')) || document.querySelector('.fs-lyrics-content');
    if (!scrollContainer) return;

    const elRect = activeEl.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();
    const currentRelativeTop = elRect.top - containerRect.top;
    const targetScrollTop = scrollContainer.scrollTop + currentRelativeTop - (scrollContainer.clientHeight / 2) + (activeEl.clientHeight / 2);

    smoothScrollLyricsTo(targetScrollTop);
}

function setupLyricsScrollInteractivity() {
    const scrollContainer = document.querySelector('.fs-lyrics-content');
    if (!scrollContainer || scrollContainer._hasScrollListener) return;
    scrollContainer._hasScrollListener = true;

    const onUserScroll = () => {
        isUserInteractingWithLyrics = true;
        isProgrammaticLyricsScrolling = false;
        if (lyricsScrollRaf) {
            cancelAnimationFrame(lyricsScrollRaf);
            lyricsScrollRaf = null;
        }
        if (userLyricsScrollTimeout) clearTimeout(userLyricsScrollTimeout);
        userLyricsScrollTimeout = setTimeout(() => {
            isUserInteractingWithLyrics = false;
            const container = document.getElementById('fs-lyrics-container');
            const activeEl = container ? container.querySelector('.fs-lyrics-line.active-lyric') : null;
            if (activeEl) {
                scrollActiveLyricIntoView(activeEl, true);
            }
        }, 2000);
    };

    scrollContainer.addEventListener('wheel', onUserScroll, { passive: true });
    scrollContainer.addEventListener('touchstart', onUserScroll, { passive: true });
    scrollContainer.addEventListener('touchmove', onUserScroll, { passive: true });
}

function syncLyricsTick(currentTime, forceScroll = false) {
    if (!currentLyricsData || !currentLyricsData.synced || !currentLyricsData.lines || currentLyricsData.lines.length === 0) {
        return;
    }

    // Apply offset only to the display lookup time, NOT to the audio
    const effectiveTime = Math.max(0, currentTime + lyricsOffsetSeconds);
    const lines = currentLyricsData.lines;

    // Binary search for the active lyric line
    let low = 0;
    let high = lines.length - 1;
    let foundIndex = -1;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (lines[mid].time <= effectiveTime) {
            foundIndex = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    const container = document.getElementById('fs-lyrics-container');
    if (!container) return;

    if (foundIndex !== activeLyricIndex || forceScroll) {
        activeLyricIndex = foundIndex;
        const lineEls = container.querySelectorAll('.fs-lyrics-line');
        let activeEl = null;

        lineEls.forEach((el, i) => {
            el.classList.remove('active-lyric', 'near-lyric');
            if (i === foundIndex) {
                el.classList.add('active-lyric');
                activeEl = el;
            } else if (i === foundIndex - 1 || i === foundIndex + 1) {
                el.classList.add('near-lyric');
            }
        });

        if (activeEl) {
            scrollActiveLyricIntoView(activeEl, forceScroll);
        }
    }
}

async function loadLyricsForTrack(track) {
    if (!track || !track.title) return;
    currentLyricsTrackId = track.id;
    activeLyricIndex = -1;
    updateFsLyricsButtonState(false, true);

    const container = document.getElementById('fs-lyrics-container');
    const syncBadge = document.getElementById('fs-lyrics-sync-badge');
    if (container) {
        container.classList.add('lyrics-fading-out');
        setTimeout(() => {
            if (currentLyricsTrackId === track.id) {
                container.innerHTML = '<p class="fs-lyrics-placeholder">Looking for lyrics...</p>';
                container.classList.remove('lyrics-fading-out');
            }
        }, 140);
    }

    try {
        const params = new URLSearchParams({
            title: track.title || '',
            artist: track.artist || '',
            album: track.album || '',
            duration: track.duration || 0,
            trackId: track.id || ''
        });

        const res = await fetch(`/api/music/lyrics?${params}`);
        if (!res.ok) throw new Error('Lyrics fetch failed');
        const data = await res.json();

        // Check if track hasn't changed during fetch
        if (state.currentTrack && state.currentTrack.id !== track.id) return;

        if (data.success && data.lyrics && (data.lyrics.syncedLyrics || data.lyrics.plainLyrics)) {
            currentLyricsData = data.lyrics;
            updateFsLyricsButtonState(true, false);

            if (userWantsLyrics) {
                setFsPlayerMode('lyrics');
            } else {
                setFsPlayerMode('artwork');
            }

            if (data.lyrics.synced && data.lyrics.lines && data.lyrics.lines.length > 0) {
                if (syncBadge) {
                    syncBadge.innerHTML = '<span style="color:var(--accent-primary, #38bdf8); margin-right:4px;">●</span> SYNCED LYRICS';
                    syncBadge.style.cursor = 'pointer';
                    syncBadge.title = 'Click to re-center current lyric';
                    syncBadge.onclick = () => {
                        isUserInteractingWithLyrics = false;
                        if (userLyricsScrollTimeout) clearTimeout(userLyricsScrollTimeout);
                        const ct = window.playbackManager ? window.playbackManager.getCurrentTime() : 0;
                        syncLyricsTick(ct, true);
                    };
                }

                if (container) {
                    container.innerHTML = data.lyrics.lines.map((l, i) => `
                        <div class="fs-lyrics-line" data-index="${i}" data-time="${l.time}">${escapeHtml(l.text)}</div>
                    `).join('');

                    container.classList.remove('lyrics-fading-out');
                    container.classList.remove('lyrics-fading-in');
                    void container.offsetWidth;
                    container.classList.add('lyrics-fading-in');

                    container.querySelectorAll('.fs-lyrics-line').forEach(el => {
                        el.addEventListener('click', () => {
                            const t = parseFloat(el.getAttribute('data-time'));
                            if (!isNaN(t) && window.playbackManager) {
                                isUserInteractingWithLyrics = false;
                                if (userLyricsScrollTimeout) clearTimeout(userLyricsScrollTimeout);
                                window.playbackManager.seek(t);
                                syncLyricsTick(t, true);
                            }
                        });
                    });
                }
                setupLyricsScrollInteractivity();
                setTimeout(() => {
                    syncLyricsTick(window.playbackManager ? window.playbackManager.getCurrentTime() : 0, true);
                }, 80);
            } else {
                if (syncBadge) {
                    syncBadge.textContent = 'PLAIN LYRICS';
                    syncBadge.onclick = null;
                    syncBadge.style.cursor = 'default';
                }
                // Plain lyrics fallback
                const plainLines = (data.lyrics.plainLyrics || '').split(/\r?\n/).filter(Boolean);
                if (container) {
                    container.innerHTML = plainLines.map(line => `
                        <div class="fs-lyrics-line" style="cursor:default; opacity:0.8;">${escapeHtml(line)}</div>
                    `).join('');
                    container.classList.remove('lyrics-fading-out');
                    container.classList.remove('lyrics-fading-in');
                    void container.offsetWidth;
                    container.classList.add('lyrics-fading-in');
                }
            }
        } else {
            currentLyricsData = null;
            updateFsLyricsButtonState(false, false);
            setFsPlayerMode('artwork'); // AUTOMATICALLY switch to Centered Apple Music Player!

            if (syncBadge) {
                syncBadge.textContent = 'LYRICS';
                syncBadge.onclick = null;
                syncBadge.style.cursor = 'default';
            }
            if (container) {
                container.innerHTML = '<p class="fs-lyrics-placeholder">Lyrics not available for this track.</p>';
                container.classList.remove('lyrics-fading-out');
            }
        }
    } catch (err) {
        console.warn('[Lyrics] Error:', err.message);
        currentLyricsData = null;
        updateFsLyricsButtonState(false, false);
        setFsPlayerMode('artwork'); // AUTOMATICALLY switch to Centered Apple Music Player!

        if (container) {
            container.innerHTML = '<p class="fs-lyrics-placeholder">Lyrics not available for this track.</p>';
            container.classList.remove('lyrics-fading-out');
        }
    }
}

// ==========================================
// UNIFIED QUALITY-PRESERVING DOWNLOADS
// ==========================================
const activeDownloads = new Set();

async function downloadTrackFromData(encodedCandidateData) {
    let track;
    try {
        track = JSON.parse(decodeURIComponent(encodedCandidateData));
    } catch (e) {
        return showToast('Unable to parse track data', 'error');
    }

    if (!track || !track.id) return;

    if (activeDownloads.has(track.id)) {
        return showToast(`Download already in progress for "${track.title}"`, 'info');
    }

    const source = (track.source || track.provider || '').toLowerCase();
    if (source === 'youtube' || String(track.id).startsWith('yt_') || track.videoId) {
        return showToast('Downloads are unavailable for YouTube streams.', 'warning');
    }

    activeDownloads.add(track.id);
    showToast(`Preparing download: "${track.title}"...`, 'info');

    try {
        const params = new URLSearchParams({
            id: track.id,
            source: track.source || 'telegram',
            title: track.title || '',
            artist: track.artist || '',
            format: track.format || '',
            audioUrl: track.audioUrl || track.preview || ''
        });

        const downloadUrl = `/api/music/download?${params}`;
        
        // Check if on-demand retrieval is required
        const checkRes = await fetch(downloadUrl);
        if (checkRes.status === 202) {
            showToast(`✨ Retrieving lossless master for "${track.title}". Download will start shortly...`, 'info');
            let ready = false;
            let attempts = 0;
            while (!ready && attempts < 25) {
                await new Promise(r => setTimeout(r, 1500));
                attempts++;
                const pollRes = await fetch(`/api/telegram/prepare/${track.id}`);
                const pollData = await pollRes.json();
                if (pollData.status === 'READY') {
                    ready = true;
                    break;
                }
            }
        } else if (!checkRes.ok && checkRes.status !== 200) {
            const errData = await checkRes.json().catch(() => ({}));
            throw new Error(errData.message || 'Download request failed');
        }

        // Trigger native download
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        showToast(`✓ Download started for "${track.title}"`, 'success');
    } catch (err) {
        console.error('[Download] Error:', err);
        showToast(`Download failed: ${err.message}`, 'error');
    } finally {
        activeDownloads.delete(track.id);
    }
}

// Window bindings for Audio Settings, Candidate Sources, Lyrics, and Downloads
window.openAudioSettingsModal = openAudioSettingsModal;
window.closeAudioSettingsModal = closeAudioSettingsModal;
window.savePlaybackSetting = savePlaybackSetting;
window.openCandidateSourcesModal = openCandidateSourcesModal;
window.closeCandidateSourcesModal = closeCandidateSourcesModal;
window.playSpecificCandidate = playSpecificCandidate;
window.downloadTrackFromData = downloadTrackFromData;
window.setLyricsOffset = setLyricsOffset;
