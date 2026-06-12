'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import type { ExamSession, StudentConnection } from '@/lib/types'
import styles from './student.module.css'

export default function StudentPage() {
  const router = useRouter()
  const [session, setSession] = useState<ExamSession | null>(null)
  const [connection, setConnection] = useState<StudentConnection | null>(null)
  const [loading, setLoading] = useState(true)
  const [nameInput, setNameInput] = useState('')
  const [nameSubmitted, setNameSubmitted] = useState(false)
  const [nameError, setNameError] = useState('')
  const [joining, setJoining] = useState(false)

  const [showWarning, setShowWarning] = useState(false)
  const [warningMsg, setWarningMsg] = useState('')
  const [warningCount, setWarningCount] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const connectionRef = useRef<StudentConnection | null>(null)
  const sessionRef = useRef<ExamSession | null>(null)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const heartbeatRef = useRef<NodeJS.Timeout | null>(null)
  const hiddenAtRef = useRef<number | null>(null)
  const examUrlRef = useRef<string>('')

  // URL 추적을 위한 refs
  const lastKnownUrlRef = useRef<string>('')
  const visibilityJustFiredRef = useRef(false)
  const urlPollRef = useRef<NodeJS.Timeout | null>(null)
  const performanceObserverRef = useRef<PerformanceObserver | null>(null)

  useEffect(() => {
    examUrlRef.current = window.location.href
    lastKnownUrlRef.current = window.location.href
    fetchSession()
  }, [])

  async function fetchSession() {
    const { data: sess } = await supabase
      .from('exam_sessions')
      .select('*')
      .eq('status', 'active')
      .order('started_at', { ascending: false })
      .limit(1)
      .single()
    setSession(sess ?? null)
    setLoading(false)
  }

  async function handleJoin() {
    const name = nameInput.trim()
    if (!name) { setNameError('이름을 입력해주세요.'); return }
    if (!session) return
    setJoining(true)
    setNameError('')

    const { count } = await supabase
      .from('student_connections')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', session.id)
      .neq('status', 'disconnected')

    const seatNumber = (count ?? 0) + 1
    const pcLabel = `PC-${String(seatNumber).padStart(2, '0')}`

    const { data: conn } = await supabase
      .from('student_connections')
      .insert({
        session_id: session.id,
        seat_number: seatNumber,
        pc_label: pcLabel,
        student_name: name,
        status: 'active',
        is_focused: true,
      })
      .select()
      .single()

    if (!conn) { setJoining(false); setNameError('입장 중 오류가 발생했습니다. 다시 시도해주세요.'); return }

    setConnection(conn)
    connectionRef.current = conn
    sessionRef.current = session
    setNameSubmitted(true)
    setJoining(false)

    await logEvent('connected', `${name} (${pcLabel}) 접속`)

    const startTime = new Date(session.started_at).getTime()
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
        filter: `id=eq.${session.id}`,
      }, payload => {
        if (payload.new.status === 'ended') {
          cleanup()
          router.push('/')
        }
      })
      .subscribe()

    // 이벤트 리스너 등록
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('focus', handleWindowFocus)
    window.addEventListener('beforeunload', handleBeforeUnload)
    document.addEventListener('keydown', handleKeyDown)

    // ── URL 변경 감지 시작 ──
    startUrlTracking()
  }

  // ────────────────────────────────────────────────
  // URL 변경 감지: PerformanceObserver + popstate + 폴링
  // ────────────────────────────────────────────────
  function startUrlTracking() {
    // 1) popstate (뒤로/앞으로 탐색)
    window.addEventListener('popstate', handleUrlChange)

    // 2) history.pushState / replaceState 패치
    const origPush = history.pushState.bind(history)
    const origReplace = history.replaceState.bind(history)

    history.pushState = function(...args) {
      origPush(...args)
      handleUrlChange()
    }
    history.replaceState = function(...args) {
      origReplace(...args)
      handleUrlChange()
    }

    // 3) PerformanceObserver: navigation 항목으로 외부 사이트 이동 감지
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const nav = entry as PerformanceNavigationTiming
          if (nav.name && nav.name !== lastKnownUrlRef.current) {
            handleExternalNavigation(nav.name)
          }
        }
      })
      po.observe({ type: 'navigation', buffered: true })
      performanceObserverRef.current = po
    } catch {
      // PerformanceObserver 미지원 환경 무시
    }

    // 4) 폴링 백업: 500ms마다 현재 URL 체크
    urlPollRef.current = setInterval(() => {
      const current = window.location.href
      if (current !== lastKnownUrlRef.current) {
        handleUrlChange()
      }
    }, 500)
  }

  // 같은 출처(same-origin) URL 변경 처리
  const handleUrlChange = useCallback(async () => {
    const newUrl = window.location.href
    const oldUrl = lastKnownUrlRef.current
    if (newUrl === oldUrl) return
    lastKnownUrlRef.current = newUrl

    const keywords = sessionRef.current?.blocked_keywords ?? []
    const matched = keywords.find(kw => newUrl.toLowerCase().includes(kw))

    if (matched) {
      setWarningMsg(`차단된 키워드가 포함된 주소입니다: "${matched}"\n이 행동은 교사에게 기록됩니다.`)
      setShowWarning(true)
      setWarningCount(prev => prev + 1)
      await updateConnectionStatus('warning', false)
      await logEvent('blocked_site', `차단 키워드 "${matched}" 포함 URL: ${newUrl}`)
    } else {
      const from = getDomain(oldUrl)
      const to = getDomain(newUrl)
      await logEvent('url_change', `${from} → ${to}`)
    }
  }, [])

  // 외부 사이트(cross-origin) 탐색 처리
  async function handleExternalNavigation(newUrl: string) {
    const oldUrl = lastKnownUrlRef.current
    if (newUrl === oldUrl) return
    lastKnownUrlRef.current = newUrl

    const keywords = sessionRef.current?.blocked_keywords ?? []
    const matched = keywords.find(kw => newUrl.toLowerCase().includes(kw))

    if (matched) {
      setWarningMsg(`차단된 키워드가 포함된 주소입니다: "${matched}"\n이 행동은 교사에게 기록됩니다.`)
      setShowWarning(true)
      setWarningCount(prev => prev + 1)
      await updateConnectionStatus('warning', false)
      await logEvent('blocked_site', `차단 키워드 "${matched}" 포함 URL: ${getDomain(newUrl)}`)
    } else {
      const from = getDomain(oldUrl)
      const to = getDomain(newUrl)
      await logEvent('url_change', `${from} → ${to}`)
    }
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

  function getDomain(url: string): string {
    try { return new URL(url).hostname } catch { return url || '알 수 없음' }
  }

  // ── visibilitychange: 탭 전환 감지 ──
  const handleVisibilityChange = useCallback(async () => {
    visibilityJustFiredRef.current = true
    setTimeout(() => { visibilityJustFiredRef.current = false }, 100)

    if (document.hidden) {
      hiddenAtRef.current = Date.now()
      await updateConnectionStatus('active', false)
      await logEvent('tab_hidden', `탭 이탈: ${getDomain(examUrlRef.current)}`)
    } else {
      const returnedAt = Date.now()
      const duration = hiddenAtRef.current ? Math.round((returnedAt - hiddenAtRef.current) / 1000) : null
      hiddenAtRef.current = null
      const referrer = document.referrer || ''
      const durationStr = duration !== null ? ` (${duration}초 체류)` : ''
      const keywords = sessionRef.current?.blocked_keywords ?? []

      const matchedRef = keywords.length > 0 && referrer
        ? keywords.find(kw => referrer.toLowerCase().includes(kw))
        : null
      const currentUrl = window.location.href
      const matchedCurrent = keywords.length > 0
        ? keywords.find(kw => currentUrl.toLowerCase().includes(kw))
        : null

      if (matchedRef) {
        const detail = `차단 사이트 방문: ${getDomain(referrer)}${durationStr} → 시험화면 복귀`
        setWarningMsg(`차단된 사이트를 방문했습니다: "${matchedRef}"\n이 행동은 교사에게 기록됩니다.`)
        setShowWarning(true)
        setWarningCount(prev => prev + 1)
        await updateConnectionStatus('warning', false)
        await logEvent('blocked_site', detail)
      } else if (matchedCurrent) {
        setWarningMsg(`차단된 키워드가 포함된 주소입니다: "${matchedCurrent}"\n이 행동은 교사에게 기록됩니다.`)
        setShowWarning(true)
        setWarningCount(prev => prev + 1)
        await updateConnectionStatus('warning', false)
        await logEvent('blocked_site', `차단 키워드 "${matchedCurrent}" 포함 URL: ${getDomain(currentUrl)}`)
      } else {
        const from = referrer ? getDomain(referrer) : '알 수 없음'
        const to = getDomain(examUrlRef.current)
        const detail = referrer
          ? `탭 복귀: ${from} → ${to}${durationStr}`
          : `탭 복귀${durationStr}`
        setShowWarning(false)
        await updateConnectionStatus('active', true)
        await logEvent('tab_visible', detail)
      }

      lastKnownUrlRef.current = window.location.href
    }
  }, [])

  // ── window blur: 다른 앱/창으로 전환 감지 ──
  const handleWindowBlur = useCallback(async () => {
    // visibilitychange와 동시에 발생한 경우 중복 방지
    if (visibilityJustFiredRef.current) return
    if (document.hidden) return
    hiddenAtRef.current = Date.now()
    await updateConnectionStatus('active', false)
    await logEvent('window_blur', `창 전환: ${getDomain(examUrlRef.current)} → 다른 창`)
  }, [])

  // ── window focus: 창 복귀 감지 ──
  const handleWindowFocus = useCallback(async () => {
    if (visibilityJustFiredRef.current) return
    const returnedAt = Date.now()
    const duration = hiddenAtRef.current ? Math.round((returnedAt - hiddenAtRef.current) / 1000) : null
    hiddenAtRef.current = null
    const durationStr = duration !== null ? ` (${duration}초 후 복귀)` : ''

    const currentUrl = window.location.href
    const keywords = sessionRef.current?.blocked_keywords ?? []
    const matched = keywords.find(kw => currentUrl.toLowerCase().includes(kw))

    if (matched) {
      setWarningMsg(`차단된 키워드가 포함된 주소입니다: "${matched}"\n이 행동은 교사에게 기록됩니다.`)
      setShowWarning(true)
      setWarningCount(prev => prev + 1)
      await updateConnectionStatus('warning', false)
      await logEvent('blocked_site', `차단 키워드 "${matched}" 포함 URL: ${getDomain(currentUrl)}`)
    } else {
      setShowWarning(false)
      await updateConnectionStatus('active', true)
      await logEvent('window_focus', `창 복귀: → ${getDomain(examUrlRef.current)}${durationStr}`)
    }

    lastKnownUrlRef.current = currentUrl
  }, [])

  const handleKeyDown = useCallback(async (e: KeyboardEvent) => {
    const blockedKeys: Record<string, string> = { 'Meta': 'Windows 키', 'OS': 'Windows 키' }
    const label = blockedKeys[e.key]
    if (label) await logEvent('window_blur', `${label} 입력 감지`)
    if (e.altKey && (e.key === 'Tab' || e.key === 'F4')) {
      await logEvent('window_blur', `Alt+${e.key} 입력 감지`)
    }
  }, [])

  const handleBeforeUnload = useCallback((e: BeforeUnloadEvent) => {
    const conn = connectionRef.current
    const sess = sessionRef.current
    if (!conn || !sess) return
    e.preventDefault()
    e.returnValue = '시험이 진행 중입니다. 정말 이 페이지를 나가시겠습니까?'
    navigator.sendBeacon('/api/log-disconnect', JSON.stringify({
      session_id: sess.id,
      connection_id: conn.id,
      seat_number: conn.seat_number,
      event_type: 'disconnected',
      detail: `페이지 이탈 시도: ${examUrlRef.current}`,
    }))
  }, [])

  function cleanup() {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    window.removeEventListener('blur', handleWindowBlur)
    window.removeEventListener('focus', handleWindowFocus)
    window.removeEventListener('beforeunload', handleBeforeUnload)
    document.removeEventListener('keydown', handleKeyDown)
    window.removeEventListener('popstate', handleUrlChange)
    if (timerRef.current) clearInterval(timerRef.current)
    if (heartbeatRef.current) clearInterval(heartbeatRef.current)
    if (urlPollRef.current) clearInterval(urlPollRef.current)
    if (performanceObserverRef.current) performanceObserverRef.current.disconnect()
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

  if (!nameSubmitted) {
    return (
      <div className={styles.noSession}>
        <div className={styles.joinCard}>
          <div className={styles.joinHeader}>
            <span className={styles.joinSubject}>{session.subject}</span>
            <h2 className={styles.joinTitle}>시험 입장</h2>
          </div>
          <div className={styles.joinBody}>
            <label className={styles.joinLabel}>이름</label>
            <input
              className={styles.joinInput}
              type="text"
              placeholder="홍길동"
              value={nameInput}
              onChange={e => { setNameInput(e.target.value); setNameError('') }}
              onKeyDown={e => e.key === 'Enter' && handleJoin()}
              autoFocus
              maxLength={20}
            />
            {nameError && <p className={styles.joinError}>{nameError}</p>}
            <button
              className={styles.joinBtn}
              onClick={handleJoin}
              disabled={joining || !nameInput.trim()}
            >
              {joining ? '입장 중...' : '입장하기'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.app}>
      {showWarning && (
        <div className={styles.warningOverlay}>
          <div className={styles.warningBox}>
            <div className={styles.warningIcon}>⚠</div>
            <h2 className={styles.warningTitle}>주의</h2>
            <p className={styles.warningMsg}>{warningMsg}</p>
            <p className={styles.warningNote}>이 행동은 교사 화면에 기록됩니다.</p>
            <button className={styles.btnReturn} onClick={() => setShowWarning(false)}>
              시험 화면으로 돌아가기
            </button>
          </div>
        </div>
      )}

      <header className={styles.topbar}>
        <div className={styles.topLeft}>
          <span className={styles.siteName}>GCHS 컴퓨터실 제어</span>
          <span className={styles.siteSub}>{session.subject}</span>
        </div>
        <div className={styles.topRight}>
          {connection && (
            <span className={styles.seatBadge}>
              {connection.student_name} ({connection.pc_label})
            </span>
          )}
          <span className={styles.timerBadge}>{formatTime(elapsed)}</span>
          {warningCount > 0 && <span className={styles.warnBadge}>경고 {warningCount}회</span>}
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.statusCard}>
          <div className={styles.statusIcon}>🟢</div>
          <h1 className={styles.statusTitle}>시험이 진행 중입니다</h1>
          <p className={styles.statusDesc}>
            차단된 키워드가 포함된 사이트에 접속하면 교사에게 즉시 알림이 전송됩니다.
          </p>
          <div className={styles.infoRow}>
            <div className={styles.infoItem}>
              <span className={styles.infoLabel}>이름</span>
              <span className={styles.infoVal}>{connection?.student_name ?? '—'}</span>
            </div>
            <div className={styles.infoItem}>
              <span className={styles.infoLabel}>순번</span>
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
