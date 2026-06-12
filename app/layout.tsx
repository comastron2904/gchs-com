import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'GCHS 컴퓨터실 제어',
  description: 'GCHS 시험 감독 시스템',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  )
}
