export type SessionStatus = 'active' | 'ended'
export type ConnectionStatus = 'active' | 'warning' | 'disconnected'
export type EventType =
  | 'connected'
  | 'tab_hidden'
  | 'tab_visible'
  | 'window_blur'
  | 'window_focus'
  | 'blocked_site'
  | 'url_change'
  | 'disconnected'

export interface ExamSession {
  id: string
  subject: string
  teacher_id: string
  status: SessionStatus
  started_at: string
  ended_at: string | null
  blocked_keywords: string[]
}

export interface StudentConnection {
  id: string
  session_id: string
  seat_number: number
  pc_label: string
  student_name: string
  status: ConnectionStatus
  is_focused: boolean
  connected_at: string
  last_seen_at: string
}

export interface ActivityLog {
  id: string
  session_id: string
  connection_id: string
  seat_number: number
  event_type: EventType
  detail: string | null
  created_at: string
}
