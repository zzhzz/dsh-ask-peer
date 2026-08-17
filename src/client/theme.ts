/**
 * dsh's web app exposes semantic colors as CSS variables (--dsw-alias-*) that
 * flip automatically with the host's light/dark mode (the app redefines the
 * underlying --dsw-static-* palette on body[data-ds-dark-theme]). Using them
 * here makes the ask-peer UI follow dsh's theme; the fallbacks keep the
 * plugin readable even if a host does not define the tokens.
 */
export function theme(variable: string, fallback: string): string {
  return `var(${variable}, ${fallback})`
}

export const themeTokens = {
  text: theme('--dsw-alias-label-primary', '#1f2328'),
  textSecondary: theme('--dsw-alias-label-secondary', '#1f2328'),
  muted: theme('--dsw-alias-label-tertiary', '#667'),
  border: theme('--dsw-alias-border-l3', '#d8dee6'),
  borderInput: theme('--dsw-alias-border-l3', '#c3cbd6'),
  blockBg: theme('--dsw-alias-bg-layer-2', '#fbfcfe'),
  inputBg: theme('--dsw-alias-bg-layer-3', '#ffffff'),
  buttonBg: theme('--dsw-alias-button-ghost-active-fill', '#ffffff'),
  primaryBg: theme('--dsw-alias-button-primary-fill', '#1f6feb'),
  primaryText: theme('--dsw-alias-label-primary-foreground', '#ffffff'),
  error: theme('--dsw-alias-state-error-primary', '#c62828'),
}
