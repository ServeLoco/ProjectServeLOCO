/**
 * ServeLoco Color Tokens
 *
 * Background  : off-white / white
 * Text        : deep charcoal
 * Primary     : warm amber-orange (original — not Blinkit/Swiggy yellow)
 * Success     : cool teal-green
 */

const palette = {
  // Neutrals
  white: '#FFFFFF',
  offWhite: '#F9F4E6',    // Base background (subtle warm cream / golden tint)
  grey50: '#E6E8EC',      // Inset inputs / fallback canvas background
  grey100: '#DFE2E6',     // Disabled / borders
  grey200: '#C7CCD4',     // Soft borders
  grey300: '#9CA3AF',     // Inactive navigation / hints
  grey400: '#6B7280',     // Muted text (cool grey)
  grey500: '#4B5563',
  grey600: '#374151',
  charcoal: '#0E1116',    // Ink/dark text
  black: '#000000',

  // Primary — Ink/dark
  primary50: '#F3F4F6',
  primary100: '#E5E7EB',
  primary200: '#D1D5DB',
  primary300: '#9CA3AF',
  primary400: '#4B5563',
  primary500: '#0E1116',  // Near-black ink
  primary600: '#05070A',
  primary700: '#000000',

  // Success — Green
  success50: '#EAFDF5',
  success100: '#C6F4DF',
  success200: '#7FE7B9',
  success300: '#3FE09D',
  success500: '#1FB574',  // Success green
  success600: '#179E62',
  success700: '#0E814F',

  // Error — Danger Red
  error50: '#FFF0F0',
  error300: '#FCA5A5',
  error500: '#E5484D',  // Danger red
  error600: '#C93B40',

  // Warning — Amber
  warning300: '#FDE047',
  warning500: '#F4A62A',  // Warning amber

  // Info — Blue
  info300: '#93C5FD',
  info500: '#3B82F6',  // Info blue

  // Saffron/Orange — Highlight/Offer
  saffron300: '#FFBB99',
  saffron500: '#FF7A3A',  // Saffron highlight
  saffron600: '#E05A1A',

  // Overlay
  overlayLight: 'rgba(0,0,0,0.02)',
  overlayMid: 'rgba(0,0,0,0.30)',
  overlayDark: 'rgba(0,0,0,0.50)',
  overlayWhite: 'rgba(255,255,255,0.92)',
};

export const colors = {
  white: palette.white,
  grey100: palette.grey100,

  // --- Backgrounds ---
  bgApp: palette.offWhite,
  bgSurface: palette.white,
  bgCard: palette.white,
  bgInput: palette.grey50,
  bgDisabled: palette.grey100,
  bgSkeletonBase: palette.grey100,
  bgSkeletonShimmer: palette.grey200,

  textPrimary: palette.charcoal,
  textSecondary: palette.grey400,
  textTertiary: palette.grey300,
  textMuted: palette.grey400,
  textHint: palette.grey300,
  textDisabled: palette.grey300,
  textInverse: palette.white,
  textLink: palette.info500,
  textError: palette.error500,
  textSuccess: palette.success500,

  // --- Primary Accent (near-black ink) ---
  primary: palette.primary500,
  primaryLight: palette.primary100,
  primaryDark: palette.primary600,
  primaryText: palette.white,

  // --- Success Accent (cool green) ---
  success: palette.success500,
  success100: palette.success100,
  successLight: palette.success50,
  successDark: palette.success600,
  successText: palette.white,

  // --- Error ---
  error: palette.error500,
  errorLight: palette.error50,
  errorBorder: palette.error300,

  // --- Warning ---
  warning: palette.warning500,
  warningLight: '#FFF6DC',

  // --- Info ---
  info: palette.info500,
  infoLight: '#EFF6FF',

  // --- Borders ---
  border: palette.grey100,
  borderStrong: palette.grey200,
  borderFocus: palette.primary400,

  // --- Navigation ---
  navBg: palette.white,
  navActive: palette.primary500,
  navInactive: palette.grey300,

  // --- Overlays ---
  overlay: palette.overlayMid,
  overlayDark: palette.overlayDark,
  overlayLight: palette.overlayLight,

  // --- Misc ---
  shimmerFrom: palette.grey100,
  shimmerTo: palette.grey200,
  badgeBg: palette.saffron500,
  badgeText: palette.white,
  divider: palette.grey100,
  shadow: palette.black,

  // --- 3D Buttons & Gradients (gradient-ready color pairs) ---
  btnDarkStart: '#2A303D',       // Ink gradient top
  btnDarkEnd: '#0E1116',         // Ink/dark button base
  btnSuccessStart: '#3FE09D',    // Soft green top
  btnSuccessEnd: '#1FB574',      // Success green base
  btnHighlightStart: '#FF9A66',  // Soft saffron top
  btnHighlightEnd: '#FF7A3A',    // Saffron highlight base

  // Saffron / orange highlight tokens (added)
  saffron: palette.saffron500,
  saffronLight: '#FFF2EB',
  saffron300: palette.saffron300,
  saffronDark: palette.saffron600,

  // --- Dashboard / Home hero header (added) ---
  brandGradientStart: '#FFB07A',   // Soft saffron top of header
  brandGradientEnd:   '#FF7A3A',   // Saffron bottom
  brandInk:           '#1A1F2B',   // Deep ink for header text on brand
  glassOverlay:       'rgba(255,255,255,0.18)',
  glassBorder:        'rgba(255,255,255,0.28)',
  surfaceMuted:       '#F5F6F9',   // Soft inner surface for skeleton / search bg
  badgeHotBg:         'rgba(255, 122, 58, 0.12)',
  badgeHotText:       '#C8490F',   // Deep saffron for HOT pill

  // Raw palette for edge cases
  palette,
};
