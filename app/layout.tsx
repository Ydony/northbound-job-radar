import type { Metadata } from 'next';
import { DM_Sans, Fraunces } from 'next/font/google';
import './globals.css';

const sans = DM_Sans({ variable: '--font-sans', subsets: ['latin'] });
const display = Fraunces({ variable: '--font-display', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Ik Engels — English Job Radar',
  description: 'Strict English-language screening and CV matching for Swiss and Netherlands roles.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${sans.variable} ${display.variable}`}>{children}</body></html>;
}
