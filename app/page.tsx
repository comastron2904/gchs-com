'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import type { ExamSession } from '@/lib/types'
import styles from './page.module.css'

export default function Home() {
  const router = useRouter()
  const [session, setSession] = useState<ExamSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginId, setLoginId] = useState('')
  const [loginPw, setLoginPw] = useState('')
  const [loginErr, setLoginErr] = useState(false)
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    fetchActiveSession()
    const tick = setInterval(() => setNow(new Date()), 10000)

    // Realtime: session 변화 감지
    const channel = supabase
      .channel('home-session-watch')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exam_sessions' }, () => {
        fetchActiveSession()
      })
      .subscribe()

    return () => { supabase.removeChannel(channel); clearInterval(tick) }
  }, [])

  async function fetchActiveSession() {
    const { data } = await supabase
      .from('exam_sessions')
      .select('*')
      .eq('status', 'active')
      .order('started_at', { ascending: false })
      .limit(1)
      .single()
    setSession(data ?? null)
    setLoading(false)
  }

  function doLogin() {
    if (loginId.trim() === 'GCHS' && loginPw === '2026') {
      setLoginOpen(false)
      router.push('/teacher')
    } else {
      setLoginErr(true)
      setLoginPw('')
    }
  }

  function goStudent() {
    router.push('/student')
  }

  const isActive = session?.status === 'active'

  return (
    <div className={styles.app}>
      {/* 상단 바 */}
      <header className={styles.topbar}>
        <div className={styles.topLeft}>
          <span className={styles.siteName}>GCHS 컴퓨터실 제어</span>
          <span className={styles.siteSub}>3학년 2반 · 컴퓨터실 B</span>
        </div>
        <div className={styles.topRight}>
          <span className={`${styles.badge} ${isActive ? styles.badgeActive : styles.badgeIdle}`}>
            <span className={`${styles.dot} ${isActive ? styles.dotActive : ''}`} />
            {isActive ? '관리 중' : '대기 중'}
          </span>
          <button className={styles.btnOutline} onClick={() => setLoginOpen(true)}>
            교사 로그인
          </button>
        </div>
      </header>

      {/* 메인 */}
      <main className={styles.main}>
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <div className={`${styles.iconWrap} ${isActive ? styles.iconActive : styles.iconIdle}`}>
              {isActive ? '🟢' : '⬜'}
            </div>
            <div className={styles.cardTitleGroup}>
              <h1 className={styles.cardTitle}>
                {loading ? '확인 중...' : isActive ? '시험 관리 중' : '현재 관리 중이 아닙니다'}
              </h1>
              <p className={styles.cardDesc}>
                {isActive
                  ? `${session!.subject} · 교사가 현재 시험을 관리하고 있습니다.`
                  : '교사가 시험을 시작하면 이 화면이 자동으로 업데이트됩니다.'}
              </p>
            </div>
          </div>

          <div className={styles.infoGrid}>
            <div className={styles.infoCell}>
              <div className={styles.infoLabel}>현재 상태</div>
              <div className={styles.infoValue} style={{ color: isActive ? 'var(--green)' : 'var(--text-3)' }}>
                {isActive ? '관리 중' : '대기 중'}
              </div>
            </div>
            <div className={styles.infoCell}>
              <div className={styles.infoLabel}>담당 교사</div>
              <div className={styles.infoValue}>{isActive ? 'GCHS' : '—'}</div>
            </div>
            <div className={styles.infoCell}>
              <div className={styles.infoLabel}>시험 과목</div>
              <div className={styles.infoValue}>{isActive ? session!.subject : '—'}</div>
            </div>
            <div className={styles.infoCell}>
              <div className={styles.infoLabel}>시작 시각</div>
              <div className={styles.infoValue}>
                {isActive
                  ? new Date(session!.started_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
                  : '—'}
              </div>
            </div>
          </div>

          {isActive && (
            <button className={styles.btnPrimary} onClick={goStudent} style={{ marginTop: 8 }}>
              학생으로 참여하기
            </button>
          )}
          {!isActive && (
            <p className={styles.hint}>교사 로그인 후 시험을 시작할 수 있습니다.</p>
          )}
        </div>

        <p className={styles.clock}>
          {now.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })}{' '}
          {now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
        </p>
      </main>

      {/* 로그인 모달 */}
      {loginOpen && (
        <div className={styles.modalBg} onClick={() => setLoginOpen(false)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <h2 className={styles.modalTitle}>교사 로그인</h2>
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>아이디</label>
              <input
                type="text"
                value={loginId}
                onChange={e => { setLoginId(e.target.value); setLoginErr(false) }}
                placeholder="아이디 입력"
                onKeyDown={e => e.key === 'Enter' && doLogin()}
                autoFocus
              />
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>비밀번호</label>
              <input
                type="password"
                value={loginPw}
                onChange={e => { setLoginPw(e.target.value); setLoginErr(false) }}
                placeholder="비밀번호 입력"
                onKeyDown={e => e.key === 'Enter' && doLogin()}
              />
            </div>
            {loginErr && (
              <p className={styles.errMsg}>아이디 또는 비밀번호가 올바르지 않습니다.</p>
            )}
            <div className={styles.modalActions}>
              <button className={styles.btnOutline} onClick={() => setLoginOpen(false)}>취소</button>
              <button className={styles.btnNavy} onClick={doLogin}>로그인</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
