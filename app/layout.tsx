import type { Metadata } from 'next';
// Fonts ship inside the image, so air-gapped sites render the same as connected ones.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans-condensed/600.css';
import '@fontsource/ibm-plex-sans-condensed/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
import '../ui/styles.css';

export const metadata: Metadata = { title: 'AeroTrace Gate', description: 'Dual-layer DO-178C audit agents with a one-click approval gate.' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
