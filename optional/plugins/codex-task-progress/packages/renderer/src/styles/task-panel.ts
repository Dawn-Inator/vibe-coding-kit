import { css } from "lit";

/** Native task panel. Host-provided tokens remain the theme authority. */
export const taskPanelStyles = css`
  :host {
    --ctp-panel-glass: color-mix(in srgb, var(--ctp-surface, #fff) 94%, transparent);
    --ctp-panel-tint: color-mix(in srgb, var(--ctp-accent, #626b75) 9%, var(--ctp-surface, #fff));
    --ctp-panel-ink: color-mix(in srgb, var(--ctp-accent, #626b75) 65%, var(--ctp-text, #343a40));
    --ctp-panel-fill: color-mix(in srgb, var(--ctp-accent, #626b75) 72%, var(--ctp-surface, #fff));
    --ctp-panel-line: var(--ctp-border, #343a4024);
    --ctp-panel-track: var(--ctp-track, color-mix(in srgb, var(--ctp-text, #343a40) 12%, var(--ctp-surface, #fff)));
    --ctp-panel-ease: cubic-bezier(.16, 1, .3, 1);
    display: block;
    min-width: 0;
    color: var(--ctp-text, #343a40);
    color-scheme: light dark;
    font: inherit;
    -webkit-font-smoothing: antialiased;
  }

  *, *::before, *::after { box-sizing: border-box; }
  [hidden] { display: none !important; }
  button, summary { font: inherit; color: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  button { border: 0; border-radius: 8px; padding: 6px 9px; background: transparent; }
  button:hover { background: var(--ctp-hover, #343a400a); }
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
    box-shadow: 0 4px 14px -5px #20262c20, inset 0 1px 0 #ffffff0a;
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
  .summary-state { display: block; overflow: hidden; color: var(--ctp-muted, #697078); font-size: 10px; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
  .summary-state .execution { color: inherit; }
  .percent { color: var(--ctp-panel-ink); font-size: 20px; font-weight: 500; line-height: 1; letter-spacing: -.7px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .percent small { margin-inline-start: 1px; font-size: 11px; letter-spacing: 0; }
  .capsule-chevron { width: 12px; height: 12px; color: var(--ctp-muted, #697078); transition: transform 200ms var(--ctp-panel-ease); }
  .main[aria-expanded="true"] .capsule-chevron { transform: rotate(180deg); }
  .edge-progress { position: absolute; inset: -1px; width: calc(100% + 2px); height: 44px; overflow: visible; stroke-width: 3; }
  .edge-progress path { vector-effect: non-scaling-stroke; }
  .edge-track { stroke: var(--ctp-panel-track); }
  .edge-fill { stroke: var(--ctp-panel-fill); }
  .orb { display: grid; flex: none; place-items: center; width: 40px; height: 40px; border-radius: 50%; padding: 0; color: var(--ctp-muted, #697078); }
  .orb svg { width: 17px; height: 17px; }
  .orb[aria-expanded="true"] { color: var(--ctp-panel-ink); background: var(--ctp-panel-tint); }
  .heartbeat-mark { position: absolute; inset-block-start: 7px; inset-inline-end: 7px; width: 5px; height: 5px; border: 1px solid var(--ctp-surface, #fff); border-radius: 50%; background: var(--ctp-panel-ink); }
  .heartbeat-mark[data-status="none"], .heartbeat-mark[data-status="candidates"] { background: var(--ctp-muted, #697078); }
  .heartbeat-mark[data-status="stale"], .heartbeat-mark[data-status="error"] { background: var(--ctp-error, #b15838); }
  .body {
    position: relative;
    width: 100%;
    display: flex;
    flex-direction: column;
    max-height: var(--ctp-panel-max-height, min(640px, calc(100dvh - 72px)));
    min-height: 0;
    margin-top: 8px;
    overflow: hidden;
    border: 1px solid var(--ctp-panel-line);
    border-radius: 20px;
    background: var(--ctp-panel-glass);
    box-shadow: 0 18px 55px -18px #20262c38, 0 4px 12px -5px #00000020, inset 0 1px 0 #ffffff0a;
    -webkit-backdrop-filter: blur(28px);
    backdrop-filter: blur(28px);
    transform-origin: top center;
    animation: ctp-panel-enter 200ms var(--ctp-panel-ease) both;
  }
  @keyframes ctp-panel-enter { from { opacity: 0; transform: translateY(-6px) scale(.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
  .panel-head { flex: none; padding: 19px 20px 14px; }
  .panel-head[data-view="heartbeat"] { padding: 10px 16px 8px; }
  .panel-kicker { display: flex; align-items: center; gap: 7px; margin-bottom: 9px; color: var(--ctp-muted, #697078); font-size: 10px; line-height: 1.4; }
  .panel-kicker svg { width: 12px; height: 12px; }
  .panel-heading { display: flex; align-items: center; gap: 8px; }
  .panel-head[data-view="heartbeat"] .panel-heading { gap: 8px; }
  .heartbeat-heading-icon { display: grid; flex: none; place-items: center; width: 21px; height: 21px; color: var(--ctp-panel-ink); }
  .heartbeat-heading-icon svg { width: 20px; height: 20px; }
  .panel-title { display: -webkit-box; min-width: 0; max-height: 2.8em; margin: 0; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; font-size: 17px; font-weight: 600; line-height: 1.4; letter-spacing: -.4px; overflow-wrap: anywhere; }
  .panel-head[data-view="heartbeat"] .panel-title { font-size: 16px; }
  .panel-title:focus { outline: none; }
  .panel-subtitle { margin: 7px 0 0; color: var(--ctp-muted, #697078); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
  .total-line { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin-top: 14px; color: var(--ctp-muted, #697078); font-size: 10px; line-height: 1.5; }
  .total-line strong { color: var(--ctp-text, #343a40); font-weight: 550; }
  .total-line .execution { margin-inline-start: auto; color: var(--ctp-panel-ink); }
  .track, .module-track { display: block; height: 3px; overflow: hidden; border-radius: 5px; background: var(--ctp-panel-track); }
  .track { margin-top: 9px; }
  .fill, .module-fill { display: block; height: 100%; border-radius: inherit; background: var(--ctp-panel-fill); transform-origin: left center; }
  .scroll { flex: 1 1 auto; min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; padding: 0 10px 10px; scrollbar-width: thin; scrollbar-color: var(--ctp-panel-line) transparent; }
  .scroll > .empty, .scroll > .diagnostic, .scroll > .heartbeat, .scroll > .error { margin-inline: 10px; }
  .scroll > button { margin: 7px 4px 0; border: 1px solid var(--ctp-panel-line); font-size: 11px; }
  .row { display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; margin: 0 0 8px; border: 1px solid var(--ctp-panel-line); border-radius: 999px; padding: 12px 14px; background: var(--ctp-panel-glass); text-align: start; }
  .row:hover, .row[aria-expanded="true"] { background: var(--ctp-hover, #343a400a); }
  .row:focus-visible { outline-offset: -2px; }
  .module-icon { display: grid; flex: none; place-items: center; width: 36px; height: 36px; border: 0; border-radius: 50%; background: var(--ctp-hover, #343a400a); color: var(--ctp-muted, #697078); font-size: 10px; font-variant-numeric: tabular-nums; }
  .module-icon[data-status="active"], .module-icon[data-status="completed"] { background: var(--ctp-panel-tint); color: var(--ctp-panel-ink); }
  .module-icon svg { width: 15px; height: 15px; }
  .module-content { flex: 1; min-width: 0; }
  .module-title-line { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
  .name { min-width: 0; overflow: hidden; font-size: 12px; font-weight: 550; line-height: 1.5; text-overflow: ellipsis; white-space: nowrap; }
  .module-percent { flex: none; margin-inline-start: auto; color: var(--ctp-muted, #697078); font-size: 10px; font-variant-numeric: tabular-nums; }
  .module-track { margin-top: 7px; }
  .module-meta { display: flex; align-items: center; gap: 8px; margin-top: 6px; color: var(--ctp-muted, #697078); font-size: 10px; font-variant-numeric: tabular-nums; line-height: 1.4; }
  .module-meta .status { margin-inline-start: auto; }
  .module-arrow { width: 12px; height: 12px; color: var(--ctp-muted, #697078); transition: transform 180ms var(--ctp-panel-ease); }
  .row[aria-expanded="true"] .module-arrow { transform: rotate(90deg); }
  .detail { min-width: 0; max-width: 100%; padding: 0 14px 9px 23px; overflow-wrap: anywhere; animation: ctp-nodes-enter 180ms var(--ctp-panel-ease) both; }
  .objective-detail-title { margin: 0 0 8px; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
  @keyframes ctp-nodes-enter { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }
  .check { position: relative; min-width: 0; padding: 10px 0 10px 29px; overflow-wrap: anywhere; }
  .check:not(:last-child)::before { position: absolute; inset-inline-start: 7px; inset-block: 26px -8px; width: 1px; background: var(--ctp-panel-line); content: ""; }
  .node-symbol { position: absolute; inset-inline-start: 0; inset-block-start: 12px; display: grid; place-items: center; width: 15px; height: 15px; border: 1px solid var(--ctp-panel-line); border-radius: 50%; background: var(--ctp-surface, #fff); color: var(--ctp-muted, #697078); font-size: 10px; }
  .node-symbol svg { width: 10px; height: 10px; stroke-width: 1.8; }
  .node-symbol[data-status="completed"] { border-color: transparent; background: var(--ctp-panel-tint); color: var(--ctp-panel-ink); }
  .node-symbol[data-status="active"] { border-color: var(--ctp-panel-ink); color: var(--ctp-panel-ink); }
  .node-symbol[data-status="blocked"], .node-status[data-status="blocked"] { color: var(--ctp-error, #b15838); }
  .node-symbol[data-status="cancelled"] { border-style: dashed; }
  .node-head { display: flex; align-items: baseline; gap: 9px; }
  .node-title { min-width: 0; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
  .node-status { flex: none; margin-inline-start: auto; color: var(--ctp-muted, #697078); font-size: 10px; line-height: 1.5; white-space: nowrap; }
  .evidence { min-width: 0; margin: 5px 0 0; color: var(--ctp-muted, #697078); font-size: 11px; line-height: 1.7; overflow-wrap: anywhere; word-break: break-word; }
  .evidence strong { font-weight: 550; }
  .evidence svg { display: inline-block; width: 11px; height: 11px; margin-inline-end: 4px; vertical-align: -1px; color: var(--ctp-panel-ink); }
  .panel-foot { display: flex; flex: none; align-items: center; flex-wrap: wrap; gap: 6px; min-height: 38px; border-top: 1px solid var(--ctp-panel-line); padding: 10px 19px; color: var(--ctp-muted, #697078); font-size: 10px; line-height: 1.4; }
  .panel-foot svg { width: 12px; height: 12px; color: var(--ctp-panel-ink); }
  .heartbeat { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--ctp-panel-line); }
  .heartbeat:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
  .hb-panel { display: grid; gap: 8px; margin: 0; padding: 0; border: 0; }
  .hb-panel details { margin-top: 0; }
  .hb-panel h3 { margin: 0; }
  .hb-status, .hb-count { display: inline-flex; flex: none; align-items: center; border-radius: 999px; padding: 3px 8px; background: var(--ctp-hover, #343a400a); color: var(--ctp-muted, #697078); font-size: 10px; line-height: 1.35; }
  .panel-heading > .hb-status { margin-inline-start: auto; }
  .hb-status[data-certification="certified"] { background: var(--ctp-panel-tint); color: var(--ctp-panel-ink); }
  .hb-status[data-certification="record-validated"] { border: 1px solid var(--ctp-panel-line); background: var(--ctp-surface, #fff); color: var(--ctp-muted, #697078); }
  .hb-status[data-status="stale"], .hb-status[data-status="error"] { background: color-mix(in srgb, var(--ctp-error, #b15838) 10%, var(--ctp-surface, #fff)); color: var(--ctp-error, #b15838); }
  .hb-time-card { min-width: 0; margin: 0; padding: 0; border: 0; background: transparent; }
  .hb-times { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .hb-time { min-width: 0; min-height: 118px; border: 1px solid var(--ctp-panel-line); border-radius: 16px; padding: 14px; background: var(--ctp-surface, #fff); }
  .hb-time-label { display: flex; align-items: center; gap: 7px; min-width: 0; color: var(--ctp-muted, #697078); font-size: 12px; line-height: 1.45; }
  .hb-time-label svg { width: 16px; height: 16px; }
  .hb-time > strong { display: block; min-width: 0; margin-top: 9px; font-size: 22px; font-weight: 600; line-height: 1.25; font-variant-numeric: tabular-nums; letter-spacing: -.45px; overflow-wrap: anywhere; }
  .hb-time-date { margin-top: 7px; color: var(--ctp-muted, #697078); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
  .hb-time-caption { margin-top: 4px; color: var(--ctp-muted, #697078); font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
  .hb-time-next[data-missing="true"] > strong { color: var(--ctp-muted, #697078); font-size: 17px; font-weight: 450; letter-spacing: 0; }
  .info-card { min-width: 0; overflow: hidden; border: 1px solid var(--ctp-panel-line); border-radius: 14px; background: var(--ctp-surface, #fff); }
  .info-card[data-tone="warning"] { border-color: color-mix(in srgb, #d98216 30%, var(--ctp-panel-line)); background: color-mix(in srgb, #f6a93a 7%, var(--ctp-surface, #fff)); }
  .info-card[data-tone="error"] { border-color: color-mix(in srgb, var(--ctp-error, #b15838) 28%, var(--ctp-panel-line)); }
  .info-card-head { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 40px; padding: 6px 11px; }
  .info-card-title { display: flex; align-items: center; gap: 8px; min-width: 0; margin: 0; font-size: 12px; font-weight: 550; line-height: 1.45; }
  .info-card-title > span:nth-child(2) { min-width: 0; overflow-wrap: anywhere; }
  .info-card-title > svg { flex: none; width: 17px; height: 17px; color: var(--ctp-muted, #697078); }
  .info-card[data-tone="warning"] .info-card-title > svg { color: var(--ctp-warning-ink, #8b4c08); }
  .info-card[data-tone="error"] .info-card-title > svg { color: var(--ctp-error, #b15838); }
  .info-card-count { flex: none; border-radius: 999px; padding: 2px 7px; background: var(--ctp-hover, #343a400a); color: var(--ctp-muted, #697078); font-size: 10px; font-weight: 450; }
  .info-card-action { display: inline-flex; flex: none; align-items: center; gap: 5px; margin-inline-start: auto; border: 1px solid var(--ctp-panel-line); border-radius: 7px; padding: 5px 8px; background: var(--ctp-surface, #fff); color: var(--ctp-muted, #697078); font-size: 11px; cursor: pointer; }
  .info-card-action:hover:not(:disabled) { background: var(--ctp-hover, #343a400a); }
  .info-card-action:focus-visible { outline: 2px solid var(--ctp-panel-ink); outline-offset: 2px; }
  .info-card-action:disabled { opacity: .55; cursor: default; }
  .info-card-body { min-width: 0; padding: 0 11px 10px; overflow-wrap: anywhere; }
  .info-card-body > :first-child { margin-top: 0; }
  .info-card-body > :last-child { margin-bottom: 0; }
  .info-card-error { min-width: 0; margin-top: 6px; color: var(--ctp-error, #b15838); font-size: 11px; line-height: 1.5; }
  .info-card-more { margin-top: 7px; }
  .hb-alert .info-card-body { font-size: 11px; line-height: 1.55; }
  .hb-alert p { margin: 0 0 6px; overflow-wrap: anywhere; }
  .hb-history { min-width: 0; }
  .hb-history-head { min-height: 38px; }
  .hb-refresh { font-size: 10px; }
  .hb-refresh svg { width: 15px; height: 15px; }
  .hb-wake { min-width: 0; }
  .hb-wake > summary { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 34px; list-style: none; }
  .hb-wake-time { min-width: 0; overflow: hidden; font-size: 12px; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
  .hb-wake-chevron { width: 14px; height: 14px; margin-inline-start: auto; color: var(--ctp-muted, #697078); transition: transform 160ms var(--ctp-panel-ease); }
  .hb-wake[open] > summary .hb-wake-chevron { transform: rotate(90deg); }
  .hb-wake-body { display: grid; gap: 10px; min-width: 0; padding: 4px 0; }
  .hb-snapshot { min-width: 0; overflow-wrap: anywhere; }
  .hb-snapshot p { margin: 4px 0; }
  .hb-blocked-task { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--ctp-panel-line); }
  .hb-record .info-card-head { min-height: 32px; }
  .hb-older { display: block; width: 100%; margin: 3px 0 0; border-top: 1px solid var(--ctp-panel-line); border-radius: 0; padding: 9px 5px 2px; color: var(--ctp-muted, #697078); text-align: start; font-size: 11px; }
  .heartbeat h3, h3 { margin: 0 0 9px; font-size: 12px; font-weight: 600; line-height: 1.5; }
  .audit-summary { display: flex; align-items: center; gap: 12px; border: 1px solid var(--ctp-panel-line); border-radius: 13px; padding: 14px; background: var(--ctp-hover, #343a400a); }
  .audit-symbol { display: grid; flex: none; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: var(--ctp-panel-tint); color: var(--ctp-panel-ink); }
  .audit-symbol svg { width: 20px; height: 20px; }
  .audit-summary strong { font-size: 12px; font-weight: 550; }
  .audit-summary p { margin: 5px 0 0; color: var(--ctp-muted, #697078); font-size: 11px; line-height: 1.6; }
  dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px 12px; margin: 12px 0; font-size: 11px; line-height: 1.6; }
  dt { color: var(--ctp-muted, #697078); }
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
  .muted { color: var(--ctp-muted, #697078); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
  .empty { margin: 12px 10px; color: var(--ctp-muted, #697078); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
  .status { font-size: 10px; font-weight: 400; white-space: nowrap; }
  .path-value { overflow-wrap: anywhere; word-break: break-word; }
  .diagnostic-text { max-width: 100%; max-height: 150px; overflow: auto; margin: 6px 0 0; border: 1px solid var(--ctp-panel-line); border-radius: 8px; padding: 8px; background: var(--ctp-hover, #343a400a); color: var(--ctp-muted, #697078); font: 11px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; user-select: text; }
  .error { margin: 8px 0; color: var(--ctp-error, #b15838); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
  .sr-status { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
  details { margin-top: 7px; }
  summary { border-radius: 5px; font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
  :host(:dir(rtl)) .edge-progress { transform: scaleX(-1); }
  :host(:dir(rtl)) .fill, :host(:dir(rtl)) .module-fill { transform-origin: right center; }
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
    .hb-time { min-height: 118px; padding: 12px; }
    .hb-time-label { gap: 5px; font-size: 11px; }
    .hb-time-label svg { width: 15px; height: 15px; }
    .info-card-head { padding-inline: 8px; }
    .info-card-body { padding-inline: 8px; }
    .hb-refresh { gap: 3px; padding-inline: 4px; }
    .hb-wake-body { margin-inline-start: 8px; padding: 7px; }
    .hb-record { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 319px) {
    .hb-times { grid-template-columns: minmax(0, 1fr); }
    .hb-time { min-height: 0; }
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
