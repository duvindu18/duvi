/** Line icons on a 24px grid: 1.5px stroke, square caps, mitred joins (Seedform icon spec). Bundled, no icon font. */
import type { SVGProps } from 'react'

const base: SVGProps<SVGSVGElement> = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'square',
  strokeLinejoin: 'miter',
  'aria-hidden': true
}

export const IconChat = () => (
  <svg {...base}>
    <path d="M4 5.5h16v10H9l-5 3.5z" />
  </svg>
)
export const IconScript = () => (
  <svg {...base}>
    <path d="M8.5 8 4.5 12l4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13" />
  </svg>
)
export const IconVisual = () => (
  <svg {...base}>
    <path d="M3.5 19.5h17M5.5 19.5V10l6.5-5 6.5 5v9.5M9.5 19.5v-5h5v5" />
  </svg>
)
export const IconSkills = () => (
  <svg {...base}>
    <path d="M5 4.5h10.5l3.5 3.5v11.5H5zM15 4.5V8h4M8.5 12h7M8.5 15.5h5" />
  </svg>
)
export const IconDocs = () => (
  <svg {...base}>
    <path d="M7 3.5h7l4 4v13H7zM13.5 3.5v4.5H18M4.5 7v15h11" />
  </svg>
)
export const IconSettings = () => (
  <svg {...base}>
    <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="8" cy="17" r="2" />
  </svg>
)
export const IconChevron = () => (
  <svg {...base} width="16" height="16">
    <path d="m7 10 5 5 5-5" />
  </svg>
)
/** App mark: a plan-view square with a courtyard, the seed of the app icon (M7). */
export const Mark = (p: { className?: string }) => (
  <svg viewBox="0 0 16 16" className={p.className} aria-hidden="true">
    <path fill="currentColor" fillRule="evenodd" d="M0 0h16v16H0zM5 5v6h6V5z" />
  </svg>
)
