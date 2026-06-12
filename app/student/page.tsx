'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import type { ExamSession, StudentConnection } from '@/lib/types'
import styles from './student.module.css'

// 전체화면 진입 시도 (사용자 제스처 없이는 브라우저가 거부하므로 클릭에도 연결)
function requestFS() {
  const el = document.documentElement
  if (el.requestFullscreen) el.requestFullscreen()
  else if ((el as any).webkitRequestFullscreen) (el as any).webkitRequestFullscreen()
}

function isFullscreen() {
  return !!(
    document.fullscreenElement ||
    (document as any).webkitFullscreenElement
  )
}

export default function StudentPage() {
  const router = useRouter()
  const [session, setSession] = useState<ExamSession | null>(null)
  const [connection, setConnection] = useState<StudentConnection | null>(null)
  const [loading, setLoading] = useState(true)
  const [showWarning, setShowWarning] = useState(false)
  const [warningMsg, setWarningMsg] = useState('')
  const [warningCount, setWarningCount] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  // 전체화면 이탈 후 복귀 유도 오버레이
  const [showFsPrompt, setShowFsPrompt] = useState(false)
  const connectionRef = useRef<StudentConnection | null>(null)
  const sessionRef = useRef<ExamSession | null>(null)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const heartbeatRef = useRef<NodeJS.Timeout | null>(null)
  // 전체화면 이탈 → 즉시 재진입 시도 타이머
  const fsRetryRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    init()
    return () => { cleanup() }
  }, [])

  async function init() {
    const { data: sess } = await supabase
      .from('exam_sessions')
      .select('*')
      .eq('status', 'active')
      .order('started_at', { ascending: false })
      .limit(1)
      .single()

    if (!sess) { setLoading(false); return }

    setSession(sess)
    sessionRef.current = sess

    const { count } = await supabase
      .from('student_connections')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', sess.id)
      .neq('status', 'disconnected')

    const seatNumber = (count ?? 0) + 1
    const pcLabel = `PC-${String(seatNumber).padStart(2, '0')}`

    const { data: conn } = await supabase
      .from('student_connections')
      .insert({ session_id: sess.id, seat_number: seatNumber, pc_label: pcLabel, status: 'active', is_focused: true })
      .select()
      .single()

    if (!conn) { setLoading(false); return }

    setConnection(conn)
    connectionRef.current = conn
    await logEvent('connected', `${pcLabel} 접속`)

    const startTime = new Date(sess.started_at).getTime()
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }, 1000)

    heartbeatRef.current = setInterval(async () => {
      if (!connectionRef.current) return
      await supabase
        .from('student_connections')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', connectionRef.current.id)
    }, 30000)

    supabase
      .channel('student-session-watch')
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'exam_sessions',
        filter: `id=eq.${sess.id}`,
      }, payload => {
        if (payload.new.status === 'ended') {
          // 전체화면 해제 후 홈으로
          if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
          cleanup()
          router.push('/')
        }
      })
      .subscribe()

    setLoading(false)

    // 이벤트 등록
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('focus', handleWindowFocus)
    window.addEventListener('beforeunload', handleBeforeUnload)
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange)
    // 시스템 키 감지 (Windows 키 등 — 실제 preventDefault는 안 되지만 로그는 가능)
    document.addEventListener('keydown', handleKeyDown)

    // 전체화면 진입 (사용자 제스처 맥락에서 호출되어야 허용)
    // 로딩 후 짧은 딜레이로 시도
    setTimeout(() => { requestFS() }, 300)
  }

  async function logEvent(eventType: string, detail?: string) {
    const conn = connectionRef.current
    const sess = sessionRef.current
    if (!conn || !sess) return
    await supabase.from('activity_logs').insert({
      session_id: sess.id,
      connection_id: conn.id,
      seat_number: conn.seat_number,
      event_type: eventType,
      detail: detail ?? null,
    })
  }

  async function updateConnectionStatus(status: string, isFocused: boolean) {
    const conn = connectionRef.current
    if (!conn) return
    const updated = { ...conn, status, is_focused: isFocused } as StudentConnection
    setConnection(updated)
    connectionRef.current = updated
    await supabase
      .from('student_connections')
      .update({ status, is_focused: isFocused, last_seen_at: new Date().toISOString() })
      .eq('id', conn.id)
  }

  // 전체화면 변화 감지
  const handleFullscreenChange = useCallback(async () => {
    if (!isFullscreen()) {
      // 전체화면 이탈
      setShowFsPrompt(true)
      setWarningCount(prev => prev + 1)
      await updateConnectionStatus('warning', false)
      await logEvent('window_blur', '전체화면 이탈 (ESC 또는 시스템 키)')

      // 3초 후 자동 재진입 시도 (사용자가 버튼 안 누를 경우 대비)
      if (fsRetryRef.current) clearTimeout(fsRetryRef.current)
      fsRetryRef.current = setTimeout(() => {
        requestFS()
        setShowFsPrompt(false)
      }, 3000)
    } else {
      // 전체화면 복귀
      setShowFsPrompt(false)
      if (fsRetryRef.current) clearTimeout(fsRetryRef.current)
      await updateConnectionStatus('active', true)
      await logEvent('window_focus', '전체화면 복귀')
    }
  }, [])

  const handleVisibilityChange = useCallback(async () => {
    if (document.hidden) {
      setWarningMsg('다른 탭 또는 창으로 이동했습니다.\n시험 중에는 이 페이지를 유지해야 합니다.')
      setShowWarning(true)
      setWarningCount(prev => prev + 1)
      await updateConnectionStatus('warning', false)
      await logEvent('tab_hidden', '탭 숨김 감지')
    } else {
      // 복귀 시 이전 탭 URL 체크 (document.referrer 또는 performance.navigation)
      const keywords = sessionRef.current?.blocked_keywords ?? []
      if (keywords.length > 0) {
        // 브라우저가 허용하는 범위에서 직전 URL 확인
        const referrer = document.referrer.toLowerCase()
        const matched = keywords.find(kw => referrer.includes(kw))
        if (matched) {
          setWarningMsg(`차단된 사이트를 방문했습니다: "${matched}"\n이 행동은 교사에게 기록됩니다.`)
          setShowWarning(true)
          setWarningCount(prev => prev + 1)
          await updateConnectionStatus('warning', false)
          await logEvent('blocked_site', `차단 키워드 감지: ${matched} (${document.referrer})`)
          setTimeout(() => { if (!isFullscreen()) requestFS() }, 200)
          return
        }
      }
      setShowWarning(false)
      setTimeout(() => { if (!isFullscreen()) requestFS() }, 200)
      await updateConnectionStatus('active', true)
      await logEvent('tab_visible', '탭 복귀')
    }
  }, [])

  const handleWindowBlur = useCallback(async () => {
    if (document.hidden) return
    setWarningMsg('다른 창으로 전환되었습니다.\n시험 중에는 이 창을 유지해야 합니다.')
    setShowWarning(true)
    setWarningCount(prev => prev + 1)
    await updateConnectionStatus('warning', false)
    await logEvent('window_blur', '다른 창으로 전환')
  }, [])

  const handleWindowFocus = useCallback(async () => {
    setShowWarning(false)
    setTimeout(() => { if (!isFullscreen()) requestFS() }, 200)
    await updateConnectionStatus('active', true)
    await logEvent('window_focus', '창 복귀')
  }, [])

  // 시스템 키 감지 — 실제 막을 수는 없지만 로그 기록
  const handleKeyDown = useCallback(async (e: KeyboardEvent) => {
    const blockedKeys: Record<string, string> = {
      'Meta': 'Windows 키',
      'OS': 'Windows 키',
      'Escape': 'ESC 키',
    }
    const label = blockedKeys[e.key]
    if (label) {
      // ESC는 전체화면 해제 막기 불가 → fullscreenchange 가 처리
      // Windows 키는 OS 레벨이라 preventDefault 안 됨, 로그만
      await logEvent('window_blur', `${label} 입력 감지`)
    }
    // Alt+Tab, Alt+F4 등 조합키
    if (e.altKey && (e.key === 'Tab' || e.key === 'F4')) {
      await logEvent('window_blur', `Alt+${e.key} 입력 감지`)
    }
  }, [])

  const handleBeforeUnload = useCallback((e: BeforeUnloadEvent) => {
    const conn = connectionRef.current
    const sess = sessionRef.current
    if (!conn || !sess) return

    // 시험 중 탭 닫기/새로고침 차단 — 브라우저 확인 다이얼로그 강제 표시
    e.preventDefault()
    e.returnValue = '시험이 진행 중입니다. 정말 이 페이지를 나가시겠습니까?'

    navigator.sendBeacon('/api/log-disconnect', JSON.stringify({
      session_id: sess.id,
      connection_id: conn.id,
      seat_number: conn.seat_number,
      event_type: 'disconnected',
      detail: '브라우저 닫힘 또는 페이지 이탈 시도',
    }))
  }, [])

  function cleanup() {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    window.removeEventListener('blur', handleWindowBlur)
    window.removeEventListener('focus', handleWindowFocus)
    window.removeEventListener('beforeunload', handleBeforeUnload)
    document.removeEventListener('fullscreenchange', handleFullscreenChange)
    document.removeEventListener('webkitfullscreenchange', handleFullscreenChange)
    document.removeEventListener('keydown', handleKeyDown)
    if (timerRef.current) clearInterval(timerRef.current)
    if (heartbeatRef.current) clearInterval(heartbeatRef.current)
    if (fsRetryRef.current) clearTimeout(fsRetryRef.current)
    if (connectionRef.current) {
      supabase
        .from('student_connections')
        .update({ status: 'disconnected' })
        .eq('id', connectionRef.current.id)
        .then(() => {})
    }
  }

  function formatTime(s: number) {
    const h = Math.floor(s / 3600).toString().padStart(2, '0')
    const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0')
    const sec = (s % 60).toString().padStart(2, '0')
    return `${h}:${m}:${sec}`
  }

  if (loading) return <div className={styles.loading}>접속 중...</div>

  if (!session) {
    return (
      <div className={styles.noSession}>
        <div className={styles.noSessionCard}>
          <h2>진행 중인 시험이 없습니다</h2>
          <p>교사가 시험을 시작하면 이 페이지에서 참여할 수 있습니다.</p>
          <button className={styles.btnOutline} onClick={() => router.push('/')}>돌아가기</button>
        </div>
      </div>
    )
  }

  return (
    // 클릭 시 전체화면 재진입 (사용자 제스처)
    <div className={styles.app} onClick={() => { if (!isFullscreen()) requestFS() }}>

      {/* 전체화면 이탈 오버레이 — 3초 카운트다운 후 자동 복귀 */}
      {showFsPrompt && (
        <div className={styles.fsOverlay}>
          <div className={styles.fsBox}>
            <div className={styles.fsIcon}>🔒</div>
            <h2 className={styles.fsTitle}>전체화면에서 이탈했습니다</h2>
            <p className={styles.fsMsg}>
              시험 중에는 전체화면을 유지해야 합니다.<br/>
              3초 후 자동으로 복귀됩니다.
            </p>
            <p className={styles.fsNote}>이 행동은 교사 화면에 기록되었습니다.</p>
            <button
              className={styles.btnReturn}
              onClick={e => { e.stopPropagation(); requestFS(); setShowFsPrompt(false) }}
            >
              지금 바로 전체화면으로 돌아가기
            </button>
          </div>
        </div>
      )}

      {/* 탭/창 전환 경고 팝업 */}
      {showWarning && !showFsPrompt && (
        <div className={styles.warningOverlay}>
          <div className={styles.warningBox}>
            <div className={styles.warningIcon}>⚠</div>
            <h2 className={styles.warningTitle}>주의</h2>
            <p className={styles.warningMsg}>{warningMsg}</p>
            <p className={styles.warningNote}>이 행동은 교사 화면에 기록됩니다.</p>
            <button
              className={styles.btnReturn}
              onClick={e => { e.stopPropagation(); requestFS(); setShowWarning(false) }}
            >
              시험 화면으로 돌아가기
            </button>
          </div>
        </div>
      )}

      {/* 상단 바 */}
      <header className={styles.topbar}>
        <div className={styles.topLeft}>
          <span className={styles.siteName}>GCHS 컴퓨터실 제어</span>
          <span className={styles.siteSub}>{session.subject}</span>
        </div>
        <div className={styles.topRight}>
          {connection && <span className={styles.seatBadge}>{connection.pc_label}</span>}
          <span className={styles.timerBadge}>{formatTime(elapsed)}</span>
          {warningCount > 0 && <span className={styles.warnBadge}>경고 {warningCount}회</span>}
        </div>
      </header>

      {/* 메인 */}
      <main className={styles.main}>
        <div className={styles.statusCard}>
          <div className={styles.statusIcon}>🟢</div>
          <h1 className={styles.statusTitle}>시험이 진행 중입니다</h1>
          <p className={styles.statusDesc}>
            전체화면이 강제 유지됩니다.<br/>
            이탈 시 교사에게 즉시 알림이 전송됩니다.
          </p>
          <div className={styles.infoRow}>
            <div className={styles.infoItem}>
              <span className={styles.infoLabel}>내 순번</span>
              <span className={styles.infoVal}>{connection?.pc_label ?? '—'}</span>
            </div>
            <div className={styles.infoItem}>
              <span className={styles.infoLabel}>경과 시간</span>
              <span className={styles.infoVal}>{formatTime(elapsed)}</span>
            </div>
            <div className={styles.infoItem}>
              <span className={styles.infoLabel}>경고 횟수</span>
              <span className={styles.infoVal} style={{ color: warningCount > 0 ? 'var(--red)' : 'inherit' }}>
                {warningCount}회
              </span>
            </div>
          </div>
        </div>
        <p className={styles.notice}>시험이 종료되면 자동으로 이 화면에 표시됩니다.</p>
      </main>
    </div>
  )
}
