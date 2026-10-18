import type { Metadata } from 'next';
import { Archivo, Archivo_Narrow } from 'next/font/google';
import { I18nProvider } from '@/i18n/client';
import { getLang } from '@/i18n/server';
import './globals.css';

const archivo = Archivo({ subsets: ['latin'], variable: '--font-archivo', display: 'swap' });
const archivoNarrow = Archivo_Narrow({ subsets: ['latin'], weight: ['500', '600'], variable: '--font-archivo-narrow', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Tilvara back office', template: '%s · Tilvara' },
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = await getLang();
  return (
    <html lang={lang === 'fil' ? 'fil' : 'en'} className={`${archivo.variable} ${archivoNarrow.variable}`}>
      <body>
        <I18nProvider lang={lang}>{children}</I18nProvider>
      </body>
    </html>
  );
}
