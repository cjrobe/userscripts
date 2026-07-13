// ==UserScript==
// @name         Instagram PC Suite
// @namespace    https://instagram.com
// @version      10.1
// @description  Combined: progress bar + no-loop + session seen counter (always on), and keyboard-driven PC mode (F) using Instagram's native post modal. Replaces both "Instagram PC Experience (Alt)" and the progress-bar/seen-counter script — run only this one.
// @author       Emree.el on instagram (progress bar), jcunews (no-loop logic)
// @match        *://*.instagram.com/*
// @grant        none
// @run-at       document-start
// @license      MIT
// ==/UserScript==
(function () {
  'use strict';

  // ============================================================
  // CONFIGURATION
  // ============================================================
  // Key bindings (PC mode)
  const KEY_ACTIVATE     = 'f';   // activate / deactivate PC mode
  const KEY_NEXT         = 'j';   // next post
  const KEY_PREV         = 'k';   // previous post
  const KEY_LIKE         = 'l';   // toggle like on current post
  const KEY_GALLERY_BACK = 'a';   // previous image in gallery/carousel
  const KEY_GALLERY_FWD  = 's';   // next image in gallery/carousel
  const KEY_COMMENTS     = 'c';   // toggle comments panel
  const KEY_PLAYPAUSE    = 'p';   // play / pause video
  const KEY_MUTE         = 'm';   // mute / unmute video
  const KEY_SAVE         = 'b';   // save / bookmark current post
  const KEY_IMMERSIVE    = 'i';   // toggle immersive curtain over the feed
  const KEY_PROFILE      = 'u';   // open the current post's author profile in a new tab
  const KEY_TRANSLATE    = 't';   // translate the current post once (single click, manual)
  const KEY_HIDE         = 'h';   // hide / show the on-screen control panels

  // Feed features
  const disableVideoLoop  = true;  // false = allow normal looping
  const showSeenCounter   = true;  // false = hide badges + HUD
  const seenThreshold     = 0.4;   // fraction visible before a post counts as seen
  const reencounterGapMs  = 4000;  // post must be gone from viewport this long before "seen" applies
  const autoPauseNewVideos = false; // true = pause videos when discovered (off: let videos autoplay)
  const commentsDefaultOn  = false; // false = comments hidden by default in PC mode
  const immersiveDefaultOn = true;  // curtain over the feed while in PC mode (hides open/close flash)
  // ============================================================

  // === VIDEO LOOP PREVENTION (single hijack — must run before IG's code) ===
  const originalAddEventListener = HTMLVideoElement.prototype.addEventListener;
  if (disableVideoLoop) {
    HTMLVideoElement.prototype.addEventListener = function (type) {
      if (type === 'ended') return;
      return originalAddEventListener.apply(this, arguments);
    };
  }

  // === KEYBOARD SHELL — registered at document-start, before Instagram's
  // scripts have loaded, so this listener is FIRST in window-capture order.
  // Instagram's own key handlers (including its native like shortcut in the
  // post modal) register later, which means stopImmediatePropagation in our
  // handler genuinely starves them. Registering later (as before) let one
  // trusted keypress reach BOTH Instagram and this script: like -> native
  // unlike -> our verify-retry re-like, i.e. the like flicker. ===
  // Suppress the WHOLE key event family, not just keydown: canceling a
  // keydown never cancels the matching keyup (and keypress suppression is
  // browser-dependent), so a shortcut Instagram registers on keyup/keypress
  // would still fire — one extra like-toggle, i.e. the residual flicker.
  // Actions run once, on keydown; keypress/keyup for owned keys are eaten.
  let pcKeyHandler = null;  // acts on keydown (set by initPcMode)
  let pcKeySwallow = null;  // returns true if PC mode owns this key event
  ['keydown', 'keypress', 'keyup'].forEach((type) => {
    window.addEventListener(type, (e) => {
      if (type === 'keydown') {
        if (pcKeyHandler) pcKeyHandler(e);
      } else if (pcKeySwallow && pcKeySwallow(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
  });

  // ============================================================
  // POST IDENTITY
  // Identity = permalink shortcode (/p/<code>/ or /reel/<code>/): permanent
  // and unique per post. Never track posts by element identity or index —
  // Instagram virtualizes the feed (few articles mounted, recycled, with
  // scroll re-anchoring).
  // ============================================================
  function articleCode(article) {
    if (!article) return null;
    const a = article.querySelector('a[href*="/p/"], a[href*="/reel/"]');
    const m = a && a.getAttribute('href').match(/\/(?:p|reel)\/([^\/]+)/);
    return m ? m[1] : null;
  }

  // --- Geometry helpers ---
  function visibleHeight(el) {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
  }
  function feedArticles() {
    // exclude the modal's article — adjacency must be over feed posts only
    return [...document.querySelectorAll('article')].filter(a => !a.closest('div[role="dialog"]'));
  }
  function mostVisibleArticle() {
    let best = null, bestH = 0;
    feedArticles().forEach((a) => {
      const h = visibleHeight(a);
      if (h > bestH) { bestH = h; best = a; }
    });
    return best;
  }
  function articleByCode(code) {
    return feedArticles().find((a) => articleCode(a) === code) || null;
  }

  // ============================================================
  // SEEN TRACKING — badges, HUD, dual counting paths
  // ============================================================
  // All tracking is SESSION-scoped: nothing persists across page loads.
  const sessionNums   = new Map(); // code -> Nth unique post seen this session
  const seenAgain     = new Set(); // codes re-encountered after leaving the viewport
  const lastVisibleAt = new Map(); // code -> last visibility ping (ms)
  let hud = null;
  let pcActive = false;          // set by PC mode below
  let pcCounter = null;          // PC-mode fallback counter (top-right; used when immersive OFF)
  let pcLabelCount = null;       // count line inside the vertical curtain label (immersive ON)
  let pcPostNumber = 0;

  function updateHud() {
    if (!showSeenCounter || !document.body) return;
    if (!hud || !hud.isConnected) {
      hud = document.createElement('div');
      hud.style.cssText =
        'position:fixed; top:70px; right:16px; z-index:99999; ' +
        'background:rgba(0,0,0,0.75); color:#fff; font:13px/1.4 sans-serif; ' +
        'padding:6px 10px; border-radius:8px; pointer-events:none;';
      document.body.appendChild(hud);
    }
    // Write-on-change only: every DOM write here is a mutation inside
    // React-adjacent territory and re-triggers our own MutationObserver.
    const displayWanted = pcActive ? 'none' : '';
    if (hud.style.display !== displayWanted) hud.style.display = displayWanted;
    // "Post #4, 4 seen" — current post's number plus total unique posts
    const curArt = mostVisibleArticle();
    const curNum = curArt ? sessionNums.get(articleCode(curArt)) : null;
    const hudText = (curNum ? 'Post #' + curNum + ', ' : '') + sessionNums.size + ' seen';
    if (hud.textContent !== hudText) hud.textContent = hudText;
    if (pcActive) {
      const counterText = 'Post #' + pcPostNumber + ', ' + sessionNums.size + ' seen';
      // Count now lives in the vertical curtain label (immersive ON); the
      // top-right counter is the fallback shown only when immersive is OFF.
      if (pcLabelCount && pcLabelCount.textContent !== counterText) pcLabelCount.textContent = counterText;
      if (pcCounter && pcCounter.textContent !== counterText) pcCounter.textContent = counterText;
    }
  }

  function addBadge(article, num, seenBefore) {
    if (!showSeenCounter) return;
    // No badge inside the post modal — it floats next to the Close button
    // and duplicates the PC-mode counter. Feed badges only.
    if (article.closest('div[role="dialog"]')) return;
    let b = article.querySelector('.igps-badge');
    if (!b) {
      b = document.createElement('div');
      b.className = 'igps-badge';
      b.style.cssText =
        'position:absolute; top:8px; right:8px; z-index:9999; ' +
        'font:bold 12px sans-serif; color:#fff; padding:3px 8px; ' +
        'border-radius:10px; pointer-events:none;';
      article.style.position = 'relative';
      article.appendChild(b);
    }
    const text = '#' + num + (seenBefore ? ' · seen' : '');
    if (b.textContent !== text) {
      b.textContent = text;
      b.style.background = seenBefore ? 'rgba(120,120,120,0.85)' : 'rgba(220,40,40,0.85)';
    }
  }

  // Idempotent — safe from any path, also repairs badges React wipes out.
  function markSeen(article) {
    const code = articleCode(article);
    if (!code) return null;
    const now = Date.now();
    // "Seen" = re-encounter WITHIN this session: the post was viewed, left
    // the viewport (no visibility ping for reencounterGapMs), and is back.
    // The gap rule matters because the poller re-marks a visible post every
    // 800ms — without it, every post would flag itself "seen" while you're
    // still looking at it.
    if (sessionNums.has(code) && now - (lastVisibleAt.get(code) || 0) > reencounterGapMs) {
      seenAgain.add(code); // sticky for the rest of the session
    }
    lastVisibleAt.set(code, now);
    if (!sessionNums.has(code)) sessionNums.set(code, sessionNums.size + 1);
    addBadge(article, sessionNums.get(code), seenAgain.has(code));
    updateHud();
    return code;
  }

  // Path 1: IntersectionObserver — instant, but browsers stop firing it in
  // hidden/throttled tabs (verified live).
  const seenObserver = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting && e.intersectionRatio >= seenThreshold) markSeen(e.target);
    });
  }, { threshold: [seenThreshold] });

  function watchArticles() {
    document.querySelectorAll('article:not([data-igps])').forEach((a) => {
      a.dataset.igps = '1';
      seenObserver.observe(a);
    });
  }

  // Path 2: interval poller — keeps counting when IO is throttled.
  setInterval(() => {
    document.querySelectorAll('article').forEach((a) => {
      const r = a.getBoundingClientRect();
      if (r.height > 0 && visibleHeight(a) / r.height >= seenThreshold) markSeen(a);
    });
    // Sweep ALL videos, not just unhooked ones: Instagram often adds the
    // <video> element bare and sets the blob src later (missed by the
    // observer -> frozen at end), and React re-renders can delete the bar
    // from an already-hooked video — createProgressBar's internal guards
    // make this cheap and idempotent, and the bar self-heals.
    document.querySelectorAll('video').forEach(createProgressBar);
  }, 800);

  // ============================================================
  // PROGRESS BAR (single implementation for feed AND modal videos)
  // ============================================================
  function createProgressBar(video) {
    if (!video.parentElement) return;

    // --- One-time hook per video (noloop guard). React never removes this:
    // the attribute and listeners live on the video element itself. ---
    if (disableVideoLoop && !video.hasAttribute('noloop')) {
      video.loop = false;
      video.setAttribute('noloop', '');
      // Only auto-pause videos that haven't started — the late-video sweep
      // must never pause something the user is already watching.
      if (autoPauseNewVideos && video.currentTime < 0.5) video.pause();

      // Hook React's play/pause overlay: replay ended videos on click, and
      // record the user's manual pause/play intent. (The old version played
      // any paused video on click, which made click-to-pause impossible.)
      if (video.parentNode) {
        video.parentNode.querySelectorAll('div[role]').forEach(el => {
          Object.keys(el).some(k => {
            if (k.startsWith('__reactProps$')) {
              if (String(el[k].onClick).includes('pause')) {
                el.addEventListener('click', () => {
                  if (video.ended) {
                    delete video.dataset.igpcUserPaused;
                    video.currentTime = 0;
                    video.play();
                    return;
                  }
                  // Instagram's own handler toggles play/pause; record where
                  // it landed as the user's intent.
                  setTimeout(() => {
                    if (video.paused) video.dataset.igpcUserPaused = '1';
                    else delete video.dataset.igpcUserPaused;
                  }, 100);
                });
              }
              return true;
            }
          });
        });
      }

      // Sticky manual pause: once the user pauses this video, nothing —
      // Instagram's tab-refocus autoplay included — may restart it until
      // the user plays it again (P or click).
      video.addEventListener('play', () => {
        if (video.dataset.igpcUserPaused) video.pause();
      });

      // When a video ends it stops on its last frame; P (or a click)
      // replays. Advancing here would be arbitrary in a mixed photo/video
      // feed — J is the one advance mechanism for every post type.

      // Look the indicator up live: React can wipe and rebuild the bar, so a
      // captured reference would go stale and the bar would stop moving.
      video.addEventListener('timeupdate', () => {
        if (disableVideoLoop) video.loop = false;
        const ind = video.parentElement &&
          video.parentElement.querySelector('.igps-progress-bar > div');
        if (ind && video.duration) {
          ind.style.width = ((video.currentTime / video.duration) * 100) + '%';
        }
      });
    }

    // --- Bar creation (re-runs whenever React has wiped the bar) ---
    if (video.parentElement.querySelector('.igps-progress-bar')) return;

    const bar = document.createElement('div');
    bar.className = 'igps-progress-bar';
    bar.style.cssText =
      'position:absolute; bottom:5px; left:0; width:100%; height:5px; ' +
      'background:rgba(0,0,0,0.5); cursor:pointer; z-index:9999;';

    const indicator = document.createElement('div');
    indicator.style.cssText = 'height:100%; width:0%; background:#ff0000;';
    bar.appendChild(indicator);

    video.parentElement.style.position = 'relative';
    video.parentElement.appendChild(bar);

    bar.addEventListener('click', (e) => {
      const rect = bar.getBoundingClientRect();
      video.currentTime = video.duration * ((e.clientX - rect.left) / rect.width);
    });
  }

  // ============================================================
  // PC MODE — keyboard-driven browsing in Instagram's native post modal
  // ============================================================
  const commentsStyle = document.createElement('style');
  commentsStyle.id = 'igpc-comments-style';

  function initPcMode() {
    // The shortcode is the source of truth for "which post are we on" —
    // element references go stale across await gaps because virtualization
    // recycles them. Resolve the element fresh at each use.
    let currentArticle = null;
    let currentCode = null;
    let transitioning = false;
    let markerInterval = null;

    // --- Persistent preferences (toggles survive reloads and sessions) ---
    // Config constants above are only the first-run defaults; after that,
    // the user's last toggle state wins.
    const PREFS_KEY = 'igpc_prefs_v1';
    let prefs;
    try { prefs = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (e) { prefs = {}; }
    let commentsHidden = prefs.commentsHidden != null ? prefs.commentsHidden : !commentsDefaultOn;
    let isMuted        = prefs.isMuted        != null ? prefs.isMuted        : true;
    let immersiveOn    = prefs.immersiveOn    != null ? prefs.immersiveOn    : immersiveDefaultOn;
    let controlsHidden = prefs.controlsHidden != null ? prefs.controlsHidden : false;
    function savePrefs() {
      try {
        localStorage.setItem(PREFS_KEY,
          JSON.stringify({ commentsHidden, isMuted, immersiveOn, controlsHidden }));
      } catch (e) {}
    }

    // --- Immersive curtain ---
    // A fixed overlay that hides the feed during modal open/close/scroll
    // transitions. z-index 2 is deliberate: Instagram's feed content stacks
    // at 0/auto and its modal portal at z-index 3 (measured live), so the
    // curtain sits exactly between them. pointer-events:none means it can
    // never intercept clicks — purely visual, nothing for React to fight.
    const curtain = document.createElement('div');
    curtain.id = 'igpc-curtain';
    curtain.style.cssText =
      'position:fixed;inset:0;z-index:2;pointer-events:none;' +
      'opacity:0;transition:opacity 0.2s ease;display:none;';

    document.body.appendChild(curtain);

    // Vertical label on the empty left strip — reads bottom-to-top
    // (writing-mode + rotate 180). Names the page BEHIND the curtain, so the
    // user always knows what they'll return to on exit. It's a SEPARATE fixed
    // element at z-index 11 (above the freeze-frame's z-index 10), so it
    // stays put during post transitions instead of being covered and
    // re-revealed by each freeze frame.
    const curtainLabelWrap = document.createElement('div');
    curtainLabelWrap.style.cssText =
      'position:fixed;left:0;top:0;height:100%;width:64px;z-index:11;pointer-events:none;' +
      'opacity:0;transition:opacity 0.2s ease;';

    // TITLE (HOME / Profile: name) — the anchor. Vertically centered and,
    // crucially, in its OWN absolutely-centered box so its position never
    // depends on the count's length. This is what "stays centered" means.
    const titleBox = document.createElement('div');
    titleBox.style.cssText =
      'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;';
    const curtainLabelTitle = document.createElement('div');
    curtainLabelTitle.style.cssText =
      'writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap;' +
      'font:bold 22px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'color:#b0b3b8;letter-spacing:3px;';
    titleBox.appendChild(curtainLabelTitle);

    // COUNT (Post #N, N seen) — sits just above the title, anchored by its
    // BOTTOM edge. Because only `bottom` is fixed (top/height auto), longer
    // numbers extend it UPWARD without ever nudging the title.
    const countBox = document.createElement('div');
    countBox.style.cssText =
      'position:absolute;left:0;width:64px;display:flex;justify-content:center;';
    const curtainLabelCount = document.createElement('div');
    curtainLabelCount.style.cssText =
      'writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap;' +
      'font:600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'color:#b0b3b8;letter-spacing:1px;opacity:0.6;';
    countBox.appendChild(curtainLabelCount);

    curtainLabelWrap.appendChild(titleBox);
    curtainLabelWrap.appendChild(countBox);
    document.body.appendChild(curtainLabelWrap);
    pcLabelCount = curtainLabelCount; // updateHud writes the count here

    // Anchor the count's bottom a fixed gap above the (centered) title. Only
    // needs to run when the TITLE changes — never on a count change, so the
    // count digits growing can't shift anything.
    function layoutCurtainLabel() {
      const th = curtainLabelTitle.getBoundingClientRect().height || 60;
      const gap = 20; // breathing room between title and count
      countBox.style.bottom = 'calc(50% + ' + Math.round(th / 2 + gap) + 'px)';
    }

    let curtainLabelText = 'HOME'; // captured at activate() from the underlying page

    // The page behind the curtain: a profile (/username/) or the home feed.
    // Read at activation, before any modal changes the URL to /p/<code>/.
    function computeCurtainLabel() {
      const NON_PROFILE = ['explore', 'reels', 'direct', 'stories', 'accounts', 'about', 'legal'];
      const m = location.pathname.match(/^\/([a-zA-Z0-9._]+)\/?$/);
      if (m && !NON_PROFILE.includes(m[1])) return 'Profile: ' + m[1];
      return 'HOME';
    }

    function updateCurtain() {
      // Top-right counter is the fallback shown only when the vertical label
      // isn't (i.e. immersive OFF). Its text is kept fresh by updateHud.
      if (pcCounter) pcCounter.style.display = (pcActive && !immersiveOn) ? '' : 'none';
      if (pcActive && immersiveOn) {
        // Match the page's own theme background (IG dark mode: rgb(12,16,20))
        curtain.style.background =
          getComputedStyle(document.body).backgroundColor || 'rgb(26,26,26)';
        curtain.style.display = '';
        curtainLabelWrap.style.display = '';
        if (curtainLabelTitle.textContent !== curtainLabelText) {
          curtainLabelTitle.textContent = curtainLabelText;
        }
        layoutCurtainLabel();   // anchor count above the (now-measurable) title
        curtain.offsetWidth; // reflow so the opacity transition runs
        curtain.style.opacity = '1';
        curtainLabelWrap.style.opacity = '1';
        updateHud(); // refresh the count line for the just-shown label
      } else {
        curtain.style.opacity = '0';
        curtainLabelWrap.style.opacity = '0';
        setTimeout(() => {
          if (!(pcActive && immersiveOn)) {
            curtain.style.display = 'none';
            curtainLabelWrap.style.display = 'none';
          }
        }, 220);
      }
    }

    function toggleImmersive() {
      immersiveOn = !immersiveOn;
      savePrefs();
      updateCurtain();
      updateTogglesPanel();
    }

    // --- Freeze-frame ---
    // Feed navigation must close one modal and open the next; instead of
    // showing that churn, snapshot the outgoing post's media and hold it
    // fullscreen (z-index 10: above the modal, below our HUD) until the
    // incoming post's media is actually loaded, then fade it away.
    let freezeEl = null;

    // Spinner keyframes (injected once)
    const spinStyle = document.createElement('style');
    spinStyle.textContent = '@keyframes igpcspin { to { transform: rotate(360deg); } }';
    document.head.appendChild(spinStyle);

    // Pick the media that is actually VISIBLE right now. Carousels keep
    // neighboring slides mounted and shifted to the side — a naive "first
    // video / largest image" pick lands on an offscreen slide and puts the
    // freeze completely offset (observed live on carousel posts). Clip each
    // candidate against its nearest overflow-clipping ancestor (the carousel
    // viewport) and the window, then take the largest visible area.
    function pickMainMedia(dialog) {
      const art = dialog.querySelector('article');
      if (!art) return null;
      let best = null, bestArea = 0;
      art.querySelectorAll('video, img[src]').forEach(el => {
        const er = el.getBoundingClientRect();
        let r = { left: er.left, right: er.right, top: er.top, bottom: er.bottom };
        let p = el.parentElement;
        while (p && p !== art) {
          const cs = getComputedStyle(p);
          if (/hidden|clip|scroll|auto/.test(cs.overflowX + ' ' + cs.overflowY)) {
            const pr = p.getBoundingClientRect();
            r = {
              left: Math.max(r.left, pr.left), right: Math.min(r.right, pr.right),
              top: Math.max(r.top, pr.top), bottom: Math.min(r.bottom, pr.bottom)
            };
            break;
          }
          p = p.parentElement;
        }
        const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
        const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
        const area = w * h;
        if (area > bestArea) { bestArea = area; best = el; }
      });
      return bestArea > 10000 ? best : null; // ignore avatar-sized images
    }

    // The description/comments column, measured per post: walk up from a
    // known inner element (comment form / timestamp) and keep the topmost
    // ancestor that sits to the right of the media.
    function findInfoColumn(art, mediaRect) {
      let el = art.querySelector('form') || art.querySelector('time');
      let best = null;
      while (el && el !== art) {
        const r = el.getBoundingClientRect();
        if (r.left >= mediaRect.right - 40 && r.width > 120 && r.height > 100) best = el;
        el = el.parentElement;
      }
      return best;
    }

    async function raiseFreezeFrame() {
      dropFreezeFrame();
      const dialog = getDialog();
      if (!dialog) return;
      let copyImg = null;
      const layer = document.createElement('div');
      layer.id = 'igpc-freeze';
      // Mounted INVISIBLE (opacity 0, no transition): the real modal stays
      // fully visible beneath while the snapshot decodes. Mounting opaque
      // immediately flashed a gray, contentless layer for a frame or two
      // before the image appeared (the "gray before the freeze" flicker).
      layer.style.cssText =
        'position:fixed;inset:0;z-index:10;pointer-events:none;' +
        'background:' + (getComputedStyle(document.body).backgroundColor || 'rgb(26,26,26)') + ';' +
        'opacity:0;';
      const media = pickMainMedia(dialog);
      if (media) {
        const r = media.getBoundingClientRect();
        let copy = null;
        if (media.tagName === 'VIDEO') {
          // Canvas capture of the current frame. Displaying a (possibly
          // tainted) canvas is fine — restrictions only apply to readback.
          if (media.videoWidth) {
            const c = document.createElement('canvas');
            c.width = media.videoWidth;
            c.height = media.videoHeight;
            try { c.getContext('2d').drawImage(media, 0, 0); copy = c; } catch (e) { copy = null; }
          }
        } else if (media.src) {
          copy = document.createElement('img');
          copy.src = media.src; // already cached — renders instantly
          copyImg = copy;
        }
        if (copy && r.width > 0) {
          // 80% opacity signals "held, not current" while staying readable
          copy.style.cssText =
            'position:absolute;left:' + Math.round(r.left) + 'px;top:' + Math.round(r.top) +
            'px;width:' + Math.round(r.width) + 'px;height:' + Math.round(r.height) +
            'px;object-fit:contain;opacity:0.8;';
          layer.appendChild(copy);
        }

        // Simplified stand-in for the description/comments column: div
        // shapes and theme tones only, no text — keeps the modal layout
        // from visually collapsing to just the media during the hold.
        const art = dialog.querySelector('article');
        if (art) {
          const aR = art.getBoundingClientRect();
          // Measure the real column per post; geometric fallback only when
          // the walk fails (the fallback over-wide look was a reported bug).
          const colEl = findInfoColumn(art, r);
          const cR = colEl ? colEl.getBoundingClientRect() : null;
          const pLeft   = Math.round(cR ? cR.left   : r.right);
          const pTop    = Math.round(cR ? cR.top    : aR.top);
          const pWidth  = Math.round(cR ? cR.width  : aR.right - r.right);
          const pHeight = Math.round(cR ? cR.height : aR.height);
          if (pWidth > 120 && pHeight > 100) {
            const bodyBg = getComputedStyle(document.body).backgroundColor || 'rgb(26,26,26)';
            const rgb = (bodyBg.match(/\d+/g) || [26, 26, 26]).map(Number);
            const dark = (rgb[0] + rgb[1] + rgb[2]) / 3 < 128;
            const panelBg   = dark ? '#212328' : '#fff'; // IG dark-mode panel color
            const shape     = dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)';
            const shapeSoft = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
            const panel = document.createElement('div');
            panel.style.cssText =
              'position:absolute;left:' + pLeft + 'px;top:' + pTop +
              'px;width:' + pWidth + 'px;height:' + pHeight + 'px;' +
              'background:' + panelBg + ';border-left:1px solid ' + shapeSoft + ';' +
              'box-sizing:border-box;padding:20px;opacity:0.8;overflow:hidden;';
            panel.innerHTML =
              '<div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;">' +
                '<div style="width:32px;height:32px;border-radius:50%;background:' + shape + ';flex:none;"></div>' +
                '<div style="width:40%;height:12px;border-radius:6px;background:' + shape + ';"></div>' +
              '</div>' +
              [72, 58, 65, 38, 66, 52, 60, 44].map(w =>
                '<div style="width:' + w + '%;height:10px;border-radius:5px;background:' +
                shapeSoft + ';margin-bottom:14px;"></div>'
              ).join('');
            layer.appendChild(panel);
          }
        }
      }
      // Loading spinner so the hold reads as "loading", not "stuck"
      const spinner = document.createElement('div');
      spinner.style.cssText =
        'position:absolute;left:50%;top:50%;width:36px;height:36px;margin:-18px 0 0 -18px;' +
        'border:3px solid rgba(255,255,255,0.25);border-top-color:rgba(255,255,255,0.9);' +
        'border-radius:50%;animation:igpcspin 0.8s linear infinite;';
      layer.appendChild(spinner);
      document.body.appendChild(layer);
      freezeEl = layer;
      const paintTick = () => new Promise((res) => {
        let done = false;
        const finish = () => { if (!done) { done = true; res(); } };
        requestAnimationFrame(() => requestAnimationFrame(finish));
        setTimeout(finish, 150); // rAF never fires in hidden tabs
      });
      // 1) let the snapshot decode + lay out while still invisible
      if (copyImg && copyImg.decode) { try { await copyImg.decode(); } catch (e) {} }
      await paintTick();
      // 2) atomic reveal — pixel-identical to the modal beneath, so the
      //    swap itself is invisible; no transition on the way IN
      layer.style.opacity = '1';
      layer.offsetWidth;
      layer.style.transition = 'opacity 0.2s ease'; // for the fade-out later
      // 3) ensure the covering frame is committed before the caller closes
      //    the modal underneath
      await paintTick();
      // Self-destruct: never hold the old post longer than 3s, no matter
      // what happens to the navigation that raised it.
      setTimeout(() => { if (freezeEl === layer) dropFreezeFrame(); }, 3000);
    }

    function dropFreezeFrame() {
      const layer = freezeEl;
      if (!layer) return;
      freezeEl = null;
      // Crossfade: incoming post eases 0.8 -> 1 while the freeze fades out.
      // Inline styles only, cleared right after — nothing persistent for
      // React to reconcile against.
      const d = getDialog();
      if (d) {
        d.style.transition = 'opacity 0.25s ease';
        d.style.opacity = '0.8';
        d.offsetWidth; // reflow so the transition runs
        d.style.opacity = '1';
        setTimeout(() => { d.style.transition = ''; d.style.opacity = ''; }, 400);
      }
      layer.style.opacity = '0';
      setTimeout(() => layer.remove(), 260);
    }

    // Resolves when the open modal's main media is displayable (or timeout).
    function waitForDialogMedia(timeout = 2000) {
      return new Promise((resolve) => {
        const t0 = Date.now();
        const check = () => {
          const d = getDialog();
          if (!d) { resolve(false); return; }
          const v = d.querySelector('article video');
          const img = d.querySelector('article img[src]');
          if ((v && v.readyState >= 2) || (img && img.complete && img.naturalWidth > 0)) {
            resolve(true); return;
          }
          if (Date.now() - t0 > timeout) { resolve(false); return; }
          setTimeout(check, 100);
        };
        check();
      });
    }

    // --- Prompt + HUD panels ---
    const prompt = document.createElement('div');
    prompt.id = 'igpc-prompt';
    prompt.innerHTML = `Press <b>${KEY_ACTIVATE.toUpperCase()}</b> for PC mode`;
    prompt.style.cssText =
      'position:fixed;bottom:16px;right:16px;background:rgba(0,0,0,0.85);' +
      'color:#fff;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'padding:8px 14px;border-radius:8px;z-index:99999;pointer-events:none;opacity:0.7;';
    document.body.appendChild(prompt);

    const panelCSS =
      'position:fixed;right:16px;background:rgba(0,0,0,0.85);' +
      'color:#fff;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'padding:8px 12px;border-radius:8px;z-index:100000;pointer-events:none;' +
      'line-height:1.8;opacity:0.8;display:none;white-space:nowrap;';

    const controlsPanel = document.createElement('div');
    controlsPanel.id = 'igpc-controls';
    controlsPanel.style.cssText = panelCSS + 'top:70px;';
    controlsPanel.innerHTML =
      `<div style="font-weight:bold;margin-bottom:2px;opacity:0.6;font-size:10px;">CONTROLS</div>` +
      `<div><b>${KEY_ACTIVATE.toUpperCase()}</b> exit</div>` +
      `<div><b>${KEY_PREV.toUpperCase()}</b> prev post</div>` +
      `<div><b>${KEY_NEXT.toUpperCase()}</b> next post</div>` +
      `<div><b>${KEY_LIKE.toUpperCase()}</b> like</div>` +
      `<div><b>${KEY_SAVE.toUpperCase()}</b> save</div>` +
      `<div><b>${KEY_PROFILE.toUpperCase()}</b> profile ↗</div>` +
      `<div><b>${KEY_TRANSLATE.toUpperCase()}</b> translate</div>` +
      `<div><b>${KEY_GALLERY_BACK.toUpperCase()}</b> gallery prev</div>` +
      `<div><b>${KEY_GALLERY_FWD.toUpperCase()}</b> gallery next</div>` +
      `<div><b>${KEY_PLAYPAUSE.toUpperCase()}</b> play/pause</div>` +
      `<div><b>${KEY_HIDE.toUpperCase()}</b> hide controls</div>`;
    document.body.appendChild(controlsPanel);

    const togglesPanel = document.createElement('div');
    togglesPanel.id = 'igpc-toggles';
    togglesPanel.style.cssText = panelCSS + 'top:300px;'; // fallback; repositioned dynamically on activate
    togglesPanel.innerHTML =
      `<div style="font-weight:bold;margin-bottom:2px;opacity:0.6;font-size:10px;">TOGGLES</div>` +
      `<div id="igpc-t-comments"><b>${KEY_COMMENTS.toUpperCase()}</b> comments <span>ON</span></div>` +
      `<div id="igpc-t-mute"><b>${KEY_MUTE.toUpperCase()}</b> mute <span>ON</span></div>` +
      `<div id="igpc-t-immersive"><b>${KEY_IMMERSIVE.toUpperCase()}</b> immersive <span>ON</span></div>`;
    document.body.appendChild(togglesPanel);

    function updateTogglesPanel() {
      const cEl = document.querySelector('#igpc-t-comments span');
      const mEl = document.querySelector('#igpc-t-mute span');
      const iEl = document.querySelector('#igpc-t-immersive span');
      if (cEl) cEl.textContent = commentsHidden ? 'OFF' : 'ON';
      if (mEl) mEl.textContent = isMuted ? 'ON' : 'OFF';
      if (iEl) iEl.textContent = immersiveOn ? 'ON' : 'OFF';
    }

    const counter = document.createElement('div');
    counter.id = 'igpc-counter';
    counter.style.cssText =
      'position:fixed;top:16px;right:16px;background:rgba(0,0,0,0.85);' +
      'color:#fff;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'padding:6px 12px;border-radius:8px;z-index:100000;pointer-events:none;display:none;';
    document.body.appendChild(counter);
    pcCounter = counter;

    // Minimal hint shown (bottom-right, where the exit prompt sits) when the
    // control panels are hidden via H — the only affordance left on screen.
    const hideHint = document.createElement('div');
    hideHint.id = 'igpc-hide-hint';
    hideHint.innerHTML = `Press <b>${KEY_HIDE.toUpperCase()}</b> to show controls`;
    hideHint.style.cssText =
      'position:fixed;bottom:16px;right:16px;background:rgba(0,0,0,0.85);' +
      'color:#fff;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'padding:8px 14px;border-radius:8px;z-index:100000;pointer-events:none;opacity:0.7;display:none;';
    document.body.appendChild(hideHint);

    // Show/hide the control chrome. When hidden, panels + exit prompt go away
    // and only the bottom-right "H to show controls" hint remains.
    function applyControlsVisibility() {
      if (!pcActive) {
        controlsPanel.style.display = 'none';
        togglesPanel.style.display = 'none';
        hideHint.style.display = 'none';
        return;
      }
      if (controlsHidden) {
        controlsPanel.style.display = 'none';
        togglesPanel.style.display = 'none';
        prompt.style.display = 'none';
        hideHint.style.display = '';
      } else {
        controlsPanel.style.display = '';
        togglesPanel.style.display = '';
        // Position toggles just below the controls panel — from its rendered
        // height, so adding/removing key rows can never collide.
        togglesPanel.style.top =
          Math.round(controlsPanel.getBoundingClientRect().bottom + 12) + 'px';
        prompt.style.display = '';
        hideHint.style.display = 'none';
      }
    }

    function toggleHideControls() {
      controlsHidden = !controlsHidden;
      savePrefs();
      applyControlsVisibility();
    }

    // --- Dialog helpers ---
    // Instagram uses role="dialog" for share sheets, report flows, and
    // confirmations too — only a dialog CONTAINING an article is the post
    // modal. Matching any dialog made toggleLike scope to share sheets and
    // made the dialog-observer exit PC mode when a popover closed.
    function getDialog() {
      return [...document.querySelectorAll('div[role="dialog"]')]
        .find(d => d.querySelector('article')) || null;
    }
    function closeDialog() {
      const dialog = getDialog();
      if (!dialog) return;
      // Prefer the modal's own Close button — history.back() can navigate
      // clean off Instagram if the modal wasn't opened via pushState.
      const closeSvg = dialog.querySelector('svg[aria-label="Close"]') ||
                       document.querySelector('svg[aria-label="Close"]');
      const btn = closeSvg && (closeSvg.closest('button, [role="button"]') || closeSvg.parentElement);
      if (btn) { btn.click(); return; }
      if (/^\/(?:p|reel)\//.test(location.pathname)) window.history.back();
    }
    function waitForDialog(timeout = 3000) {
      return new Promise((resolve) => {
        if (getDialog()) { resolve(true); return; }
        const obs = new MutationObserver(() => {
          if (getDialog()) { obs.disconnect(); resolve(true); }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { obs.disconnect(); resolve(false); }, timeout);
      });
    }
    function waitForDialogClose(timeout = 1500) {
      return new Promise((resolve) => {
        if (!getDialog()) { resolve(); return; }
        const obs = new MutationObserver(() => {
          if (!getDialog()) { obs.disconnect(); resolve(); }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { obs.disconnect(); resolve(); }, timeout);
      });
    }
    const delay = ms => new Promise(r => setTimeout(r, ms));

    function getCommentButton(article) {
      const svg = article.querySelector('svg[aria-label="Comment"]');
      if (!svg) return null;
      return svg.closest('[role="button"]') || svg.parentElement;
    }

    function findNearestArticle() {
      const articles = feedArticles();
      if (articles.length === 0) return null;
      let closest = articles[0];
      let closestDist = Infinity;
      for (const a of articles) {
        const dist = Math.abs(a.getBoundingClientRect().top);
        if (dist < closestDist) { closestDist = dist; closest = a; }
      }
      return closest;
    }

    function getAdjacentArticle(current, direction) {
      const articles = feedArticles();
      let idx = current ? articles.indexOf(current) : -1;
      // Virtualization recovery: re-find the post by permalink code instead
      // of jumping to articles[0].
      if (idx === -1 && current) {
        const code = articleCode(current);
        if (code) idx = articles.findIndex(a => articleCode(a) === code);
      }
      if (idx === -1) idx = articles.indexOf(findNearestArticle());
      if (idx === -1) {
        return direction === 'next' ? articles[0] : articles[articles.length - 1];
      }
      if (direction === 'next') {
        return idx + 1 < articles.length ? articles[idx + 1] : null;
      } else {
        return idx - 1 >= 0 ? articles[idx - 1] : null;
      }
    }

    // Compare by shortcode, not element identity: virtualization re-creates
    // elements for posts we've already passed, which made recycled OLD posts
    // look "new" and could bounce navigation backwards.
    function waitForNewArticle(beforeCodes, timeout = 5000) {
      const findNew = () => feedArticles().find(a => {
        const c = articleCode(a);
        return c && !beforeCodes.has(c);
      });
      return new Promise((resolve) => {
        const initial = findNew();
        if (initial) { resolve(initial); return; }
        const obs = new MutationObserver(() => {
          const n = findNew();
          if (n) { obs.disconnect(); resolve(n); }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { obs.disconnect(); resolve(findNew() || null); }, timeout);
      });
    }

    // --- Open a specific article in the modal ---
    async function openArticle(article) {
      const btn = getCommentButton(article);
      if (!btn) return false;

      article.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await delay(500);

      btn.click();
      const opened = await waitForDialog();

      if (opened) {
        markCommentsContainer();
        await delay(200);
        markCommentsContainer();
        const dialog2 = getDialog();
        if (dialog2) {
          dialog2.querySelectorAll('video').forEach(v => {
            v.loop = false;
            v.muted = isMuted;
            v.play();
          });
        }
      }
      return opened;
    }

    // --- Navigate to next/prev post ---
    // --- Profile-style modal navigation ---
    // Profile post modals have native between-post arrows: svg "Next" /
    // "Go back" INSIDE the dialog but OUTSIDE the article (verified live).
    // Carousel arrows live inside the article, so containment disambiguates.
    function postNavArrow(direction) {
      const dialog = getDialog();
      if (!dialog) return null;
      const article = dialog.querySelector('article');
      const sel = direction === 'next'
        ? 'svg[aria-label="Next"], button[aria-label="Next"]'
        : 'svg[aria-label="Go back"], svg[aria-label="Go Back"], ' +
          'button[aria-label="Go back"], button[aria-label="Go Back"]';
      const el = [...dialog.querySelectorAll(sel)].find(x => !article || !article.contains(x));
      if (!el) return null;
      return el.tagName.toLowerCase() === 'svg'
        ? (el.closest('button, [role="button"]') || el.parentElement)
        : el;
    }

    // Adopt whatever post modal is currently open: tag comments, apply mute,
    // count the post, and sync the counter. Used when activating with a
    // modal already open and after profile-arrow navigation.
    function adoptCurrentDialog() {
      const d = getDialog();
      const art = d && d.querySelector('article');
      if (!art) return false;
      markCommentsContainer();
      d.querySelectorAll('video').forEach(v => { v.loop = false; v.muted = isMuted; v.play(); });
      const code = markSeen(art);
      if (code) { pcPostNumber = sessionNums.get(code); currentCode = code; }
      updateHud();
      return true;
    }

    // Re-resolve the current post's element from its shortcode; fall back to
    // the held reference only if it's still mounted, then to viewport geometry.
    function resolveCurrentArticle() {
      return (currentCode && articleByCode(currentCode)) ||
        (currentArticle && document.contains(currentArticle) ? currentArticle : null) ||
        findNearestArticle();
    }

    async function reopenCurrent() {
      const cur = resolveCurrentArticle();
      if (cur) await openArticle(cur);
    }

    async function navigate(direction) {
      if (transitioning) return;
      transitioning = true;

      // Profile-style modal: use Instagram's native between-post arrows —
      // the modal stays open, no close/scroll/reopen dance needed.
      const arrow = postNavArrow(direction);
      if (arrow) {
        arrow.click();
        await delay(700);
        adoptCurrentDialog();
        transitioning = false;
        return;
      }

      try {
        if (getDialog()) {
          // Hold the outgoing post on screen while the next one loads —
          // awaited so the snapshot is painted before the modal closes
          if (immersiveOn) await raiseFreezeFrame();
          closeDialog();
          await waitForDialogClose();
          await delay(100);
        }

        let target = getAdjacentArticle(resolveCurrentArticle(), direction);

        if (!target && direction === 'next') {
          const beforeCodes = new Set(feedArticles().map(articleCode).filter(Boolean));
          const last = feedArticles().pop();
          if (last) {
            last.scrollIntoView({ behavior: 'smooth', block: 'start' });
            await delay(400);
            window.scrollBy(0, 800);
            await delay(300);
            window.scrollBy(0, 800);
          }
          target = await waitForNewArticle(beforeCodes);
          if (!target) {
            await reopenCurrent();
            return;
          }
        }

        if (!target) {
          await reopenCurrent();
          return;
        }

        currentArticle = target;
        currentCode = articleCode(target);
        const code = markSeen(target); // session number + seen flag
        pcPostNumber = code ? sessionNums.get(code) : pcPostNumber + (direction === 'next' ? 1 : -1);
        updateHud();

        await openArticle(currentArticle);
        // Reveal only once the incoming post's media is actually displayable
        await waitForDialogMedia();
      } finally {
        dropFreezeFrame();
        transitioning = false;
      }
    }

    // --- Like / Save (dialog-only scope, robust selection, verify+retry) ---
    // Main action-row icons are 24px; per-comment hearts are 12px. Fall back
    // to the largest rendered match in case Instagram changes the attribute.
    function findMainActionSvg(scope, selector) {
      const svgs = [...scope.querySelectorAll(selector)];
      return svgs.find(s => parseInt(s.getAttribute('height')) === 24) ||
        svgs.map(s => ({ s, w: s.getBoundingClientRect().width }))
            .filter(o => o.w > 0)
            .sort((a, b) => b.w - a.w)
            .map(o => o.s)[0] || null;
    }

    // Click the action, then verify the aria-label flipped within 800ms and
    // retry once if the click was swallowed. Dialog-only: document scope
    // would hit the WRONG post's button.
    function toggleAction(selector) {
      const dialog = getDialog();
      if (!dialog) return;
      const svg = findMainActionSvg(dialog, selector);
      if (!svg) return;
      const before = svg.getAttribute('aria-label');
      (svg.closest('button, [role="button"]') || svg.parentElement).click();
      setTimeout(() => {
        const d2 = getDialog();
        if (!d2) return;
        const now = findMainActionSvg(d2, selector);
        if (now && now.getAttribute('aria-label') === before) {
          (now.closest('button, [role="button"]') || now.parentElement).click();
        }
      }, 800);
    }

    function toggleLike() {
      toggleAction('svg[aria-label="Like"], svg[aria-label="Unlike"]');
    }

    function toggleSave() {
      // Saved-state label is "Remove" (verified live)
      toggleAction('svg[aria-label="Save"], svg[aria-label="Remove"]');
    }

    // Manual translate: click "See translation" ONCE in the open modal.
    // Deliberately NOT automatic and NOT on a timer. An earlier auto-version
    // clicked on a 500ms interval; because the label stays in the DOM while
    // the translation loads, it re-clicked mid-load, and the repeated hits to
    // Instagram's bulk_translate endpoint tripped server-side rate limiting
    // (confirmed live: HTTP 403 Forbidden). One click per keypress can't do
    // that. If Instagram still 403s, the translation is refused server-side
    // and nothing here can force it.
    function manualTranslate() {
      const d = getDialog();
      const scope = d && d.querySelector('article');
      if (!scope) return;
      for (const el of scope.querySelectorAll('span, div, button')) {
        if (el.children.length === 0 && /^see translation$/i.test((el.textContent || '').trim())) {
          (el.closest('[role="button"], button') || el).click();
          return;
        }
      }
    }

    // Open the current post's author profile in a new tab. The avatar image
    // ("<name>'s profile picture") anchors the exact author; the fallback
    // scans for the first username-shaped link, skipping app routes.
    const NON_PROFILE_ROUTES = ['p', 'reel', 'reels', 'explore', 'direct',
      'stories', 'accounts', 'about', 'legal'];
    function openAuthorProfile() {
      const dialog = getDialog();
      const scope = (dialog && dialog.querySelector('article')) || mostVisibleArticle();
      if (!scope) return;
      let username = null;
      const avatar = scope.querySelector('img[alt*="profile picture"]');
      const avatarLink = avatar && avatar.closest('a[href]');
      const fromHref = (a) => {
        const m = (a.getAttribute('href') || '').match(/^\/([a-zA-Z0-9._]+)\/?$/);
        return m && !NON_PROFILE_ROUTES.includes(m[1]) ? m[1] : null;
      };
      if (avatarLink) username = fromHref(avatarLink);
      if (!username) {
        for (const a of scope.querySelectorAll('a[href]')) {
          username = fromHref(a);
          if (username) break;
        }
      }
      if (username) window.open('https://www.instagram.com/' + username + '/', '_blank', 'noopener');
    }

    function galleryNavigate(direction) {
      const dialog = getDialog();
      if (!dialog) return;
      // Scope to the article: on profiles the dialog ALSO contains the
      // between-post arrows with the same labels — those belong to J/K.
      const scope = dialog.querySelector('article') || dialog;
      const sel = direction === 'forward'
        ? 'button[aria-label="Next"], svg[aria-label="Next"]'
        : 'button[aria-label="Go Back"], button[aria-label="Go back"], ' +
          'svg[aria-label="Go Back"], svg[aria-label="Go back"]';
      const el = scope.querySelector(sel);
      if (!el) return;
      const btn = el.tagName.toLowerCase() === 'svg'
        ? (el.closest('button, [role="button"]') || el.parentElement)
        : el;
      btn.click();
    }

    function markCommentsContainer() {
      var dialog = getDialog();
      if (!dialog) return;
      var article = dialog.querySelector('article');
      if (!article) return;
      var uls = article.querySelectorAll('ul');
      for (var i = 0; i < uls.length; i++) {
        var firstChild = uls[i].children[0];
        if (firstChild && firstChild.getAttribute('role') === 'button' && firstChild.querySelector('li')) {
          uls[i].setAttribute('data-igpc', 'comments-list');
          break;
        }
      }
    }

    function updateCommentsCSS() {
      if (commentsHidden) {
        commentsStyle.textContent =
          'div[role="dialog"] [data-igpc="comments-list"] > div:not(:first-child) { display: none !important; }' +
          'div[role="dialog"] [data-igpc="comments-list"] > ul { display: none !important; }' +
          'div[role="dialog"] article form { display: none !important; }';
      } else {
        commentsStyle.textContent = '';
      }
    }

    function toggleComments() {
      if (!getDialog()) return;
      commentsHidden = !commentsHidden;
      savePrefs();
      markCommentsContainer();
      updateCommentsCSS();
      updateTogglesPanel();
    }

    function togglePlayPause() {
      const dialog = getDialog();
      const scope = dialog || document;
      const video = scope.querySelector('video');
      if (!video) return;
      if (video.ended) {                       // replay from start
        delete video.dataset.igpcUserPaused;
        video.currentTime = 0;
        video.play();
      } else if (video.paused) {
        delete video.dataset.igpcUserPaused;   // explicit play clears the hold
        video.play();
      } else {
        video.dataset.igpcUserPaused = '1';    // sticky until the user plays
        video.pause();
      }
    }

    function toggleMute() {
      isMuted = !isMuted;
      savePrefs();
      const dialog = getDialog();
      const scope = dialog || document;
      scope.querySelectorAll('video').forEach(v => { v.muted = isMuted; });
      updateTogglesPanel();
    }

    // --- Activate / Deactivate ---
    async function activate() {
      pcActive = true;
      // Capture the underlying page name BEFORE opening a modal changes the URL
      curtainLabelText = computeCurtainLabel();
      prompt.innerHTML = `Press <b>${KEY_ACTIVATE.toUpperCase()}</b> to leave PC mode`;
      applyControlsVisibility(); // shows panels (or the hide-hint) per pref
      updateTogglesPanel();
      updateCommentsCSS(); // apply the default comments state immediately
      updateCurtain();     // raise the immersive curtain + counter visibility

      markerInterval = setInterval(markCommentsContainer, 500);
      pcPostNumber = 1;

      // A post modal is already open (feed or profile) — adopt it as-is.
      if (getDialog()) {
        adoptCurrentDialog();
        return;
      }

      currentArticle = findNearestArticle();
      currentCode = articleCode(currentArticle);

      if (currentArticle) {
        // Feed: open the nearest post's modal
        const code = markSeen(currentArticle);
        if (code) pcPostNumber = sessionNums.get(code);
        updateHud();

        transitioning = true;
        await openArticle(currentArticle);
        transitioning = false;
      } else {
        // Profile page: no <article> elements, just a tile grid — open the
        // first post to start, then J/K ride the native modal arrows.
        const tile = document.querySelector('main a[href*="/p/"], main a[href*="/reel/"]');
        if (tile) {
          transitioning = true;
          tile.click();
          await waitForDialog();
          adoptCurrentDialog();
          transitioning = false;
        }
      }
    }

    function deactivate() {
      pcActive = false;
      if (markerInterval) { clearInterval(markerInterval); markerInterval = null; }
      prompt.innerHTML = `Press <b>${KEY_ACTIVATE.toUpperCase()}</b> for PC mode`;
      prompt.style.display = '';
      applyControlsVisibility();             // pcActive false -> hides all panels + hint
      // Preferences persist — only the visual side-effects are withdrawn.
      commentsStyle.textContent = '';        // never leave hide-rules active outside PC mode
      updateCurtain();                       // pcActive is false -> curtain + counter drop
      updateHud(); // restore feed HUD
      closeDialog();
    }

    // --- Detect dialog closed externally (with grace period: React
    // re-renders can blink the dialog out for a frame) ---
    let dialogGoneTimer = null;
    const dialogObserver = new MutationObserver(() => {
      if (pcActive && !transitioning && !getDialog()) {
        if (!dialogGoneTimer) {
          dialogGoneTimer = setTimeout(() => {
            dialogGoneTimer = null;
            if (pcActive && !transitioning && !getDialog()) deactivate();
          }, 600);
        }
      } else if (dialogGoneTimer && getDialog()) {
        clearTimeout(dialogGoneTimer);
        dialogGoneTimer = null;
      }
    });
    dialogObserver.observe(document.body, { childList: true, subtree: true });

    // --- Keyboard handler ---
    // Assigned into the document-start shell above, so it runs before every
    // Instagram handler regardless of where they register.

    // Which key events belong to PC mode (used to eat keypress/keyup too)
    const OWNED_KEYS = [KEY_NEXT, KEY_PREV, KEY_LIKE, KEY_SAVE, KEY_GALLERY_BACK,
      KEY_GALLERY_FWD, KEY_COMMENTS, KEY_PLAYPAUSE, KEY_MUTE, KEY_IMMERSIVE,
      KEY_PROFILE, KEY_TRANSLATE, KEY_HIDE];
    pcKeySwallow = (e) => {
      const tag = e.target.tagName ? e.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return false;
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      const k = e.key.toLowerCase();
      if (k === KEY_ACTIVATE) return true;
      if (!pcActive) return false;
      return e.key === 'Escape' || OWNED_KEYS.includes(k);
    };

    pcKeyHandler = (e) => {
      const tag = e.target.tagName ? e.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const keyLower = e.key.toLowerCase();

      if (keyLower === KEY_ACTIVATE) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (pcActive) deactivate(); else activate();
        return;
      }

      if (!pcActive) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }

      if (keyLower === KEY_NEXT) {
        e.preventDefault(); e.stopImmediatePropagation();
        navigate('next');
      } else if (keyLower === KEY_PREV) {
        e.preventDefault(); e.stopImmediatePropagation();
        navigate('prev');
      } else if (keyLower === KEY_LIKE) {
        e.preventDefault(); e.stopImmediatePropagation();
        toggleLike();
      } else if (keyLower === KEY_SAVE) {
        e.preventDefault(); e.stopImmediatePropagation();
        toggleSave();
      } else if (keyLower === KEY_GALLERY_FWD) {
        e.preventDefault(); e.stopImmediatePropagation();
        galleryNavigate('forward');
      } else if (keyLower === KEY_GALLERY_BACK) {
        e.preventDefault(); e.stopImmediatePropagation();
        galleryNavigate('backward');
      } else if (keyLower === KEY_COMMENTS) {
        e.preventDefault(); e.stopImmediatePropagation();
        toggleComments();
      } else if (keyLower === KEY_PLAYPAUSE) {
        e.preventDefault(); e.stopImmediatePropagation();
        togglePlayPause();
      } else if (keyLower === KEY_MUTE) {
        e.preventDefault(); e.stopImmediatePropagation();
        toggleMute();
      } else if (keyLower === KEY_IMMERSIVE) {
        e.preventDefault(); e.stopImmediatePropagation();
        toggleImmersive();
      } else if (keyLower === KEY_PROFILE) {
        e.preventDefault(); e.stopImmediatePropagation();
        openAuthorProfile();
      } else if (keyLower === KEY_TRANSLATE) {
        e.preventDefault(); e.stopImmediatePropagation();
        manualTranslate();
      } else if (keyLower === KEY_HIDE) {
        e.preventDefault(); e.stopImmediatePropagation();
        toggleHideControls();
      }
    };
  }

  // ============================================================
  // BOOT
  // ============================================================
  function init() {
    document.head.appendChild(commentsStyle);

    // Debounced: Instagram mutates the DOM constantly (and so do our own
    // badge/HUD writes) — coalesce bursts into one sweep 150ms later instead
    // of running full querySelectorAll scans on every mutation record.
    let mutationTimer = null;
    const observer = new MutationObserver(() => {
      if (mutationTimer) return;
      mutationTimer = setTimeout(() => {
        mutationTimer = null;
        document.querySelectorAll('video').forEach(createProgressBar);
        watchArticles();
      }, 150);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll('video').forEach(createProgressBar);
    watchArticles();
    updateHud();
    initPcMode();
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
