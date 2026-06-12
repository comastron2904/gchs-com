'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import type { ExamSession, StudentConnection, ActivityLog } from '@/lib/types'
import styles from './teacher.module.css'

const EVENT_LABEL: Record<string, { text: string; color: string }> = {
  connected:     { text: '접속',        color: '#185FA5' },
  tab_hidden:    { text: '탭 이탈',     color: '#A32D2D' },
  tab_visible:   { text: '탭 복귀',     color: '#0F6E56' },
  window_blur:   { text: '창 전환',     color: '#A32D2D' },
  window_focus:  { text: '창 복귀',     color: '#0F6E56' },
  blocked_site:  { text: '차단 사이트', color: '#7C1F1F' },
  disconnected:  { text: '연결 끊김',   color: '#854F0B' },
}

export default function TeacherPage() {
  const router = useRouter()
  const [session, setSession] = useState<ExamSession | null>(null)
  const [connections, setConnections] = useState<StudentConnection[]>([])
  const [logs, setLogs] = useState<ActivityLog[]>([])
  const [subject, setSubject] = useState('')
  const [keywordInput, setKeywordInput] = useState('')
  const [blockedKeywords, setBlockedKeywords] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [elapsed, setElapsed] = useState(0)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const logsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetchActiveSession()

    const channel = supabase
      .channel('teacher-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exam_sessions' }, () => {
        fetchActiveSession()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'student_connections' }, () => {
        fetchConnections()
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_logs' }, payload => {
        setLogs(prev => [...prev, payload.new as ActivityLog])
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [])

  useEffect(() => {
    if (session?.status === 'active') {
      const startTime = new Date(session.started_at).getTime()
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTime) / 1000))
      }, 1000)
      fetchConnections()
      fetchLogs()
    } else {
      if (timerRef.current) clearInterval(timerRef.current)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [session?.id, session?.status])

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

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

  async function fetchConnections() {
    if (!session?.id) return
    const { data } = await supabase
      .from('student_connections')
      .select('*')
      .eq('session_id', session.id)
      .order('seat_number', { ascending: true })
    setConnections(data ?? [])
  }

  async function fetchLogs() {
    if (!session?.id) return
    const { data } = await supabase
      .from('activity_logs')
      .select('*')
      .eq('session_id', session.id)
      .order('created_at', { ascending: true })
      .limit(200)
    setLogs(data ?? [])
  }

  async function startExam() {
    if (!subject.trim()) return
    const { data } = await supabase
      .from('exam_sessions')
      .insert({ subject: subject.trim(), teacher_id: 'GCHS', status: 'active', blocked_keywords: blockedKeywords })
      .select()
      .single()
    setSession(data)
    setElapsed(0)
  }

  function addKeyword() {
    const kw = keywordInput.trim().toLowerCase()
    if (!kw || blockedKeywords.includes(kw)) return
    setBlockedKeywords(prev => [...prev, kw])
    setKeywordInput('')
  }

  function removeKeyword(kw: string) {
    setBlockedKeywords(prev => prev.filter(k => k !== kw))
  }

  async function endExam() {
    if (!session) return
    await supabase
      .from('exam_sessions')
      .update({ status: 'ended', ended_at: new Date().toISOString() })
      .eq('id', session.id)
    await supabase
      .from('student_connections')
      .update({ status: 'disconnected' })
      .eq('session_id', session.id)
    setSession(null)
    setConnections([])
    setLogs([])
  }

  function formatTime(s: number) {
    const h = Math.floor(s / 3600).toString().padStart(2, '0')
    const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0')
    const sec = (s % 60).toString().padStart(2, '0')
    return `${h}:${m}:${sec}`
  }

  function formatLogTime(iso: string) {
    return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  const warningCount = connections.filter(c => c.status === 'warning').length
  const activeCount = connections.filter(c => c.status === 'active').length

  if (loading) {
    return <div className={styles.loading}>불러오는 중...</div>
  }

  return (
    <div className={styles.app}>
      {/* 상단 바 */}
      <header className={styles.topbar}>
        <div className={styles.topLeft}>
          <button className={styles.backBtn} onClick={() => router.push('/')}>←</button>
          <span className={styles.siteName}>GCHS 컴퓨터실 제어</span>
          <span className={styles.siteSub}>교사 대시보드</span>
        </div>
        <div className={styles.topRight}>
          {session && (
            <>
              <span className={styles.timerBadge}>{formatTime(elapsed)}</span>
              <span className={styles.badge} style={{ background: 'var(--green-bg)', color: 'var(--green-text)' }}>
                <span className={styles.dotActive} /> 관리 중
              </span>
            </>
          )}
        </div>
      </header>

      {/* 시험 시작 전 */}
      {!session && (
        <div className={styles.startWrap}>
          <div className={styles.startCard}>
            <h2 className={styles.startTitle}>시험 시작</h2>
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>시험 과목</label>
              <input
                type="text"
                value={subject}
                onChange={e => setSubject(e.target.value)}
                placeholder="예: 정보 · IB CS HL"
                onKeyDown={e => e.key === 'Enter' && startExam()}
                autoFocus
              />
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>차단 키워드 (URL에 포함된 단어)</label>
              <div className={styles.keywordRow}>
                <input
                  type="text"
                  value={keywordInput}
                  onChange={e => setKeywordInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addKeyword()}
                  placeholder="예: youtube, chatgpt, naver"
                />
                <button className={styles.btnAdd} onClick={addKeyword} disabled={!keywordInput.trim()}>추가</button>
              </div>
              {blockedKeywords.length > 0 && (
                <div className={styles.tagList}>
                  {blockedKeywords.map(kw => (
                    <span key={kw} className={styles.tag}>
                      {kw}
                      <button className={styles.tagDel} onClick={() => removeKeyword(kw)}>×</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <button
              className={styles.btnGreen}
              onClick={startExam}
              disabled={!subject.trim()}
            >
              ▶ 시험 시작
            </button>
          </div>
        </div>
      )}

      {/* 대시보드 */}
      {session && (
        <div className={styles.dashboard}>
          {/* 요약 바 */}
          <div className={styles.summaryBar}>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>과목</span>
              <span className={styles.summaryVal}>{session.subject}</span>
            </div>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>접속 PC</span>
              <span className={styles.summaryVal}>{connections.length}대</span>
            </div>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>정상</span>
              <span className={styles.summaryVal} style={{ color: 'var(--green)' }}>{activeCount}대</span>
            </div>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>경고</span>
              <span className={styles.summaryVal} style={{ color: warningCount > 0 ? 'var(--red)' : 'var(--text-3)' }}>
                {warningCount}대
              </span>
            </div>
            {session.blocked_keywords?.length > 0 && (
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>차단 키워드</span>
                <div className={styles.tagListSmall}>
                  {session.blocked_keywords.map(kw => (
                    <span key={kw} className={styles.tagSmall}>{kw}</span>
                  ))}
                </div>
              </div>
            )}
            <div className={styles.summaryRight}>
              <button className={styles.btnRed} onClick={endExam}>■ 시험 종료</button>
            </div>
          </div>

          <div className={styles.cols}>
            {/* PC 목록 */}
            <section className={styles.pcSection}>
              <h3 className={styles.sectionTitle}>접속 PC 목록</h3>
              {connections.length === 0 ? (
                <div className={styles.emptyMsg}>아직 접속한 학생이 없습니다.<br/>학생이 사이트에 접속하면 자동으로 표시됩니다.</div>
              ) : (
                <div className={styles.pcGrid}>
                  {connections.map(c => (
                    <div
                      key={c.id}
                      className={`${styles.pcCard} ${
                        c.status === 'warning' ? styles.pcWarning :
                        c.status === 'disconnected' ? styles.pcDisconnected :
                        c.is_focused ? styles.pcActive : styles.pcBlurred
                      }`}
                    >
                      <div className={styles.pcNum}>{String(c.seat_number).padStart(2, '0')}</div>
                      <div className={styles.pcLabel}>{c.student_name || c.pc_label}</div>
                      <div className={styles.pcSub}>{c.pc_label}</div>
                      <div className={styles.pcStatus}>
                        {c.status === 'warning' ? '⚠ 경고' :
                         c.status === 'disconnected' ? '연결 끊김' :
                         c.is_focused ? '정상' : '전환됨'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* 활동 로그 */}
            <section className={styles.logSection}>
              <h3 className={styles.sectionTitle}>
                실시간 활동 로그
                <span className={styles.logCount}>{logs.length}건</span>
              </h3>
              <div className={styles.logList}>
                {logs.length === 0 && (
                  <div className={styles.emptyMsg}>로그가 없습니다.</div>
                )}
                {logs.map(log => {
                  const ev = EVENT_LABEL[log.event_type] ?? { text: log.event_type, color: 'var(--text-2)' }
                  return (
                    <div key={log.id} className={styles.logRow}>
                      <span className={styles.logTime}>{formatLogTime(log.created_at)}</span>
                      <span className={styles.logSeat}>PC-{String(log.seat_number).padStart(2, '0')}</span>
                      <span className={styles.logEvent} style={{ color: ev.color }}>{ev.text}</span>
                      {log.detail && <span className={styles.logDetail}>{log.detail}</span>}
                    </div>
                  )
                })}
                <div ref={logsEndRef} />
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  )
}
