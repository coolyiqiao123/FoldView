(function () {
  'use strict';

  var root = document.documentElement;
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia && matchMedia('(pointer: fine)').matches;

  /* ————————————————————————————————————————
     Copy-to-clipboard pills + live status
  ———————————————————————————————————————— */
  var status = document.getElementById('copyStatus');
  var statusTimer = 0;
  function announce(message) {
    if (!status) return;
    window.clearTimeout(statusTimer);
    status.textContent = message;
    status.classList.add('visible');
    statusTimer = window.setTimeout(function () { status.classList.remove('visible'); }, 3200);
  }
  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var field = document.createElement('textarea');
      field.value = text;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      try {
        if (document.execCommand && document.execCommand('copy')) resolve();
        else reject(new Error('copy unavailable'));
      } catch (error) { reject(error); }
      field.remove();
    });
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  }
  document.querySelectorAll('[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () {
      copyText(button.dataset.copy).then(function () {
        button.classList.add('copied');
        announce('Install command copied');
        window.setTimeout(function () { button.classList.remove('copied'); }, 1800);
      }).catch(function () {
        button.classList.add('animate-shake');
        button.addEventListener('animationend', function () { button.classList.remove('animate-shake'); }, { once: true });
        announce('Could not copy — select the command manually');
      });
    });
  });

  /* ————————————————————————————————————————
     Mobile menu
  ———————————————————————————————————————— */
  var menuButton = document.getElementById('menuButton');
  var menu = document.getElementById('primaryNav');
  function closeMenu(returnFocus) {
    if (!menuButton || !menu) return;
    menu.classList.remove('open');
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.setAttribute('aria-label', 'Open menu');
    if (returnFocus) menuButton.focus();
  }
  if (menuButton && menu) {
    menuButton.addEventListener('click', function () {
      var open = !menu.classList.contains('open');
      menu.classList.toggle('open', open);
      menuButton.setAttribute('aria-expanded', String(open));
      menuButton.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    });
    menu.addEventListener('click', function (event) {
      if (event.target.closest('a')) closeMenu(false);
    });
    document.addEventListener('click', function (event) {
      if (menu.classList.contains('open') && !event.target.closest('.site-nav')) closeMenu(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && menu.classList.contains('open')) closeMenu(true);
    });
  }

  /* ————————————————————————————————————————
     Manifesto modal
  ———————————————————————————————————————— */
  var modal = document.getElementById('manifestoModal');
  var modalOpenButton = document.getElementById('manifestoButton');
  var modalCloseButton = document.getElementById('manifestoClose');
  var lastFocus = null;
  function openModal() {
    if (!modal) return;
    lastFocus = document.activeElement;
    modal.hidden = false;
    requestAnimationFrame(function () { modal.classList.add('open'); });
    document.body.classList.add('no-scroll');
    if (modalCloseButton) modalCloseButton.focus();
  }
  function closeModal() {
    if (!modal || modal.hidden) return;
    modal.classList.remove('open');
    document.body.classList.remove('no-scroll');
    var finish = function () { modal.hidden = true; };
    if (reduce) finish(); else window.setTimeout(finish, 220);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  if (modal) {
    if (modalOpenButton) modalOpenButton.addEventListener('click', openModal);
    if (modalCloseButton) modalCloseButton.addEventListener('click', closeModal);
    modal.addEventListener('click', function (event) {
      if (event.target === modal) closeModal();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !modal.hidden) closeModal();
    });
  }

  /* ————————————————————————————————————————
     Cursor-tracking sheen for liquid glass
  ———————————————————————————————————————— */
  if (finePointer) {
    document.addEventListener('mousemove', function (event) {
      var el = event.target && event.target.closest ? event.target.closest('.liquid-glass, .glass-panel') : null;
      if (!el) return;
      var rect = el.getBoundingClientRect();
      el.style.setProperty('--mx', (event.clientX - rect.left) + 'px');
      el.style.setProperty('--my', (event.clientY - rect.top) + 'px');
    }, { passive: true });
  }

  /* ————————————————————————————————————————
     Scroll reveals
  ———————————————————————————————————————— */
  var revealTargets = document.querySelectorAll('.reveal');
  if (!reduce && 'IntersectionObserver' in window) {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -5%' });
    revealTargets.forEach(function (el) { revealObserver.observe(el); });
  } else {
    revealTargets.forEach(function (el) { el.classList.add('in'); });
  }

  /* ————————————————————————————————————————
     AI tiling demo (1 → 2 halves → 3 columns → 2×2)
  ———————————————————————————————————————— */
  var tilingStage = document.getElementById('tilingStage');
  var tilingLabel = document.getElementById('tilingLabel');
  if (tilingStage && !reduce && 'IntersectionObserver' in window) {
    var tilingCounts = [1, 2, 3, 4];
    var tilingIndex = 3;
    var tilingTimer = 0;
    var stepTiling = function () {
      tilingIndex = (tilingIndex + 1) % tilingCounts.length;
      var count = tilingCounts[tilingIndex];
      tilingStage.dataset.count = String(count);
      if (tilingLabel) tilingLabel.textContent = 'pm ai · ' + count + (count === 1 ? ' window' : ' windows');
    };
    new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        window.clearInterval(tilingTimer);
        if (entry.isIntersecting) tilingTimer = window.setInterval(stepTiling, 1900);
      });
    }, { threshold: 0.3 }).observe(tilingStage);
  }

  /* ————————————————————————————————————————
     Galaxy backdrop — the projects-in-orbit canvas
  ———————————————————————————————————————— */
  var galaxyDim = null;
  (function galaxy() {
    var canvas = document.getElementById('galaxy');
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    var dpr, w, h, cx, cy;
    var stars = [];
    var raf = 0, last = 0, running = false, resizeTimer = 0;
    var dim = 1;
    var TILT = -0.22, COST = Math.cos(TILT), SINT = Math.sin(TILT), SQUASH = 0.44;

    function sprite(size, color) {
      var c = document.createElement('canvas');
      c.width = c.height = size;
      var g = c.getContext('2d');
      var grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, color);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
      return c;
    }
    var dotSprite = sprite(10, 'rgba(255,255,255,1)');
    var glowSprite = sprite(34, 'rgba(196,218,255,1)');

    function build() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = w / 2;
      cy = h * 0.44;
      var count = Math.max(240, Math.min(820, Math.round(w * h / 2600)));
      var maxR = Math.max(w, 560) * 0.55;
      var minR = Math.min(w, h) * 0.1;
      stars = [];
      for (var i = 0; i < count; i++) {
        var f = Math.pow(Math.random(), 0.62);
        var r = minR + f * (maxR - minR);
        var roll = Math.random();
        var a0 = roll < 0.72
          ? (roll < 0.36 ? 0 : Math.PI) + r * 0.0022 + (Math.random() - 0.5) * 0.85
          : Math.random() * Math.PI * 2;
        stars.push({
          r: r,
          a: a0,
          v: (0.00008 + 0.01 / (r + 40)) * (0.75 + Math.random() * 0.5),
          s: Math.random() < 0.18 ? 2.6 : 1.6 + Math.random() * 0.9,
          b: 0.25 + Math.random() * 0.5,
          tw: 0.0004 + Math.random() * 0.0012,
          ph: Math.random() * Math.PI * 2,
          hue: Math.random() < 0.12 ? 175 + Math.random() * 165 : -1,
          g: Math.random() < 0.045
        });
      }
    }

    function draw(now) {
      var dt = last ? Math.min(now - last, 50) : 16;
      last = now;
      ctx.clearRect(0, 0, w, h);
      var glowR = Math.min(w, h) * 0.4;
      var grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
      grad.addColorStop(0, 'rgba(255,255,255,' + (0.05 * dim).toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(cx - glowR, cy - glowR, glowR * 2, glowR * 2);
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < stars.length; i++) {
        var st = stars[i];
        st.a += st.v * dt;
        var ox = Math.cos(st.a) * st.r;
        var oy = Math.sin(st.a) * st.r * SQUASH;
        var x = cx + ox * COST - oy * SINT;
        var y = cy + ox * SINT + oy * COST;
        var alpha = st.b * (0.55 + 0.45 * Math.sin(now * st.tw + st.ph)) * dim;
        if (alpha <= 0.012) continue;
        if (st.hue >= 0) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = 'hsla(' + st.hue.toFixed(0) + ', 70%, 75%, ' + alpha.toFixed(3) + ')';
          ctx.fillRect(x, y, 1.6, 1.6);
        } else {
          ctx.globalAlpha = alpha;
          var sp = st.g ? glowSprite : dotSprite;
          var sz = st.g ? st.s * 6 : st.s * 2.4;
          ctx.drawImage(sp, x - sz / 2, y - sz / 2, sz, sz);
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    function loop(now) {
      draw(now);
      raf = requestAnimationFrame(loop);
    }
    function start() {
      if (running) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(loop);
    }
    function stop() {
      running = false;
      cancelAnimationFrame(raf);
    }

    build();
    canvas.classList.add('on');
    if (reduce) {
      draw(0);
    } else {
      start();
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) stop(); else start();
      });
    }
    window.addEventListener('resize', function () {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(function () {
        build();
        if (reduce) draw(0);
      }, 160);
    });

    galaxyDim = function (value) {
      if (value === dim) return;
      dim = value;
      if (reduce) draw(0);
    };
  })();

  /* ————————————————————————————————————————
     Hero pointer parallax
  ———————————————————————————————————————— */
  if (!reduce && finePointer) {
    var heroInner = document.getElementById('heroParallax');
    if (heroInner) {
      var parallaxRaf = 0;
      window.addEventListener('mousemove', function (event) {
        cancelAnimationFrame(parallaxRaf);
        parallaxRaf = requestAnimationFrame(function () {
          var x = (event.clientX / window.innerWidth - 0.5) * 14;
          var y = (event.clientY / window.innerHeight - 0.5) * 10;
          heroInner.style.transform = 'translate3d(' + x.toFixed(1) + 'px, ' + y.toFixed(1) + 'px, 0)';
        });
      }, { passive: true });
    }
  }

  /* ————————————————————————————————————————
     Dashboard tabs (Launch ⇥ AI Swarm)
  ———————————————————————————————————————— */
  var dashTabs = Array.prototype.slice.call(document.querySelectorAll('.dash-tab'));
  function selectDashTab(tab) {
    dashTabs.forEach(function (t) {
      var active = t === tab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
      var panel = document.getElementById(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !active;
    });
  }
  dashTabs.forEach(function (tab, index) {
    tab.addEventListener('click', function () { selectDashTab(tab); });
    tab.addEventListener('keydown', function (event) {
      var move = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!move) return;
      event.preventDefault();
      var next = dashTabs[(index + move + dashTabs.length) % dashTabs.length];
      next.focus();
      selectDashTab(next);
    });
  });

  /* ————————————————————————————————————————
     Launch rows — selectable projects, typed detail pane
  ———————————————————————————————————————— */
  var launchRows = Array.prototype.slice.call(document.querySelectorAll('#panelLaunch .dash-row'));
  var detailTyped = document.getElementById('detailTyped');
  var typeTimer = 0;

  function detailTokens(row) {
    var port = row.dataset.port;
    return [
      { tag: 'strong' },
      { text: row.dataset.name },
      { tag: 'code' },
      { text: row.dataset.path },
      { tag: 'p' },
      { cls: port ? 'live' : 'idle', text: port ? '● localhost:' + port : '○ not running' },
      { text: port ? ' · ↵ opens' : ' · l starts the dev command' },
      { tag: 'p', cls: 'dash-meta' },
      { text: 'Git · ' + row.dataset.git },
      { br: true },
      { text: 'Files · ' + row.dataset.files },
      { br: true },
      { text: 'Model · ' + row.dataset.model },
      { br: true },
      { text: 'Effort · ' + row.dataset.effort }
    ];
  }

  function paintDetail(tokens, shown, typing) {
    if (!detailTyped) return;
    var frag = document.createDocumentFragment();
    var node = null;
    var left = shown;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.tag) {
        node = document.createElement(t.tag);
        if (t.cls) node.className = t.cls;
        frag.appendChild(node);
      } else if (t.br) {
        if (node && left > 0) node.appendChild(document.createElement('br'));
      } else if (t.text) {
        if (left <= 0) break;
        var slice = t.text.slice(0, left);
        left -= t.text.length;
        var span = document.createElement('span');
        if (t.cls) span.className = t.cls;
        span.textContent = slice;
        if (node) node.appendChild(span);
      }
    }
    if (typing) {
      var caret = document.createElement('span');
      caret.className = 'type-caret';
      caret.textContent = '▍';
      (node || frag).appendChild(caret);
    }
    detailTyped.replaceChildren(frag);
  }

  function selectProject(row) {
    launchRows.forEach(function (r) { r.classList.toggle('selected', r === row); });
    var tokens = detailTokens(row);
    window.clearInterval(typeTimer);
    var total = tokens.reduce(function (n, t) { return n + (t.text ? t.text.length : 0); }, 0);
    if (reduce) { paintDetail(tokens, total, false); return; }
    var shown = 0;
    paintDetail(tokens, 0, true);
    typeTimer = window.setInterval(function () {
      shown += 2;
      if (shown >= total) {
        window.clearInterval(typeTimer);
        paintDetail(tokens, total, false);
      } else {
        paintDetail(tokens, shown, true);
      }
    }, 18);
  }

  launchRows.forEach(function (row, index) {
    row.addEventListener('click', function () { selectProject(row); });
    row.addEventListener('keydown', function (event) {
      var move = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (!move) return;
      event.preventDefault();
      var next = launchRows[(index + move + launchRows.length) % launchRows.length];
      next.focus();
      selectProject(next);
    });
  });

  /* ————————————————————————————————————————
     Auto-demo — cycle rows while in view, yield to the visitor
  ———————————————————————————————————————— */
  var dashWindow = document.getElementById('dashWindow');
  if (dashWindow && launchRows.length && !reduce && 'IntersectionObserver' in window) {
    var autoTimer = 0;
    var autoStopped = false;
    var stopAuto = function () {
      autoStopped = true;
      window.clearInterval(autoTimer);
    };
    dashWindow.addEventListener('pointerdown', stopAuto);
    dashWindow.addEventListener('keydown', stopAuto);
    new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        window.clearInterval(autoTimer);
        if (autoStopped || !entry.isIntersecting) return;
        autoTimer = window.setInterval(function () {
          var current = launchRows.findIndex(function (r) { return r.classList.contains('selected'); });
          var next = launchRows[(current + 1) % launchRows.length];
          selectProject(next);
        }, 2800);
      });
    }, { threshold: 0.4 }).observe(dashWindow);
  }

  /* ————————————————————————————————————————
     Scroll pipeline: nav glass, galaxy dim, scroll scenes
  ———————————————————————————————————————— */
  function clamp(value, minimum, maximum) { return Math.min(Math.max(value, minimum), maximum); }
  function lerp(from, to, progress) { return from + (to - from) * progress; }
  var nav = document.getElementById('siteNav');
  var ticking = false;

  function updateScenes() {
    ticking = false;
    var viewport = window.innerHeight || document.documentElement.clientHeight;
    var scrollTop = window.scrollY || window.pageYOffset || 0;
    if (nav) nav.classList.toggle('scrolled', scrollTop > 24);
    if (galaxyDim) galaxyDim(clamp(1 - (scrollTop / (viewport * 1.35)) * 0.7, 0.3, 1));
    if (reduce) return;

    var phoneSection = document.querySelector('.phone-scroll');
    var phone = document.getElementById('phoneFrame');
    if (phoneSection && phone) {
      var phoneRect = phoneSection.getBoundingClientRect();
      var phoneTravel = Math.max(1, phoneRect.height - viewport);
      var phoneProgress = clamp(-phoneRect.top / phoneTravel, 0, 1);
      phone.style.transform = 'translateY(' + lerp(48, -24, phoneProgress).toFixed(1) + 'px) rotate(' + lerp(4, -2, phoneProgress).toFixed(1) + 'deg)';
    }
  }

  function scheduleScenes() {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(updateScenes);
    }
  }
  window.addEventListener('scroll', scheduleScenes, { passive: true });
  window.addEventListener('resize', scheduleScenes);
  updateScenes();
})();
