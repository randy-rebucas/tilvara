import { LangSwitch } from '@/components/lang-switch';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="band flex h-16 items-center justify-between px-6 text-white sm:px-8">
        <span className="text-[1.5rem] font-bold tracking-[0.04em]">Tilvara</span>
        <LangSwitch onBand />
      </header>
      <main className="mx-auto max-w-[1040px] px-4 py-8 sm:px-6 md:py-14">{children}</main>
    </div>
  );
}
