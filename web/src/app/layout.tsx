import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ROSOrin Pro · Embodied AI con Gemini Live y JS (JSConf MX)',
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
      <head>
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600;700&family=Space+Grotesk:wght@700&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
