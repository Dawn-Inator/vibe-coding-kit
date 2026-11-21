/* Kit-authored presenter. MIT. One owned clock for steps, boundaries and ambience. */
(() => {
  'use strict';
  const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
  const mix = (a, b, p) => a + (b - a) * p;
  const ease = p => p * p * (3 - 2 * p);
  const color = (a, b, p) => {
    if (!/^#[\da-f]{6}$/i.test(a || '') || !/^#[\da-f]{6}$/i.test(b || '')) return p < .5 ? a : b;
    return '#' + [1, 3, 5].map(i => Math.round(mix(parseInt(a.slice(i, i + 2), 16), parseInt(b.slice(i, i + 2), 16), p)).toString(16).padStart(2, '0')).join('');
  };
  function blendTheme(a, b, p) {
    const result = {...a, ...b};
    for (const name of ['level', 'cameraX']) result[name] = mix(a[name] ?? b[name] ?? 0, b[name] ?? a[name] ?? 0, p);
    result.light = [0, 1].map(i => mix(a.light?.[i] ?? .8, b.light?.[i] ?? .8, p));
    result.tint = color(a.tint || '#74b7e3', b.tint || '#74b7e3', p);
    const old = new Map((a.objects || []).map(item => [item.id, item]));
    result.objects = (b.objects || []).map(item => {
      const prior = old.get(item.id);
      if (!prior || prior.kind !== item.kind) return {...item, reveal: (item.reveal ?? 1) * p};
      old.delete(item.id);
      const next = {...item};
      for (const key of ['x', 'y', 'radius', 'rotation', 'reveal']) next[key] = mix(prior[key] ?? (key === 'reveal' ? 1 : 0), item[key] ?? (key === 'reveal' ? 1 : 0), p);
      next.color = color(prior.color || '#74b7e3', item.color || '#74b7e3', p);
      return next;
    });
    for (const item of old.values()) result.objects.push({...item, reveal: (item.reveal ?? 1) * (1 - p)});
    return result;
  }

  window.createPresenter = function createPresenter({stage, sceneDefinitions, theme = null}) {
    if (!stage) throw new Error('Presenter requires an artwork stage');
    const sections = [...stage.querySelectorAll('section[data-scene]')];
    if (!sections.length) throw new Error('Presenter requires at least one scene');
    const keys = new Set();
    const scenes = sections.map(section => {
      const key = section.dataset.scene;
      if (keys.has(key)) throw new Error(`Duplicate scene key: ${key}`);
      keys.add(key);
      const factory = sceneDefinitions[key];
      if (typeof factory !== 'function') throw new Error(`Missing scene factory: ${key}`);
      const scene = factory(section);
      if (!scene?.steps?.length || scene.steps.some(step => typeof step.render !== 'function')) throw new Error(`Scene ${key} requires progress renderers`);
      return scene;
    });
    let media = matchMedia('(prefers-reduced-motion: reduce)');
    const query = new URLSearchParams(location.search);
    const reduced = () => media.matches || query.get('reduce') === '1';
    const listeners = new Set();
    let page = 0, step = 0, progress = 0, phase = 'scene', paused = true;
    let running = false, frame = 0, generation = 0, mark = null, base = 0;
    let ambientTime = 0, lastTime = null, boundary = null, exportFrozen = false, disposed = false;
    let resumeAfterHidden = false;
    const pageIndex = i => Math.max(0, Math.min(sections.length - 1, Math.trunc(Number(i) || 0)));
    const stepIndex = (i, n) => Math.max(0, Math.min(scenes[i].steps.length - 1, Math.trunc(Number(n) || 0)));
    const duration = () => Math.max(1, scenes[page].steps[step].durationMs || 900);
    function state() {
      return {currentPage: page, targetPage: page, totalPages: sections.length, sceneKey: sections[page].dataset.scene,
        step, stepCount: scenes[page].steps.length, progress, durationMs: phase === 'transition' ? boundary.duration : duration(),
        phase, transitionProgress: boundary?.progress ?? null, paused, playing: running && !paused,
        ambientTimeMs: ambientTime, reducedMotion: reduced(), exportFrozen, theme: theme?.getState?.() ?? null};
    }
    function emit() { for (const callback of listeners) callback(state()); }
    function cancel() {
      generation++;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      mark = lastTime = null;
    }
    function resetLayers() {
      sections.forEach(section => {
        for (const property of ['opacity', 'visibility', 'transform', 'clipPath', 'zIndex']) section.style[property] = '';
      });
    }
    function select(i, n) {
      const focus = document.activeElement;
      if (focus && sections.some(section => section.contains(focus))) focus.blur();
      page = pageIndex(i); step = stepIndex(page, n);
      sections.forEach((section, index) => {
        const active = index === page;
        section.classList.toggle('active', active);
        section.setAttribute('aria-hidden', String(!active));
        section.inert = !active;
      });
    }
    function sceneTheme(i = page, n = step, p = progress) {
      const scene = scenes[i];
      return {...scene.theme, ...scene.getTheme?.({step: n, progress: p, timeMs: ambientTime})};
    }
    function paintTheme(config) { theme?.render({...config, timeMs: ambientTime}); }
    function paint() {
      if (phase === 'transition' && boundary) {
        const q = ease(boundary.progress);
        const incoming = sections[page], outgoing = sections[boundary.from];
        const incomingProgress = boundary.settled ? 1 : q * .18;
        scenes[page].steps[step].render(incomingProgress);
        outgoing.style.visibility = 'visible'; outgoing.style.zIndex = '1';
        outgoing.style.opacity = '1';
        incoming.style.visibility = 'visible'; incoming.style.zIndex = '2';
        incoming.style.opacity = '1';
        // Complementary masks keep the transparent content layers from
        // superimposing text while the shared scenery remains continuous.
        if (boundary.axis === 'vertical') {
          incoming.style.clipPath = boundary.direction > 0 ? `inset(0 0 ${100 * (1 - q)}% 0)` : `inset(${100 * (1 - q)}% 0 0 0)`;
          outgoing.style.clipPath = boundary.direction > 0 ? `inset(${100 * q}% 0 0 0)` : `inset(0 0 ${100 * q}% 0)`;
        } else {
          incoming.style.clipPath = boundary.direction > 0 ? `inset(0 ${100 * (1 - q)}% 0 0)` : `inset(0 0 0 ${100 * (1 - q)}%)`;
          outgoing.style.clipPath = boundary.direction > 0 ? `inset(0 0 0 ${100 * q}%)` : `inset(0 ${100 * q}% 0 0)`;
        }
        paintTheme(blendTheme(boundary.themeFrom, sceneTheme(page, step, incomingProgress), q));
      } else {
        scenes[page].steps[step].render(progress);
        paintTheme(sceneTheme());
      }
    }
    function wake() {
      if (disposed || paused || document.hidden || reduced() || exportFrozen || frame) return;
      if (!running && !theme) return;
      const token = generation;
      frame = requestAnimationFrame(now => tick(now, token));
    }
    function tick(now, token) {
      if (token !== generation || disposed) return;
      frame = 0;
      if (reduced()) { onReduced(); return; }
      if (paused || document.hidden || exportFrozen) return;
      if (lastTime !== null) ambientTime += Math.max(0, now - lastTime);
      lastTime = now;
      if (running) {
        if (mark === null) mark = now;
        const milliseconds = phase === 'transition' ? boundary.duration : duration();
        const p = clamp(base + (now - mark) / milliseconds);
        if (phase === 'transition') {
          boundary.progress = p;
          paint();
          if (p >= 1) {
            const settled = boundary.settled;
            phase = 'scene'; boundary = null; resetLayers();
            progress = settled ? 1 : .18;
            running = !settled;
            base = progress; mark = now;
            paint();
          }
        } else {
          progress = p; paint();
          if (p >= 1) { progress = 1; running = false; mark = null; paint(); }
        }
        emit();
      } else paintTheme(sceneTheme());
      wake();
    }
    function settleBoundary() {
      if (phase !== 'transition') return;
      phase = 'scene'; boundary = null; resetLayers();
      progress = 1; running = false;
      paint();
    }
    function instant(i, n, p = 0, freeze = true, resetTime = true) {
      cancel(); resetLayers(); boundary = null; phase = 'scene';
      select(i, n); progress = clamp(p); running = false; paused = freeze;
      exportFrozen = false;
      if (resetTime) ambientTime = 0;
      paint(); emit(); if (!freeze) wake();
      return state();
    }
    function play() {
      if (disposed) return state();
      cancel(); exportFrozen = false;
      if (reduced()) { settleBoundary(); progress = 1; running = false; paused = true; paint(); emit(); return state(); }
      if (phase === 'scene' && progress >= 1) progress = 0;
      base = phase === 'transition' ? boundary.progress : progress;
      paused = false; running = true; paint(); emit(); wake();
      return state();
    }
    function pause() { cancel(); paused = true; emit(); return state(); }
    function goto(i, options = {}) {
      const target = pageIndex(i), targetStep = stepIndex(target, options.step ?? 0);
      if (target === page && options.step === undefined) return state();
      cancel(); settleBoundary(); exportFrozen = false;
      if (target === page) return options.settled ? instant(target, targetStep, 1, reduced(), reduced()) : goStep(targetStep, options);
      const from = page, themeFrom = sceneTheme();
      scenes[from].steps[step].render(1);
      select(target, targetStep);
      if (reduced() || options.animate === false) return instant(target, targetStep, 1, true, reduced());
      progress = 0; phase = 'transition'; paused = false; running = true; base = 0;
      boundary = {from, direction: target > from ? 1 : -1, progress: 0, duration: scenes[target].transitionMs || 760,
        settled: options.settled === true, axis: scenes[target].transitionAxis || scenes[from].transitionAxis || 'horizontal', themeFrom};
      paint(); emit(); wake(); return state();
    }
    function goStep(n, options = {}) {
      const target = stepIndex(page, n);
      instant(page, target, options.animate === false || reduced() ? 1 : 0, true, reduced());
      if (options.animate !== false && !reduced()) play();
      return state();
    }
    function nextStep() {
      cancel(); settleBoundary();
      if (step < scenes[page].steps.length - 1) return goStep(step + 1);
      if (page < sections.length - 1) return goto(page + 1);
      return instant(page, step, 1, reduced(), false);
    }
    function prevStep() {
      cancel(); settleBoundary();
      if (step > 0) return instant(page, step - 1, 1, reduced(), false);
      if (page > 0) return goto(page - 1, {step: scenes[page - 1].steps.length - 1, settled: true});
      return instant(0, 0, 1, reduced(), false);
    }
    function nextPage() { return page < sections.length - 1 ? goto(page + 1) : state(); }
    function prevPage() { return page > 0 ? goto(page - 1, {step: scenes[page - 1].steps.length - 1, settled: true}) : state(); }
    function seek(p) { return instant(page, step, clamp(p), true); }
    function replay() { instant(page, step, 0, true, false); return play(); }
    function refreshGeometry() {
      scenes.forEach(scene => scene.measure?.()); theme?.resize?.(); paint(); return state();
    }
    function onKey(event) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]') || event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
      if ((event.key === ' ' || event.key === 'Enter') && event.target.closest('button,a')) return;
      const handlers = {ArrowRight: nextStep, ArrowDown: nextStep, ' ': nextStep, ArrowLeft: prevStep, ArrowUp: prevStep,
        PageDown: nextPage, PageUp: prevPage,
        Home: () => goto(0, {step: 0}), End: () => goto(sections.length - 1, {step: scenes.at(-1).steps.length - 1, settled: true})};
      if (handlers[event.key]) { event.preventDefault(); handlers[event.key](); }
    }
    function onReduced() {
      if (!reduced()) return;
      cancel(); settleBoundary(); progress = 1; running = false; paused = true;
      ambientTime = 0; paint(); emit();
    }
    function bindReducedMedia() {
      if (disposed) return;
      media.removeEventListener('change', onReduced);
      media = matchMedia('(prefers-reduced-motion: reduce)');
      media.addEventListener('change', onReduced);
      if (reduced()) onReduced();
    }
    function onVisibility() {
      if (document.hidden) {
        resumeAfterHidden = !paused && !exportFrozen;
        if (running) base = phase === 'transition' ? boundary.progress : progress;
        cancel();
      } else if (resumeAfterHidden) { resumeAfterHidden = false; wake(); }
    }
    const proof = {show: (i, options = {}) => instant(i, options.step ?? 0, 0, true), goto,
      nextStep, prevStep, nextPage, prevPage, goStep, seek, play, pause, replay, refreshGeometry, getState: state,
      onChange(callback) { listeners.add(callback); callback(state()); return () => listeners.delete(callback); },
      dispose() {
        disposed = true; cancel(); listeners.clear(); theme?.dispose?.();
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('visibilitychange', onVisibility);
        media.removeEventListener('change', onReduced);
        document.removeEventListener('DOMContentLoaded', bindReducedMedia);
        removeEventListener('resize', refreshGeometry);
        if (window.renderSlide === exportSlide) delete window.renderSlide;
      }};
    async function exportSlide(i, options = {}) {
      if (options.exportMode) document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
      const target = pageIndex(i);
      const n = options.step === undefined ? scenes[target].steps.length - 1 : stepIndex(target, options.step);
      instant(target, n, 1, true);
      if (options.exportMode) {
        exportFrozen = true;
        document.body.classList.add('artwork');
        document.querySelectorAll('[data-presentation-controls]').forEach(el => { el.hidden = true; });
        dispatchEvent(new Event('resize'));
        refreshGeometry();
      }
      await new Promise(resolve => requestAnimationFrame(resolve));
      return state();
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibility);
    media.addEventListener('change', onReduced);
    // A presenter can mount during parsing, including document.setContent.
    // Subscribe against the completed document as well as the initial view.
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindReducedMedia, {once: true});
    addEventListener('resize', refreshGeometry);
    window.renderSlide = exportSlide;
    scenes.forEach(scene => scene.measure?.());
    theme?.resize?.();
    instant(0, 0, reduced() ? 1 : 0, true);
    refreshGeometry();
    document.fonts?.ready.then(() => { if (!disposed) refreshGeometry(); });
    if (!reduced()) play();
    return proof;
  };
})();
