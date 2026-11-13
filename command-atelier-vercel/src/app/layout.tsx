export const metadata = {
  title: 'Command Atelier — Action, Routine & Study Decision System',
  description: 'Single-focus action, syllabus, and study execution system with Gemini voice-controlled AI Co-Pilot.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
