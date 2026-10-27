import type { Metadata } from 'next';
import './globals.css';
import { ApiKeyBoot } from '@/components/ApiKeyBoot';

export const metadata: Metadata = {
  title: 'ROSOrin Pro · De Web a Physical AI con Gemini Live y JS (JSConf MX)',
  description:
    'Orquestando audio, video y telemetría sobre ROS 2 desde JavaScript con Gemini Live y Rust.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      {/* Fonts are loaded once from globals.css (@import of Google Fonts). */}
      <body>
        <ApiKeyBoot />
        {children}
      </body>
    </html>
  );
}
