import type { ReactNode } from "react";

/**
 * One original illustration per CLI, drawn as SVG and animated with CSS (see `.au-m-*` in ai-usage.css). They are
 * decorative: the tool's name is always printed next to them, so they are hidden from screen readers. Animations
 * stop under `prefers-reduced-motion`.
 */
function Frame({ slug, children }: { slug: string; children: ReactNode }) {
  return (
    <svg className={`au-mascot au-m-${slug}`} viewBox="0 0 160 160" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

function ClaudeCode() {
  return (
    <Frame slug="claude-code">
      <defs>
        <linearGradient id="au-g-cc" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ec8a5e" />
          <stop offset="1" stopColor="#c85f34" />
        </linearGradient>
      </defs>
      <g>
        <circle className="au-m-dot" cx="64" cy="20" r="4" fill="#ec8a5e" />
        <circle className="au-m-dot" cx="80" cy="16" r="4" fill="#ec8a5e" />
        <circle className="au-m-dot" cx="96" cy="20" r="4" fill="#ec8a5e" />
      </g>
      <g className="au-m-body">
        <rect x="26" y="74" width="12" height="24" fill="#c85f34" />
        <rect x="122" y="74" width="12" height="24" fill="#c85f34" />
        <rect x="38" y="44" width="84" height="76" fill="url(#au-g-cc)" />
        <rect x="38" y="44" width="84" height="8" fill="#f4a47c" opacity="0.7" />
        <rect x="38" y="112" width="84" height="8" fill="#a84b27" opacity="0.55" />
        <g className="au-m-eye">
          <rect x="54" y="68" width="10" height="20" fill="#2a1710" />
        </g>
        <g className="au-m-eye">
          <rect x="96" y="68" width="10" height="20" fill="#2a1710" />
        </g>
        <g className="au-m-leg-a">
          <rect x="46" y="120" width="10" height="16" fill="#c85f34" />
          <rect x="92" y="120" width="10" height="16" fill="#c85f34" />
        </g>
        <g className="au-m-leg-b">
          <rect x="62" y="120" width="10" height="16" fill="#a84b27" />
          <rect x="106" y="120" width="10" height="16" fill="#a84b27" />
        </g>
      </g>
    </Frame>
  );
}

function Codex() {
  const cloud = "M46 112 Q16 112 22 82 Q26 58 52 62 Q58 32 90 36 Q118 40 120 68 Q146 68 142 94 Q138 112 116 112 Z";
  return (
    <Frame slug="codex">
      <defs>
        <linearGradient id="au-g-cx" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8f9cff" />
          <stop offset="0.55" stopColor="#6a5cf5" />
          <stop offset="1" stopColor="#4a2fd0" />
        </linearGradient>
        <clipPath id="au-c-cx">
          <path d={cloud} />
        </clipPath>
      </defs>
      <g className="au-m-cloud">
        <path d={cloud} fill="url(#au-g-cx)" />
        <g clipPath="url(#au-c-cx)">
          <ellipse className="au-m-sheen" cx="70" cy="50" rx="34" ry="10" fill="#ffffff" />
        </g>
        <g className="au-m-chev">
          <path d="M58 76 L74 90 L58 104" fill="none" stroke="#ffffff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
        </g>
        <rect className="au-m-caret" x="84" y="98" width="24" height="7" rx="3.5" fill="#ffffff" />
      </g>
    </Frame>
  );
}

function OpenCode() {
  return (
    <Frame slug="opencode">
      <defs>
        <linearGradient id="au-g-oc" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4b5565" />
          <stop offset="1" stopColor="#232a35" />
        </linearGradient>
        <clipPath id="au-c-oc">
          <rect x="34" y="34" width="92" height="92" rx="10" />
        </clipPath>
      </defs>
      <g className="au-m-mark">
        <rect x="34" y="34" width="92" height="92" rx="10" fill="url(#au-g-oc)" stroke="#ffffff" strokeOpacity="0.18" />
        <rect x="34" y="34" width="92" height="6" fill="#ffffff" opacity="0.14" clipPath="url(#au-c-oc)" />
        <g clipPath="url(#au-c-oc)">
          <rect className="au-m-scan" x="34" y="40" width="92" height="3" fill="#9fe6c9" />
        </g>
        <rect className="au-m-core" x="62" y="62" width="36" height="36" rx="5" fill="#0f141b" />
        <rect x="62" y="62" width="36" height="36" rx="5" fill="none" stroke="#9fe6c9" strokeWidth="2" opacity="0.7" />
        <rect className="au-m-caret" x="72" y="76" width="16" height="8" rx="2" fill="#9fe6c9" />
        <path d="M34 54 V34 H54 M106 34 H126 V54 M126 106 V126 H106 M54 126 H34 V106" fill="none" stroke="#9fe6c9" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
      </g>
    </Frame>
  );
}

function Pi() {
  return (
    <Frame slug="pi">
      <defs>
        <radialGradient id="au-g-pi" cx="0.35" cy="0.3" r="0.9">
          <stop offset="0" stopColor="#c4b0ff" />
          <stop offset="0.55" stopColor="#8a62f0" />
          <stop offset="1" stopColor="#5a34c4" />
        </radialGradient>
      </defs>
      <g className="au-m-orb">
        <circle cx="80" cy="78" r="48" fill="url(#au-g-pi)" />
        <ellipse cx="64" cy="52" rx="22" ry="10" fill="#ffffff" opacity="0.22" />
        <g className="au-m-glyph">
          <path d="M54 64 H106 M68 64 V100 M92 64 Q92 94 102 100" fill="none" stroke="#ffffff" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
        </g>
        <g className="au-m-orbit">
          <circle cx="80" cy="18" r="5" fill="#c4b0ff" />
        </g>
      </g>
    </Frame>
  );
}

/** A tool the module has no illustration for: a neutral block with two eyes. */
function Generic() {
  return (
    <Frame slug="generic">
      <g className="au-m-orb">
        <rect x="38" y="42" width="84" height="76" rx="16" fill="#8a93a3" />
        <rect x="38" y="42" width="84" height="10" rx="5" fill="#ffffff" opacity="0.25" />
        <g className="au-m-eye">
          <rect x="58" y="70" width="10" height="18" rx="3" fill="#1b2330" />
        </g>
        <g className="au-m-eye">
          <rect x="92" y="70" width="10" height="18" rx="3" fill="#1b2330" />
        </g>
      </g>
    </Frame>
  );
}

const MASCOTS: Record<string, () => ReactNode> = { "claude-code": ClaudeCode, codex: Codex, opencode: OpenCode, pi: Pi };

/** The mascot of a tool, or the neutral one when the module has none for it. */
export function Mascot({ slug }: { slug: string }) {
  const Draw = MASCOTS[slug] ?? Generic;
  return <Draw />;
}

export const MASCOT_SLUGS = Object.keys(MASCOTS);
