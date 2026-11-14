import { css } from "lit";

/** Ordinary-chat task panel. Host-provided tokens remain the theme authority. */
export const taskPanelStyles = css`
  :host {
    --ctp-panel-glass: color-mix(in srgb, var(--ctp-surface, #fff) 94%, transparent);
    --ctp-panel-tint: color-mix(in srgb, var(--ctp-accent, #357353) 9%, var(--ctp-surface, #fff));
    --ctp-panel-ink: color-mix(in srgb, var(--ctp-accent, #357353) 65%, var(--ctp-text, #263b2b));
    --ctp-panel-fill: color-mix(in srgb, var(--ctp-accent, #357353) 72%, var(--ctp-surface, #fff));
    --ctp-panel-line: var(--ctp-border, #263b2b24);
    --ctp-panel-track: var(--ctp-track, color-mix(in srgb, var(--ctp-text, #263b2b) 12%, var(--ctp-surface, #fff)));
    --ctp-panel-ease: cubic-bezier(.16, 1, .3, 1);
    display: block;
    min-width: 0;
    color: var(--ctp-text, #263b2b);
    color-scheme: light dark;
    font: inherit;
    -webkit-font-smoothing: antialiased;
  }

  *, *::before, *::after { box-sizing: border-box; }
  [hidden] { display: none !important; }
  button, summary { font: inherit; color: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  button { border: 0; border-radius: 8px; padding: 6px 9px; background: transparent; }
  button:hover { background: var(--ctp-hover, #263b2b0a); }
  button:focus-visible, summary:focus-visible {
    outline: 2px solid var(--ctp-panel-ink);
    outline-offset: 3px;
  }
  button:disabled { cursor: default; opacity: .6; }
  svg {
    display: block;
    flex: none;
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.55;
    stroke-linecap: round;
    stroke-linejoin: round;
    pointer-events: none;
  }
  .panel { position: relative; width: 100%; min-width: 0; }
  .summary { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 44px; }
  .main, .orb {
    position: relative;
    border: 1px solid var(--ctp-panel-line);
    background: var(--ctp-panel-glass);
    box-shadow: 0 4px 14px -5px #17281e20, inset 0 1px 0 #ffffff0a;
    -webkit-backdrop-filter: blur(18px);
    backdrop-filter: blur(18px);
  }
  .main {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto 12px;
    flex: 1;
    align-items: center;
    gap: 10px;
    height: 44px;
    min-width: 0;
    border-radius: 999px;
    padding: 0 15px;
    text-align: start;
  }
  .main:hover, .orb:hover { background: var(--ctp-surface, #fff); }
  .main[aria-expanded="true"] {
    border-color: var(--ctp-panel-line);
    background: var(--ctp-surface, #fff);
  }
  .orb[aria-expanded="true"] {
    border-color: color-mix(in srgb, var(--ctp-panel-ink) 50%, var(--ctp-panel-line));
  }
  .main:focus:not(:focus-visible) { outline: none; }
  .main:active, .orb:active { transform: scale(.98); }
  .capsule-icon { color: var(--ctp-panel-ink); }
  .capsule-copy { display: block; min-width: 0; }
  .title { display: block; overflow: hidden; font-size: 12px; font-weight: 550; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }
  .summary-state { display: block; overflow: hidden; color: var(--ctp-muted, #626e65); font-size: 10px; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
  .summary-state .execution { color: inherit; }
  .percent { color: var(--ctp-panel-ink); font-size: 20px; font-weight: 500; line-height: 1; letter-spacing: -.7px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .percent small { margin-inline-start: 1px; font-size: 11px; letter-spacing: 0; }
  .capsule-chevron { width: 12px; height: 12px; color: var(--ctp-muted, #626e65); transition: transform 200ms var(--ctp-panel-ease); }
  .main[aria-expanded="true"] .capsule-chevron { transform: rotate(180deg); }
  .edge-progress { position: absolute; inset: -1px; width: calc(100% + 2px); height: 44px; overflow: visible; stroke-width: 3; }
  .edge-progress path { vector-effect: non-scaling-stroke; }
  .edge-track { stroke: var(--ctp-panel-track); }
  .edge-fill { stroke: var(--ctp-panel-fill); }
  .orb-wrap { position: relative; flex: none; }
  .orb { display: grid; flex: none; place-items: center; width: 40px; height: 40px; border-radius: 50%; padding: 0; color: var(--ctp-muted, #626e65); }
  .orb svg { width: 17px; height: 17px; }
  .orb[aria-expanded="true"] { color: var(--ctp-panel-ink); background: var(--ctp-panel-tint); }
  .heartbeat-mark { position: absolute; inset-block-start: 7px; inset-inline-end: 7px; width: 5px; height: 5px; border: 1px solid var(--ctp-surface, #fff); border-radius: 50%; background: var(--ctp-panel-ink); }
  .heartbeat-mark[data-status="none"], .heartbeat-mark[data-status="candidates"] { background: var(--ctp-muted, #626e65); }
  .heartbeat-mark[data-status="stale"], .heartbeat-mark[data-status="error"] { background: var(--ctp-error, #b15838); }
  .tooltip {
    position: absolute;
    z-index: 2;
    inset-block-start: calc(100% + 8px);
    inset-inline-start: 50%;
    border: 1px solid var(--ctp-panel-line);
    border-radius: 6px;
    padding: 5px 8px;
    background: var(--ctp-surface, #fff);
    color: var(--ctp-text, #263b2b);
    font-size: 10px;
    line-height: 1.4;
    white-space: nowrap;
    opacity: 0;
    transform: translateX(-50%);
    pointer-events: none;
  }
  .orb-wrap:hover .orb[aria-expanded="false"] + .tooltip, .orb:focus-visible + .tooltip { opacity: 1; }
  .body {
    position: absolute;
    z-index: 5;
    inset-block-start: 55px;
    inset-inline-start: 0;
    display: flex;
    flex-direction: column;
    width: 100%;
    max-height: var(--ctp-panel-max-height, min(496px, calc(100dvh - 80px)));
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--ctp-panel-line);
    border-radius: 20px;
    background: var(--ctp-panel-glass);
    box-shadow: 0 18px 55px -18px #17281e38, 0 4px 12px -5px #00000020, inset 0 1px 0 #ffffff0a;
    -webkit-backdrop-filter: blur(28px);
    backdrop-filter: blur(28px);
    transform-origin: top center;
    animation: ctp-panel-enter 200ms var(--ctp-panel-ease) both;
  }
  .body.compact {
    position: fixed;
    inset-block-start: var(--ctp-popover-top, 12px);
    inset-inline-start: auto;
    left: var(--ctp-popover-left, 12px);
    right: auto;
    width: var(--ctp-popover-width, calc(100vw - 24px));
    max-height: var(--ctp-popover-height, calc(100dvh - 24px));
  }
  .body[data-state="closing"], .body.is-leaving { animation: ctp-panel-leave 130ms ease-in both; pointer-events: none; }
  @keyframes ctp-panel-enter { from { opacity: 0; transform: translateY(-6px) scale(.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
  @keyframes ctp-panel-leave { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(-4px); } }
  .panel-head { flex: none; padding: 19px 20px 14px; }
  .panel-head[data-view="heartbeat"] { padding: 10px 16px 8px; }
  .panel-kicker { display: flex; align-items: center; gap: 7px; margin-bottom: 9px; color: var(--ctp-muted, #626e65); font-size: 10px; line-height: 1.4; }
  .panel-kicker svg { width: 12px; height: 12px; }
  .panel-heading { display: flex; align-items: center; gap: 8px; }
  .panel-head[data-view="heartbeat"] .panel-heading { gap: 8px; }
  .heartbeat-heading-icon { display: grid; flex: none; place-items: center; width: 21px; height: 21px; color: var(--ctp-panel-ink); }
  .heartbeat-heading-icon svg { width: 20px; height: 20px; }
  .panel-title { display: -webkit-box; min-width: 0; max-height: 2.8em; margin: 0; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; font-size: 17px; font-weight: 600; line-height: 1.4; letter-spacing: -.4px; overflow-wrap: anywhere; }
  .panel-head[data-view="heartbeat"] .panel-title { font-size: 16px; }
  .panel-title:focus { outline: none; }
  .close-panel { display: grid; flex: none; place-items: center; width: 26px; height: 26px; margin-inline-start: auto; border-radius: 50%; padding: 0; color: var(--ctp-muted, #626e65); }
  .close-panel svg { width: 14px; height: 14px; }
  .panel-subtitle { margin: 7px 0 0; color: var(--ctp-muted, #626e65); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
  .total-line { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin-top: 14px; color: var(--ctp-muted, #626e65); font-size: 10px; line-height: 1.5; }
  .total-line strong { color: var(--ctp-text, #263b2b); font-weight: 550; }
  .total-line .execution { margin-inline-start: auto; color: var(--ctp-panel-ink); }
  .track, .module-track { display: block; height: 3px; overflow: hidden; border-radius: 5px; background: var(--ctp-panel-track); }
  .track { margin-top: 9px; }
  .fill, .module-fill { display: block; height: 100%; border-radius: inherit; background: var(--ctp-panel-fill); transform-origin: left center; }
  .scroll { flex: 1 1 auto; min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; padding: 0 10px 10px; scrollbar-width: thin; scrollbar-color: var(--ctp-panel-line) transparent; }
  .scroll > .empty, .scroll > .diagnostic, .scroll > .heartbeat, .scroll > .error { margin-inline: 10px; }
  .scroll > button { margin: 7px 4px 0; border: 1px solid var(--ctp-panel-line); font-size: 11px; }
  .row { display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; margin: 0 0 8px; border: 1px solid var(--ctp-panel-line); border-radius: 999px; padding: 12px 14px; background: var(--ctp-panel-glass); text-align: start; }
  .row:hover, .row[aria-expanded="true"] { background: var(--ctp-hover, #263b2b0a); }
  .row:focus-visible { outline-offset: -2px; }
  .module-icon { display: grid; flex: none; place-items: center; width: 36px; height: 36px; border: 0; border-radius: 50%; background: var(--ctp-hover, #263b2b0a); color: var(--ctp-muted, #626e65); font-size: 10px; font-variant-numeric: tabular-nums; }
  .module-icon[data-status="active"], .module-icon[data-status="completed"] { background: var(--ctp-panel-tint); color: var(--ctp-panel-ink); }
  .module-icon svg { width: 15px; height: 15px; }
  .module-content { flex: 1; min-width: 0; }
  .module-title-line { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
  .name { min-width: 0; overflow: hidden; font-size: 12px; font-weight: 550; line-height: 1.5; text-overflow: ellipsis; white-space: nowrap; }
  .module-percent { flex: none; margin-inline-start: auto; color: var(--ctp-muted, #626e65); font-size: 10px; font-variant-numeric: tabular-nums; }
  .module-track { margin-top: 7px; }
  .module-meta { display: flex; align-items: center; gap: 8px; margin-top: 6px; color: var(--ctp-muted, #626e65); font-size: 10px; font-variant-numeric: tabular-nums; line-height: 1.4; }
  .module-meta .status { margin-inline-start: auto; }
  .module-arrow { width: 12px; height: 12px; color: var(--ctp-muted, #626e65); transition: transform 180ms var(--ctp-panel-ease); }
  .row[aria-expanded="true"] .module-arrow { transform: rotate(90deg); }
  .detail { min-width: 0; max-width: 100%; padding: 0 14px 9px 23px; overflow-wrap: anywhere; animation: ctp-nodes-enter 180ms var(--ctp-panel-ease) both; }
  .objective-detail-title { margin: 0 0 8px; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
  @keyframes ctp-nodes-enter { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }
  .check { position: relative; min-width: 0; padding: 10px 0 10px 29px; overflow-wrap: anywhere; }
  .check:not(:last-child)::before { position: absolute; inset-inline-start: 7px; inset-block: 26px -8px; width: 1px; background: var(--ctp-panel-line); content: ""; }
  .node-symbol { position: absolute; inset-inline-start: 0; inset-block-start: 12px; display: grid; place-items: center; width: 15px; height: 15px; border: 1px solid var(--ctp-panel-line); border-radius: 50%; background: var(--ctp-surface, #fff); color: var(--ctp-muted, #626e65); font-size: 10px; }
  .node-symbol svg { width: 10px; height: 10px; stroke-width: 1.8; }
  .node-symbol[data-status="completed"] { border-color: transparent; background: var(--ctp-panel-tint); color: var(--ctp-panel-ink); }
  .node-symbol[data-status="active"] { border-color: var(--ctp-panel-ink); color: var(--ctp-panel-ink); }
  .node-symbol[data-status="blocked"], .node-status[data-status="blocked"] { color: var(--ctp-error, #b15838); }
  .node-symbol[data-status="cancelled"] { border-style: dashed; }
  .node-head { display: flex; align-items: baseline; gap: 9px; }
  .node-title { min-width: 0; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
  .node-status { flex: none; margin-inline-start: auto; color: var(--ctp-muted, #626e65); font-size: 10px; line-height: 1.5; white-space: nowrap; }
  .evidence { min-width: 0; margin: 5px 0 0; color: var(--ctp-muted, #626e65); font-size: 11px; line-height: 1.7; overflow-wrap: anywhere; word-break: break-word; }
  .evidence strong { font-weight: 550; }
  .evidence svg { display: inline-block; width: 11px; height: 11px; margin-inline-end: 4px; vertical-align: -1px; color: var(--ctp-panel-ink); }
  .panel-foot { display: flex; flex: none; align-items: center; flex-wrap: wrap; gap: 6px; min-height: 38px; border-top: 1px solid var(--ctp-panel-line); padding: 10px 19px; color: var(--ctp-muted, #626e65); font-size: 10px; line-height: 1.4; }
  .panel-foot svg { width: 12px; height: 12px; color: var(--ctp-panel-ink); }
  .heartbeat { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--ctp-panel-line); }
  .heartbeat:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
  .hb-panel { display: grid; gap: 8px; margin: 0; padding: 0; border: 0; }
  .hb-panel details { margin-top: 0; }
  .hb-panel h3 { margin: 0; }
  .hb-status, .hb-count { display: inline-flex; flex: none; align-items: center; border-radius: 999px; padding: 3px 8px; background: var(--ctp-hover, #263b2b0a); color: var(--ctp-muted, #626e65); font-size: 10px; line-height: 1.35; }
  .panel-heading > .hb-status { margin-inline-start: auto; }
  .hb-status[data-status="ready"] { background: var(--ctp-panel-tint); color: var(--ctp-panel-ink); }
  .hb-status[data-status="stale"], .hb-status[data-status="error"] { background: color-mix(in srgb, var(--ctp-error, #b15838) 10%, var(--ctp-surface, #fff)); color: var(--ctp-error, #b15838); }
  .hb-time-card { border-radius: 14px; padding: 14px 13px 10px; background: var(--ctp-hover, #263b2b0a); }
  .hb-times { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .hb-time { min-width: 0; }
  .hb-time + .hb-time { border-inline-start: 1px solid var(--ctp-panel-line); padding-inline-start: 15px; }
  .hb-time-label { display: flex; align-items: center; gap: 7px; color: var(--ctp-muted, #626e65); font-size: 11px; line-height: 1.45; }
  .hb-time-label svg { width: 16px; height: 16px; }
  .hb-time > strong { display: block; margin-top: 5px; font-size: 20px; font-weight: 600; line-height: 1.25; font-variant-numeric: tabular-nums; letter-spacing: -.45px; }
  .hb-time-date { margin-top: 11px; border-top: 1px solid var(--ctp-panel-line); padding-top: 7px; color: var(--ctp-muted, #626e65); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
  .hb-alert { border: 1px solid color-mix(in srgb, #d98216 24%, var(--ctp-panel-line)); border-radius: 12px; padding: 0 11px; background: color-mix(in srgb, #f6a93a 9%, var(--ctp-surface, #fff)); color: var(--ctp-warning-ink, #8b4c08); }
  .hb-alert > summary { display: flex; align-items: center; gap: 9px; min-height: 40px; font-size: 12px; font-weight: 550; list-style: none; }
  .hb-alert > summary::-webkit-details-marker, .hb-items > summary::-webkit-details-marker, .hb-history summary::-webkit-details-marker, .hb-source > summary::-webkit-details-marker { display: none; }
  .hb-alert > summary > svg:first-child { width: 17px; height: 17px; color: var(--ctp-warning-ink, #8b4c08); }
  .hb-alert .hb-alert-chevron { width: 14px; height: 14px; margin-inline-start: auto; transition: transform 160ms var(--ctp-panel-ease); }
  .hb-alert[open] .hb-alert-chevron { transform: rotate(180deg); }
  .hb-alert p { margin: 0 0 8px; font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; }
  .hb-items { overflow: hidden; border-radius: 12px; background: var(--ctp-hover, #263b2b0a); }
  .hb-items > summary { display: flex; align-items: center; gap: 9px; min-height: 44px; padding: 0 12px; font-size: 12px; font-weight: 550; list-style: none; }
  .hb-items > summary > svg:first-child { width: 18px; height: 18px; color: var(--ctp-muted, #626e65); }
  .hb-items .hb-count { margin-inline-start: 1px; }
  .hb-disclosure-chevron { width: 14px; height: 14px; margin-inline-start: auto; color: var(--ctp-muted, #626e65); transition: transform 160ms var(--ctp-panel-ease); }
  .hb-items[open] > summary .hb-disclosure-chevron, .hb-source[open] > summary .hb-disclosure-chevron { transform: rotate(90deg); }
  .hb-items-body { padding: 0 12px 7px; }
  .hb-item { padding: 8px 0; border-top: 1px solid var(--ctp-panel-line); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
  .hb-item strong { font-weight: 550; }
  .hb-item p { margin: 3px 0 0; color: var(--ctp-muted, #626e65); white-space: pre-wrap; }
  .hb-history { min-width: 0; border: 1px solid var(--ctp-panel-line); border-radius: 14px; padding: 10px; }
  .hb-history-head { display: flex; align-items: center; gap: 6px; min-height: 28px; margin-bottom: 4px; }
  .hb-history-head h3 { display: flex; align-items: center; gap: 8px; min-width: 0; margin: 0; font-size: 13px; }
  .hb-history-head h3 > svg { width: 17px; height: 17px; }
  .hb-refresh { display: flex; flex: none; align-items: center; gap: 5px; margin-inline-start: auto; padding: 5px 6px; color: var(--ctp-muted, #626e65); font-size: 10px; }
  .hb-refresh svg { width: 15px; height: 15px; }
  .hb-wake { position: relative; min-width: 0; }
  .hb-wake:not(:last-of-type) { border-bottom: 1px solid var(--ctp-panel-line); }
  .hb-wake > summary { position: relative; display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 34px; padding: 3px 5px 3px 16px; list-style: none; }
  .hb-wake > summary::before { position: absolute; inset-inline-start: 1px; width: 9px; height: 9px; border: 2px solid var(--ctp-panel-line); border-radius: 50%; background: var(--ctp-surface, #fff); content: ""; }
  .hb-wake[open] > summary::before, .hb-wake:first-of-type > summary::before { border-color: var(--ctp-panel-ink); background: var(--ctp-panel-tint); }
  .hb-wake-time { min-width: 0; overflow: hidden; font-size: 12px; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
  .hb-wake-count { flex: none; border-radius: 999px; padding: 2px 7px; background: var(--ctp-hover, #263b2b0a); color: var(--ctp-muted, #626e65); font-size: 10px; }
  .hb-wake-chevron { width: 14px; height: 14px; margin-inline-start: auto; color: var(--ctp-muted, #626e65); transition: transform 160ms var(--ctp-panel-ease); }
  .hb-wake[open] > summary .hb-wake-chevron { transform: rotate(90deg); }
  .hb-wake-body { margin: 0 0 7px 16px; border-radius: 11px; padding: 6px 8px; background: var(--ctp-hover, #263b2b0a); }
  .hb-wake-raw { margin: 3px 0 6px; }
  .hb-wake-raw > summary, .hb-record-raw > summary { color: var(--ctp-muted, #626e65); font-size: 10px; text-decoration: underline; text-underline-offset: 2px; list-style: none; }
  .hb-wake-raw > summary::-webkit-details-marker, .hb-record-raw > summary::-webkit-details-marker { display: none; }
  .hb-wake-original p, .hb-row-original p { display: grid; grid-template-columns: 55px minmax(0, 1fr); gap: 5px; margin: 4px 0; font-size: 10px; line-height: 1.5; overflow-wrap: anywhere; }
  .hb-wake-original strong, .hb-row-original strong { color: var(--ctp-muted, #626e65); font-weight: 500; }
  .hb-wake-original code, .hb-row-original code { font: 10px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
  .hb-row-original { min-width: 190px; max-width: 100%; margin-top: 5px; border: 1px solid var(--ctp-panel-line); border-radius: 7px; padding: 6px; background: var(--ctp-surface, #fff); }
  .hb-wake-line, .hb-truncated { margin: 4px 0; color: var(--ctp-muted, #626e65); font-size: 10px; line-height: 1.5; }
  .hb-record { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 6px; padding: 4px 0; }
  .hb-record-preview { display: flex; min-width: 0; gap: 7px; font-size: 11px; line-height: 1.55; }
  .hb-record-preview strong { flex: none; max-width: 42%; overflow: hidden; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
  .hb-record-preview > span { display: -webkit-box; min-width: 0; max-height: 3.1em; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; color: var(--ctp-muted, #626e65); overflow-wrap: anywhere; }
  .hb-record-raw { min-width: max-content; margin: 0; }
  .hb-record-raw > summary { border-radius: 4px; }
  .hb-more-records { border-top: 1px solid var(--ctp-panel-line); padding-top: 5px; }
  .hb-more-records > summary { color: var(--ctp-muted, #626e65); font-size: 10px; }
  .hb-older { display: block; width: 100%; margin: 3px 0 0; border-top: 1px solid var(--ctp-panel-line); border-radius: 0; padding: 9px 5px 2px; color: var(--ctp-muted, #626e65); text-align: start; font-size: 11px; }
  .hb-source { border-radius: 11px; background: var(--ctp-hover, #263b2b0a); }
  .hb-source > summary { display: flex; align-items: center; gap: 8px; min-height: 41px; padding: 0 11px; font-size: 11px; list-style: none; }
  .hb-source > summary > svg:first-child { width: 17px; height: 17px; color: var(--ctp-muted, #626e65); }
  .hb-source-list { display: grid; gap: 5px; padding: 0 11px 10px; }
  .hb-source-list > div { display: grid; grid-template-columns: 68px minmax(0, 1fr); gap: 7px; font-size: 10px; line-height: 1.5; }
  .hb-source-list > div > span { color: var(--ctp-muted, #626e65); }
  .hb-source-list code { overflow-wrap: anywhere; }
  .heartbeat h3, h3 { margin: 0 0 9px; font-size: 12px; font-weight: 600; line-height: 1.5; }
  .audit-summary { display: flex; align-items: center; gap: 12px; border: 1px solid var(--ctp-panel-line); border-radius: 13px; padding: 14px; background: var(--ctp-hover, #263b2b0a); }
  .audit-symbol { display: grid; flex: none; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: var(--ctp-panel-tint); color: var(--ctp-panel-ink); }
  .audit-symbol svg { width: 20px; height: 20px; }
  .audit-summary strong { font-size: 12px; font-weight: 550; }
  .audit-summary p { margin: 5px 0 0; color: var(--ctp-muted, #626e65); font-size: 11px; line-height: 1.6; }
  dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px 12px; margin: 12px 0; font-size: 11px; line-height: 1.6; }
  dt { color: var(--ctp-muted, #626e65); }
  dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
  .audit-time { grid-template-columns: 1fr 1fr; gap: 0; margin: 18px 0; }
  .audit-time > div + div { border-inline-start: 1px solid var(--ctp-panel-line); padding-inline-start: 18px; }
  .audit-time dt { margin-bottom: 7px; font-size: 10px; }
  .audit-time dd { font-size: 20px; letter-spacing: -.7px; font-variant-numeric: tabular-nums; }
  .event { position: relative; margin: 0 10px; padding: 5px 0 18px 24px; overflow-wrap: anywhere; }
  .event::before { position: absolute; inset-inline-start: 1px; inset-block-start: 9px; width: 8px; height: 8px; border: 1px solid var(--ctp-panel-line); border-radius: 50%; background: var(--ctp-surface, #fff); content: ""; }
  .event:not(:last-child)::after { position: absolute; inset-inline-start: 4px; inset-block: 19px 0; width: 1px; background: var(--ctp-panel-line); content: ""; }
  .event:first-child::before { border-color: var(--ctp-panel-ink); background: var(--ctp-panel-tint); }
  .event > strong { font-size: 12px; font-weight: 550; }
  .event > .muted { font-size: 10px; }
  .event p { margin: 5px 0 0; font-size: 11px; line-height: 1.7; }
  .event p.muted { font-size: 11px; }
  .muted { color: var(--ctp-muted, #626e65); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
  .empty { margin: 12px 10px; color: var(--ctp-muted, #626e65); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
  .status { font-size: 10px; font-weight: 400; white-space: nowrap; }
  .path-value { overflow-wrap: anywhere; word-break: break-word; }
  .diagnostic { margin-block: 9px; font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
  .diagnostic-text { max-height: 180px; overflow: auto; margin: 7px 0; border: 1px solid var(--ctp-panel-line); border-radius: 8px; padding: 8px; background: var(--ctp-hover, #263b2b0a); color: var(--ctp-muted, #626e65); font: 11px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; user-select: text; }
  .error { margin: 8px 0; color: var(--ctp-error, #b15838); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
  .sr-status { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
  details { margin-top: 7px; }
  summary { border-radius: 5px; font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
  :host([dir="rtl"]) .edge-progress { transform: scaleX(-1); }
  :host([dir="rtl"]) .fill, :host([dir="rtl"]) .module-fill { transform-origin: right center; }
  @media (max-width: 450px) {
    .summary { gap: 6px; }
    .main { grid-template-columns: 15px minmax(0, 1fr) auto; gap: 8px; padding-inline: 11px; }
    .capsule-icon { width: 15px; height: 15px; }
    .capsule-chevron { display: none; }
    .title { font-size: 11px; }
    .summary-state { font-size: 10px; }
    .percent { font-size: 18px; }
    .panel-head { padding: 16px 15px 13px; }
    .panel-head[data-view="heartbeat"] { padding: 8px 14px 7px; }
    .panel-title { font-size: 15px; }
    .row { gap: 9px; padding-inline: 10px; }
    .module-icon { width: 30px; height: 30px; }
    .name { font-size: 11px; }
    .panel-foot { padding-inline: 15px; }
    .detail { padding-inline-start: 17px; padding-inline-end: 8px; }
    .hb-panel { gap: 8px; }
    .hb-time-card { padding-inline: 10px; }
    .hb-time + .hb-time { padding-inline-start: 10px; }
    .hb-time > strong { font-size: 18px; }
    .hb-history { padding: 8px; }
    .hb-history-head h3 { gap: 5px; font-size: 12px; }
    .hb-refresh { gap: 3px; padding-inline: 4px; }
    .hb-wake-body { margin-inline-start: 8px; padding: 7px; }
    .hb-record { grid-template-columns: minmax(0, 1fr); }
    .hb-record-raw { min-width: 0; justify-self: end; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
    .main:active, .orb:active { transform: none; }
  }
  @media (prefers-reduced-transparency: reduce) {
    .main, .orb, .body { background: var(--ctp-surface, #fff); -webkit-backdrop-filter: none; backdrop-filter: none; }
  }
  @supports not (backdrop-filter: blur(1px)) {
    .main, .orb, .body { background: var(--ctp-surface, #fff); }
  }
`;
