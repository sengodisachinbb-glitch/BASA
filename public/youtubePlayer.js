/**
 * YouTube Audio Player Component
 * Handles the YouTube IFrame API to play audio seamlessly in the background.
 */

class YouTubeAudioPlayer {
    constructor() {
        this.player = null;
        this.isReady = false;
        this.currentVideoId = null;
        
        // Listeners
        this.onReadyCallback = null;
        this.onStateChangeCallback = null;
        this.onErrorCallback = null;
    }

    init(containerId) {
        if (window.onYouTubeIframeAPIReady) return; // Prevent multiple initializations

        window.onYouTubeIframeAPIReady = () => {
            this.player = new YT.Player(containerId, {
                height: '250',
                width: '250',
                playerVars: {
                    autoplay: 0,
                    controls: 0,
                    disablekb: 1,
                    fs: 0,
                    playsinline: 1,
                    rel: 0,
                    enablejsapi: 1,
                    origin: window.location.origin
                },
                events: {
                    'onReady': this.onPlayerReady.bind(this),
                    'onStateChange': this.onPlayerStateChange.bind(this),
                    'onError': this.onPlayerError.bind(this)
                }
            });
        };

        // Inject YouTube API Script dynamically only if not already injected
        if (!document.getElementById('youtube-iframe-api')) {
            const tag = document.createElement('script');
            tag.id = 'youtube-iframe-api';
            tag.src = "https://www.youtube.com/iframe_api";
            const firstScriptTag = document.getElementsByTagName('script')[0];
            if (firstScriptTag && firstScriptTag.parentNode) {
                firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
            } else {
                document.head.appendChild(tag);
            }
        }
    }

    onPlayerReady(event) {
        this.isReady = true;
        if (this.onReadyCallback) this.onReadyCallback();
    }

    onPlayerStateChange(event) {
        // event.data values:
        // -1 (unstarted), 0 (ended), 1 (playing), 2 (paused), 3 (buffering), 5 (video cued).
        if (this.onStateChangeCallback) {
            this.onStateChangeCallback(event.data);
        }
    }

    onPlayerError(event) {
        console.error('YouTube Player Error:', event.data);
        if (this.onErrorCallback) this.onErrorCallback(event.data);
        // Advance to next valid track gracefully to prevent getting stuck
        if (typeof window.playNext === 'function') {
            setTimeout(() => window.playNext(), 50);
        } else if (typeof playNext === 'function') {
            setTimeout(() => playNext(), 50);
        }
    }

    loadAndPlay(videoId) {
        this.currentVideoId = videoId;
        if (this.isReady && this.player && typeof this.player.loadVideoById === 'function') {
            this.player.loadVideoById(videoId);
        } else {
            console.warn('YouTube Player not ready yet. Will play when ready.');
            // Save it to play once ready
            const oldReady = this.onReadyCallback;
            this.onReadyCallback = () => {
                if (oldReady) oldReady();
                if (this.player && typeof this.player.loadVideoById === 'function') {
                    this.player.loadVideoById(videoId);
                }
            };
        }
    }

    resume() {
        if (this.isReady && this.player) this.player.playVideo();
    }
    
    // Alias play to resume for compatibility if needed
    play() {
        this.resume();
    }

    pause() {
        if (this.isReady && this.player) this.player.pauseVideo();
    }

    seek(seconds) {
        if (this.isReady && this.player) this.player.seekTo(seconds, true);
    }
    
    // Alias seekTo to seek for compatibility
    seekTo(seconds) {
        this.seek(seconds);
    }

    setVolume(volume) {
        // volume from 0 to 100
        if (this.isReady && this.player) this.player.setVolume(volume);
    }

    getCurrentTime() {
        return this.isReady && this.player && typeof this.player.getCurrentTime === 'function' ? this.player.getCurrentTime() : 0;
    }

    getDuration() {
        return this.isReady && this.player && typeof this.player.getDuration === 'function' ? this.player.getDuration() : 0;
    }
}

// Expose instance globally
window.ytAudioPlayer = new YouTubeAudioPlayer();
