import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { session_id, connection_id, seat_number } = body

    await Promise.all([
      supabase
        .from('student_connections')
        .update({ status: 'disconnected', is_focused: false })
        .eq('id', connection_id),
      supabase.from('activity_logs').insert({
        session_id,
        connection_id,
        seat_number,
        event_type: 'disconnected',
        detail: '브라우저 닫힘 또는 페이지 이탈',
      }),
    ])

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
