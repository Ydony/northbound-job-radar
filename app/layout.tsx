import type { Metadata } from 'next';
import { DM_Sans, Fraunces } from 'next/font/google';
import './globals.css';

/*
 * #141: the second half of the load flash. Until these arrive the page is laid out in
 * whatever the system offers, and everything moves when they land - the "bloated, then
 * normal" the owner described.
 *
 * `display: 'swap'` keeps the text readable meanwhile rather than invisible, and
 * `adjustFontFallback` is what stops the swap moving anything: Next generates a fallback
 * face with size-adjust, ascent and descent matched to the real one, so the fallback
 * occupies the same space and the substitution is a change of shape rather than of
 * layout. It is the default for next/font/google, but stating it here is the point of
 * this change - it is the thing that must not be turned off.
 */
const sans = DM_Sans({
  variable: '--font-sans',
  subsets: ['latin'],
  display: 'swap',
  adjustFontFallback: true,
  fallback: ['system-ui', 'Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'],
});
const display = Fraunces({
  variable: '--font-display',
  subsets: ['latin'],
  display: 'swap',
  adjustFontFallback: true,
  fallback: ['Georgia', 'Times New Roman', 'serif'],
});

export const metadata: Metadata = {
  robots: { index: false, follow: false, nosnippet: true, noimageindex: true },
  title: 'Ik ben een appel — English job filter',
  description: 'An English job-search filter for people who do not speak Dutch. Screens Netherlands and Switzerland vacancies and hides the ones that need a local language.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${sans.variable} ${display.variable}`}>{children}</body></html>;
}
